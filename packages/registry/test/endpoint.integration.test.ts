import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { queryEndpoint, requestStop, ServiceEndpointServer } from '../src/endpoint.ts';

test('endpoint is exclusive, reports its instance, and stops only with the token', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'registry-ep-'));
  const hello = { instance_id: 'instance-a', pid: process.pid };
  let stops = 0;
  const first = await ServiceEndpointServer.listen(home, hello, { token: 'secret', onStop: () => {
    stops += 1;
  } });
  try {
    expect(first).not.toBeNull();
    expect(await ServiceEndpointServer.listen(home, { instance_id: 'instance-b', pid: 1 }, { token: 'x', onStop: () => undefined })).toBeNull();
    expect(await queryEndpoint(home)).toEqual({ state: 'alive', hello });
    expect(await requestStop(home, { instanceId: 'instance-a', token: 'wrong' })).toBe(false);
    expect(await requestStop(home, { instanceId: 'instance-b', token: 'secret' })).toBe(false);
    expect(stops).toBe(0);
    expect(await requestStop(home, { instanceId: 'instance-a', token: 'secret' })).toBe(true);
    expect(stops).toBe(1);
  } finally {
    first?.close();
  }
  expect(await queryEndpoint(home)).toEqual({ state: 'gone' });
  rmSync(home, { recursive: true, force: true });
});
