import path from 'node:path';

import { expect, test } from 'vitest';

import { childMain } from '../src/child.ts';
import { serviceEndpointPath } from '../src/endpoint.ts';

test('child main rejects incomplete argv', async () => {
  expect(await childMain([])).toBe(2);
  expect(await childMain(['--child', '--home', '/tmp'])).toBe(2);
  expect(await childMain(['--child', '--home', '/tmp', '--port', '1', '--handshake-fd', '3'])).toBe(2);
});

test('long homes fall back to a short socket path', () => {
  const home = path.join('/', 'x'.repeat(120));
  const endpoint = serviceEndpointPath(home);
  if (process.platform === 'win32') expect(endpoint.startsWith('\\\\.\\pipe\\')).toBe(true);
  else expect(Buffer.byteLength(endpoint)).toBeLessThanOrEqual(100);
});
