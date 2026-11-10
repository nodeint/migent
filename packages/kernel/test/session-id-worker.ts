// Child process for session-id.test.ts: waits for the start file, then claims session ids.
import { existsSync } from "node:fs";
import { createNumericSessionDirectory } from "../src/session-id.ts";

const [sessions, start, count] = process.argv.slice(2) as [string, string, string];
while (!existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
const ids: string[] = [];
for (let i = 0; i < Number(count); i += 1) ids.push(createNumericSessionDirectory(sessions)[0]);
process.stdout.write(JSON.stringify(ids));
