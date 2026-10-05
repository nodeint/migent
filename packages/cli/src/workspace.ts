import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ConfigurationError } from "@migent/kernel";

let invocationCwd: string | null = null;

export function setInvocationCwd(cwd?: string): void {
  invocationCwd = cwd === undefined ? null : path.resolve(cwd);
}

export function invocationCwdPath(): string {
  return invocationCwd ?? process.cwd();
}

export function findWorkspace(start: string): string {
  let current = path.resolve(start);
  for (;;) {
    if (isFile(path.join(current, ".migent", "config.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new ConfigurationError(
    "Could not find .migent/config.yaml in this directory or its parents.",
  );
}

export function resolvePrompt(args: {
  prompt?: string | null;
  promptFile?: string | null;
  promptStdin: boolean;
}): string {
  if (args.promptStdin) {
    const text = readFileSync(0, "utf8");
    if (text === "") throw new Error("Prompt from stdin is empty.");
    return text;
  }
  if (args.promptFile == null) {
    if (args.prompt == null) throw new Error("Pass one of --prompt, --file, or --stdin.");
    return args.prompt;
  }
  try {
    return readFileSync(args.promptFile, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read prompt file: ${args.promptFile} (${reason})`);
  }
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}
