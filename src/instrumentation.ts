import { instrumentCli, type CliSdk } from 'agentrail-cli-sdk';

import type { Environments } from './environments.js';
import { VERSION } from './version.js';

/**
 * Agentrail's own CLI SDK in the CLI: each request to an Agentrail MCP
 * server says which command ran, in which run and in which of an agent's
 * sessions, so Agentrail can join an agent's CLI runs into its journey
 * (`x-agentrail-cli`). Nothing goes anywhere but those servers, which with
 * Agentrail's own sign-in include its sign-in endpoints: never WorkOS's sign-in
 * pages or npm. `DO_NOT_TRACK` turns it off.
 */
export function instrument(
  environments: Environments,
  env: Readonly<Record<string, string | undefined>>,
  onError: (error: Error) => void,
): CliSdk {
  return instrumentCli({
    name: 'agentrail',
    version: VERSION,
    origins: [
      ...new Set(
        Object.values(environments).map(
          (environment) => new URL(environment.mcpUrl).origin,
        ),
      ),
    ],
    // The CLI puts the header on its own requests (`withHeaders`), so a test's
    // fetch sees it as the server would; the SDK still takes it off a
    // request redirected to any other origin.
    watchRequests: false,
    env,
    onError,
  });
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

/** `fetch`, with the CLI's header on each request to an Agentrail MCP server. */
export function withHeaders(
  base: typeof fetch,
  agentrail: CliSdk,
): typeof fetch {
  return (input, init) => {
    const added = agentrail.headers(urlOf(input));
    if (Object.keys(added).length === 0) return base(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    for (const [name, value] of Object.entries(added)) headers.set(name, value);
    return base(input, { ...init, headers });
  };
}
