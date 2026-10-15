import type { ChildProcess, SpawnOptions, SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import crossSpawn from "cross-spawn";

// The process wrapper imports this file from source, so it uses Node built-ins and plain
// JavaScript-compatible TypeScript only.

const require = createRequire(import.meta.url);
const whichModule = require("which") as {
  sync(command: string, options: { nothrow: true }): string | null;
};

const BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);

export class UnpassableArgument extends Error {
  constructor(command: string) {
    super(
      `${command} is a Windows batch script, and cmd.exe cuts arguments at line breaks. ` +
        "Remove line breaks from the provider options passed on its command line.",
    );
    this.name = "UnpassableArgument";
  }
}

/**
 * npm installs provider CLIs on Windows as `.cmd` shims, which run through cmd.exe. cmd.exe ends
 * the command at a line break, so such an argument would be silently cut short.
 */
export function assertArgumentsPassable(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  resolve: (command: string) => string | null = (name) => whichModule.sync(name, { nothrow: true }),
): void {
  if (platform !== "win32") return;
  if (!args.some((arg) => /[\r\n]/.test(arg))) return;
  const resolved = resolve(command) ?? command;
  if (BATCH_EXTENSIONS.has(path.extname(resolved).toLowerCase())) throw new UnpassableArgument(command);
}

/** `spawn` that also runs `.cmd`/`.bat` shims and PATHEXT lookups on Windows. */
export function spawnProvider(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  assertArgumentsPassable(command, args);
  return crossSpawn(command, [...args], options);
}

export function spawnProviderSync(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
  assertArgumentsPassable(command, args);
  return crossSpawn.sync(command, [...args], options);
}
