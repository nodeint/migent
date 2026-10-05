#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderUsage, runCommand, type ArgsDef, type CommandDef } from "citty";
import { ConfigurationError } from "@migent/kernel";
import { printError } from "./display.js";
import { cliHooks } from "./hooks.js";
import { root } from "./program.js";
import { setInvocationCwd } from "./workspace.js";

type ArgDef = {
  type?: string;
  alias?: string | string[];
};
type Command = CommandDef<ArgsDef>;

export async function main(argv: string[] = process.argv.slice(2), cwd?: string): Promise<number> {
  setInvocationCwd(cwd);
  try {
    const unknown = unknownOption(root, argv);
    if (unknown !== null) {
      printError(`No such option: ${unknown}`);
      return 2;
    }
    const located = locate(root, argv);
    if (located.unknownCommand !== null) {
      process.stderr.write(`Unknown command ${located.unknownCommand}\n`);
      return 2;
    }
    if (located.showHelp) {
      await printHelp(located.command, located.parent);
      return located.helpExplicit ? 0 : 2;
    }
    const { result } = await runCommand(located.command, { rawArgs: located.rawArgs });
    return typeof result === "number" ? result : 0;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      printError(error.message);
      return 2;
    }
    if (isCliError(error)) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
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
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
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

interface Located {
  command: Command;
  parent: Command | undefined;
  rawArgs: string[];
  unknownCommand: string | null;
  showHelp: boolean;
  helpExplicit: boolean;
}

function locate(command: Command, argv: readonly string[]): Located {
  let current = command;
  let parent: Command | undefined;
  let index = 0;
  const helpExplicit = argv.some((arg) => arg === "--help" || arg === "-h");
  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (token === "--" || token.startsWith("-")) break;
    const subs = subCommands(current);
    if (subs && Object.hasOwn(subs, token)) {
      parent = current;
      current = subs[token] ?? current;
      index += 1;
      continue;
    }
    if (subs && !current.run) {
      return {
        command: current,
        parent,
        rawArgs: [],
        unknownCommand: token,
        showHelp: false,
        helpExplicit,
      };
    }
    break;
  }
  const rawArgs = argv.slice(index).filter((arg) => arg !== "--help" && arg !== "-h");
  const grouped = Boolean(subCommands(current)) && !current.run;
  return {
    command: current,
    parent,
    rawArgs,
    unknownCommand: null,
    showHelp: helpExplicit || grouped,
    helpExplicit,
  };
}

function unknownOption(command: Command, argv: readonly string[]): string | null {
  let current = command;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") break;
    if (token === "--help" || token === "-h") continue;
    if (token.startsWith("-")) {
      const kind = flagKind(current, flagName(token));
      if (kind === null) return token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
      if (kind === "string" && !token.includes("=")) index += 1;
      continue;
    }
    const subs = subCommands(current);
    if (subs && Object.hasOwn(subs, token)) {
      current = subs[token] ?? current;
      continue;
    }
    if (subs && !current.run) return null;
  }
  return null;
}

async function printHelp(command: Command, parent: Command | undefined): Promise<void> {
  const usage = await renderUsage(command, parent);
  const parentName = metaName(parent);
  const name = metaName(command) || "migent";
  const title = parentName ? `${parentName} ${name}` : name;
  process.stdout.write(`Usage: ${title}\n${usage}\n`);
}

function subCommands(command: Command): Record<string, Command> | null {
  const value = command.subCommands;
  if (!value || typeof value === "function") return null;
  return value as Record<string, Command>;
}

function argRecord(command: Command): Record<string, ArgDef> {
  const value = command.args;
  if (!value || typeof value === "function") return {};
  return value as Record<string, ArgDef>;
}

function flagKind(command: Command, name: string): "boolean" | "string" | null {
  for (const [key, def] of Object.entries(argRecord(command))) {
    if (def.type === "positional") continue;
    const names = new Set<string>([key]);
    const aliases = def.alias === undefined ? [] : Array.isArray(def.alias) ? def.alias : [def.alias];
    for (const alias of aliases) names.add(alias);
    if (!names.has(name)) continue;
    return def.type === "boolean" ? "boolean" : "string";
  }
  return null;
}

function flagName(token: string): string {
  const body = token.startsWith("--") ? token.slice(2) : token.slice(1);
  const eq = body.indexOf("=");
  return eq === -1 ? body : body.slice(0, eq);
}

function metaName(command: Command | undefined): string {
  const meta = command?.meta;
  if (!meta || typeof meta !== "object" || meta instanceof Promise) return "";
  return "name" in meta && typeof meta.name === "string" ? meta.name : "";
}

function isCliError(error: unknown): error is Error {
  return error instanceof Error && error.name === "CLIError";
}
