import { type HeadlessOption, clientIds, createClient } from "@nodeint/migent-adapters";
import {
  ClientCommandFailed,
  clientCatalogSource,
  clientsListingModel,
  loadCatalogSync,
  loadOptionValues,
  type CatalogOutcome,
  type CatalogSource,
  type ClientCatalogInput,
  type RunCommand,
  type Which,
} from "@nodeint/migent-doctor";
import {
  ConfigurationError,
  killProcessTree,
  whichSync,
  spawnProvider,
  spawnProviderSync,
  type CliClient,
  type CliModelCatalog,
  type ClientRegistry,
  type ModelClientLookup,
} from "@nodeint/migent-kernel";
import { cliHooks } from "./hooks.js";

// The catalog helpers belong to the doctor; commands keep importing them from here.
export { ClientCommandFailed, asCatalog, knownModel, loadCatalog, loadOptionValues } from "@nodeint/migent-doctor";
export type { CatalogSource, RunCommand, Which } from "@nodeint/migent-doctor";

/**
 * The CLI composition root: every client is built from the adapters' own factories. Model-to-client
 * inference lists each installed client's models synchronously, once per registry instance, and only
 * when an agent omits `client.type`.
 */
export function clientRegistry(): ClientRegistry {
  const outcomes = new Map<string, CatalogOutcome>();
  const outcomeOf = (id: string): CatalogOutcome => {
    const known = outcomes.get(id);
    if (known !== undefined) return known;
    const which = cliHooks.which ?? whichSync;
    const injected = cliHooks.runCommand;
    const run = (argv: string[], input?: string): string => {
      if (injected === null) return runClientCommand(argv, input);
      const out = injected(argv, input);
      if (typeof out !== "string") throw new ClientCommandFailed("Model lookup needs a synchronous command runner.");
      return out;
    };
    const client = createClient(id);
    let outcome: CatalogOutcome;
    if (which(client.command) === null) outcome = { status: "skipped" };
    else {
      try {
        outcome = { status: "loaded", ids: loadCatalogSync(catalogSourceOf(client), which, run).ids };
      } catch (error) {
        outcome = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
      }
    }
    outcomes.set(id, outcome);
    return outcome;
  };
  return {
    ids: () => clientIds(),
    get: (id: string): CliClient => {
      if (!clientIds().includes(id)) {
        throw new ConfigurationError(`Unknown CLI client: ${id}. Supported: ${clientIds().join(", ")}.`);
      }
      return createClient(id);
    },
    clientsForModel: (model: string): ModelClientLookup =>
      clientsListingModel(
        model,
        clientIds().map((id) => ({ id, command: createClient(id).command, outcome: outcomeOf(id) })),
      ),
  };
}

/** The catalog surface of one client; it exposes fewer methods than the adapter. */
export function catalogSourceOf(client: CliClient): CatalogSource {
  return clientCatalogSource(client as unknown as ClientCatalogInput);
}

/** Every known client with its executable, installed ones first. */
export function detected(which: Which): Array<[string, string | null, CliClient]> {
  const rows = clientIds().map(
    (id) => [id, which(createClient(id).command), createClient(id)] as [string, string | null, CliClient],
  );
  rows.sort((left, right) => {
    const leftMissing = left[1] === null ? 1 : 0;
    const rightMissing = right[1] === null ? 1 : 0;
    if (leftMissing !== rightMissing) return leftMissing - rightMissing;
    if (left[0] < right[0]) return -1;
    if (left[0] > right[0]) return 1;
    return 0;
  });
  return rows;
}

export function parseOptions(pairs: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const pair of pairs) {
    if (!pair.includes("=")) throw new ClientCommandFailed(`Option must be KEY=VALUE: ${pair}.`);
    const index = pair.indexOf("=");
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name === "" || value === "") throw new ClientCommandFailed(`Option must be KEY=VALUE: ${pair}.`);
    parsed[name] = value;
  }
  return parsed;
}

export async function acceptedOptions(
  client: CliClient,
  model: string,
  catalog: CliModelCatalog,
  which: Which,
  runCommand: RunCommand,
  options: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  if (Object.keys(options).length === 0) return {};
  client.validateOptions(options);
  const source = clientCatalogSource(client as unknown as ClientCatalogInput);
  const stored: Record<string, string> = {};
  for (const [name, value] of Object.entries(options)) {
    const values = await loadOptionValues(source, name, model, catalog, which, runCommand);
    if (values === null) {
      stored[name] = value;
      continue;
    }
    if (!values.includes(value)) {
      if (values.length === 0) throw new ClientCommandFailed(`${model} does not accept ${name}.`);
      throw new ClientCommandFailed(`${name} must be one of: ${values.join(", ")}.`);
    }
    stored[name] = value;
  }
  return stored;
}

export function runClientCommand(
  argv: string[], input?: string, options: { cwd?: string; timeoutMs?: number } = {},
): string {
  const [command, ...args] = argv;
  if (command === undefined) throw new ClientCommandFailed("Client command is empty.");
  const completed = spawnProviderSync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60_000,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    windowsHide: true,
    ...(input === undefined ? {} : { input }),
  });
  if (completed.error) {
    throw new Error(completed.error.message);
  }
  if (completed.status !== 0) {
    const detail = (completed.stderr || completed.stdout || "").trim();
    throw new ClientCommandFailed(detail || `${command} exited ${completed.status}.`);
  }
  return completed.stdout ?? "";
}

/** Like `runClientCommand`, but does not block the event loop, so lookups run side by side. */
export function runClientCommandAsync(
  argv: string[], input?: string, options: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  const [command, ...args] = argv;
  if (command === undefined) return Promise.reject(new ClientCommandFailed("Client command is empty."));
  return new Promise((resolve, reject) => {
    const child = spawnProvider(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      windowsHide: true,
      // Its own process group on POSIX, so a timeout can end the whole tree.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) killProcessTree(child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill();
      }
      finish(() => reject(new Error(`${command} timed out after ${options.timeoutMs ?? 60_000}ms.`)));
    }, options.timeoutMs ?? 60_000);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => finish(() => reject(new Error(error.message))));
    child.on("close", (status) => finish(() => {
      if (status === 0) resolve(stdout);
      else reject(new ClientCommandFailed((stderr || stdout).trim() || `${command} exited ${status}.`));
    }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/** Discover native headless CLI options independently of model availability. */
export async function loadHeadlessOptions(
  source: CatalogSource,
  runCommand: RunCommand,
): Promise<HeadlessOption[]> {
  const candidate = source as Partial<CatalogSource>;
  if (typeof candidate.optionsCommand !== "function" || typeof candidate.parseOptions !== "function") {
    throw new ClientCommandFailed(`${source.command} does not discover headless options.`);
  }
  const command = candidate.optionsCommand();
  const help = await runCommand(command.argv, command.stdin ?? undefined);
  return [...candidate.parseOptions(help)] as HeadlessOption[];
}

/** Help may be printed on stderr even when the command succeeds (Agy). */
export const runOptionsCommand: RunCommand = (argv, input) => {
  const [command, ...args] = argv;
  if (!command) throw new ClientCommandFailed("Options command is empty.");
  const completed = spawnProviderSync(command, args, {
    encoding: "utf8", timeout: 15_000, windowsHide: true,
    ...(input === undefined ? {} : { input }),
  });
  if (completed.error) throw completed.error;
  const output = [completed.stdout, completed.stderr].filter(Boolean).join("\n");
  if (completed.status !== 0) throw new ClientCommandFailed(output.trim() || `${command} exited ${completed.status}.`);
  return output;
};
