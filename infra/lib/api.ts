import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { CorsHttpMethod, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { AuthConstruct } from './auth';
import type { PipelineConstruct } from './pipeline';

const here = path.dirname(fileURLToPath(import.meta.url));
const handler = (name: string) => path.join(here, '..', '..', 'backend', 'src', 'handlers', `${name}.ts`);

/**
 * HTTP API (not REST API): a third of the price, and its built-in JWT
 * authorizer verifies Cognito tokens at the gateway — no custom authorizer
 * Lambda to write, test, or pay for. Handlers only ever see requests whose
 * token already checked out.
 */
export class ApiConstruct extends Construct {
  readonly api: HttpApi;

  constructor(scope: Construct, id: string, auth: AuthConstruct, pipeline: PipelineConstruct) {
    super(scope, id);

    /**
     * Primary store. PK USER#<sub> / SK APP#<id>: the only access pattern
     * is "all applications for one user" (a single Query), each item is a
     * whole application with its history embedded — no GSIs, no joins, no
     * over-normalization. On-demand billing = $0 when idle.
     */
    const table = new Table(this, 'Applications', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY, // personal project; RETAIN for anything multi-user
    });

    const appsFn = new NodejsFunction(this, 'ApplicationsFn', {
      entry: handler('applications'),
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: { TABLE_NAME: table.tableName, EVENT_BUS_NAME: pipeline.bus.eventBusName },
    });
    table.grantReadWriteData(appsFn);
    pipeline.bus.grantPutEventsTo(appsFn);

    const analyticsFn = new NodejsFunction(this, 'AnalyticsFn', {
      entry: handler('analytics'),
      runtime: Runtime.NODEJS_22_X,
      // HTTP API caps a request at 30 s; the handler polls Athena to ~20 s.
      timeout: Duration.seconds(29),
      memorySize: 256,
      environment: {
        ATHENA_WORKGROUP: pipeline.workgroupName,
        GLUE_DATABASE: pipeline.databaseName,
      },
    });
    // Athena runs with the CALLER's permissions, so the analytics Lambda
    // needs Athena + Glue catalog reads + S3 access to both the data
    // prefix (read) and the results prefix (write).
    analyticsFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults'],
        resources: ['*'], // Athena workgroup ARNs aren't exposed by CfnWorkGroup; scoping via workgroup config
      }),
    );
    analyticsFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetPartitions'],
        resources: ['*'],
      }),
    );
    pipeline.bucket.grantReadWrite(analyticsFn);

    const authorizer = new HttpJwtAuthorizer('CognitoJwt', auth.userPool.userPoolProviderUrl, {
      jwtAudience: [auth.client.userPoolClientId],
    });

    this.api = new HttpApi(this, 'Api', {
      corsPreflight: {
        // The two places the frontend is served from; add origins here if
        // the app moves.
        allowOrigins: ['https://jasmanss.github.io', 'http://localhost:5178'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.PUT, CorsHttpMethod.DELETE, CorsHttpMethod.OPTIONS],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
      defaultAuthorizer: authorizer,
    });

    const apps = new HttpLambdaIntegration('Apps', appsFn);
    this.api.addRoutes({ path: '/applications', methods: [HttpMethod.GET, HttpMethod.PUT], integration: apps });
    this.api.addRoutes({ path: '/applications/{id}', methods: [HttpMethod.DELETE], integration: apps });
    this.api.addRoutes({
      path: '/analytics',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('Analytics', analyticsFn),
    });
  }
}
