import { DynamoDBDocumentClient, BatchWriteCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { handler } from './applications';
import type { ApiEvent } from '../lib/http';

const ddbMock = mockClient(DynamoDBDocumentClient);
const busMock = mockClient(EventBridgeClient);

process.env.TABLE_NAME = 'test-table';
process.env.EVENT_BUS_NAME = 'test-bus';

/** Builds a minimal API Gateway v2 event with (or without) a verified sub. */
function apiEvent(method: string, options: { sub?: string; body?: unknown; id?: string } = {}): ApiEvent {
  return {
    requestContext: {
      http: { method },
      authorizer: options.sub ? { jwt: { claims: { sub: options.sub } } } : { jwt: { claims: {} } },
    },
    pathParameters: options.id ? { id: options.id } : undefined,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    isBase64Encoded: false,
  } as unknown as ApiEvent;
}

const app = (overrides: Record<string, unknown> = {}) => ({
  id: 'a1',
  company: 'Lyft',
  role: 'Data Analyst',
  url: '',
  location: '',
  workMode: '',
  salary: '',
  source: 'LinkedIn',
  status: 'applied',
  dateApplied: '2026-09-01',
  followUpDate: '',
  contactName: '',
  contactEmail: '',
  resumeVersion: '',
  priority: 2,
  notes: '',
  history: [{ status: 'applied', at: '2026-09-01T12:00:00Z' }],
  createdAt: '2026-09-01T12:00:00Z',
  updatedAt: '2026-09-01T12:00:00Z',
  ...overrides,
});

const statusOf = (result: unknown) => (result as { statusCode: number }).statusCode;
const bodyOf = (result: unknown) => JSON.parse((result as { body: string }).body);

beforeEach(() => {
  ddbMock.reset();
  busMock.reset();
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(BatchWriteCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
  busMock.on(PutEventsCommand).resolves({});
});

describe('auth', () => {
  it('rejects requests without a verified sub claim', async () => {
    expect(statusOf(await handler(apiEvent('GET')))).toBe(401);
    expect(statusOf(await handler(apiEvent('PUT', { body: { applications: [] } })))).toBe(401);
    expect(ddbMock.calls()).toHaveLength(0);
  });
});

describe('GET /applications', () => {
  it('returns the caller’s applications only (partition key from the JWT)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ pk: 'USER#u1', sk: 'APP#a1', app: app() }] });
    const result = await handler(apiEvent('GET', { sub: 'u1' }));
    expect(statusOf(result)).toBe(200);
    expect(bodyOf(result).applications).toHaveLength(1);
    const query = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(query.ExpressionAttributeValues).toEqual({ ':pk': 'USER#u1' });
  });
});

describe('PUT /applications', () => {
  it('rejects malformed bodies', async () => {
    const cases = [
      apiEvent('PUT', { sub: 'u1' }), // no body
      apiEvent('PUT', { sub: 'u1', body: { nope: true } }),
      apiEvent('PUT', { sub: 'u1', body: { applications: 'not-an-array' } }),
      apiEvent('PUT', { sub: 'u1', body: { applications: [{ id: '', status: 'applied' }] } }),
      apiEvent('PUT', { sub: 'u1', body: { applications: [app({ status: 'made-up-status' })] } }),
    ];
    for (const event of cases) {
      expect(statusOf(await handler(event))).toBe(400);
    }
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('rejects raw non-JSON bodies', async () => {
    const event = apiEvent('PUT', { sub: 'u1' });
    (event as unknown as { body: string }).body = '{not json';
    expect(statusOf(await handler(event))).toBe(400);
  });

  it('stores new applications and emits a status event for each', async () => {
    const result = await handler(apiEvent('PUT', { sub: 'u1', body: { applications: [app()] } }));
    expect(statusOf(result)).toBe(200);
    expect(bodyOf(result)).toEqual({ stored: 1, events: 1 });

    const write = ddbMock.commandCalls(BatchWriteCommand)[0].args[0].input;
    expect(write.RequestItems!['test-table'][0].PutRequest!.Item).toMatchObject({ pk: 'USER#u1', sk: 'APP#a1' });

    const entries = busMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries!;
    const detail = JSON.parse(entries[0].Detail!);
    expect(detail).toMatchObject({ user_id: 'u1', app_id: 'a1', status: 'applied', prev_status: null, source: 'LinkedIn' });
  });

  it('emits transition events only when the status actually changed', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ app: app() }] }); // stored: applied
    const unchanged = app({ notes: 'edited', updatedAt: '2026-09-02T12:00:00Z' });
    const moved = app({ id: 'a2', status: 'interviewing', updatedAt: '2026-09-02T12:00:00Z' });
    ddbMock.on(QueryCommand).resolves({ Items: [{ app: app() }, { app: app({ id: 'a2' }) }] });

    const result = await handler(apiEvent('PUT', { sub: 'u1', body: { applications: [unchanged, moved] } }));
    expect(bodyOf(result).events).toBe(1);
    const detail = JSON.parse(busMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].Detail!);
    expect(detail).toMatchObject({ app_id: 'a2', status: 'interviewing', prev_status: 'applied' });
  });

  it('skips writes for apps whose updatedAt is unchanged', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ app: app() }] });
    const result = await handler(apiEvent('PUT', { sub: 'u1', body: { applications: [app()] } }));
    expect(bodyOf(result)).toEqual({ stored: 0, events: 0 });
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('caps a sync at 500 applications', async () => {
    const many = Array.from({ length: 501 }, (_, i) => app({ id: `a${i}` }));
    expect(statusOf(await handler(apiEvent('PUT', { sub: 'u1', body: { applications: many } })))).toBe(400);
  });
});

describe('DELETE /applications/{id}', () => {
  it('deletes within the caller’s partition', async () => {
    const result = await handler(apiEvent('DELETE', { sub: 'u1', id: 'a1' }));
    expect(statusOf(result)).toBe(200);
    expect(ddbMock.commandCalls(DeleteCommand)[0].args[0].input.Key).toEqual({ pk: 'USER#u1', sk: 'APP#a1' });
  });

  it('requires an id', async () => {
    expect(statusOf(await handler(apiEvent('DELETE', { sub: 'u1' })))).toBe(400);
  });
});
