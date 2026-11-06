import type { CliClient, HeadlessOption } from "@nodeint/migent-adapters";
import { ConfigurationError, type Provider, type ProviderOption, type View } from "@nodeint/migent-kernel";
import { field } from "./columns.js";
import type { Column } from "./render.js";
import type { DiscoveryContext, DiscoveryOutcome } from "./discovery.js";
import type { MachineQuery, MachineResource } from "./resource-types.js";

function requireName(label: string, name: string | null): string {
  if (name === null) throw new ConfigurationError(`Pass a ${label} name.`);
  return name;
}

function capitalized(label: string): string {
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function defaultClientOf(provider: Provider): string | null {
  const value = (provider as { clientId?: unknown }).clientId;
  return typeof value === "string" && value !== "" ? value : null;
}

function providerView(name: string, provider: Provider): View {
  return {
    kind: "provider",
    name,
    command: provider.command,
    default_client: defaultClientOf(provider),
    requires_client: provider.requiresClient === true,
  };
}

function clientView(context: DiscoveryContext, id: string): View {
  const client = context.client(id);
  const path = context.pathOf(client);
  return {
    kind: "client",
    name: id,
    command: client.command,
    available: path !== null,
    path,
    effort_option: client.effortOption ?? null,
    problems: path === null ? [`${client.command} is not on PATH.`] : [],
  };
}

function modelView(client: string, model: string, isDefault: boolean): View {
  return { kind: "model", name: model, client, default: isDefault };
}

function optionView(client: string, option: ProviderOption): View {
  return {
    kind: "option",
    name: option.name,
    client,
    source: "configured",
    prompt: option.prompt === true,
    allow_default: option.allowDefault === true,
    overridable: option.overridable === true,
  };
}

function nativeOptionView(client: string, option: HeadlessOption): View {
  return {
    kind: "option",
    name: option.name,
    client,
    source: "native",
    flags: option.flags,
    description: option.description,
    argument: option.argument,
    value_mode: option.valueMode,
    type: option.type,
    choices: option.choices,
    default: option.defaultValue,
  };
}

function effortView(client: string, model: string, option: string, values: readonly string[]): View {
  return { kind: "effort", name: model, client, model, option, values };
}

function outcomeMessage(outcome: DiscoveryOutcome<unknown>): string {
  return outcome.status === "ok" ? "" : outcome.message;
}

/** The clients a machine list or lookup considers: one when --client narrows it. */
function selectedClients(context: DiscoveryContext, query: MachineQuery): CliClient[] {
  return query.client !== null
    ? [context.client(query.client)]
    : context.clientIds.map((id) => context.client(id));
}

/** One stderr warning per skipped or failed client in a list. */
function warnOutcome(context: DiscoveryContext, clientId: string, outcome: DiscoveryOutcome<unknown>): void {
  if (outcome.status === "skipped") context.warn(`${clientId}: ${outcome.message}; skipped.`);
  else if (outcome.status === "failed") context.warn(`${clientId}: ${outcome.message}`);
}

interface ClientRows {
  client: string;
  outcome: DiscoveryOutcome<View[]>;
}

/**
 * The one lookup contract for client-keyed singletons: a row is identified by
 * (client, name), and ambiguity is reported rather than resolved silently.
 */
async function lookupView(options: {
  label: string;
  name: string;
  scoped: string | null;
  candidates: readonly CliClient[];
  rowsFor: (client: CliClient) => Promise<DiscoveryOutcome<View[]>>;
}): Promise<View> {
  const { label, name, scoped } = options;
  const results: ClientRows[] = await Promise.all(
    options.candidates.map(async (client) => ({ client: client.id, outcome: await options.rowsFor(client) })),
  );
  const matches: Array<{ client: string; view: View }> = [];
  for (const result of results) {
    if (result.outcome.status !== "ok") continue;
    for (const view of result.outcome.value) {
      if (String(view.name) === name) matches.push({ client: result.client, view });
    }
  }
  if (matches.length === 1) return matches[0]!.view;
  if (matches.length > 1) {
    throw new ConfigurationError(
      `${capitalized(label)} ${name} matches more than one client: ${matches.map((match) => match.client).join(", ")}. Pass --client to choose one.`,
    );
  }

  const skipped = results.filter((result) => result.outcome.status === "skipped");
  const failed = results.filter((result) => result.outcome.status === "failed");
  if (scoped !== null) {
    const first = skipped[0] ?? failed[0];
    const reason = first === undefined ? undefined : outcomeMessage(first.outcome);
    throw new ConfigurationError(
      reason === undefined || reason === ""
        ? `${capitalized(label)} not found: ${name} for client ${scoped}.`
        : `${capitalized(label)} ${name} is not available for client ${scoped}: ${reason}`,
    );
  }

  const searched = results.filter((result) => result.outcome.status === "ok").map((result) => result.client);
  const parts = [`No ${label} ${name} found.`, `Searched: ${searched.length > 0 ? searched.join(", ") : "none"}.`];
  if (skipped.length > 0) {
    parts.push(`Skipped: ${skipped.map((item) => `${item.client} (${outcomeMessage(item.outcome)})`).join(", ")}.`);
  }
  if (failed.length > 0) {
    parts.push(`Failed: ${failed.map((item) => `${item.client} (${outcomeMessage(item.outcome)})`).join(", ")}.`);
  }
  throw new ConfigurationError(parts.join(" "));
}

/** Clients with an effort option are the only candidates for an effort probe. */
function effortCandidates(context: DiscoveryContext, scoped: string | null): CliClient[] {
  if (scoped !== null) return [context.client(scoped)];
  return context.clientIds
    .map((id) => context.client(id))
    .filter((client) => client.effortOption !== undefined);
}

const providerResource: MachineResource = {
  scope: "machine",
  kind: "provider",
  names: ["provider", "providers"],
  summary: "Registered providers with their default CLI client and whether they require one.",
  acceptsClient: false,
  acceptsNative: false,
  columns: [field("NAME", "name"), field("DEFAULT_CLIENT", "default_client"), field("REQUIRES_CLIENT", "requires_client")],
  list: async (context) =>
    Object.keys(context.providers)
      .sort()
      .map((name) => providerView(name, context.providers[name]!)),
  get: async (context, query) => {
    const name = requireName("provider", query.name);
    const provider = context.providers[name];
    if (provider === undefined) {
      throw new ConfigurationError(`Provider not found: ${name}. Available: ${Object.keys(context.providers).sort().join(", ")}.`);
    }
    return providerView(name, provider);
  },
};

const clientResource: MachineResource = {
  scope: "machine",
  kind: "client",
  names: ["client", "clients"],
  summary: "Registered CLI clients with their command, PATH availability, and effort option.",
  acceptsClient: false,
  acceptsNative: false,
  columns: [
    field("NAME", "name"),
    field("COMMAND", "command"),
    field("AVAILABLE", "available"),
    field("PATH", "path"),
    field("EFFORT_OPTION", "effort_option"),
  ],
  // PATH facts only: this type runs no discovery.
  list: async (context) => context.clientIds.map((id) => clientView(context, id)),
  get: async (context, query) => clientView(context, requireName("client", query.name)),
};

const modelResource: MachineResource = {
  scope: "machine",
  kind: "model",
  names: ["model", "models"],
  summary: "Model ids each CLI client reports, with the client's default model.",
  acceptsClient: true,
  acceptsNative: false,
  columns: [field("NAME", "name"), field("CLIENT", "client"), field("DEFAULT", "default")],
  list: async (context, query) => {
    const rows: View[] = [];
    for (const client of selectedClients(context, query)) {
      const outcome = await context.catalog(client);
      if (outcome.status !== "ok") {
        warnOutcome(context, client.id, outcome);
        continue;
      }
      const catalog = outcome.value;
      for (const model of catalog.ids) rows.push(modelView(client.id, model, model === catalog.defaultId));
    }
    return rows;
  },
  get: async (context, query) => {
    const name = requireName("model", query.name);
    return lookupView({
      label: "model",
      name,
      scoped: query.client,
      candidates: selectedClients(context, query),
      rowsFor: async (client) => {
        const outcome = await context.catalog(client);
        if (outcome.status !== "ok") return outcome;
        return { status: "ok", value: outcome.value.ids.map((model) => modelView(client.id, model, model === outcome.value.defaultId)) };
      },
    });
  },
};

const CONFIGURED_OPTION_COLUMNS: readonly Column[] = [
  field("CLIENT", "client"),
  field("NAME", "name"),
  field("PROMPT", "prompt"),
  field("ALLOW_DEFAULT", "allow_default"),
  field("OVERRIDABLE", "overridable"),
];

const NATIVE_OPTION_COLUMNS: readonly Column[] = [
  field("CLIENT", "client"),
  field("NAME", "name"),
  field("ARGUMENT", "argument"),
  field("VALUE_MODE", "value_mode"),
  field("TYPE", "type"),
  field("CHOICES", "choices"),
  field("DEFAULT", "default"),
];

const optionResource: MachineResource = {
  scope: "machine",
  kind: "option",
  names: ["option", "options"],
  summary: "Migent's option metadata per client, or the CLI's native headless options with --native.",
  acceptsClient: true,
  acceptsNative: true,
  columns: NATIVE_OPTION_COLUMNS,
  columnsFor: (query) => (query.native ? NATIVE_OPTION_COLUMNS : CONFIGURED_OPTION_COLUMNS),
  list: async (context, query) =>
    query.native ? listNativeOptions(context, query) : listConfiguredOptions(context, query),
  get: async (context, query) => {
    const name = requireName("option", query.name);
    if (query.native) {
      return lookupView({
        label: "option",
        name,
        scoped: query.client,
        candidates: selectedClients(context, query),
        rowsFor: async (client) => {
          const outcome = await context.nativeOptions(client);
          if (outcome.status !== "ok") return outcome;
          return { status: "ok", value: outcome.value.map((option) => nativeOptionView(client.id, option)) };
        },
      });
    }
    return lookupView({
      label: "option",
      name,
      scoped: query.client,
      candidates: selectedClients(context, query),
      rowsFor: async (client) => ({
        status: "ok",
        value: client.options().map((option) => optionView(client.id, option)),
      }),
    });
  },
};

async function listConfiguredOptions(context: DiscoveryContext, query: MachineQuery): Promise<View[]> {
  const rows: View[] = [];
  for (const client of selectedClients(context, query)) {
    for (const option of client.options()) rows.push(optionView(client.id, option));
  }
  return rows;
}

async function listNativeOptions(context: DiscoveryContext, query: MachineQuery): Promise<View[]> {
  const rows: View[] = [];
  for (const client of selectedClients(context, query)) {
    const outcome = await context.nativeOptions(client);
    if (outcome.status !== "ok") {
      warnOutcome(context, client.id, outcome);
      continue;
    }
    for (const option of outcome.value) rows.push(nativeOptionView(client.id, option));
  }
  return rows;
}

const effortResource: MachineResource = {
  scope: "machine",
  kind: "effort",
  names: ["effort", "efforts"],
  summary: "Effort values per client and model, under the client's native option name.",
  acceptsClient: true,
  acceptsNative: false,
  columns: [
    field("CLIENT", "client"),
    field("MODEL", "model"),
    field("OPTION", "option"),
    field("VALUES", "values"),
  ],
  list: async (context, query) => {
    const rows: View[] = [];
    for (const client of selectedClients(context, query)) {
      const outcome = await context.efforts(client);
      if (outcome.status !== "ok") {
        warnOutcome(context, client.id, outcome);
        continue;
      }
      for (const row of outcome.value) rows.push(effortView(client.id, row.model, row.option, row.values));
    }
    return rows;
  },
  get: async (context, query) => {
    const name = requireName("effort", query.name);
    const candidates = effortCandidates(context, query.client);
    return lookupView({
      label: "effort",
      name,
      scoped: query.client,
      candidates,
      rowsFor: async (client) => {
        const outcome = await context.effort(client, name);
        if (outcome.status !== "ok") return outcome;
        // A known empty list is a real row (the model takes no effort values);
        // only a model absent from the catalog yields no row.
        if (outcome.value === null) return { status: "ok", value: [] };
        return {
          status: "ok",
          value: [effortView(client.id, name, client.effortOption ?? "effort", outcome.value)],
        };
      },
    });
  },
};

export const MACHINE_RESOURCES: readonly MachineResource[] = [
  providerResource,
  clientResource,
  modelResource,
  optionResource,
  effortResource,
];
