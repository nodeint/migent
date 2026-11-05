import { defaultProviders } from "@nodeint/migent-adapters";
import {
  ProviderCommandFailed,
  loadOptionValues,
  type CatalogProvider,
  type RunCommand,
  type Which,
} from "@nodeint/migent-doctor";
import { killProcessTree, spawnProvider, spawnProviderSync, type CliModelCatalog, type Provider } from "@nodeint/migent-kernel";

// The catalog helpers belong to the doctor; commands keep importing them from here.
export { ProviderCommandFailed, asCatalog, knownModel, loadCatalog, loadOptionValues } from "@nodeint/migent-doctor";
export type { CatalogProvider, RunCommand, Which } from "@nodeint/migent-doctor";

export function providerMap(): Record<string, Provider> {
  return defaultProviders();
}

export function requireProvider(providers: Record<string, Provider>, provider: string): Provider {
  const impl = providers[provider];
  if (impl === undefined) {
    const supported = Object.keys(providers).sort().join(", ");
    throw new ProviderCommandFailed(`Unknown provider: ${provider}. Supported: ${supported}.`);
  }
  return impl;
}

export function detected(
  providers: Record<string, Provider>,
  which: Which,
): Array<[string, string | null, Provider]> {
  const rows = Object.entries(providers).filter(([, provider]) => provider.requiresClient !== true).map(
    ([name, provider]) => [name, which(provider.command), provider] as [string, string | null, Provider],
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
    if (!pair.includes("=")) throw new ProviderCommandFailed(`Option must be KEY=VALUE: ${pair}.`);
    const index = pair.indexOf("=");
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name === "" || value === "") throw new ProviderCommandFailed(`Option must be KEY=VALUE: ${pair}.`);
    parsed[name] = value;
  }
  return parsed;
}

export async function acceptedOptions(
  provider: Provider,
  model: string,
  catalog: CliModelCatalog,
  which: Which,
  runCommand: RunCommand,
  options: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  if (Object.keys(options).length === 0) return {};
  provider.validateOptions(options);
  const stored: Record<string, string> = {};
  for (const [name, value] of Object.entries(options)) {
    const values = await loadOptionValues(provider, name, model, catalog, which, runCommand);
    if (values === null) {
      stored[name] = value;
      continue;
    }
    if (!values.includes(value)) {
      if (values.length === 0) throw new ProviderCommandFailed(`${model} does not accept ${name}.`);
      throw new ProviderCommandFailed(`${name} must be one of: ${values.join(", ")}.`);
    }
    stored[name] = value;
  }
  return stored;
}

export function runProviderCommand(
  argv: string[], input?: string, options: { cwd?: string; timeoutMs?: number } = {},
): string {
  const [command, ...args] = argv;
  if (command === undefined) throw new ProviderCommandFailed("Provider command is empty.");
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
    throw new ProviderCommandFailed(detail || `${command} exited ${completed.status}.`);
  }
  return completed.stdout ?? "";
}

/** Like `runProviderCommand`, but does not block the event loop, so lookups run side by side. */
export function runProviderCommandAsync(
  argv: string[], input?: string, options: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  const [command, ...args] = argv;
  if (command === undefined) return Promise.reject(new ProviderCommandFailed("Provider command is empty."));
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
      else reject(new ProviderCommandFailed((stderr || stdout).trim() || `${command} exited ${status}.`));
    }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

