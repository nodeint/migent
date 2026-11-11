import {
  AgentPlaceholder,
  ClientOptions,
  ClientSelection,
  ConfigMapping,
  Description,
  EffectiveConfig,
  isValid,
  NonBlankString,
  Responsibilities,
  RoleEntry,
  type SchemaIssue,
  schemaIssues,
  type TSchema,
} from '@nodeint/migent-contracts';

import { ConfigurationError } from './errors.js';

/**
 * Translates the structural contracts in `@nodeint/migent-contracts` into Migent errors. The
 * contract decides whether a node is valid; this module owns the vocabulary: the `code`, the
 * message, and the author-coordinate `path`.
 *
 * Every check validates one node against its field schema, so a consumer validates only what it
 * reads. A caller that already ran the whole document once passes the resulting `StructuralIndex`;
 * a check then takes its verdict from the index instead of validating again.
 */

/** A config location: `label` is the dotted text shown in messages, `path` the literal key segments. */
export interface Field {
  label: string;
  path: readonly (string | number)[];
}

/** Keys a client mapping accepts, derived from the contract. */
export const CLIENT_KEYS: readonly string[] = Object.keys(ClientSelection.properties);
/** Keys a role accepts, derived from the contract. */
export const ROLE_KEYS: readonly string[] = Object.keys(RoleEntry.properties);

/** First structural error per author path, for the nodes of an effective config. */
export type StructuralIndex = ReadonlyMap<string, ConfigurationError>;

const keyOf = (path: readonly (string | number)[]): string => JSON.stringify(path);

const labelOf = (where: Field, rest: readonly (string | number)[]): string =>
  rest.reduce<string>(
    (text, segment) => {
      if (typeof segment === 'number') return `${text}[${segment}]`;
      return text === '' ? segment : `${text}.${segment}`;
    },
    where.label,
  );

const isUnusedKey = (issue: SchemaIssue): boolean => issue.keyword === 'additionalProperties' || issue.keyword === 'boolean';

/** A property name rejected by the contract's `propertyNames` (an option key). */
const isKeyIssue = (issue: SchemaIssue): boolean =>
  issue.schemaPath.endsWith('/propertyNames') && issue.path.length > 0 && issue.keyword !== 'propertyNames';

/**
 * Where an agent sits in an effective config: `agents.<name>` or `roles.<name>.agent`. Names are
 * data, so a node is identified by its full position, never by a segment that a name could equal.
 */
/** Path depth of an agent mapping: `agents.<name>`. */
const AGENTS_PATH_BASE = 2;
/** Path depth of a role's inline agent: `roles.<role>.agent`. */
const ROLE_AGENT_PATH_BASE = 3;
/** Segments after the agent base for an option: `client.options.<key>`. */
const OPTION_PATH_TAIL_LENGTH = 3;

function agentBase(path: readonly (string | number)[]): number {
  if (path[0] === 'agents' && path.length >= AGENTS_PATH_BASE) return AGENTS_PATH_BASE;
  if (path[0] === 'roles' && path[2] === 'agent' && path.length >= ROLE_AGENT_PATH_BASE) return ROLE_AGENT_PATH_BASE;
  return -1;
}

/** `<agent>.client`, with the issue pointing at the client node itself. */
function isClientNode(path: readonly (string | number)[]): boolean {
  const base = agentBase(path);
  return base !== -1 && path.length === base + 1 && path[base] === 'client';
}

/** `<agent>.client.options.<key>`. */
function isOptionEntry(path: readonly (string | number)[]): boolean {
  const base = agentBase(path);
  return base !== -1 && path.length === base + OPTION_PATH_TAIL_LENGTH && path[base] === 'client' && path[base + 1] === 'options';
}

/** Maps one schema issue to the code and path Migent has always reported for it. */
function translate(issue: SchemaIssue, where: Field): ConfigurationError {
  const rest = issue.path;
  const at = { label: labelOf(where, rest), path: [...where.path, ...rest] };
  if (isUnusedKey(issue)) {
    return new ConfigurationError(`${at.label} is not used by Migent.`, { code: 'unknown-key', path: at.path });
  }
  if (isKeyIssue(issue) && isOptionEntry(at.path)) {
    const parent = labelOf(where, rest.slice(0, -1));
    return new ConfigurationError(`Missing or invalid ${parent} key.`, { code: 'option-key-invalid', path: at.path });
  }
  if (isOptionEntry(at.path)) {
    return new ConfigurationError(`Missing or invalid ${at.label}.`, { code: 'option-invalid', path: at.path });
  }
  if (isClientNode(at.path) && typeof issue.value === 'string') {
    return new ConfigurationError(
      `${at.label} must be a mapping: use ${at.label}.type. Run \`migent migrate\`.`,
      { code: 'client-not-mapping', path: at.path },
    );
  }
  if (issue.keyword === 'type' && issue.message === 'must be array') {
    return new ConfigurationError(`${at.label} must be a list.`, { code: 'not-a-list', path: at.path });
  }
  return new ConfigurationError(`Missing or invalid ${at.label}.`, { code: 'missing-or-invalid', path: at.path });
}

function first(schema: TSchema, value: unknown, where: Field): ConfigurationError | null {
  const [issue] = schemaIssues(schema, value);
  return issue === undefined ? null : translate(issue, where);
}

/** Looks the verdict of a node up in the index. Only `agents` and `roles` nodes are indexed. */
function indexed(index: StructuralIndex | undefined, where: Field): ConfigurationError | null | undefined {
  if (index === undefined || (where.path[0] !== 'agents' && where.path[0] !== 'roles')) return undefined;
  return index.get(keyOf(where.path)) ?? null;
}

/**
 * Throws the structural error of a node. With an index the verdict comes from it. A node the
 * contract leaves optional but a consumer needs (`value` is absent) is still checked directly.
 */
function verdict(
  node: { index: StructuralIndex | undefined; where: Field },
  check: () => ConfigurationError | null,
  value?: unknown,
): void {
  const { index, where } = node;
  const known = indexed(index, where);
  const problem = known === undefined || (known === null && value === undefined) ? check() : known;
  if (problem !== null) throw problem;
}

// ---- per-node checks: each returns the error for one node, or null ----------------------------

const checkMapping = (value: unknown, where: Field) => first(ConfigMapping, value, where);
const checkString = (value: unknown, where: Field) => first(NonBlankString, value, where);

function checkClientNode(value: unknown, where: Field): ConfigurationError | null {
  if (typeof value === 'string') {
    return new ConfigurationError(
      `${where.label} must be a mapping: use ${where.label}.type. Run \`migent migrate\`.`,
      { code: 'client-not-mapping', path: where.path },
    );
  }
  return checkMapping(value, where);
}

/** One error per bad option entry, in entry order: a bad key first, then a bad value. */
function optionErrors(value: Record<string, unknown>, where: Field): Map<string, ConfigurationError> {
  const issues = schemaIssues(ClientOptions, value);
  const errors = new Map<string, ConfigurationError>();
  for (const key of Object.keys(value)) {
    const own = issues.filter((issue) => issue.path[0] === key);
    const keyIssue = own.find(isKeyIssue);
    const valueIssue = own.find((issue) => !isKeyIssue(issue));
    const at = [...where.path, key];
    if (keyIssue !== undefined) {
      errors.set(key, new ConfigurationError(`Missing or invalid ${where.label} key.`, { code: 'option-key-invalid', path: at }));
    } else if (valueIssue !== undefined) {
      errors.set(key, new ConfigurationError(`Missing or invalid ${where.label}.${key}.`, { code: 'option-invalid', path: at }));
    }
  }
  return errors;
}

const checkList = (value: unknown, where: Field): ConfigurationError | null => {
  const [issue] = schemaIssues(Responsibilities, value);
  if (issue === undefined) return null;
  return translate(issue, where);
};

// ---- readers: validate (or consult the index), then normalize ---------------------------------

export function mapping(value: unknown, where: Field, index?: StructuralIndex): Record<string, unknown> {
  verdict({ index, where }, () => checkMapping(value, where), value);
  return value as Record<string, unknown>;
}

/** A non-blank string, trimmed. */
export function requiredString(value: unknown, where: Field, index?: StructuralIndex): string {
  verdict({ index, where }, () => checkString(value, where), value);
  return (value as string).trim();
}

export function optionalString(value: unknown, where: Field, index?: StructuralIndex): string | undefined {
  return (value === null || value === undefined) ? undefined : requiredString(value, where, index);
}

/** Absent or null is an empty list. */
export function stringItems(raw: unknown, where: Field, index?: StructuralIndex): string[] {
  if ((raw === null || raw === undefined)) return [];
  verdict({ index, where }, () => checkList(raw, where));
  return (raw as string[]).map((item) => item.trim());
}

export function roleDescription(value: unknown, where: Field, index?: StructuralIndex): string {
  verdict({ index, where }, () => first(Description, value, where), value);
  return (value as string).trim();
}

export interface ClientFields {
  type: string | undefined;
  options: Record<string, string>;
  optionsSet: boolean;
}

/** Reads an agent's non-null `client` against the closed `ClientSelection` contract. */
export function readClient(value: unknown, clientField: Field, index?: StructuralIndex): ClientFields {
  verdict({ index, where: clientField }, () => checkClientNode(value, clientField), value);
  const clientConfig = value as Record<string, unknown>;
  for (const key of Object.keys(clientConfig)) {
    if (CLIENT_KEYS.includes(key)) continue;
    const at = { label: `${clientField.label}.${key}`, path: [...clientField.path, key] };
    verdict({ index, where: at }, () => new ConfigurationError(`${at.label} is not used by Migent.`, { code: 'unknown-key', path: at.path }));
  }
  const typeField = { label: `${clientField.label}.type`, path: [...clientField.path, 'type'] };
  const type = optionalString(clientConfig.type, typeField, index);
  const options = (clientConfig.options === null || clientConfig.options === undefined)
    ? {}
    : readOptions(clientConfig.options, { label: `${clientField.label}.options`, path: [...clientField.path, 'options'] }, index);
  return { type, options, optionsSet: (clientConfig.options !== null && clientConfig.options !== undefined) };
}

/** A non-null `client.options` mapping, validated against `ClientOptions` and trimmed. */
export function readOptions(value: unknown, where: Field, index?: StructuralIndex): Record<string, string> {
  verdict({ index, where }, () => checkMapping(value, where));
  const raw = value as Record<string, unknown>;
  const known = index === undefined ? undefined : new Map<string, ConfigurationError>();
  const errors = known ?? optionErrors(raw, where);
  if (known !== undefined) {
    for (const key of Object.keys(raw)) {
      const found = index!.get(keyOf([...where.path, key]));
      if (found !== undefined) known.set(key, found);
    }
  }
  for (const key of Object.keys(raw)) {
    const problem = errors.get(key);
    if (problem !== undefined) throw problem;
  }
  const options: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) options[key] = (item as string).trim();
  return options;
}

/** An `agents.<name>` entry that is exactly `{}`: a placeholder for a local mapping. */
export function isAgentPlaceholder(value: unknown): boolean {
  return isValid(AgentPlaceholder, value);
}

// ---- the whole-document pass ------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

const typeOfValue = (value: unknown): string => {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
};

/**
 * The instance path of the schema node a `schemaPath` reaches, with every `anyOf` branch that
 * does not describe the value dropped. A branch matches by JSON type, or is the first when none
 * does. This is how a union such as "named agent or placeholder" reports one set of issues.
 */
function onChosenBranches(issue: SchemaIssue, owner: readonly (string | number)[], root: unknown): boolean {
  const segments = issue.schemaPath.replace(/^#\/?/, '').split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  let node: unknown = EffectiveConfig;
  let depth = 0;
  for (let at = 0; at < segments.length; at += 1) {
    const segment = segments[at]!;
    const container = node as JsonSchema | unknown[];
    if (segment === 'anyOf') {
      const value = owner.slice(0, depth).reduce<unknown>(
        (current, key) => (typeof current === 'object' && current !== null ? (current as Record<string | number, unknown>)[key] : undefined),
        root,
      );
      const branches = (container as JsonSchema).anyOf as JsonSchema[];
      const matching = branches.findIndex((branch) => branch.type === typeOfValue(value));
      const chosen = matching === -1 ? 0 : matching;
      if (Number(segments[at + 1]) !== chosen) return false;
      node = branches[chosen];
      at += 1;
      continue;
    }
    if (segment === 'properties' || segment === 'patternProperties') {
      node = (container as JsonSchema)[segment];
      node = (node as JsonSchema)[segments[at + 1]!];
      at += 1;
      depth += 1;
      continue;
    }
    if (segment === 'items') depth += 1;
    node = (container as JsonSchema)[segment];
    if (node === undefined) break;
  }
  return true;
}

/**
 * One structural pass over an effective config, indexed by author path. The `EffectiveConfig`
 * contract is validated once; each issue is mapped to Migent's code and path. Nothing is emitted:
 * every check looks up the nodes it reads, so a bad `responsibilities` never hides the verdict on
 * `agent`. Placeholders (`agents.<n>` exactly `{}`) satisfy the contract and have no entries.
 */
export function buildStructuralIndex(config: Record<string, unknown>): StructuralIndex {
  const index = new Map<string, ConfigurationError>();
  const root: Field = { label: '', path: [] };
  for (const raw of schemaIssues(EffectiveConfig, config)) {
    if (raw.keyword === 'anyOf' || raw.keyword === 'additionalProperties' || raw.keyword === 'propertyNames') continue;
    if (!onChosenBranches(raw, raw.path, config)) continue;
    const required = raw.keyword === 'required' ? (raw.params.requiredProperties as string[]) : null;
    const issues = required === null ? [raw] : required.map((key) => ({ ...raw, path: [...raw.path, key] }));
    for (const issue of issues) {
      const key = keyOf(issue.path);
      const problem = translate(issue, root);
      const current = index.get(key);
      // A bad option key outranks a bad value at the same entry, as when options are read directly.
      if (current === undefined || (current.code === 'option-invalid' && problem.code === 'option-key-invalid')) {
        index.set(key, problem);
      }
    }
  }
  return index;
}

/** Container problems (`agents`, `roles`), read from the index. */
export function containerIssues(config: Record<string, unknown>): ConfigurationError[] {
  const index = buildStructuralIndex(config);
  const issues: ConfigurationError[] = [];
  if (index.has(keyOf(['agents']))) {
    issues.push(new ConfigurationError('Missing or invalid agents.', { code: 'agents-invalid', path: ['agents'] }));
  }
  if (index.has(keyOf(['roles']))) {
    issues.push(new ConfigurationError('Missing or invalid roles.', { code: 'roles-invalid', path: ['roles'] }));
  }
  return issues;
}
