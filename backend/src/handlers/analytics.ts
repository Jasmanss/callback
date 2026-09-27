import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { json, unauthorized, userIdOf, type ApiEvent, type ApiResult } from '../lib/http';

/**
 * GET /analytics — runs real SQL over the status-event history in S3.
 *
 * Two queries (in parallel): median days from Applied to first response
 * grouped by source, and grouped by month applied. "First response" is the
 * first transition into screening/interviewing/offer/rejected — a rejection
 * counts as a response, matching the app's own "heard back" stat.
 *
 * The user id is NEVER interpolated into SQL from the request path/body —
 * it comes from the verified JWT and is passed as an Athena execution
 * parameter (a real bind parameter), so injection isn't possible even if
 * a sub claim were somehow attacker-shaped.
 *
 * Latency note: Athena is a batch engine; simple queries take 1–5 s. The
 * handler polls up to ~20 s (HTTP API caps requests at 30 s) and returns
 * 504 with a retry hint if Athena is slower — acceptable for an analytics
 * page a person opens occasionally, and it avoids adding a job/callback
 * system that wouldn't be load-bearing.
 */

const athena = new AthenaClient({});

const BY_SOURCE = `
  WITH firsts AS (
    SELECT app_id,
           min(source) AS source,
           min(CASE WHEN status = 'applied' AND applied_date != '' THEN from_iso8601_date(applied_date) END) AS applied,
           min(CASE WHEN status IN ('screening','interviewing','offer','rejected') THEN date(from_iso8601_timestamp("at")) END) AS responded
    FROM status_events
    WHERE user_id = ?
    GROUP BY app_id
  )
  SELECT source,
         count(*) AS applications,
         count(responded) AS responses,
         approx_percentile(date_diff('day', applied, responded), 0.5) AS median_days
  FROM firsts
  WHERE applied IS NOT NULL
  GROUP BY source
  ORDER BY applications DESC
`;

const BY_MONTH = `
  WITH firsts AS (
    SELECT app_id,
           min(CASE WHEN status = 'applied' AND applied_date != '' THEN from_iso8601_date(applied_date) END) AS applied,
           min(CASE WHEN status IN ('screening','interviewing','offer','rejected') THEN date(from_iso8601_timestamp("at")) END) AS responded
    FROM status_events
    WHERE user_id = ?
    GROUP BY app_id
  )
  SELECT substr(cast(applied AS varchar), 1, 7) AS month,
         count(*) AS applications,
         count(responded) AS responses,
         approx_percentile(date_diff('day', applied, responded), 0.5) AS median_days
  FROM firsts
  WHERE applied IS NOT NULL
  GROUP BY 1
  ORDER BY 1 DESC
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runQuery(sql: string, userId: string): Promise<Record<string, string>[]> {
  const started = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      ExecutionParameters: [`'${userId.replace(/'/g, '')}'`],
      WorkGroup: process.env.ATHENA_WORKGROUP,
      QueryExecutionContext: { Database: process.env.GLUE_DATABASE },
    }),
  );
  const id = started.QueryExecutionId!;

  const deadline = Date.now() + 20_000;
  for (;;) {
    const status = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = status.QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(status.QueryExecution?.Status?.StateChangeReason ?? 'Query failed');
    }
    if (Date.now() > deadline) throw new Error('timeout');
    await sleep(400);
  }

  const results = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id }));
  const rows = results.ResultSet?.Rows ?? [];
  const header = (rows[0]?.Data ?? []).map((d) => d.VarCharValue ?? '');
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    (row.Data ?? []).forEach((cell, i) => {
      record[header[i]] = cell.VarCharValue ?? '';
    });
    return record;
  });
}

export async function handler(event: ApiEvent): Promise<ApiResult> {
  const userId = userIdOf(event);
  if (!userId) return unauthorized();

  try {
    const [bySource, byMonth] = await Promise.all([runQuery(BY_SOURCE, userId), runQuery(BY_MONTH, userId)]);
    return json(200, {
      bySource,
      byMonth,
      note: 'Built from your status-change history; new events land after the hourly batch.',
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'timeout') {
      return json(504, { error: 'The analytics query is still running — try again in a few seconds.' });
    }
    return json(502, { error: 'The analytics query failed.' });
  }
}
