import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ApiConstruct } from './api';
import { AuthConstruct } from './auth';
import { PipelineConstruct } from './pipeline';

/**
 * Everything the opt-in cloud mode needs, and nothing else:
 *   Cognito (identity) → HTTP API + Lambdas (CRUD/analytics) → DynamoDB (store)
 *   → EventBridge → SQS → hourly Lambda → S3 → Glue/Athena (analytics data).
 * No VPC (nothing here needs one, and NAT gateways are the classic idle-cost
 * trap), no crawler, no CDN, no queues beyond the one that is load-bearing.
 */
export class CallbackCloudStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const auth = new AuthConstruct(this, 'Auth');
    const pipeline = new PipelineConstruct(this, 'Pipeline');
    const api = new ApiConstruct(this, 'Api', auth, pipeline);

    new CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    new CfnOutput(this, 'ClientId', { value: auth.client.userPoolClientId });
    new CfnOutput(this, 'ApiUrl', { value: api.api.apiEndpoint });
    // The one value to paste into the app's Cloud dialog.
    new CfnOutput(this, 'CloudConfig', {
      value: JSON.stringify({
        region: this.region,
        clientId: auth.client.userPoolClientId,
        apiUrl: api.api.apiEndpoint,
      }),
    });
  }
}
