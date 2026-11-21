import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CliError, EXIT } from './errors.js';
import { isSystemError } from './files.js';
import type { Runtime } from './runtime.js';

/** A lock older than this was left by a command that ended without letting go. */
const STALE_AFTER_MS = 30_000;
const CHECK_EVERY_MS = 100;
/** How many times a command checks for another to let go before giving up. */
const CHECKS = 300;

/** Takes the lock; false when another command holds it. */
async function take(path: string): Promise<boolean> {
  try {
    await writeFile(path, '', { mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if (isSystemError(error) && error.code === 'EEXIST') return false;
    throw error;
  }
}

/** When the lock was taken; undefined once it has been let go. */
async function takenAt(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if (isSystemError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Runs `use` while no other agentrail command holds the lock `name`. A
 * refresh token is good for one use, and Agentrail ends the whole sign-in
 * when one is used twice, so two commands must never refresh, or switch
 * organization from, the same sign-in at once. The lock is a file created
 * only where none exists; one left by a command that crashed is taken over
 * once it is stale.
 */
export async function withLock<T>(
  runtime: Runtime,
  name: string,
  use: () => Promise<T>,
): Promise<T> {
  const directory = join(runtime.configDir, 'locks');
  const path = join(directory, `${name}.lock`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (let check = 1; !(await take(path)); check += 1) {
    const at = await takenAt(path);
    if (at === undefined) continue;
    if (runtime.now().getTime() - at > STALE_AFTER_MS) {
      await rm(path, { force: true });
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
    await rm(path, { force: true });
  }
}
