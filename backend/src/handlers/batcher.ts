import { DeleteMessageBatchCommand, ReceiveMessageCommand, SQSClient, type Message } from '@aws-sdk/client-sqs';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

/**
 * Hourly batcher: drains the status-event queue and writes ONE newline-
 * delimited JSON object per run into S3, partitioned by day:
 *
 *   s3://<bucket>/events/dt=2026-09-26/<timestamp>-<uuid>.jsonl
 *
 * Why a queue at all: EventBridge routes events but does not STORE them —
 * a scheduled Lambda can't ask the bus "what happened since last run".
 * The bus rule targets SQS, which holds events durably (up to 14 days)
 * until this function runs. EventBridge still earns its place over the API
 * Lambda writing to SQS/S3 directly: the write path stays one line
 * (PutEvents) and future consumers (notifications, webhooks) attach as new
 * rules without touching CRUD code.
 *
 * Why hourly batches instead of writing S3 per event: Athena bills by data
 * scanned and slows down on many tiny objects; one file per hour keeps the
 * object count low with zero extra services.
 *
 * Why JSONL rather than Parquet: Parquet is columnar — cheaper scans and
 * faster queries at large scale — but writing it correctly from a Node
 * Lambda needs a third-party writer or a heavyweight layer. JSONL is
 * written correctly with JSON.stringify and read natively by Athena's JSON
 * SerDe. At personal-tracker volume (a few KB/day) the scan-cost advantage
 * of Parquet rounds to zero, so JSONL wins on "simplest to set up
 * correctly". If volume ever justified it, the switch is contained to this
 * file plus the Glue table's SerDe.
 *
 * Delivery is at-least-once (SQS standard queue), so duplicates are
 * possible. Every event carries event_id, and the analytics SQL only uses
 * MIN() aggregates per application — a duplicate row changes nothing.
 */

const sqs = new SQSClient({});
const s3 = new S3Client({});

const MAX_MESSAGES = 2000; // safety valve per run; the queue keeps the rest for the next hour

export async function handler(): Promise<{ written: number }> {
  const queueUrl = process.env.QUEUE_URL!;
  const lines: string[] = [];
  const toDelete: Message[] = [];

  while (lines.length < MAX_MESSAGES) {
    const batch = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    if (!batch.Messages || batch.Messages.length === 0) break;
    for (const message of batch.Messages) {
      try {
        // The SQS body is the EventBridge envelope; the event we wrote is in .detail.
        const envelope = JSON.parse(message.Body ?? '') as { detail?: unknown };
        if (envelope.detail && typeof envelope.detail === 'object') {
          lines.push(JSON.stringify(envelope.detail));
        }
      } catch {
        // A malformed message is dropped (deleted) rather than poisoning the queue forever.
      }
      toDelete.push(message);
    }
  }

  if (lines.length > 0) {
    const now = new Date();
    const dt = now.toISOString().slice(0, 10);
    const key = `events/dt=${dt}/${now.getTime()}-${randomUUID()}.jsonl`;
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: key,
        Body: lines.join('\n') + '\n',
        ContentType: 'application/x-ndjson',
      }),
    );
  }

  // Delete only after the S3 write succeeded: a failed run leaves messages
  // in the queue for the next hour instead of losing them.
  for (let i = 0; i < toDelete.length; i += 10) {
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: toDelete.slice(i, i + 10).map((m, j) => ({ Id: String(j), ReceiptHandle: m.ReceiptHandle! })),
      }),
    );
  }

  return { written: lines.length };
}
