import {
  commandFor,
  loadCredential,
  saveCredential,
  type Credential,
} from './credentials.js';
import type { Environment } from './environments.js';
import { CliError, EXIT } from './errors.js';
import { withLock } from './lock.js';
import type { Runtime } from './runtime.js';
import { loadSignIns } from './sign-ins.js';
import { credentialFrom, requestTokens } from './tokens.js';

/** Refreshed this long before it expires, so a call never starts stale. */
const REFRESH_MARGIN_MS = 60_000;
/** How long a refresh that lost a race waits for the winner's sign-in. */
const RACE_CHECKS = 5;
const RACE_CHECK_EVERY_MS = 200;

/**
 * Which sign-in a command uses: the one for the organization commands act
 * in, or the one the person approved in the browser, which alone may switch
 * organization.
 */
export type SignInUse = 'active' | 'browser';

/** The lock a sign-in's refresh token is used under (`lock.ts`). */
export function lockOf(
  environment: Environment,
  organizationId: string | undefined,
): string {
  return organizationId === undefined
    ? environment.name
    : `${environment.name}-${organizationId}`;
}

function fresh(runtime: Runtime, credential: Credential): boolean {
  const expiresAt = new Date(credential.expiresAt).getTime();
  return expiresAt - runtime.now().getTime() > REFRESH_MARGIN_MS;
}

/**
 * The sign-in a command that does not hold the lock stored after refreshing
 * with `spent` first: a CLI before 0.2 refreshes without it. That command
 * stores it once its own answer arrives, which can be a moment after this
 * one's, so the store is read again for a second before giving up.
 */
async function refreshedElsewhere(
  runtime: Runtime,
  environment: Environment,
  organizationId: string | undefined,
  spent: string,
): Promise<Credential | undefined> {
  for (let check = 1; ; check += 1) {
    const stored = await loadCredential(runtime, environment, organizationId);
    if (stored !== undefined && stored.credential.refreshToken !== spent) {
      return stored.credential;
    }
    if (check === RACE_CHECKS) return undefined;
    await runtime.sleep(RACE_CHECK_EVERY_MS);
  }
}

/** Refreshes a stored sign-in, holding its lock. */
async function refresh(
  runtime: Runtime,
  environment: Environment,
  organizationId: string | undefined,
): Promise<string> {
  const login = commandFor(environment, 'login');
  return withLock(runtime, lockOf(environment, organizationId), async () => {
    // Another command may have refreshed it while this one waited.
    const stored = await loadCredential(runtime, environment, organizationId);
    if (!stored) {
      throw new CliError(
        EXIT.signIn,
        `Not signed in to Agentrail ${environment.name}. Run ${login}.`,
      );
    }
    const { credential, storage } = stored;
    if (fresh(runtime, credential)) return credential.accessToken;
    if (credential.refreshToken === undefined) {
      throw new CliError(
        EXIT.signIn,
        `Your sign-in to ${environment.name} expired. Run ${login}.`,
      );
    }
    const answer = await requestTokens(runtime, credential.tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: credential.clientId,
      resource: credential.resource,
    });
    if (answer.kind === 'error') {
      // Another command refreshed first: each refresh token is accepted
      // once, so this one is spent, and the sign-in that command stored is
      // fresh.
      if (answer.error === 'invalid_grant') {
        const other = await refreshedElsewhere(
          runtime,
          environment,
          organizationId,
          credential.refreshToken,
        );
        if (other !== undefined) return other.accessToken;
      }
      throw new CliError(
        EXIT.signIn,
        `Your sign-in to ${environment.name} expired (${answer.error}). Run ${login}.`,
      );
    }
    // RFC 6749 §6: a new refresh token replaces the old one; without one,
    // the old one stays good.
    const tokens = {
      ...answer,
      refreshToken: answer.refreshToken ?? credential.refreshToken,
    };
    const refreshed = credentialFrom(runtime, tokens, {
      environment: environment.name,
      tokenEndpoint: credential.tokenEndpoint,
      clientId: credential.clientId,
      resource: credential.resource,
      email: credential.email,
    });
    await saveCredential(
      runtime,
      environment,
      refreshed,
      storage,
      organizationId,
    );
    return refreshed.accessToken;
  });
}

/**
 * The access token for a command. `AGENTRAIL_TOKEN` wins and is never
 * written anywhere (CLI-007); otherwise the stored sign-in for the
 * organization commands act in, refreshed when it is about to expire.
 */
export async function accessToken(
  runtime: Runtime,
  environment: Environment,
  use: SignInUse = 'active',
): Promise<string> {
  const given = runtime.env.AGENTRAIL_TOKEN;
  if (given) return given;

  const signIns = await loadSignIns(runtime, environment);
  const organizationId =
    use === 'active' ? (signIns.active ?? undefined) : undefined;
  const stored = await loadCredential(runtime, environment, organizationId);
  if (!stored) {
    if (organizationId !== undefined) {
      const name =
        signIns.switched.find((one) => one.id === organizationId)?.name ??
        organizationId;
      throw new CliError(
        EXIT.signIn,
        `Not signed in to ${name} in Agentrail ${environment.name}. Run ${commandFor(environment, `org use ${organizationId}`)} to switch to it again, or ${commandFor(environment, 'login')}.`,
      );
    }
    throw new CliError(
      EXIT.signIn,
      `Not signed in to Agentrail ${environment.name}. Run ${commandFor(environment, 'login')}.`,
    );
  }
  if (fresh(runtime, stored.credential)) return stored.credential.accessToken;
  return refresh(runtime, environment, organizationId);
}
