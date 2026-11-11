// Child process for conditional-write.test.ts: waits for the start file, then writes once.
import { existsSync } from 'node:fs';

import { writeFileConditional } from '../src/conditional-write.ts';
import { ARGV_USER_OFFSET, INT32_BYTES } from '../src/constants.ts';

/** Lines per payload: large enough that interleaved writes would be visible. */
const PAYLOAD_LINES = 20_000;

const [destination, start, baseHash, tag] = process.argv.slice(ARGV_USER_OFFSET) as [string, string, string, string];
while (!existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(INT32_BYTES)), 0, 0, 1);
const content = `${tag}\n`.repeat(PAYLOAD_LINES);
const result = writeFileConditional(destination, content, { baseHash: baseHash === '-' ? null : baseHash });
process.stdout.write(JSON.stringify({ tag, status: result.status }));
