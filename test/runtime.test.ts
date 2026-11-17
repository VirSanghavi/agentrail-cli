import { describe, expect, it, vi } from 'vitest';

import { ENVIRONMENTS } from '../src/environments.js';
import { isWebPage, processRuntime } from '../src/runtime.js';

describe('the pages login opens in a browser', () => {
  // The URL comes from the authorization server: anything but a web page
  // could open a file or start another program.
  it.each([
    ['https://auth.example.com/device?code=ABCD', true],
    ['http://127.0.0.1:8080/device', true],
    ['http://localhost/device', true],
    ['http://auth.example.com/device', false],
    ['file:///etc/passwd', false],
    ['ms-settings:privacy', false],
    ['not a url', false],
  ])('opens %s: %s', (url, opened) => {
    expect(isWebPage(url)).toBe(opened);
  });
});

describe('what the installed CLI tells Agentrail', () => {
  // Fails if someone lists an origin that is not one of Agentrail's MCP
  // servers, or leaves one out: the CLI's runs, sessions and agent would
  // reach a sign-in page or npm, or prod's or dev's journeys would lose them.
  it('goes to Agentrail’s MCP servers alone, on the requests the CLI makes', async () => {
    const sent: Headers[] = [];
    vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return Promise.resolve(new Response('{}'));
    });
    const runtime = processRuntime();
    try {
      const told = (url: string) => Object.keys(runtime.agentrail.headers(url));
      if (!runtime.agentrail.enabled) return; // DO_NOT_TRACK is set here.
      expect(told(ENVIRONMENTS.prod.mcpUrl)).toEqual(['x-agentrail-cli']);
      expect(told(ENVIRONMENTS.dev.mcpUrl)).toEqual(['x-agentrail-cli']);
      for (const elsewhere of [
        'https://registry.npmjs.org/-/package/agentrail-cli/dist-tags',
        'https://secure-aspiration-31.authkit.app/oauth2/token',
        'https://agentrail.co/',
      ])
        expect(told(elsewhere)).toEqual([]);
      await runtime.fetch(ENVIRONMENTS.prod.mcpUrl, { method: 'POST' });
      expect(sent[0]?.get('x-agentrail-cli')).toMatch(/cli="agentrail"/u);
    } finally {
      runtime.agentrail.close();
      vi.unstubAllGlobals();
    }
  });
});
