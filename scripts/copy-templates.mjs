// Build step after `tsc -b`: copy CLI templates into dist and mark the entry executable.
// Plain Node so it runs the same from sh, cmd.exe and PowerShell.
import { chmodSync, cpSync, rmSync } from "node:fs";

const source = "packages/cli/src/templates";
const target = "packages/cli/dist/templates";
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
if (process.platform !== "win32") chmodSync("packages/cli/dist/index.js", 0o755);
