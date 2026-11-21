import {
  deleteCredential,
  loadCredential,
  type Credential,
  type Removal,
} from './credentials.js';
import { discoverSignIn } from './discovery.js';
import type { Environment } from './environments.js';
import { CliError } from './errors.js';
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
  /** The organizations whose sign-ins Agentrail could not be told to end, and why. */
  readonly notEnded:
    | { readonly organizations: readonly string[]; readonly reason: string }
    | undefined;
}

/** A sign-in to end, with the organization it acts in as the person knows it. */
interface ToEnd {
  readonly organization: string;
  readonly credential: Credential;
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

/**
 * Ends each sign-in at Agentrail (RFC 7009), so a copy of its token is worth
 * nothing. Each is tried, whatever happened to the one before.
 */
async function endAll(
  runtime: Runtime,
  environment: Environment,
  toEnd: readonly ToEnd[],
): Promise<Pick<SignOut, 'ended' | 'notEnded'>> {
  if (toEnd.length === 0) return { ended: 0, notEnded: undefined };
  let revocationEndpoint: string | undefined;
  try {
    ({ revocationEndpoint } = await discoverSignIn(
      runtime,
      environment.mcpUrl,
    ));
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return {
      ended: 0,
      notEnded: {
        organizations: toEnd.map((one) => one.organization),
        reason: error.message,
      },
    };
  }
  // RFC 8414 makes revocation optional: a server without it ends a sign-in
  // when the CLI is disconnected in Agentrail's Settings.
  if (revocationEndpoint === undefined)
    return { ended: 0, notEnded: undefined };
  let ended = 0;
  const failed: string[] = [];
  let reason: string | undefined;
  for (const { organization, credential } of toEnd) {
    const refresh = credential.refreshToken;
    try {
      await revokeToken(runtime, revocationEndpoint, {
        token: refresh ?? credential.accessToken,
        token_type_hint:
          refresh === undefined ? 'access_token' : 'refresh_token',
        client_id: credential.clientId,
      });
      ended += 1;
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      failed.push(organization);
      reason ??= error.message;
    }
  }
  return {
    ended,
    notEnded:
      reason === undefined ? undefined : { organizations: failed, reason },
  };
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
    {
      id: undefined,
      name:
        signIns.browser?.name ??
        'the organization you approved in your browser',
    },
    ...signIns.switched,
  ];
  const toEnd: ToEnd[] = [];
  for (const { id, name } of organizations) {
    const credential = await readable(runtime, environment, id);
    if (credential !== undefined)
      toEnd.push({ organization: name, credential });
  }
  const { ended, notEnded } = await endAll(runtime, environment, toEnd);

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
  return { browser, switched, ended, notEnded };
}
