import type { Command } from 'commander';

import { forgetCatalog } from './catalog.js';
import { commandFor } from './credentials.js';
import type { Environment } from './environments.js';
import { CliError, EXIT } from './errors.js';
import { withServer } from './mcp.js';
import {
  activeOrganization,
  listOrganizations,
  recordBrowserOrganization,
  switchOrganization,
  type ListedOrganization,
} from './organizations.js';
import { outputMode, printData, say } from './output.js';
import type { Runtime } from './runtime.js';
import { loadSignIns, saveSignIns, type Named } from './sign-ins.js';
import { everyWorkspace, workspaceChoice } from './workspace.js';

/**
 * `org use|current` and `workspace use|current`: which organization and
 * which workspace commands act in, chosen once and kept, as Render's CLI
 * does. Each organization has a sign-in of its own, made from the browser
 * sign-in without a browser.
 */

interface Context {
  readonly runtime: Runtime;
  readonly environmentOf: (command: Command) => Environment;
  readonly json: (command: Command) => boolean;
}

/** `wanted` by id, else by exact name; undefined when none is. */
function findNamed<T extends Named>(
  items: readonly T[],
  wanted: string,
  what: string,
  command: string,
): T | undefined {
  const byId = items.find((item) => item.id === wanted);
  if (byId !== undefined) return byId;
  const byName = items.filter((item) => item.name === wanted);
  if (byName.length > 1) {
    throw new CliError(
      EXIT.usage,
      `${String(byName.length)} ${what}s are named "${wanted}". Name one by its id: ${byName.map((item) => `${command} ${item.id}`).join(', ')}.`,
    );
  }
  return byName[0];
}

/** Each item on a line, for a message that lists them. */
function listing<T extends Named>(
  items: readonly T[],
  unavailable: (item: T) => string | undefined,
): string {
  return items
    .map((item) => {
      const reason = unavailable(item);
      return `  ${item.name} (${item.id})${reason === undefined ? '' : `: ${reason}`}`;
    })
    .join('\n');
}

/**
 * The item the person picks in a terminal. Without one the CLI never
 * prompts: it is a usage error that lists what could be named.
 */
async function pick<T extends Named>(
  runtime: Runtime,
  items: readonly T[],
  options: {
    readonly question: string;
    readonly command: string;
    readonly what: string;
    readonly unavailable: (item: T) => string | undefined;
  },
): Promise<T> {
  if (!runtime.stdinIsTTY) {
    throw new CliError(
      EXIT.usage,
      `Name the ${options.what}: ${options.command} <id or name>. Yours:\n${listing(items, options.unavailable)}`,
    );
  }
  const index = await runtime.choose(
    options.question,
    items.map((item) => ({
      label: item.name,
      unavailable: options.unavailable(item),
    })),
  );
  const chosen = items[index];
  if (chosen === undefined) throw new Error(`no choice ${String(index)}`);
  return chosen;
}

/** A token handed in acts in its own organization, and nothing switches it. */
function refuseGivenToken(runtime: Runtime, instead: string): void {
  if (runtime.env.AGENTRAIL_TOKEN) {
    throw new CliError(
      EXIT.usage,
      `AGENTRAIL_TOKEN is set, and commands use it in its own organization. ${instead}`,
    );
  }
}

const AGENT_ACCESS_OFF = 'agent access is off';

function addOrganizationCommands(program: Command, context: Context): void {
  const { runtime } = context;
  const org = program
    .command('org')
    .description('The organization commands act in.');

  org
    .command('use')
    .description(
      'Act in another of your organizations. Signs in to it from your browser sign-in, with no browser.',
    )
    .argument(
      '[organization]',
      'Its id or exact name; agentrail organizations list shows them.',
    )
    .action(
      async (wanted: string | undefined, _options: unknown, self: Command) => {
        const environment = context.environmentOf(self);
        refuseGivenToken(runtime, 'Unset it to switch organization.');
        const use = commandFor(environment, 'org use');
        let listed: ListedOrganization[] | undefined;
        const listOnce = async () => {
          if (listed === undefined) {
            listed = await withServer(
              runtime,
              environment,
              listOrganizations,
              'browser',
            );
            await recordBrowserOrganization(runtime, environment, listed);
          }
          return listed;
        };
        // After a login the CLI has not yet asked which organization the
        // browser sign-in acts in. It is asked first, so a sign-in kept from
        // switching to that same organization never wins over the new one.
        if ((await loadSignIns(runtime, environment)).browser === null) {
          await listOnce();
        }
        const signIns = await loadSignIns(runtime, environment);
        const { browser } = signIns;
        const kept = [
          ...(browser === null ? [] : [browser]),
          ...signIns.switched.filter((one) => one.id !== browser?.id),
        ];
        // An organization with a kept sign-in is switched to with no request.
        let target: Named | undefined =
          wanted === undefined
            ? undefined
            : findNamed(kept, wanted, 'organization', use);
        if (target === undefined) {
          const organizations = await listOnce();
          const unavailable = (one: ListedOrganization) =>
            one.agentAccess ? undefined : AGENT_ACCESS_OFF;
          const listed =
            wanted === undefined
              ? await pick(runtime, organizations, {
                  question: 'Which organization should commands act in?',
                  command: use,
                  what: 'organization',
                  unavailable,
                })
              : findNamed(organizations, wanted, 'organization', use);
          if (listed === undefined) {
            throw new CliError(
              EXIT.refused,
              `"${wanted ?? ''}" is none of your organizations in Agentrail ${environment.name}. Yours:\n${listing(organizations, unavailable)}`,
            );
          }
          if (!listed.agentAccess) {
            throw new CliError(
              EXIT.refused,
              `Agent access is off for ${listed.name}, so the CLI cannot act there. Ask an Admin there to turn it back on.`,
            );
          }
          target = listed;
        }
        const switched = await switchOrganization(runtime, environment, target);
        await forgetCatalog(runtime, environment);
        say(
          runtime,
          switched === 'already'
            ? `Commands already act in ${target.name} in Agentrail ${environment.name}.`
            : `Commands now act in ${target.name} in Agentrail ${environment.name}.`,
        );
      },
    );

  org
    .command('current')
    .description('Show the organization commands act in.')
    .action(async (_options: unknown, self: Command) => {
      const environment = context.environmentOf(self);
      const organization = runtime.env.AGENTRAIL_TOKEN
        ? (await withServer(runtime, environment, listOrganizations)).find(
            (one) => one.current,
          )
        : await activeOrganization(runtime, environment);
      if (organization === undefined) {
        throw new Error('organizations_list marked no organization current');
      }
      say(
        runtime,
        `Commands act in ${organization.name} in Agentrail ${environment.name}.`,
      );
      printData(runtime, outputMode(runtime, context.json(self)), {
        environment: environment.name,
        organizationId: organization.id,
        organizationName: organization.name,
      });
    });
}

function addWorkspaceCommands(program: Command, context: Context): void {
  const { runtime } = context;
  const workspace = program
    .command('workspace')
    .description('The workspace commands act in, kept for each organization.');

  workspace
    .command('use')
    .description(
      'Act in a workspace of the current organization, wherever no --workspace, AGENTRAIL_WORKSPACE or directory link names another.',
    )
    .argument(
      '[workspace]',
      'Its id or exact name; agentrail workspaces list shows them.',
    )
    .action(
      async (wanted: string | undefined, _options: unknown, self: Command) => {
        const environment = context.environmentOf(self);
        refuseGivenToken(
          runtime,
          'Pass --workspace or set AGENTRAIL_WORKSPACE with it instead.',
        );
        const use = commandFor(environment, 'workspace use');
        const organization = await activeOrganization(runtime, environment);
        const { workspaces } = await withServer(
          runtime,
          environment,
          everyWorkspace,
        );
        const chosen =
          wanted === undefined
            ? await pick(runtime, workspaces, {
                question: `Which workspace of ${organization.name} should commands act in?`,
                command: use,
                what: 'workspace',
                unavailable: () => undefined,
              })
            : findNamed(workspaces, wanted, 'workspace', use);
        if (chosen === undefined) {
          throw new CliError(
            EXIT.refused,
            `"${wanted ?? ''}" is no workspace of ${organization.name}. Its workspaces:\n${listing(workspaces, () => undefined)}`,
          );
        }
        const signIns = await loadSignIns(runtime, environment);
        await saveSignIns(runtime, environment, {
          ...signIns,
          workspaces: {
            ...signIns.workspaces,
            [organization.id]: { id: chosen.id, name: chosen.name },
          },
        });
        say(
          runtime,
          `Commands in ${organization.name} now act in the workspace ${chosen.name} in Agentrail ${environment.name}, unless --workspace, AGENTRAIL_WORKSPACE or a directory's link names another.`,
        );
      },
    );

  workspace
    .command('current')
    .description('Show the workspace commands act in, and why.')
    .action(async (_options: unknown, self: Command) => {
      const environment = context.environmentOf(self);
      const flag = self.optsWithGlobals<{ workspace?: string }>().workspace;
      const choice = await workspaceChoice(runtime, environment, flag);
      const { workspaces, defaultWorkspaceId } = await withServer(
        runtime,
        environment,
        everyWorkspace,
      );
      const workspaceId = choice?.workspaceId ?? defaultWorkspaceId;
      const name =
        workspaces.find((one) => one.id === workspaceId)?.name ?? null;
      const source = choice?.source;
      const why =
        source === undefined
          ? 'your default workspace'
          : source.from === 'link'
            ? `linked at ${source.path}`
            : source.from === 'workspace use'
              ? `chosen with agentrail workspace use for ${source.organization.name}`
              : `from ${source.from}`;
      say(
        runtime,
        `Commands act in ${name ?? workspaceId} in Agentrail ${environment.name}: ${why}.`,
      );
      printData(runtime, outputMode(runtime, context.json(self)), {
        environment: environment.name,
        workspaceId,
        workspaceName: name,
        from: source?.from ?? 'default',
        ...(source?.from === 'link' ? { path: source.path } : {}),
      });
    });
}

export function addSwitchCommands(program: Command, context: Context): void {
  addOrganizationCommands(program, context);
  addWorkspaceCommands(program, context);
}
