import { whichSync, type AgentAdapter, type ProviderOption } from "@nodeint/migent-kernel";
import { printProviders, type ProviderRow } from "../display.js";
import { cliHooks } from "../hooks.js";
import {
  adapterMap,
  loadCatalog,
  runProviderCommand,
  type RunCommand,
  type Which,
} from "../provider.js";

function mapProviderOption(opt: ProviderOption): {
  name: string;
  prompt: boolean;
  allow_default: boolean;
  overridable: boolean;
} {
  return {
    name: opt.name,
    prompt: opt.prompt === true,
    allow_default: opt.allowDefault === true,
    overridable: opt.overridable === true,
  };
}

function getProviderOptions(adapter: AgentAdapter): ReturnType<typeof mapProviderOption>[] {
  const candidate = adapter as Partial<{ providerOptions: () => readonly ProviderOption[] }>;
  if (typeof candidate.providerOptions === "function") {
    return candidate.providerOptions().map(mapProviderOption);
  }
  return [];
}

export async function collectProviders(
  adapters: Record<string, AgentAdapter>,
  which: Which,
  runCommand: RunCommand,
): Promise<ProviderRow[]> {
  const names = Object.keys(adapters).sort();
  const rows: ProviderRow[] = [];

  for (const name of names) {
    const adapter = adapters[name];
    const path = which(adapter.command);
    const options = getProviderOptions(adapter);
    const problems: string[] = [];
    let models: string[] = [];
    let default_model: string | null = null;

    if (path === null) {
      problems.push(`${adapter.command} is not on PATH.`);
    } else {
      try {
        const catalog = await loadCatalog(adapter, which, runCommand);
        models = [...catalog.ids];
        default_model = catalog.defaultId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        problems.push(message);
      }
    }

    rows.push({
      name,
      command: adapter.command,
      path,
      available: path !== null,
      models,
      default_model,
      options,
      problems,
    });
  }

  return rows;
}

function providerPayload(rows: readonly ProviderRow[]): {
  ok: boolean;
  providers: ProviderRow[];
} {
  return {
    ok: rows.every((row) => row.problems.length === 0),
    providers: rows.map((row) => ({ ...row })),
  };
}

export async function runProviderList(options: {
  asJson?: boolean;
  adapters?: Record<string, AgentAdapter> | null;
  which?: Which | null;
  runCommand?: RunCommand | null;
} = {}): Promise<number> {
  const adapters = options.adapters ?? adapterMap();
  const which = options.which ?? cliHooks.which ?? whichSync;
  const runCommand = options.runCommand ?? cliHooks.runCommand ?? runProviderCommand;

  const rows = await collectProviders(adapters, which, runCommand);

  if (options.asJson) {
    process.stdout.write(`${JSON.stringify(providerPayload(rows))}\n`);
  } else {
    printProviders(rows);
  }

  const hasAnyModels = rows.some((row) => row.models.length > 0);
  return hasAnyModels ? 0 : 1;
}
