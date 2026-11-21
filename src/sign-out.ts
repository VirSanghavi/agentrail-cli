import {
  deleteCredential,
  loadCredential,
  type Credential,
  type Removal,
} from './credentials.js';
import { discoverSignIn } from './discovery.js';
import type { Environment } from './environments.js';
import { causeOf, CliError } from './errors.js';
import type { Runtime } from './runtime.js';
import { replaceSignIns, signInsToReplace } from './sign-ins.js';
import { revokeToken } from './tokens.js';

/** What `logout` did. */
export interface SignOut {
  /** The browser sign-in's removal. */
  readonly browser: Removal;
  /** How many sign-ins made by switching organization were removed. */
  readonly switched: number;
  /** How many sign-ins Agentrail ended. */
  readonly ended: number;
  /** Why some could not be ended, when some could not. */
  readonly endFailure: string | undefined;
}

/** The credential, or undefined where it cannot be read: removing it still is. */
async function readable(
  runtime: Runtime,
  environment: Environment,
  organizationId: string | undefined,
): Promise<Credential | undefined> {
  try {
    return (await loadCredential(runtime, environment, organizationId))
      ?.credential;
  } catch (error) {
    // Cut short, edited by hand, or in a keychain that cannot be asked: its
    // removal below reports the keychain.
    if (error instanceof CliError) return undefined;
    throw error;
  }
}

/** Ends each sign-in at Agentrail (RFC 7009), so a copy of its token is worth nothing. */
async function endAll(
  runtime: Runtime,
  environment: Environment,
  credentials: readonly Credential[],
): Promise<{ ended: number; failure: string | undefined }> {
  if (credentials.length === 0) return { ended: 0, failure: undefined };
  let ended = 0;
  try {
    const { revocationEndpoint } = await discoverSignIn(
      runtime,
      environment.mcpUrl,
    );
    // WorkOS's AuthKit offers none: its sign-ins end when disconnected in
    // Agentrail's Settings.
    if (revocationEndpoint === undefined) return { ended, failure: undefined };
    for (const credential of credentials) {
      const refresh = credential.refreshToken;
      await revokeToken(runtime, revocationEndpoint, {
        token: refresh ?? credential.accessToken,
        token_type_hint:
          refresh === undefined ? 'access_token' : 'refresh_token',
        client_id: credential.clientId,
      });
      ended += 1;
    }
    return { ended, failure: undefined };
  } catch (error) {
    if (error instanceof CliError) return { ended, failure: causeOf(error) };
    throw error;
  }
}

/**
 * Signs out of an environment: ends each of its sign-ins at Agentrail, the
 * browser one and each made by switching organization, then removes them
 * from this computer whether or not Agentrail could be reached. The
 * workspace chosen in each organization stays.
 */
export async function signOut(
  runtime: Runtime,
  environment: Environment,
): Promise<SignOut> {
  const signIns = await signInsToReplace(runtime, environment);
  const organizations = [
    undefined,
    ...signIns.switched.map((organization) => organization.id),
  ];
  const credentials: Credential[] = [];
  for (const organizationId of organizations) {
    const credential = await readable(runtime, environment, organizationId);
    if (credential !== undefined) credentials.push(credential);
  }
  const { ended, failure } = await endAll(runtime, environment, credentials);

  const browser = await deleteCredential(runtime, environment);
  let switched = 0;
  for (const organization of signIns.switched) {
    const removal = await deleteCredential(
      runtime,
      environment,
      organization.id,
    );
    if (removal.file || removal.keychain) switched += 1;
  }
  await replaceSignIns(runtime, environment, {
    browser: null,
    active: null,
    switched: [],
    workspaces: signIns.workspaces,
  });
  return { browser, switched, ended, endFailure: failure };
}
