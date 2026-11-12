import {
  type AgentDefinitionEntry,
  type ClientRegistry,
  listAgentDefinitions,
  loadWorkspaceConfig,
  type NativeOptionSupport,
} from '@nodeint/migent-kernel';

import { cached, type ClientCatalogInput, type HeadlessOptionFact, type RunCommand, type Which } from './catalog.js';
import { agentClientType } from './client-type.js';

/** What one client's help says about its options, or why that could not be read. */
export type NativeHelp =
  | { status: 'loaded'; helpCommand: string; options: readonly HeadlessOptionFact[] }
  | { status: 'unverified'; helpCommand: string; reason: string };

/** The native option facts of every client that has them, keyed by client id. Plain data. */
export type NativeOptionFacts = Readonly<Record<string, NativeHelp>>;

/** The client surface the analysis reads. */
export interface NativeOptionClient {
  readonly id: string;
  readonly command: string;
  readonly nativeOptions?: NativeOptionSupport;
}

export interface NativeOptionFinding {
  severity: 'error' | 'warning';
  /** `option-unknown`, `option-value-invalid`, `option-conflict` or `option-unverified`. */
  code: string;
  message: string;
}

/**
 * The client ids that agent definitions bind, plus `pinned` ones (a frozen session's targets), so
 * help is read only for clients a run uses. A config that cannot load drops only its own agents.
 */
export function usedClientIds(
  workspace: string,
  clients: ClientRegistry,
  more: { extra?: readonly AgentDefinitionEntry[]; pinned?: Iterable<string> } = {},
): Set<string> {
  const { extra = [], pinned = [] } = more;
  let live: AgentDefinitionEntry[] = [];
  try { live = listAgentDefinitions(loadWorkspaceConfig(workspace)); } catch { /* the config check reports it */ }
  const used = new Set<string>(pinned);
  for (const entry of [...live, ...extra]) {
    if (typeof entry.value !== 'object' || entry.value === null || Array.isArray(entry.value)) continue;
    const type = agentClientType(entry.value as Record<string, unknown>, clients);
    if (type !== undefined) used.add(type);
  }
  return used;
}

/** Reads each flag-style client's help once. Never judges configured options. */
export async function collectNativeOptionFacts(
  clients: ClientRegistry,
  env: { which: Which; runCommand: RunCommand; only?: ReadonlySet<string> },
): Promise<NativeOptionFacts> {
  const run = cached(env.runCommand);
  const entries = await Promise.all(clients.ids().map(async (id) => {
    if (env.only !== undefined && !env.only.has(id)) return null;
    const client = clients.get(id);
    if (client.nativeOptions === undefined) return null;
    return [id, await loadHelp(client as unknown as ClientCatalogInput, env.which, run)] as const;
  }));
  return Object.fromEntries(entries.filter((entry) => entry !== null));
}

async function loadHelp(client: ClientCatalogInput, which: Which, run: RunCommand): Promise<NativeHelp> {
  const spec = client.optionsCommand();
  const helpCommand = spec.argv.join(' ');
  if (which(client.command) === null) {
    return { status: 'unverified', helpCommand, reason: `${client.command} is not on PATH.` };
  }
  try {
    const text = await run(spec.argv, spec.stdin ?? undefined);
    return { status: 'loaded', helpCommand, options: client.parseOptions(text) };
  } catch (error) {
    return { status: 'unverified', helpCommand, reason: error instanceof Error ? error.message : String(error) };
  }
}

const BOOLEAN_TEXT = new Set(['true', 'false']);

/**
 * Checks the effective options of one target against its client's help. Pure: it never starts a
 * process. Without facts for the client it reports nothing.
 */
export function analyzeNativeOptions(
  client: NativeOptionClient,
  options: Readonly<Record<string, string>>,
  facts: NativeOptionFacts | undefined,
): NativeOptionFinding[] {
  const support = client.nativeOptions;
  const help = facts?.[client.id];
  const keys = Object.keys(options);
  if (support === undefined || help === undefined || keys.length === 0) return [];
  if (help.status === 'unverified') {
    return [{
      severity: 'warning',
      code: 'option-unverified',
      message: `Could not verify ${client.id} options against \`${help.helpCommand}\`: ${help.reason}`,
    }];
  }
  const findings: NativeOptionFinding[] = [];
  const claimed = new Map<HeadlessOptionFact, string[]>();
  for (const key of keys) {
    const flag = support.flagFor(key);
    if (flag === null) continue; // The offline check reports it.
    const entry = help.options.find((option) => option.flags.includes(flag));
    if (entry === undefined) {
      findings.push({
        severity: 'error',
        code: 'option-unknown',
        message: `${key} is not an option of ${client.id}: ${flag} is not listed by \`${help.helpCommand}\`.`,
      });
      continue;
    }
    claimed.set(entry, [...(claimed.get(entry) ?? []), key]);
    const reserved = entry.flags.find((other) => other !== flag && support.reservedFlags.includes(other));
    if (reserved !== undefined) {
      findings.push({
        severity: 'error',
        code: 'option-conflict',
        message: `${key} (${flag}) is an alias of ${reserved}, which Migent sets itself.`,
      });
      continue;
    }
    const invalid = valueProblem(key, options[key] ?? '', entry);
    if (invalid !== null) findings.push({ severity: 'error', code: 'option-value-invalid', message: invalid });
  }
  for (const [entry, reached] of claimed) {
    if (reached.length === 1) continue;
    findings.push({
      severity: 'error',
      code: 'option-conflict',
      message: `${reached.join(' and ')} all set the same option of ${client.id} (${entry.flags.join(', ')}); keep one.`,
    });
  }
  return findings;
}

function valueProblem(key: string, value: string, entry: HeadlessOptionFact): string | null {
  const flag = entry.flags.find((item) => item.startsWith('--')) ?? entry.flags[0] ?? key;
  if (entry.valueMode === 'none' && !BOOLEAN_TEXT.has(value)) {
    return `${key}: ${flag} takes no value; use true or false.`;
  }
  if (entry.valueMode === 'required' && BOOLEAN_TEXT.has(value)) {
    return `${key}: ${flag} needs a value; the literal ${value} cannot be passed to it.`;
  }
  if (entry.valueMode !== 'none' && entry.choices !== null && !entry.choices.includes(value)) {
    return `${key} must be one of: ${entry.choices.join(', ')}.`;
  }
  return null;
}
