#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import { ConfigurationError } from "@nodeint/migent-kernel";
import { printError } from "./display.js";
import { PromptCancelled } from "./errors.js";
import { EXIT_CANCELLED, EXIT_CONFIG } from "./exits.js";
import { cliHooks } from "./hooks.js";
import { createProgram, type CliStatus } from "./program.js";
import { setInvocationCwd } from "./workspace.js";

export async function main(argv: string[] = process.argv.slice(2), cwd?: string): Promise<number> {
  setInvocationCwd(cwd);
  const status: CliStatus = { code: 0, handled: false };
  try {
    const program = createProgram(status);
    await program.parseAsync(argv, { from: "user" });
    if (!status.handled) {
      program.outputHelp();
      return 2;
    }
    return status.code;
  } catch (error) {
    if (error instanceof PromptCancelled) return EXIT_CANCELLED;
    if (error instanceof ConfigurationError) {
      printError(error.message);
      return EXIT_CONFIG;
    }
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    throw error;
  } finally {
    setInvocationCwd(undefined);
    cliHooks.which = null;
    cliHooks.runner = null;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}


