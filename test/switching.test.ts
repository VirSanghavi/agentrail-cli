import { spawnSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Credential } from '../src/credentials.js';
import { run } from '../src/program.js';
import { writeLink } from '../src/workspace.js';
import {
  ACME,
  BETA,
  GAMMA,
  startFakeAgentrail,
  type FakeAgentrail,
} from './support/fake-agentrail.js';
import { memoryKeychain, testRuntime } from './support/test-runtime.js';

let agentrail: FakeAgentrail;
beforeEach(async () => {
  agentrail = await startFakeAgentrail();
});
afterEach(async () => {
  await agentrail.close();
});

const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';

/** One person's computer: each command a fresh process on the same files. */
async function computer(options: { fake?: FakeAgentrail } = {}) {
  const fake = options.fake ?? agentrail;
  const keychain = memoryKeychain();
  const first = await testRuntime({ mcpUrl: fake.mcpUrl, keychain });
  const { configDir } = first;
  const { cwd } = first.runtime;
  return {
    keychain,
    configDir,
    cwd,
    async run(
      argv: string[],
      more: {
        terminal?: boolean;
        picks?: string[];
        realSleep?: boolean;
        fetch?: typeof fetch;
        now?: () => Date;
      } = {},
    ) {
      const each = await testRuntime({
        mcpUrl: fake.mcpUrl,
        keychain,
        cwd,
        ...more,
      });
      const exitCode = await run({ ...each.runtime, configDir }, [
        '--env',
        'dev',
        ...argv,
      ]);
      return {
        exitCode,
        stdout: each.stdout(),
        stderr: each.stderr(),
        asked: each.asked,
      };
    },
    async login() {
      fake.deviceAnswers.push('tokens');
      const result = await this.run(['login'], { terminal: true });
      expect(result.exitCode, result.stderr).toBe(0);
    },
    /** Makes a stored sign-in due for refresh. */
    expire(account: string) {
      const credential = JSON.parse(
        keychain.get(account) ?? '{}',
      ) as Credential;
      keychain.set(
        account,
        JSON.stringify({ ...credential, expiresAt: new Date().toISOString() }),
      );
    },
  };
}

/** Ends a sign-in at the fake, as Agentrail does on disconnect or expiry. */
function endAt(fake: FakeAgentrail, ...tokens: string[]) {
  for (const token of tokens) {
    fake.accessTokens.delete(token);
    fake.refreshTokens.delete(token);
  }
}

/** A fetch that answers one path as `answer` does, and the rest for real. */
function answering(
  path: string,
  answer: () => Response | undefined,
): typeof fetch {
  return (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const given = new URL(url).pathname === path ? answer() : undefined;
    return given === undefined
      ? globalThis.fetch(input, init)
      : Promise.resolve(given);
  };
}

function forms(fake: FakeAgentrail, grant: string) {
  return fake.tokenRequests
    .filter((form) => form.get('grant_type') === grant)
    .map((form) => Object.fromEntries(form));
}

describe('switching organization', () => {
  // Fails if someone keeps WorkOS-shaped requests against Agentrail's own
  // sign-in server: the exchange's fields, the organization it names, or
  // commands still acting in the first organization after the switch.
  it('signs in, switches to another organization by exchange, and acts and refreshes there', async () => {
    const pc = await computer();
    await pc.login();

    const switched = await pc.run(['org', 'use', 'Beta']);
    expect(switched.exitCode, switched.stderr).toBe(0);
    expect(switched.stderr).toContain('Commands now act in Beta');
    expect(forms(agentrail, EXCHANGE)).toEqual([
      {
        grant_type: EXCHANGE,
        client_id: 'client_test',
        subject_token: 'refresh-1',
        subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
        organization: BETA,
        resource: agentrail.mcpUrl,
      },
    ]);
    expect(pc.keychain.get(`dev/${BETA}`)).toContain('access-2');

    expect((await pc.run(['competitors', 'list'])).exitCode).toBe(0);
    expect(agentrail.toolOrganizations.at(-1)).toBe(BETA);

    // Beta's own sign-in is refreshed with its own refresh token.
    const beta = JSON.parse(
      pc.keychain.get(`dev/${BETA}`) ?? '{}',
    ) as Credential;
    pc.keychain.set(
      `dev/${BETA}`,
      JSON.stringify({ ...beta, expiresAt: new Date().toISOString() }),
    );
    expect((await pc.run(['competitors', 'list'])).exitCode).toBe(0);
    expect(forms(agentrail, 'refresh_token')).toEqual([
      {
        grant_type: 'refresh_token',
        refresh_token: 'refresh-2',
        client_id: 'client_test',
        resource: agentrail.mcpUrl,
      },
    ]);
    expect(agentrail.toolOrganizations.at(-1)).toBe(BETA);

    const whoami = await pc.run(['whoami']);
    expect(JSON.parse(whoami.stdout)).toMatchObject({
      organizationId: BETA,
      organizationName: 'Beta',
      workspaceId: 'ws-beta',
    });
    const current = await pc.run(['org', 'current']);
    expect(JSON.parse(current.stdout)).toEqual({
      environment: 'dev',
      organizationId: BETA,
      organizationName: 'Beta',
    });

    // A new browser sign-in acts in the organization it approved, and
    // switching from it starts from there.
    agentrail.approveIn = GAMMA;
    await pc.login();
    expect((await pc.run(['competitors', 'list'])).exitCode).toBe(0);
    expect(agentrail.toolOrganizations.at(-1)).toBe(GAMMA);
    const acme = await pc.run(['org', 'use', 'Acme']);
    expect(acme.exitCode, acme.stderr).toBe(0);
    expect(forms(agentrail, EXCHANGE).at(-1)).toMatchObject({
      subject_token: 'refresh-4',
      organization: ACME,
    });
  });

  // Fails if someone switches from the sign-in commands use rather than the
  // browser one (Agentrail refuses a switch from a switched sign-in), or
  // asks Agentrail again for an organization the CLI already keeps a
  // sign-in for.
  it('switches only from the browser sign-in, and back to a kept one with no request', async () => {
    const pc = await computer();
    await pc.login();
    expect((await pc.run(['org', 'use', BETA])).exitCode).toBe(0);

    const gamma = await pc.run(['org', 'use', 'Gamma']);
    expect(gamma.exitCode, gamma.stderr).toBe(0);
    expect(
      forms(agentrail, EXCHANGE).map((form) => [
        form.subject_token,
        form.organization,
      ]),
    ).toEqual([
      ['refresh-1', BETA],
      ['refresh-1', GAMMA],
    ]);

    const requests = agentrail.tokenRequests.length;
    const calls = agentrail.toolCalls.length;
    for (const [wanted, name] of [
      ['Beta', 'Beta'],
      [ACME, 'Acme'],
      ['Gamma', 'Gamma'],
    ]) {
      const back = await pc.run(['org', 'use', wanted ?? '']);
      expect(back.exitCode, back.stderr).toBe(0);
      expect(back.stderr).toContain(`Commands now act in ${name ?? ''}`);
    }
    expect(agentrail.tokenRequests).toHaveLength(requests);
    expect(agentrail.toolCalls).toHaveLength(calls);

    expect((await pc.run(['competitors', 'list'])).exitCode).toBe(0);
    expect(agentrail.toolOrganizations.at(-1)).toBe(GAMMA);
  });

  // The CLI never prompts without a terminal, and an organization no agent
  // may act in cannot be chosen.
  it('lists organizations to name without a terminal, picks in one, and refuses one with agent access off', async () => {
    const pc = await computer();
    await pc.login();
    const gamma = agentrail.organizations.find((one) => one.id === GAMMA);
    if (gamma) gamma.agentAccess = false;

    const unnamed = await pc.run(['org', 'use']);
    expect(unnamed.exitCode).toBe(2);
    expect(unnamed.stderr).toContain(`Beta (${BETA})`);
    expect(unnamed.stderr).toContain(`Gamma (${GAMMA}): agent access is off`);

    const off = await pc.run(['org', 'use', 'Gamma']);
    expect(off.exitCode).toBe(1);
    expect(off.stderr).toContain('Agent access is off for Gamma');

    const picked = await pc.run(['org', 'use'], {
      terminal: true,
      picks: ['Beta'],
    });
    expect(picked.exitCode, picked.stderr).toBe(0);
    expect(picked.asked[0]?.labels).toEqual(['Acme', 'Beta', 'Gamma']);
    expect(forms(agentrail, EXCHANGE)).toHaveLength(1);
  });

  // A refused switch must say why, in Agentrail's words or as an ended
  // sign-in, and an environment still on WorkOS must say it cannot switch.
  it('says why a switch was refused', async () => {
    const pc = await computer();
    await pc.login();
    agentrail.refreshTokens.delete('refresh-1');
    const ended = await pc.run(['org', 'use', 'Beta']);
    expect(ended.exitCode).toBe(3);
    expect(ended.stderr).toContain(
      'Your sign-in to Agentrail dev has ended. Run agentrail login --env dev.',
    );

    const workos = await startFakeAgentrail({ signIn: 'workos' });
    try {
      const old = await computer({ fake: workos });
      await old.login();
      const refused = await old.run(['org', 'use', 'Beta']);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain(
        'Agentrail dev cannot switch organization yet. Run agentrail login --env dev and choose Beta in your browser.',
      );
      // WorkOS lists token exchange among its grants: the CLI decides from
      // where its sign-in came from, and sends WorkOS nothing to exchange.
      expect(forms(workos, EXCHANGE)).toEqual([]);
    } finally {
      await workos.close();
    }
  });
});

describe('a switched sign-in that has ended', () => {
  // Fails if someone keeps a switched sign-in Agentrail refused, at refresh
  // or on a request: `org use` would find it again, and every command fail.
  it('is forgotten, so org use signs in to that organization afresh', async () => {
    const pc = await computer();
    await pc.login();
    expect((await pc.run(['org', 'use', 'Beta'])).exitCode).toBe(0);

    // Ended at Agentrail, and due for refresh here.
    endAt(agentrail, 'access-2', 'refresh-2');
    pc.expire(`dev/${BETA}`);
    const refused = await pc.run(['competitors', 'list']);
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr).toContain(
      `Your sign-in to Beta in Agentrail dev expired (invalid_grant). Run agentrail org use ${BETA} --env dev to sign in to Beta again.`,
    );
    const again = await pc.run(['org', 'use', 'Beta']);
    expect(again.exitCode, again.stderr).toBe(0);
    expect(forms(agentrail, EXCHANGE)).toHaveLength(2);
    expect((await pc.run(['competitors', 'list'])).exitCode).toBe(0);
    expect(agentrail.toolOrganizations.at(-1)).toBe(BETA);

    // Ended at Agentrail while its access token still looks good here.
    endAt(agentrail, 'access-3', 'refresh-3');
    const unaccepted = await pc.run(['competitors', 'list']);
    expect(unaccepted.exitCode).toBe(3);
    expect(unaccepted.stderr).toContain(
      `Agentrail dev no longer accepts your sign-in to Beta. Run agentrail org use ${BETA} --env dev to sign in to Beta again.`,
    );
    expect((await pc.run(['org', 'use', 'Beta'])).exitCode).toBe(0);
    expect(forms(agentrail, EXCHANGE)).toHaveLength(3);
  });

  // Fails if someone counts a switched organization as already in use when
  // its sign-in is gone from this computer.
  it('is made again when it is gone from this computer', async () => {
    const pc = await computer();
    await pc.login();
    expect((await pc.run(['org', 'use', 'Beta'])).exitCode).toBe(0);
    pc.keychain.delete(`dev/${BETA}`);

    const back = await pc.run(['org', 'use', BETA]);
    expect(back.exitCode, back.stderr).toBe(0);
    expect(back.stderr).toContain('Commands now act in Beta');
    expect(forms(agentrail, EXCHANGE)).toHaveLength(2);
    expect((await pc.run(['competitors', 'list'])).exitCode).toBe(0);
    expect(agentrail.toolOrganizations.at(-1)).toBe(BETA);
  });

  // Fails if someone lets a sign-in kept from switching win over a newer
  // browser sign-in to the same organization.
  it('never wins over a browser sign-in to the same organization', async () => {
    const pc = await computer();
    await pc.login();
    expect((await pc.run(['org', 'use', 'Beta'])).exitCode).toBe(0);
    agentrail.approveIn = BETA;
    await pc.login();

    const beta = await pc.run(['org', 'use', 'Beta']);
    expect(beta.exitCode, beta.stderr).toBe(0);
    expect(beta.stderr).toContain('Commands already act in Beta');
    // The old switched sign-in ends; the browser one is what commands use.
    endAt(agentrail, 'access-2', 'refresh-2');
    expect((await pc.run(['competitors', 'list'])).exitCode).toBe(0);
    expect(agentrail.toolOrganizations.at(-1)).toBe(BETA);
  });
});

describe('the workspace commands act in', () => {
  // Fails if someone puts the chosen workspace before a directory's link,
  // or keeps one workspace for every organization.
  it('takes the one chosen for the organization, after the link, and none chosen for another', async () => {
    const pc = await computer();
    await pc.login();
    expect((await pc.run(['org', 'use', 'Beta'])).exitCode).toBe(0);

    const chose = await pc.run(['workspace', 'use', 'Beta docs']);
    expect(chose.exitCode, chose.stderr).toBe(0);
    expect((await pc.run(['competitors', 'list'])).exitCode).toBe(0);
    expect(agentrail.toolCalls.at(-1)?.input).toEqual({
      workspaceId: 'ws-beta-docs',
    });
    const current = await pc.run(['workspace', 'current']);
    expect(JSON.parse(current.stdout)).toEqual({
      environment: 'dev',
      workspaceId: 'ws-beta-docs',
      workspaceName: 'Beta docs',
      from: 'workspace use',
    });

    await writeLink(pc.cwd, {
      environment: 'dev',
      workspaceId: 'ws-beta',
      workspaceName: 'Beta',
    });
    expect((await pc.run(['competitors', 'list'])).exitCode).toBe(0);
    expect(agentrail.toolCalls.at(-1)?.input).toEqual({
      workspaceId: 'ws-beta',
    });
    expect(
      JSON.parse((await pc.run(['workspace', 'current'])).stdout),
    ).toMatchObject({
      workspaceId: 'ws-beta',
      from: 'link',
    });
    expect((await pc.run(['unlink'])).exitCode).toBe(0);

    expect((await pc.run(['org', 'use', 'Acme'])).exitCode).toBe(0);
    expect((await pc.run(['competitors', 'list'])).exitCode).toBe(0);
    expect(agentrail.toolCalls.at(-1)?.input).toEqual({});
    expect(
      JSON.parse((await pc.run(['workspace', 'current'])).stdout),
    ).toMatchObject({
      workspaceId: 'ws-acme',
      from: 'default',
    });
  });
});

describe('sign-ins', () => {
  // Agentrail ends a whole sign-in when a refresh token is used twice, so
  // two commands that find it expiring together must refresh it once.
  // Fails if someone refreshes without the lock.
  it('refreshes once when two commands find the sign-in expiring together', async () => {
    const pc = await computer();
    await pc.login();
    const browser = JSON.parse(pc.keychain.get('dev') ?? '{}') as Credential;
    pc.keychain.set(
      'dev',
      JSON.stringify({ ...browser, expiresAt: new Date().toISOString() }),
    );

    const both = await Promise.all([
      pc.run(['competitors', 'list'], { realSleep: true }),
      pc.run(['competitors', 'list'], { realSleep: true }),
    ]);
    expect(both.map((one) => one.exitCode)).toEqual([0, 0]);
    expect(forms(agentrail, 'refresh_token')).toHaveLength(1);
  });

  // Agentrail ends the whole sign-in when a refresh token is used twice, so
  // a command must wait for one still refreshing, however long it takes.
  // Fails if someone takes the lock over from a command still running.
  it('never takes the lock from a command still refreshing', async () => {
    const pc = await computer();
    await pc.login();
    pc.expire('dev');
    const slowRefresh: typeof fetch = async (input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      if (body.includes('grant_type=refresh_token')) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      return globalThis.fetch(input, init);
    };
    const first = pc.run(['competitors', 'list'], {
      realSleep: true,
      fetch: slowRefresh,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // As if long past the time a lock used to count as left behind.
    const later = () => new Date(Date.now() + 31_000);
    const second = pc.run(['competitors', 'list'], {
      realSleep: true,
      now: later,
    });
    expect(
      (await Promise.all([first, second])).map((one) => one.exitCode),
    ).toEqual([0, 0]);
    expect(forms(agentrail, 'refresh_token')).toEqual([
      expect.objectContaining({ refresh_token: 'refresh-1' }),
    ]);
  });

  // Fails if someone never takes over a lock whose command ended without
  // letting go: every refresh after a crash would wait, then give up.
  it('takes over the lock of a command that ended without letting go', async () => {
    const pc = await computer();
    await pc.login();
    pc.expire('dev');
    const ended = spawnSync(process.execPath, ['-e', '']).pid;
    await mkdir(join(pc.configDir, 'locks'), { recursive: true });
    await writeFile(
      join(pc.configDir, 'locks', 'dev.lock'),
      JSON.stringify({ pid: ended, token: 'crashed' }),
    );
    const listed = await pc.run(['competitors', 'list']);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(forms(agentrail, 'refresh_token')).toHaveLength(1);
  });

  // Fails if someone treats a token endpoint that is gone (an environment
  // switched back to WorkOS) as Agentrail being down.
  it('asks to sign in again when its token endpoint is gone', async () => {
    const pc = await computer();
    await pc.login();
    pc.expire('dev');
    const gone = answering(
      '/oauth/token',
      () =>
        new Response(
          JSON.stringify({
            code: 'NOT_FOUND',
            message: 'Nothing here.',
            requestId: 'r-1',
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
    );
    const listed = await pc.run(['competitors', 'list'], { fetch: gone });
    expect(listed.exitCode).toBe(3);
    expect(listed.stderr).toContain(
      'Your sign-in to dev ended. Run agentrail login --env dev.',
    );
  });

  // Fails if someone stops at the first sign-in Agentrail could not be told
  // to end, or leaves out which ones those were.
  it('tries to end every sign-in on logout, and names those it could not', async () => {
    const pc = await computer();
    await pc.login();
    expect((await pc.run(['org', 'use', 'Beta'])).exitCode).toBe(0);
    expect((await pc.run(['org', 'use', 'Gamma'])).exitCode).toBe(0);
    let revocations = 0;
    const firstFails = answering('/oauth/revoke', () => {
      revocations += 1;
      return revocations === 1 ? new Response('', { status: 503 }) : undefined;
    });

    const out = await pc.run(['logout'], { fetch: firstFails });
    expect(out.exitCode).toBe(4);
    expect(revocations).toBe(3);
    expect(agentrail.revocations.map((form) => form.get('token'))).toEqual([
      'refresh-2',
      'refresh-3',
    ]);
    expect(out.stderr).toContain(
      'could not be told to end your sign-in to Acme: ',
    );
    expect(out.stderr).not.toContain('CliError');
    expect([...pc.keychain.entries.keys()]).toEqual([]);
  });

  // Fails if someone signs out without ending the sign-ins at Agentrail, or
  // leaves one made by switching on the computer.
  it('ends every sign-in at Agentrail on logout, and forgets them all', async () => {
    const pc = await computer();
    await pc.login();
    expect((await pc.run(['org', 'use', 'Beta'])).exitCode).toBe(0);

    const out = await pc.run(['logout']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toContain(
      'Also removed 1 sign-in made by switching organization.',
    );
    expect(
      agentrail.revocations.map((form) => Object.fromEntries(form)),
    ).toEqual(
      ['refresh-1', 'refresh-2'].map((token) => ({
        token,
        token_type_hint: 'refresh_token',
        client_id: 'client_test',
      })),
    );
    expect([...pc.keychain.entries.keys()]).toEqual([]);
    await expect(
      access(join(pc.configDir, 'sign-ins', 'dev.json')),
    ).rejects.toThrow();
    expect((await pc.run(['competitors', 'list'])).exitCode).toBe(3);
  });
});
