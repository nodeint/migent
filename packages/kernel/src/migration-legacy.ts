/**
 * Historical "thinking" migrations, keyed by the legacy provider ID that owned
 * them. They run before schema_version 1 only. The native option names are
 * fixed historical constants; they must not track the live adapter registry.
 */

export type MigrationBody = Record<string, unknown>;
export type MigrationFn = (body: MigrationBody) => void;
export type MigrationKind = 'model' | 'role' | 'stage';

const CODEX_REASONING_OPTION = 'model_reasoning_effort';
const GROK_REASONING_OPTION = 'reasoning-effort';

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Renames the generic `thinking` setting to the CLI's own option, never overwriting one already set. */
export function moveThinkingTo(option: string): MigrationFn {
  return (body) => {
    const {options} = body;
    if ('options' in body && !isRecord(options)) return;
    if (isRecord(options) && 'thinking' in options) {
      const value = options.thinking;
      if (nonempty(value)) {
        if (!nonempty(options[option])) options[option] = value.trim();
        delete options.thinking;
      }
    }
    const value = body.thinking;
    if (!nonempty(value)) return;
    let record = isRecord(body.options) ? body.options : null;
    if (record === null) {
      record = {};
      body.options = record;
    }
    if (!nonempty(record[option])) record[option] = value.trim();
    delete body.thinking;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const moveCodexThinking = moveThinkingTo(CODEX_REASONING_OPTION);
const moveGrokThinking = moveThinkingTo(GROK_REASONING_OPTION);

const LEGACY_MIGRATIONS: Readonly<
  Record<string, Readonly<Record<MigrationKind, Readonly<Record<number, MigrationFn>>>>>
> = Object.freeze({
  codex: Object.freeze({
    model: Object.freeze({ 0: moveCodexThinking }),
    role: Object.freeze({ 0: moveCodexThinking }),
    stage: Object.freeze({ 0: moveCodexThinking }),
  }),
  grok: Object.freeze({
    model: Object.freeze({ 0: moveGrokThinking }),
    role: Object.freeze({ 0: moveGrokThinking }),
    stage: Object.freeze({ 0: moveGrokThinking }),
  }),
});

/** Apply the historical step for one legacy provider, if it has one. */
export function applyLegacyMigration(
  kind: MigrationKind,
  provider: string | null,
  version: number,
  body: MigrationBody,
): void {
  if (provider === null) return;
  const step = LEGACY_MIGRATIONS[provider.trim().toLowerCase()]?.[kind]?.[version];
  if (step !== undefined) step(body);
}
