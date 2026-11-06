import path from "node:path";

/**
 * The only place provider IDs are interpreted after the client refactor.
 *
 * `LEGACY_PROVIDER_CLIENT` is a fixed historical table: it must not follow
 * changes in the live adapter registry. It answers "which client did this
 * provider drive by default in schema_version 5?".
 */
export const LEGACY_PROVIDER_CLIENT: Readonly<Record<string, string | null>> = Object.freeze({
  agy: "agy",
  claude: "claude-code",
  codex: "codex",
  grok: "grok",
  opencode: "opencode",
  byteplus: null,
});

/**
 * The executable Migent launched, mapped to the client that owns it. Turn
 * events record `argv`, so `argv[0]` is recorded proof of the CLI that ran.
 */
export const LEGACY_COMMAND_CLIENT: Readonly<Record<string, string>> = Object.freeze({
  agy: "agy",
  claude: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
  grok: "grok",
  opencode: "opencode",
});

/** The default client a historical provider drove. `null` when it had none. */
export function legacyClientOf(provider: string | null | undefined): string | null {
  if (typeof provider !== "string") return null;
  const key = provider.trim().toLowerCase();
  if (key === "" || !Object.hasOwn(LEGACY_PROVIDER_CLIENT, key)) return null;
  return LEGACY_PROVIDER_CLIENT[key] ?? null;
}

export type LegacyProvenance = "recorded" | "executable" | "code-path";

export type LegacyExecutionClient =
  | { client: string; provenance: LegacyProvenance }
  | { client: null; reason: string };

export interface LegacyExecutionEvidence {
  /** The `client` field of a new execution record. */
  recorded?: string | null;
  /** The `provider` field of a legacy record, for the role-session code-path only. */
  provider?: string | null;
  /** `argv[0]` of the execution's turn events, the executable Migent launched. */
  executable?: string | null;
  /** A frozen target's client, used only to corroborate other evidence. */
  frozen?: string | null;
  /** True for a `session run --role` execution, whose runner always used the provider's own client. */
  roleSession?: boolean;
}

/**
 * Decide which CLI ran one historical execution, following the evidence
 * matrix in the plan. Exactly one client must survive; a conflict or no
 * evidence refuses resume rather than guessing.
 */
export function legacyExecutionClient(evidence: LegacyExecutionEvidence): LegacyExecutionClient {
  const candidates: Array<{ client: string; provenance: LegacyProvenance }> = [];
  const recorded = nonempty(evidence.recorded);
  if (recorded !== null) candidates.push({ client: recorded, provenance: "recorded" });
  const executable = clientOfCommand(evidence.executable);
  if (executable !== null) candidates.push({ client: executable, provenance: "executable" });
  if (evidence.roleSession === true) {
    const roleClient = legacyClientOf(evidence.provider);
    if (roleClient !== null) candidates.push({ client: roleClient, provenance: "code-path" });
  }
  const clients = [...new Set(candidates.map((candidate) => candidate.client))];
  if (clients.length === 0) {
    return { client: null, reason: "no execution record names the CLI that ran it" };
  }
  if (clients.length > 1) {
    return { client: null, reason: `the recorded evidence names conflicting CLIs: ${clients.join(", ")}` };
  }
  const client = clients[0] as string;
  const frozen = nonempty(evidence.frozen);
  if (frozen !== null && frozen !== client) {
    return {
      client: null,
      reason: `the frozen target names ${frozen}, but the execution ran ${client}`,
    };
  }
  const strongest = candidates.find((candidate) => candidate.client === client) as { provenance: LegacyProvenance };
  return { client, provenance: strongest.provenance };
}

/** Map one recorded executable to a client. Accepts a full path and a Windows suffix. */
export function clientOfCommand(command: string | null | undefined): string | null {
  if (typeof command !== "string" || command.trim() === "") return null;
  const base = path.basename(command.trim()).replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
  return Object.hasOwn(LEGACY_COMMAND_CLIENT, base) ? LEGACY_COMMAND_CLIENT[base]! : null;
}

/** The client lookup key for a quota wait: recorded client, else a legacy bucket. */
export function quotaClientKey(client: string | null | undefined, provider: string | null | undefined): string {
  const recorded = nonempty(client);
  if (recorded !== null) return recorded;
  const legacy = nonempty(provider);
  return legacy === null ? "" : `legacy:${legacy}`;
}

function nonempty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
