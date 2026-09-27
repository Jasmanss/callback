import { App } from 'aws-cdk-lib';
import { CallbackCloudStack } from '../lib/callback-cloud-stack';

/**
 * One stack on purpose: the three constructs inside it (auth, api, data
 * pipeline) share references directly instead of through cross-stack
 * exports, and `cdk deploy` / `cdk destroy` is a single command. Splitting
 * into stacks earns its keep when parts deploy on different cadences or
 * are owned by different people — neither is true here.
 */
const app = new App();
new CallbackCloudStack(app, 'CallbackCloud', {
  description: 'Callback job tracker: opt-in cloud sync + personal analytics',
});
