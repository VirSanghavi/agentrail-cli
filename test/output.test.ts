import { describe, expect, it } from 'vitest';

import { outputMode } from '../src/output.js';
import { testRuntime } from './support/test-runtime.js';

describe('output mode', () => {
  // CLI-003: an agent or a pipe gets JSON; only a person at a terminal gets a
  // table. Fails too if someone goes back to a list of the CLI's own: Gemini
  // CLI and Codex give their commands a terminal, and would get a table.
  it.each([
    ['a terminal', 'table', true, {}, false],
    ['a pipe', 'json', false, {}, false],
    ['a terminal with --json', 'json', true, {}, true],
    ['a terminal inside Claude Code', 'json', true, { CLAUDECODE: '1' }, false],
    ['a terminal inside Cursor', 'json', true, { CURSOR_AGENT: '1' }, false],
    ['a terminal an agent names', 'json', true, { AGENT: 'codex' }, false],
    ['a terminal inside Gemini CLI', 'json', true, { GEMINI_CLI: '1' }, false],
    [
      'a terminal inside Codex',
      'json',
      true,
      { CODEX_SANDBOX: 'seatbelt' },
      false,
    ],
    ['a terminal set to CI=1 by hand', 'table', true, { CI: '1' }, false],
  ])('prints to %s as %s', async (_case, expected, terminal, env, json) => {
    const { runtime } = await testRuntime({
      mcpUrl: 'http://127.0.0.1:1/mcp',
      terminal,
      env,
    });
    expect(outputMode(runtime, json)).toBe(expected);
  });
});
