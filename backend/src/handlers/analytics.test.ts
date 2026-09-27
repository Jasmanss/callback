import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { handler } from './analytics';
import type { ApiEvent } from '../lib/http';

const athenaMock = mockClient(AthenaClient);

process.env.ATHENA_WORKGROUP = 'test-wg';
process.env.GLUE_DATABASE = 'test-db';

function apiEvent(sub?: string): ApiEvent {
  return {
    requestContext: {
      http: { method: 'GET' },
      authorizer: sub ? { jwt: { claims: { sub } } } : { jwt: { claims: {} } },
    },
  } as unknown as ApiEvent;
}

const statusOf = (result: unknown) => (result as { statusCode: number }).statusCode;
const bodyOf = (result: unknown) => JSON.parse((result as { body: string }).body);

const resultSet = (header: string[], rows: string[][]) => ({
  ResultSet: {
    Rows: [
      { Data: header.map((v) => ({ VarCharValue: v })) },
      ...rows.map((r) => ({ Data: r.map((v) => ({ VarCharValue: v })) })),
    ],
  },
});

beforeEach(() => {
  athenaMock.reset();
  athenaMock.on(StartQueryExecutionCommand).resolves({ QueryExecutionId: 'q1' });
  athenaMock.on(GetQueryExecutionCommand).resolves({ QueryExecution: { Status: { State: 'SUCCEEDED' } } });
  athenaMock
    .on(GetQueryResultsCommand)
    .resolves(resultSet(['source', 'applications', 'responses', 'median_days'], [['LinkedIn', '12', '6', '9']]));
});

describe('GET /analytics', () => {
  it('rejects requests without a verified sub claim', async () => {
    expect(statusOf(await handler(apiEvent()))).toBe(401);
    expect(athenaMock.calls()).toHaveLength(0);
  });

  it('binds the user id as an execution parameter, never into the SQL string', async () => {
    await handler(apiEvent("u1'; DROP TABLE--"));
    for (const call of athenaMock.commandCalls(StartQueryExecutionCommand)) {
      const input = call.args[0].input;
      expect(input.QueryString).toContain('user_id = ?');
      expect(input.QueryString).not.toContain('DROP TABLE');
      // Quotes are stripped from the bound value as defense in depth.
      expect(input.ExecutionParameters).toEqual(["'u1; DROP TABLE--'"]);
    }
  });

  it('returns parsed rows from both queries', async () => {
    const result = await handler(apiEvent('u1'));
    expect(statusOf(result)).toBe(200);
    const body = bodyOf(result);
    expect(body.bySource[0]).toEqual({ source: 'LinkedIn', applications: '12', responses: '6', median_days: '9' });
    expect(body.byMonth).toHaveLength(1);
    expect(athenaMock.commandCalls(StartQueryExecutionCommand)).toHaveLength(2);
  });

  it('maps Athena failures to a 502 without leaking internals', async () => {
    athenaMock
      .on(GetQueryExecutionCommand)
      .resolves({ QueryExecution: { Status: { State: 'FAILED', StateChangeReason: 'SYNTAX_ERROR at line 3' } } });
    const result = await handler(apiEvent('u1'));
    expect(statusOf(result)).toBe(502);
    expect(bodyOf(result).error).not.toContain('SYNTAX_ERROR');
  });
});
