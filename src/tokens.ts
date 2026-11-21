import type { Credential } from './credentials.js';
import type { EnvironmentName } from './environments.js';
import { CliError, EXIT } from './errors.js';
import { jsonObjectOf, send } from './http.js';
import type { Runtime } from './runtime.js';

/** A token endpoint's answer (RFC 6749 §5), success or error. */
export type TokenAnswer =
  | {
      readonly kind: 'tokens';
      readonly accessToken: string;
      readonly refreshToken: string | undefined;
      readonly expiresInSeconds: number;
      readonly idToken: string | undefined;
    }
  | {
      readonly kind: 'error';
      readonly error: string;
      /** The server's words for it, when it gave some (RFC 6749 §5.2). */
      readonly description: string | undefined;
    }
  /**
   * Nothing answers there any more (404 with no OAuth error): the
   * environment moved to another sign-in server, as when Agentrail's own is
   * switched back to WorkOS's, and a sign-in made at the old one has ended.
   */
  | { readonly kind: 'gone' };

/**
 * POSTs a form to an OAuth endpoint and returns its JSON object. OAuth errors
 * come back as JSON too (RFC 6749 §5.2); any other answer is exit code 4.
 */
export async function postForm(
  runtime: Runtime,
  url: string,
  form: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const answer = await send(runtime, url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });
  return { status: answer.status, body: jsonObjectOf(url, answer) };
}

export async function requestTokens(
  runtime: Runtime,
  tokenEndpoint: string,
  form: Record<string, string>,
): Promise<TokenAnswer> {
  const { status, body } = await postForm(runtime, tokenEndpoint, form);
  if (status === 404 && body.error === undefined) return { kind: 'gone' };
  if (typeof body.error === 'string') {
    return {
      kind: 'error',
      error: body.error,
      description:
        typeof body.error_description === 'string'
          ? body.error_description
          : undefined,
    };
  }
  if (
    status !== 200 ||
    typeof body.access_token !== 'string' ||
    typeof body.expires_in !== 'number'
  ) {
    throw new CliError(
      EXIT.unavailable,
      `${tokenEndpoint} answered ${status} without tokens.`,
    );
  }
  return {
    kind: 'tokens',
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresInSeconds: body.expires_in,
    idToken: typeof body.id_token === 'string' ? body.id_token : undefined,
  };
}

/**
 * Ends a sign-in at the authorization server (RFC 7009). Agentrail ends the
 * whole sign-in its token belongs to. Answers 200 for a token it no longer
 * knows, so only another answer is a failure.
 */
export async function revokeToken(
  runtime: Runtime,
  revocationEndpoint: string,
  form: { token: string; token_type_hint: string; client_id: string },
): Promise<void> {
  const answer = await send(runtime, revocationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  if (!answer.ok) {
    throw new CliError(
      EXIT.unavailable,
      `${revocationEndpoint} answered ${String(answer.status)}.`,
    );
  }
}

/** The email an OpenID ID token names, for display only; never trusted. */
function emailOf(idToken: string | undefined): string | undefined {
  const payload = idToken?.split('.')[1];
  if (payload === undefined) return undefined;
  const claims = JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as { email?: unknown };
  return typeof claims.email === 'string' ? claims.email : undefined;
}

export function credentialFrom(
  runtime: Runtime,
  tokens: Extract<TokenAnswer, { kind: 'tokens' }>,
  context: {
    environment: EnvironmentName;
    tokenEndpoint: string;
    clientId: string;
    resource: string;
    email?: string | undefined;
  },
): Credential {
  return {
    environment: context.environment,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: new Date(
      runtime.now().getTime() + tokens.expiresInSeconds * 1_000,
    ).toISOString(),
    tokenEndpoint: context.tokenEndpoint,
    clientId: context.clientId,
    resource: context.resource,
    email: emailOf(tokens.idToken) ?? context.email,
  };
}
