import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, ReceiveMessageCommand, DeleteMessageBatchCommand } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { handler } from './batcher';

const sqsMock = mockClient(SQSClient);
const s3Mock = mockClient(S3Client);

process.env.QUEUE_URL = 'https://sqs.test/queue';
process.env.BUCKET_NAME = 'test-bucket';

const envelope = (detail: unknown) => ({ Body: JSON.stringify({ detail }), ReceiptHandle: 'rh' });

beforeEach(() => {
  sqsMock.reset();
  s3Mock.reset();
  s3Mock.on(PutObjectCommand).resolves({});
  sqsMock.on(DeleteMessageBatchCommand).resolves({});
});

describe('the hourly batcher', () => {
  it('writes drained events as one day-partitioned JSONL object and deletes them', async () => {
    sqsMock
      .on(ReceiveMessageCommand)
      .resolvesOnce({ Messages: [envelope({ event_id: 'e1', user_id: 'u1' }), envelope({ event_id: 'e2', user_id: 'u1' })] })
      .resolves({ Messages: [] });

    const result = await handler();
    expect(result.written).toBe(2);

    const put = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(put.Key).toMatch(/^events\/dt=\d{4}-\d{2}-\d{2}\/\d+-[0-9a-f-]+\.jsonl$/);
    const lines = String(put.Body).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ event_id: 'e1', user_id: 'u1' });

    expect(sqsMock.commandCalls(DeleteMessageBatchCommand)).toHaveLength(1);
  });

  it('writes nothing when the queue is empty', async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [] });
    const result = await handler();
    expect(result.written).toBe(0);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('drops malformed messages without failing the run', async () => {
    sqsMock
      .on(ReceiveMessageCommand)
      .resolvesOnce({ Messages: [{ Body: '{broken', ReceiptHandle: 'rh' }, envelope({ event_id: 'ok' })] })
      .resolves({ Messages: [] });
    const result = await handler();
    expect(result.written).toBe(1);
    // The malformed one is still deleted so it can't poison the queue.
    const deleted = sqsMock.commandCalls(DeleteMessageBatchCommand)[0].args[0].input.Entries!;
    expect(deleted).toHaveLength(2);
  });

  it('leaves messages in the queue when the S3 write fails', async () => {
    sqsMock.on(ReceiveMessageCommand).resolvesOnce({ Messages: [envelope({ event_id: 'e1' })] }).resolves({ Messages: [] });
    s3Mock.on(PutObjectCommand).rejects(new Error('s3 down'));
    await expect(handler()).rejects.toThrow('s3 down');
    expect(sqsMock.commandCalls(DeleteMessageBatchCommand)).toHaveLength(0);
  });
});
