// Child process for session-id.test.ts: waits for the start file, then claims session ids.
import { existsSync } from 'node:fs';

import { ARGV_USER_OFFSET, INT32_BYTES } from '@nodeint/migent-kernel';

import { createNumericSessionDirectory } from '../src/session-id.ts';

const [sessions, start, count] = process.argv.slice(ARGV_USER_OFFSET) as [string, string, string];
while (!existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(INT32_BYTES)), 0, 0, 1);
const ids: string[] = [];
for (let i = 0; i < Number(count); i += 1) ids.push(createNumericSessionDirectory(sessions)[0]);
process.stdout.write(JSON.stringify(ids));
