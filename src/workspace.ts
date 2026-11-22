import { dirname, join } from 'node:path';

import {
  ENVIRONMENT_NAMES,
  type Environment,
  type EnvironmentName,
} from './environments.js';
import { CliError, EXIT } from './errors.js';
import { readJson, removeFile, writePrivateJson } from './files.js';
import type { Connection } from './mcp.js';
import { activeOrganization } from './organizations.js';
import type { Runtime } from './runtime.js';
import { loadSignIns, type Named } from './sign-ins.js';

/** What `agentrail link` records for a directory and those under it. */
export interface Link {
  readonly environment: EnvironmentName;
  readonly workspaceId: string;
  readonly workspaceName: string;
}

const LINK_FILE = join('.agentrail', 'link.json');

function isLink(value: unknown): value is Link {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (ENVIRONMENT_NAMES as readonly unknown[]).includes(record.environment) &&
    typeof record.workspaceId === 'string' &&
    typeof record.workspaceName === 'string'
  );
}

/**
 * The nearest link file at or above a directory, read or not: `unlink` must
 * be able to remove one cut short or edited by hand.
 */
export async function findLinkFile(
  from: string,
): Promise<{ path: string; value: unknown } | undefined> {
  for (let directory = from; ; directory = dirname(directory)) {
    const path = join(directory, LINK_FILE);
    try {
      const value = await readJson(path);
      if (value !== undefined) return { path, value };
    } catch (error) {
      // There, but not JSON: no value read from it.
      if (error instanceof SyntaxError) return { path, value: undefined };
      throw error;
    }
    if (dirname(directory) === directory) return undefined;
  }
}

/** The nearest link at or above a directory; one this CLI cannot read is named. */
export async function findLink(
  from: string,
): Promise<{ link: Link; path: string } | undefined> {
  const found = await findLinkFile(from);
  if (found === undefined) return undefined;
  if (!isLink(found.value)) {
    throw new CliError(
      EXIT.usage,
      `${found.path} is not a link this CLI wrote. Run agentrail unlink to remove it, or agentrail link <workspaceId> to replace it.`,
    );
  }
  return { link: found.value, path: found.path };
}

export async function writeLink(cwd: string, link: Link): Promise<string> {
  const path = join(cwd, LINK_FILE);
  await writePrivateJson(path, link);
  return path;
}

export async function removeLink(path: string): Promise<void> {
  await removeFile(path);
}

/** Where the workspace a command acts in came from. */
export type WorkspaceSource =
  | { readonly from: '--workspace' | 'AGENTRAIL_WORKSPACE' }
  | { readonly from: 'link'; readonly path: string }
  | { readonly from: 'workspace use'; readonly organization: Named };

/**
 * The workspace a command acts in (CLI-006): `--workspace`, then
 * `AGENTRAIL_WORKSPACE`, then the directory's link for this environment,
 * then the one `workspace use` chose for the organization commands act in.
 * Undefined leaves it to the server, which uses the caller's default.
 */
export async function workspaceChoice(
  runtime: Runtime,
  environment: Environment,
  flag: string | undefined,
): Promise<
  { readonly workspaceId: string; readonly source: WorkspaceSource } | undefined
> {
  if (flag !== undefined) {
    return { workspaceId: flag, source: { from: '--workspace' } };
  }
  const variable = runtime.env.AGENTRAIL_WORKSPACE;
  if (variable) {
    return { workspaceId: variable, source: { from: 'AGENTRAIL_WORKSPACE' } };
  }
  const found = await findLink(runtime.cwd);
  if (found?.link.environment === environment.name) {
    return {
      workspaceId: found.link.workspaceId,
      source: { from: 'link', path: found.path },
    };
  }
  // A token handed in acts in its own organization, which the CLI does not
  // know without asking.
  if (runtime.env.AGENTRAIL_TOKEN) return undefined;
  const signIns = await loadSignIns(runtime, environment);
  if (Object.keys(signIns.workspaces).length === 0) return undefined;
  const organization = await activeOrganization(runtime, environment);
  const chosen = signIns.workspaces[organization.id];
  return chosen === undefined
    ? undefined
    : {
        workspaceId: chosen.id,
        source: { from: 'workspace use', organization },
      };
}

export async function workspaceFor(
  runtime: Runtime,
  environment: Environment,
  flag: string | undefined,
): Promise<string | undefined> {
  return (await workspaceChoice(runtime, environment, flag))?.workspaceId;
}

/** Every workspace of the organization the connection acts in, and its default. */
export async function everyWorkspace(
  server: Connection,
): Promise<{ workspaces: Named[]; defaultWorkspaceId: string }> {
  const workspaces: Named[] = [];
  let defaultWorkspaceId = '';
  let cursor: string | undefined;
  do {
    const reply = await server.callTool('workspaces_list', {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (reply.kind === 'refused') {
      throw new CliError(EXIT.refused, reply.message);
    }
    const page = reply.data as {
      items: Named[];
      nextCursor: string | null;
      defaultWorkspaceId: string;
    };
    workspaces.push(...page.items.map(({ id, name }) => ({ id, name })));
    defaultWorkspaceId = page.defaultWorkspaceId;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return { workspaces, defaultWorkspaceId };
}
