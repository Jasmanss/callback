import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'node:crypto';
import { STATUSES, type Application, type Status } from '../../../src/types';
import { EVENT_DETAIL_TYPE, EVENT_SOURCE, type StatusChangeEvent } from '../lib/events';
import { badRequest, json, parseBody, unauthorized, userIdOf, type ApiEvent, type ApiResult } from '../lib/http';

/**
 * One Lambda for all /applications routes (GET list, PUT bulk upsert,
 * DELETE one). One function instead of three keeps a single cold-start
 * path and shared SDK clients; at personal-tracker traffic there is no
 * isolation benefit to splitting, and the router below is trivial.
 *
 * The write API is a BULK upsert rather than per-item POST/PATCH because
 * the client is a sync engine, not a form: it merges locally and pushes
 * the result in one round trip. DynamoDB BatchWrite makes that one API
 * call ≈ one wire operation.
 */

// SDK clients live at module scope so warm invocations reuse connections.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bus = new EventBridgeClient({});

/**
 * Key schema: PK = USER#<sub>, SK = APP#<id>.
 * The only read pattern is "everything for this user" (one Query on the
 * partition), and every item is owned by exactly one user — so a single
 * table, partitioned by user, with the application stored as one item
 * (history embedded) needs no GSIs and no joins. Analytics never reads
 * this table; it reads the event stream in S3.
 */
const pk = (userId: string) => `USER#${userId}`;
const sk = (appId: string) => `APP#${appId}`;

interface PutBody {
  applications?: unknown;
}

/** Server-side shape check: reject anything that isn't a plausible application. */
function validApp(raw: unknown): raw is Application {
  if (!raw || typeof raw !== 'object') return false;
  const a = raw as Record<string, unknown>;
  return (
    typeof a.id === 'string' &&
    a.id.length > 0 &&
    a.id.length <= 80 &&
    typeof a.company === 'string' &&
    (STATUSES as readonly string[]).includes(a.status as string) &&
    typeof a.updatedAt === 'string' &&
    Array.isArray(a.history)
  );
}

async function listApps(userId: string): Promise<Application[]> {
  const out: Application[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: process.env.TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk(userId) },
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of page.Items ?? []) out.push((item as { app: Application }).app);
    cursor = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);
  return out;
}

/**
 * Derives status transitions by comparing incoming apps with what's stored.
 * This read-before-write exists ONLY to feed the analytics event stream —
 * the upsert itself doesn't need it. At one Query per sync it's cheap, and
 * it keeps event emission server-authoritative (a buggy client can't fake
 * a transition it didn't actually write).
 */
function transitionsOf(userId: string, incoming: Application[], existing: Map<string, Application>): StatusChangeEvent[] {
  const events: StatusChangeEvent[] = [];
  const now = new Date().toISOString();
  for (const app of incoming) {
    const before = existing.get(app.id);
    if (before && before.status === app.status) continue;
    events.push({
      event_id: randomUUID(),
      user_id: userId,
      app_id: app.id,
      company: app.company,
      source: app.source || 'unknown',
      status: app.status as Status,
      prev_status: (before?.status as Status | undefined) ?? null,
      at: now,
      applied_date: app.dateApplied || '',
    });
  }
  return events;
}

async function emit(events: StatusChangeEvent[]): Promise<void> {
  // PutEvents accepts at most 10 entries per call.
  for (let i = 0; i < events.length; i += 10) {
    await bus.send(
      new PutEventsCommand({
        Entries: events.slice(i, i + 10).map((detail) => ({
          EventBusName: process.env.EVENT_BUS_NAME,
          Source: EVENT_SOURCE,
          DetailType: EVENT_DETAIL_TYPE,
          Detail: JSON.stringify(detail),
        })),
      }),
    );
  }
}

export async function handler(event: ApiEvent): Promise<ApiResult> {
  const userId = userIdOf(event);
  if (!userId) return unauthorized();

  const method = event.requestContext.http.method;

  if (method === 'GET') {
    return json(200, { applications: await listApps(userId) });
  }

  if (method === 'PUT') {
    const body = parseBody<PutBody>(event);
    if (!body || !Array.isArray(body.applications)) {
      return badRequest('Body must be {"applications": [...]}.');
    }
    if (body.applications.length > 500) {
      return badRequest('Too many applications in one sync (max 500).');
    }
    const apps = body.applications.filter(validApp);
    if (apps.length !== body.applications.length) {
      return badRequest('One or more applications are malformed.');
    }

    const existing = new Map((await listApps(userId)).map((a) => [a.id, a]));
    const events = transitionsOf(userId, apps, existing);

    // BatchWrite caps at 25 items per call.
    const changed = apps.filter((a) => {
      const before = existing.get(a.id);
      return !before || before.updatedAt !== a.updatedAt;
    });
    for (let i = 0; i < changed.length; i += 25) {
      await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [process.env.TABLE_NAME!]: changed.slice(i, i + 25).map((app) => ({
              PutRequest: { Item: { pk: pk(userId), sk: sk(app.id), app } },
            })),
          },
        }),
      );
    }
    await emit(events);
    return json(200, { stored: changed.length, events: events.length });
  }

  if (method === 'DELETE') {
    const appId = event.pathParameters?.id;
    if (!appId) return badRequest('Missing application id.');
    await ddb.send(
      new DeleteCommand({ TableName: process.env.TABLE_NAME, Key: { pk: pk(userId), sk: sk(appId) } }),
    );
    return json(200, { deleted: appId });
  }

  return json(405, { error: `Unsupported method ${method}.` });
}
