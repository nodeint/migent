// Child process for conditional-write.test.ts: waits for the start file, then writes once.
import { existsSync } from 'node:fs';

import { writeFileConditional } from '../src/conditional-write.ts';

const [destination, start, baseHash, tag] = process.argv.slice(2) as [string, string, string, string];
while (!existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
const content = `${tag}\n`.repeat(20_000);
const result = writeFileConditional(destination, content, baseHash === '-' ? null : baseHash);
process.stdout.write(JSON.stringify({ tag, status: result.status }));
