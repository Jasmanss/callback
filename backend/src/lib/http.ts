import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

/**
 * Small HTTP helpers shared by every API handler.
 *
 * Auth note: identity comes ONLY from the JWT authorizer that API Gateway
 * runs before the Lambda is invoked. By the time a handler executes, the
 * token signature/expiry/audience have already been verified against the
 * Cognito user pool, so handlers just read the verified `sub` claim. There
 * is deliberately no second auth system and no trusting of user ids sent
 * in request bodies.
 */

export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;
export type ApiResult = APIGatewayProxyResultV2;

/** The verified Cognito user id, or null when the claim is missing. */
export function userIdOf(event: ApiEvent): string | null {
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}

export function json(statusCode: number, body: unknown): ApiResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const unauthorized = () => json(401, { error: 'Not signed in.' });
export const badRequest = (message: string) => json(400, { error: message });

/** Parses a JSON body (base64-aware); null on anything malformed. */
export function parseBody<T>(event: ApiEvent): T | null {
  if (!event.body) return null;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const data: unknown = JSON.parse(raw);
    return data && typeof data === 'object' ? (data as T) : null;
  } catch {
    return null;
  }
}
