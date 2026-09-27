import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { CfnWorkGroup } from 'aws-cdk-lib/aws-athena';
import { EventBus, Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction, SqsQueue } from 'aws-cdk-lib/aws-events-targets';
import { CfnDatabase, CfnTable } from 'aws-cdk-lib/aws-glue';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const handler = (name: string) => path.join(here, '..', '..', 'backend', 'src', 'handlers', `${name}.ts`);

export const GLUE_DATABASE = 'callback_analytics';
export const EVENTS_TABLE = 'status_events';

/**
 * The analytics data pipeline:
 *
 *   API Lambda ──PutEvents──▶ EventBridge bus ──rule──▶ SQS ──hourly──▶ S3 (JSONL, dt= partitions) ──▶ Athena
 *
 * EventBridge decouples the write path from analytics: the API emits one
 * event and returns; adding consumers later (email digests, webhooks) is a
 * new rule, not a CRUD change. SQS sits between the bus and the hourly
 * batcher because EventBridge routes events but does not store them — the
 * queue is the durable buffer the scheduled Lambda drains.
 */
export class PipelineConstruct extends Construct {
  readonly bus: EventBus;
  readonly bucket: Bucket;
  readonly workgroupName: string;
  readonly databaseName = GLUE_DATABASE;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.bus = new EventBus(this, 'Bus', { eventBusName: 'callback-events' });

    this.bucket = new Bucket(this, 'Events', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Personal project: destroy + auto-empty makes `cdk destroy` actually
      // clean up. A multi-user product would RETAIN instead.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const queue = new Queue(this, 'StatusEvents', {
      // 14 days: the batcher can fail for two straight weeks before any
      // event is lost.
      retentionPeriod: Duration.days(14),
      visibilityTimeout: Duration.minutes(5),
    });

    new Rule(this, 'StatusToQueue', {
      eventBus: this.bus,
      eventPattern: { source: ['callback.api'], detailType: ['application.status-changed'] },
      targets: [new SqsQueue(queue)],
    });

    const batcher = new NodejsFunction(this, 'Batcher', {
      entry: handler('batcher'),
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.minutes(2),
      memorySize: 256,
      environment: { QUEUE_URL: queue.queueUrl, BUCKET_NAME: this.bucket.bucketName },
    });
    queue.grantConsumeMessages(batcher);
    this.bucket.grantPut(batcher);

    // The hourly schedule lives on the DEFAULT bus (scheduled rules can't
    // live on a custom bus); the custom bus above carries app events only.
    new Rule(this, 'HourlyBatch', {
      schedule: Schedule.rate(Duration.hours(1)),
      targets: [new LambdaFunction(batcher)],
    });

    /**
     * Glue table over the JSONL files, defined statically with PARTITION
     * PROJECTION instead of a Glue crawler: the partition (dt) is computed
     * from the S3 key layout at query time, so there is no crawler to run,
     * schedule, pay for, or debug — one fewer moving part.
     */
    new CfnDatabase(this, 'Db', {
      catalogId: Stack.of(this).account,
      databaseInput: { name: GLUE_DATABASE },
    });

    const table = new CfnTable(this, 'EventsTable', {
      catalogId: Stack.of(this).account,
      databaseName: GLUE_DATABASE,
      tableInput: {
        name: EVENTS_TABLE,
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          classification: 'json',
          'projection.enabled': 'true',
          'projection.dt.type': 'date',
          'projection.dt.range': '2026-01-01,NOW',
          'projection.dt.format': 'yyyy-MM-dd',
          'projection.dt.interval': '1',
          'projection.dt.interval.unit': 'DAYS',
          'storage.location.template': `s3://${this.bucket.bucketName}/events/dt=\${dt}/`,
        },
        partitionKeys: [{ name: 'dt', type: 'string' }],
        storageDescriptor: {
          location: `s3://${this.bucket.bucketName}/events/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: { serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe' },
          columns: [
            { name: 'event_id', type: 'string' },
            { name: 'user_id', type: 'string' },
            { name: 'app_id', type: 'string' },
            { name: 'company', type: 'string' },
            { name: 'source', type: 'string' },
            { name: 'status', type: 'string' },
            { name: 'prev_status', type: 'string' },
            { name: 'at', type: 'string' },
            { name: 'applied_date', type: 'string' },
          ],
        },
      },
    });
    table.node.addDependency(this.bucket);

    const workgroup = new CfnWorkGroup(this, 'Workgroup', {
      name: 'callback',
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        resultConfiguration: { outputLocation: `s3://${this.bucket.bucketName}/athena-results/` },
        // Athena bills $5/TB scanned; this cap makes a runaway query
        // impossible to feel ($0.005 worst case per query).
        bytesScannedCutoffPerQuery: 1024 * 1024 * 1024,
      },
    });
    this.workgroupName = workgroup.name!;
  }
}
