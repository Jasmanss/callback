import { RemovalPolicy } from 'aws-cdk-lib';
import { AccountRecovery, UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

/**
 * Identity lives HERE and nowhere else: Cognito issues the JWTs, API
 * Gateway's JWT authorizer verifies them, and Lambda handlers read the
 * verified `sub`. The app never stores passwords and has no user table of
 * its own — the DynamoDB partition key IS the Cognito sub.
 */
export class AuthConstruct extends Construct {
  readonly userPool: UserPool;
  readonly client: UserPoolClient;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.userPool = new UserPool(this, 'Users', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      passwordPolicy: { minLength: 10 },
      // Personal project: tearing the stack down should tear users down too.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.client = new UserPoolClient(this, 'WebClient', {
      userPool: this.userPool,
      // A browser SPA cannot keep a client secret, so there isn't one.
      generateSecret: false,
      // USER_PASSWORD_AUTH lets the frontend sign in with four plain
      // fetch() calls to the Cognito endpoint (over TLS, directly to
      // Cognito) instead of shipping an SRP crypto library. The tradeoff
      // (Cognito sees the password, which it does either way as the
      // verifier) is acceptable; swap to SRP later without an API change.
      authFlows: { userPassword: true },
    });

    // Google sign-in is a documented NEXT STEP, not built: it needs a
    // Google OAuth client + `UserPoolIdentityProviderGoogle` + a hosted UI
    // domain. Nothing in the API changes when it's added — tokens from the
    // same pool pass the same authorizer.
  }
}
