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

export function migrateModels(
  config: Record<string, unknown>,
  version: number,
  context: Readonly<Record<string, unknown>>,
): void {
  const {models} = config;
  if (!isRecord(models)) return;
  for (const [name, body] of Object.entries(models)) {
    if (!isRecord(body)) continue;
    const provider = providerName(body.provider) ?? modelProvider(context, name);
    applyLegacyMigration('model', provider, version, body);
  }
}

export function migrateRoles(
  config: Record<string, unknown>,
  version: number,
  context: Readonly<Record<string, unknown>>,
): void {
  const {roles} = config;
  if (!isRecord(roles)) return;
  for (const [name, body] of Object.entries(roles)) {
    if (!isRecord(body)) continue;
    const effectiveRoles = context.roles;
    const effectiveRole = isRecord(effectiveRoles) ? effectiveRoles[name] : null;
    const provider = roleProvider(
      context,
      Object.hasOwn(body, 'default_model') || Object.hasOwn(body, 'agent') || !isRecord(effectiveRole) ? body : effectiveRole,
    );
    applyLegacyMigration('role', provider, version, body);
  }
}

export function migrateStages(
  workflow: Record<string, unknown>,
  config: Readonly<Record<string, unknown>>,
  version: number,
): void {
  const {stages} = workflow;
  if (!Array.isArray(stages)) return;
  for (const stage of stages) {
    if (!isRecord(stage)) continue;
    const provider = stageProvider(config, stage);
    applyLegacyMigration('stage', provider, version, stage);
  }
}

/** Reads the provider of a role's agent in either document shape: `agent` or the earlier `default_model`. */
function roleProvider(config: Readonly<Record<string, unknown>>, role: Readonly<Record<string, unknown>>): string | null {
  const selection = Object.hasOwn(role, 'agent') ? role.agent : role.default_model;
  if (isRecord(selection)) return bodyProvider(selection);
  if (typeof selection !== 'string') return null;
  return modelProvider(config, selection);
}

function stageProvider(config: Readonly<Record<string, unknown>>, stage: Readonly<Record<string, unknown>>): string | null {
  const selection = Object.hasOwn(stage, 'agent') ? stage.agent : stage.model;
  if (isRecord(selection)) return bodyProvider(selection);
  if (typeof selection === 'string' && selection.trim() !== '') return modelProvider(config, selection);
  const roleName = stage.role;
  if (typeof roleName !== 'string') return null;
  const {roles} = config;
  if (!isRecord(roles)) return null;
  const role = roles[roleName.trim()];
  if (!isRecord(role)) return null;
  return roleProvider(config, role);
}

function modelProvider(config: Readonly<Record<string, unknown>>, modelName: string): string | null {
  const models = isRecord(config.agents) ? config.agents : config.models;
  if (!isRecord(models)) return null;
  const model = models[modelName.trim()];
  if (!isRecord(model)) return null;
  return bodyProvider(model);
}

/** A body's own `provider`, else the legacy provider its `client.type` was lifted from. */
function bodyProvider(body: Readonly<Record<string, unknown>>): string | null {
  const provider = providerName(body.provider);
  if (provider !== null) return provider;
  const {client} = body;
  return providerName(isRecord(client) ? client.type : client);
}

function providerName(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim();
}
