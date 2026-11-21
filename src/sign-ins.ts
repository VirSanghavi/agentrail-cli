import { join } from 'node:path';

import { commandFor } from './credentials.js';
import type { Environment } from './environments.js';
import { CliError, EXIT } from './errors.js';
import { readJson, removeFile, writePrivateJson } from './files.js';
import type { Runtime } from './runtime.js';

/** An organization or a workspace, as the CLI remembers it: id and name. */
export interface Named {
  readonly id: string;
  readonly name: string;
}

/**
 * What the CLI keeps about an environment's sign-ins besides their tokens.
 * Each organization has a sign-in of its own (Agentrail's sign-in server
 * authorizes one organization at a time): the one the person approved in
 * the browser, and one for each organization the CLI switched to from it.
 */
export interface SignIns {
  /** The organization the browser sign-in acts in, once the CLI has asked; each login forgets it. */
  readonly browser: Named | null;
  /** The organization commands act in; null for the browser sign-in's. */
  readonly active: string | null;
  /** Each organization with a sign-in made by switching to it. */
  readonly switched: readonly Named[];
  /** The workspace `workspace use` chose in each organization, by organization id. */
  readonly workspaces: Readonly<Record<string, Named>>;
}

export const NO_SIGN_INS: SignIns = {
  browser: null,
  active: null,
  switched: [],
  workspaces: {},
};

function signInsPath(runtime: Runtime, environment: Environment): string {
  return join(runtime.configDir, 'sign-ins', `${environment.name}.json`);
}

function isNamed(value: unknown): value is Named {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.name === 'string';
}

function isSignIns(value: unknown): value is SignIns {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const workspaces = record.workspaces;
  const switched = record.switched;
  return (
    (record.browser === null || isNamed(record.browser)) &&
    Array.isArray(switched) &&
    (switched as unknown[]).every(isNamed) &&
    // The active organization is the browser sign-in's, or one switched to.
    (record.active === null ||
      (switched as Named[]).some((one) => one.id === record.active)) &&
    typeof workspaces === 'object' &&
    workspaces !== null &&
    Object.values(workspaces).every(isNamed)
  );
}

/** The file as written, or undefined when it is not one this CLI wrote. */
async function readSignIns(
  runtime: Runtime,
  environment: Environment,
): Promise<SignIns | undefined> {
  let value: unknown;
  try {
    value = await readJson(signInsPath(runtime, environment));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (value === undefined) return NO_SIGN_INS;
  return isSignIns(value) ? value : undefined;
}

/** The environment's sign-ins; a file cut short or edited by hand is named. */
export async function loadSignIns(
  runtime: Runtime,
  environment: Environment,
): Promise<SignIns> {
  const signIns = await readSignIns(runtime, environment);
  if (signIns === undefined) {
    throw new CliError(
      EXIT.signIn,
      `${signInsPath(runtime, environment)} is not one this CLI wrote. Run ${commandFor(environment, 'login')} to replace it.`,
    );
  }
  return signIns;
}

/**
 * The sign-ins, for the commands that replace or remove them: one this CLI
 * cannot read counts as none, so `login` and `logout` still work.
 */
export async function signInsToReplace(
  runtime: Runtime,
  environment: Environment,
): Promise<SignIns> {
  return (await readSignIns(runtime, environment)) ?? NO_SIGN_INS;
}

export async function saveSignIns(
  runtime: Runtime,
  environment: Environment,
  signIns: SignIns,
): Promise<void> {
  await writePrivateJson(signInsPath(runtime, environment), signIns);
}

/** Saves the sign-ins, or removes the file when nothing in it is left to keep. */
export async function replaceSignIns(
  runtime: Runtime,
  environment: Environment,
  signIns: SignIns,
): Promise<void> {
  const empty =
    signIns.browser === null &&
    signIns.switched.length === 0 &&
    Object.keys(signIns.workspaces).length === 0;
  if (empty) await removeFile(signInsPath(runtime, environment));
  else await saveSignIns(runtime, environment, signIns);
}

/** The organization commands act in, when the CLI knows it without asking. */
export function activeOrganizationId(signIns: SignIns): string | undefined {
  return signIns.active ?? signIns.browser?.id;
}
