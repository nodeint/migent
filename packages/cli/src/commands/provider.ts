import { whichSync, type Provider, type ProviderOption } from "@nodeint/migent-kernel";
import { printProviders, type ProviderRow } from "../display.js";
import { cliHooks } from "../hooks.js";
import {
  providerMap,
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

function getProviderOptions(provider: Provider): ReturnType<typeof mapProviderOption>[] {
  const candidate = provider as Partial<{ providerOptions: () => readonly ProviderOption[] }>;
  if (typeof candidate.providerOptions === "function") {
    return candidate.providerOptions().map(mapProviderOption);
  }
  return [];
}

export async function collectProviders(
  providers: Record<string, Provider>,
  which: Which,
  runCommand: RunCommand,
): Promise<ProviderRow[]> {
  // A provider without a default client has no CLI of its own to probe.
  const names = Object.keys(providers).filter((name) => providers[name].requiresClient !== true).sort();
  const rows: ProviderRow[] = [];

  for (const name of names) {
    const provider = providers[name];
    const path = which(provider.command);
    const options = getProviderOptions(provider);
    const problems: string[] = [];
    let models: string[] = [];
    let default_model: string | null = null;

    if (path === null) {
      problems.push(`${provider.command} is not on PATH.`);
    } else {
      try {
        const catalog = await loadCatalog(provider, which, runCommand);
        models = [...catalog.ids];
        default_model = catalog.defaultId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        problems.push(message);
      }
    }

    rows.push({
      name,
      command: provider.command,
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
  providers?: Record<string, Provider> | null;
  which?: Which | null;
  runCommand?: RunCommand | null;
} = {}): Promise<number> {
  const providers = options.providers ?? providerMap();
  const which = options.which ?? cliHooks.which ?? whichSync;
  const runCommand = options.runCommand ?? cliHooks.runCommand ?? runProviderCommand;

  const rows = await collectProviders(providers, which, runCommand);

  if (options.asJson) {
    process.stdout.write(`${JSON.stringify(providerPayload(rows))}\n`);
  } else {
    printProviders(rows);
  }

  const hasAnyModels = rows.some((row) => row.models.length > 0);
  return hasAnyModels ? 0 : 1;
}
