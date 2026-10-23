// Build step after `tsc -b`: copy the Migent skill into dist and mark the entry executable.
// Plain Node so it runs the same from sh, cmd.exe and PowerShell.
import { chmodSync, cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = `${root}skills/migent`;
const target = `${root}packages/cli/dist/templates/migent`;
rmSync(`${root}packages/cli/dist/templates`, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
if (process.platform !== "win32") chmodSync(`${root}packages/cli/dist/index.js`, 0o755);
