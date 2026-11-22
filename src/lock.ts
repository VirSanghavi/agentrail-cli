import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CliError, EXIT } from './errors.js';
import { isSystemError } from './files.js';
import type { Runtime } from './runtime.js';

/**
 * A lock that names no holder (one being written this moment, or one a CLI
 * before 0.2 left) counts as let go once it is this old.
 */
const UNNAMED_STALE_AFTER_MS = 30_000;
const CHECK_EVERY_MS = 100;
/** How many times a command checks for another to let go before giving up. */
const CHECKS = 300;

/** Who holds a lock: the process, and this one taking of it. */
interface Owner {
  readonly pid: number;
  readonly token: string;
}

/** Takes the lock; false when another command holds it. */
async function take(path: string, owner: Owner): Promise<boolean> {
  try {
    await writeFile(path, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if (isSystemError(error) && error.code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Who holds the lock: undefined once it has been let go, null when the file
 * names no holder this CLI can read.
 */
async function ownerOf(path: string): Promise<Owner | null | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isSystemError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const { pid, token } = (value ?? {}) as { pid?: unknown; token?: unknown };
  return Number.isInteger(pid) &&
    (pid as number) > 0 &&
    typeof token === 'string'
    ? { pid: pid as number, token }
    : null;
}

/** Whether a process is still running: signal 0 checks without sending one. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isSystemError(error) && error.code === 'ESRCH') return false;
    // Another user's process: running, and not ours to signal.
    if (isSystemError(error) && error.code === 'EPERM') return true;
    throw error;
  }
}

/** When a lock that names no holder was taken; undefined once it has been let go. */
async function takenAt(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if (isSystemError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Whether the lock as `seen` was left by a command that ended without
 * letting go: its process is gone, or, naming none, it is old.
 */
async function abandoned(
  runtime: Runtime,
  path: string,
  seen: Owner | null,
): Promise<boolean> {
  if (seen !== null) return !running(seen.pid);
  const at = await takenAt(path);
  return (
    at !== undefined && runtime.now().getTime() - at > UNNAMED_STALE_AFTER_MS
  );
}

/** Removes the lock only while it is still the one `seen`, so another's new lock stays. */
async function removeIfStill(path: string, seen: Owner | null): Promise<void> {
  const now = await ownerOf(path);
  if (now === undefined) return;
  if (
    (now === null && seen === null) ||
    (now !== null && now.token === seen?.token)
  ) {
    await rm(path, { force: true });
  }
}

/**
 * Runs `use` while no other agentrail command holds the lock `name`. A
 * refresh token is good for one use, and Agentrail ends the whole sign-in
 * when one is used twice, so two commands must never refresh, or switch
 * organization from, the same sign-in at once.
 *
 * The lock is a file created only where none exists, naming the process
 * that holds it. It is taken over only once that process has ended, never
 * for being held long: a token request has no deadline, because one given
 * up on after the server rotated the token would leave the CLI holding a
 * spent one, and the next refresh would end the sign-in. A command that
 * waits too long gives up instead, and says how to clear the lock.
 */
export async function withLock<T>(
  runtime: Runtime,
  name: string,
  use: () => Promise<T>,
): Promise<T> {
  const directory = join(runtime.configDir, 'locks');
  const path = join(directory, `${name}.lock`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const owner: Owner = { pid: process.pid, token: randomUUID() };
  for (let check = 1; !(await take(path, owner)); check += 1) {
    const seen = await ownerOf(path);
    if (seen === undefined) continue;
    if (await abandoned(runtime, path, seen)) {
      await removeIfStill(path, seen);
      continue;
    }
    if (check >= CHECKS) {
      throw new CliError(
        EXIT.unavailable,
        `Another agentrail command is still refreshing your sign-in. If none is running, remove ${path} and run your command again.`,
      );
    }
    await runtime.sleep(CHECK_EVERY_MS);
  }
  try {
    return await use();
  } finally {
    await removeIfStill(path, owner);
  }
}
