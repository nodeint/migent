import path from 'node:path';

/**
 * The only place provider IDs are interpreted after the client refactor. This
 * file owns the historical tables; `legacy-execution-client.ts` reads session
 * events and reuses them without redefining them.
 *
 * `LEGACY_PROVIDER_CLIENT` is a fixed historical table: it must not follow
 * changes in the live adapter registry. It answers "which client did this
 * provider drive by default in schema_version 5?".
 */
export const LEGACY_PROVIDER_CLIENT: Readonly<Record<string, string | null>> = Object.freeze({
  agy: 'agy',
  claude: 'claude-code',
  codex: 'codex',
  grok: 'grok',
  opencode: 'opencode',
  byteplus: null,
});

/**
 * The executable Migent launched, mapped to the client that owns it. Turn
 * events record `argv`, so `argv[0]` is recorded proof of the CLI that ran.
 */
export const LEGACY_COMMAND_CLIENT: Readonly<Record<string, string>> = Object.freeze({
  agy: 'agy',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  grok: 'grok',
  opencode: 'opencode',
});

/** The default client a historical provider drove. `null` when it had none. */
export function legacyClientOf(provider: string | null | undefined): string | null {
  if (typeof provider !== 'string') return null;
  const key = provider.trim().toLowerCase();
  if (key === '' || !Object.hasOwn(LEGACY_PROVIDER_CLIENT, key)) return null;
  return LEGACY_PROVIDER_CLIENT[key] ?? null;
}

/** Map one recorded executable to a client. Accepts a full path and a Windows suffix. */
export function clientOfCommand(command: string | null | undefined): string | null {
  if (typeof command !== 'string' || command.trim() === '') return null;
  const base = path.basename(command.trim()).replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase();
  return Object.hasOwn(LEGACY_COMMAND_CLIENT, base) ? LEGACY_COMMAND_CLIENT[base] : null;
}
