/**
 * Historical "thinking" migrations, keyed by the legacy provider ID that owned
 * them. They run before schema_version 1 only. The native option names are
 * fixed historical constants; they must not track the live adapter registry.
 */

export type MigrationBody = Record<string, unknown>;
/** A step returns the migrated body; it never changes the body it receives. */
export type MigrationFn = (body: MigrationBody) => MigrationBody;
export type MigrationKind = 'model' | 'role' | 'stage';

const CODEX_REASONING_OPTION = 'model_reasoning_effort';
const GROK_REASONING_OPTION = 'reasoning-effort';

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Renames the generic `thinking` setting to the CLI's own option, never overwriting one already set. */
export function moveThinkingTo(option: string): MigrationFn {
  return (body) => {
    if ('options' in body && !isRecord(body.options)) return body;
    let options = isRecord(body.options) ? { ...body.options } : null;
    const nested = options?.thinking;
    if (options !== null && 'thinking' in options && nonempty(nested)) {
      if (!nonempty(options[option])) options[option] = nested.trim();
      delete options.thinking;
    }
    const scalar = body.thinking;
    const hasScalar = nonempty(scalar);
    if (hasScalar) {
      options ??= {};
      if (!nonempty(options[option])) options[option] = scalar.trim();
    }
    if (options === null) return body;
    const moved: MigrationBody = { ...body, options };
    if (hasScalar) delete moved.thinking;
    return moved;
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
  subject: { readonly kind: MigrationKind; readonly provider: string | null },
  version: number,
  body: MigrationBody,
): MigrationBody {
  const { kind, provider } = subject;
  if (provider === null) return body;
  const step = LEGACY_MIGRATIONS[provider.trim().toLowerCase()]?.[kind]?.[version];
  return step === undefined ? body : step(body);
}

export function migrateModels(
  config: Record<string, unknown>,
  version: number,
  context: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const {models} = config;
  if (!isRecord(models)) return config;
  const migrated = Object.fromEntries(
    Object.entries(models).map(([name, body]) => {
      if (!isRecord(body)) return [name, body];
      const provider = providerName(body.provider) ?? modelProvider(context, name);
      return [name, applyLegacyMigration({ kind: 'model', provider }, version, body)];
    }),
  );
  return { ...config, models: migrated };
}

export function migrateRoles(
  config: Record<string, unknown>,
  version: number,
  context: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const {roles} = config;
  if (!isRecord(roles)) return config;
  const effectiveRoles = context.roles;
  const migrated = Object.fromEntries(
    Object.entries(roles).map(([name, body]) => {
      if (!isRecord(body)) return [name, body];
      const effectiveRole = isRecord(effectiveRoles) ? effectiveRoles[name] : null;
      const provider = roleProvider(
        context,
        Object.hasOwn(body, 'default_model') || Object.hasOwn(body, 'agent') || !isRecord(effectiveRole) ? body : effectiveRole,
      );
      return [name, applyLegacyMigration({ kind: 'role', provider }, version, body)];
    }),
  );
  return { ...config, roles: migrated };
}

export function migrateStages(
  workflow: Record<string, unknown>,
  config: Readonly<Record<string, unknown>>,
  version: number,
): Record<string, unknown> {
  const {stages} = workflow;
  if (!Array.isArray(stages)) return workflow;
  const migrated = stages.map((stage: unknown) =>
    isRecord(stage) ? applyLegacyMigration({ kind: 'stage', provider: stageProvider(config, stage) }, version, stage) : stage,
  );
  return { ...workflow, stages: migrated };
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
