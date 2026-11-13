// Child process for session-id-retire.test.ts: waits for the start file, then retires numbers in order.
import { existsSync } from 'node:fs';

import { ARGV_USER_OFFSET, INT32_BYTES } from '@nodeint/migent-kernel';

import { retireSessionNumber } from '../src/session-id.ts';

const [sessions, start, from, to] = process.argv.slice(ARGV_USER_OFFSET) as [string, string, string, string];
while (!existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(INT32_BYTES)), 0, 0, 1);
const step = Number(from) <= Number(to) ? 1 : -1;
for (let n = Number(from); n !== Number(to) + step; n += step) retireSessionNumber(sessions, n, { waitMs: 30_000 });
