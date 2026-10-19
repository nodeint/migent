import { loadModelTarget, loadRoleInstructions, resolveStageSpec } from "./config.js";
import { ConfigurationError } from "./errors.js";
import { isRecord } from "./record.js";
import type { StageSpec, WorkflowDocument } from "./workflow.js";
import { parseYamlDocument } from "./yaml.js";

const NAME = /^[A-Za-z][A-Za-z0-9._-]*$/;
const PLAIN_SCALAR = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const UNSET = Symbol("unset");

export class ConfigEditError extends ConfigurationError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigEditError";
  }
}

export interface StageRef {
  workflow: string;
  stage: string;
  modelName: string | null;
  options: Record<string, string>;
}

export interface ModelView {
  key: string;
  provider: string;
  model: string;
  options: Record<string, string>;
  roles: readonly string[];
  stages: readonly StageRef[];
}

export interface RoleView {
  role: string;
  modelName: string;
  provider: string;
  model: string;
  options: Record<string, string>;
  instructions: readonly string[];
  sharedWith: readonly string[];
  stages: readonly StageRef[];
}

export interface ConfigView {
  models: readonly ModelView[];
  roles: readonly RoleView[];
}

export interface StageShield {
  workflow: string;
  stage: string;
  ignores: readonly string[];
}

export interface ConfigChange {
  config: Record<string, unknown>;
  createdModel: string | null;
  reusedModel: string | null;
  updatedModel: string | null;
  roles: readonly string[];
  stagesUpdated: readonly (readonly [string, string])[];
  stagesUnchanged: readonly StageShield[];
  orphanedModels: readonly string[];
}

interface Block {
  key: string;
  indent: number;
  line: number;
  end: number;
  value: string;
  children: Block[];
}

type Edit = [number, number, string[]];
type ResolvedTarget = [string, string, [string, string][]];
type Binding = [unknown, [string, string][]];

export function inspectConfig(
  config: Record<string, unknown>,
  workflows: readonly WorkflowDocument[] = [],
): ConfigView {
  const models = modelsOf(config);
  const roles = rolesOf(config);
  const modelViews: ModelView[] = [];
  for (const key of Object.keys(models)) {
    const target = loadModelTarget(config, key);
    const usedBy = Object.keys(roles).filter((name) => {
      const role = roles[name];
      return isRecord(role) && role.default_model === key;
    });
    modelViews.push({
      key,
      provider: target.provider,
      model: target.model,
      options: { ...target.options },
      roles: usedBy,
      stages: stagesUsing(workflows, roles, key),
    });
  }
  const roleViews: RoleView[] = [];
  for (const [name, role] of Object.entries(roles)) {
    if (!isRecord(role)) throw new ConfigurationError(`Missing or invalid roles.${name}.`);
    const modelName = stringValue(role.default_model, `roles.${name}.default_model`);
    const target = loadModelTarget(config, modelName);
    const shared = Object.keys(roles).filter((other) => {
      if (other === name) return false;
      const otherRole = roles[other];
      return isRecord(otherRole) && otherRole.default_model === modelName;
    });
    roleViews.push({
      role: name,
      modelName,
      provider: target.provider,
      model: target.model,
      options: roleOptionMap(role),
      instructions: loadRoleInstructions(config, name),
      sharedWith: shared,
      stages: roleStages(workflows, name),
    });
  }
  return { models: modelViews, roles: roleViews };
}

export function upsertModel(
  config: Record<string, unknown>,
  key: string,
  args: {
    provider?: string | null;
    model?: string | null;
    options?: Record<string, string | null>;
    workflows?: readonly WorkflowDocument[];
  } = {},
): ConfigChange {
  const provider = args.provider === undefined ? null : args.provider;
  const model = args.model === undefined ? null : args.model;
  const options = args.options === undefined ? UNSET : args.options;
  if ((provider === null) !== (model === null)) {
    throw new ConfigEditError("Pass both --provider and --model, or omit both.");
  }
  const updated = copyConfig(config);
  const models = modelsOf(updated);
  const exists = Object.hasOwn(models, key);
  if (!exists) requireName(key, "name");
  if (!exists && provider === null) {
    throw new ConfigEditError("Pass --provider and --model to add a model.");
  }
  let body: Record<string, unknown>;
  if (exists) {
    const current = models[key];
    if (!isRecord(current)) throw new ConfigurationError(`Missing or invalid models.${key}.`);
    body = current;
  } else {
    body = {};
    models[key] = body;
  }
  if (provider !== null && model !== null) {
    body.provider = plain(provider, "--provider");
    body.model = plain(model, "--model");
  }
  if (options !== UNSET) applyModelOptions(body, key, options);
  return describeChange(config, updated, args.workflows ?? []);
}

export function assignRoles(
  config: Record<string, unknown>,
  roles: readonly string[],
  modelName: string,
  args: { workflows?: readonly WorkflowDocument[] } = {},
): ConfigChange {
  const names = roleNames(roles);
  const updated = copyConfig(config);
  const models = modelsOf(updated);
  if (!Object.hasOwn(models, modelName)) throw new ConfigEditError(`Unknown name: ${modelName}.`);
  const roleMap = rolesOf(updated);
  for (const name of names) {
    if (!Object.hasOwn(roleMap, name)) {
      requireName(name, "role");
      roleMap[name] = { default_model: modelName };
      continue;
    }
    const role = roleMap[name];
    if (!isRecord(role)) throw new ConfigurationError(`Missing or invalid roles.${name}.`);
    role.default_model = modelName;
  }
  return describeChange(config, updated, args.workflows ?? []);
}

export function setRoleOptions(
  config: Record<string, unknown>,
  role: string,
  options: Record<string, string | null>,
  args: { workflows?: readonly WorkflowDocument[] } = {},
): ConfigChange {
  requireName(role, "role");
  const updated = copyConfig(config);
  const roleMap = rolesOf(updated);
  const body = roleMap[role];
  if (!Object.hasOwn(roleMap, role) || !isRecord(body)) {
    throw new ConfigEditError(`Unknown role: ${role}.`);
  }
  applyRoleOptions(body, role, options);
  return describeChange(config, updated, args.workflows ?? []);
}

export function placeRoleModel(
  config: Record<string, unknown>,
  role: string,
  args: {
    provider: string;
    model: string;
    options?: Record<string, string | null>;
    workflows?: readonly WorkflowDocument[];
  },
): ConfigChange {
  requireName(role, "role");
  const providerName = plain(args.provider, "--provider");
  const modelId = plain(args.model, "--model");
  const options = args.options === undefined ? UNSET : args.options;
  const workflows = args.workflows ?? [];
  const updated = copyConfig(config);
  const models = modelsOf(updated);
  let match = matchingModelName(updated, { provider: providerName, model: modelId, options: {} });
  let created: string | null = null;
  let reused: string | null = null;
  if (match === null) {
    match = suggestModelName(updated, role);
    models[match] = { provider: providerName, model: modelId };
    created = match;
  } else {
    reused = match;
  }
  const roleMap = rolesOf(updated);
  if (!Object.hasOwn(roleMap, role)) {
    roleMap[role] = { default_model: match };
  } else {
    const body = roleMap[role];
    if (!isRecord(body)) throw new ConfigurationError(`Missing or invalid roles.${role}.`);
    body.default_model = match;
  }
  const roleBody = roleMap[role];
  if (options !== UNSET) {
    if (!isRecord(roleBody)) throw new ConfigurationError(`Missing or invalid roles.${role}.`);
    applyRoleOptions(roleBody, role, options);
  }
  const change = describeChange(config, updated, workflows, { reusedModel: reused });
  if (created !== null) return { ...change, createdModel: created, reusedModel: null };
  return change;
}

export function matchingModelName(
  config: Record<string, unknown>,
  args: { provider: string; model: string; options: Record<string, string> },
): string | null {
  const models = config.models;
  if (!isRecord(models)) throw new ConfigurationError("Missing or invalid models.");
  const wanted = { ...args.options };
  for (const key of Object.keys(models)) {
    let target;
    try {
      target = loadModelTarget(config, key);
    } catch (error) {
      if (error instanceof ConfigurationError) continue;
      throw error;
    }
    if (
      target.provider === args.provider &&
      target.model === args.model &&
      recordEqual(target.options, wanted)
    ) {
      return String(key);
    }
  }
  return null;
}

export function describeChange(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  workflows: readonly WorkflowDocument[] = [],
  args: { reusedModel?: string | null } = {},
): ConfigChange {
  const afterCopy = deepCopyRecord(after);
  const beforeRoles = mappingOrEmpty(before.roles);
  const afterRoles = mappingOrEmpty(afterCopy.roles);
  const beforeModels = mappingOrEmpty(before.models);
  const afterModels = mappingOrEmpty(afterCopy.models);
  const changedRoles = orderedKeys(afterRoles, beforeRoles).filter(
    (name) =>
      !bindingsEqual(binding(beforeRoles[name]), binding(afterRoles[name])) ||
      !resolvedEqual(resolvedRole(before, name), resolvedRole(afterCopy, name)),
  );
  const created = Object.keys(afterModels).filter((key) => !Object.hasOwn(beforeModels, key));
  const updated = Object.keys(afterModels).filter(
    (key) =>
      Object.hasOwn(beforeModels, key) &&
      !deepEqual(signature(beforeModels[key]), signature(afterModels[key])),
  );
  const createdModel = created.length === 1 ? created[0]! : null;
  const updatedModel = updated.length === 1 ? updated[0]! : null;
  let reusedModel = args.reusedModel ?? null;
  if (createdModel !== null || updatedModel !== null) reusedModel = null;
  const stagesUpdated: [string, string][] = [];
  const stagesUnchanged: StageShield[] = [];
  for (const document of workflows) {
    for (const stage of Object.values(document.stages)) {
      const beforeTarget = resolvedStage(before, stage);
      const afterTarget = resolvedStage(afterCopy, stage);
      if (!resolvedEqual(beforeTarget, afterTarget)) {
        stagesUpdated.push([document.id, stage.id]);
        continue;
      }
      const ignores = shields(stage, beforeRoles, afterRoles, beforeModels, afterModels, updated);
      if (ignores.length > 0) {
        stagesUnchanged.push({ workflow: document.id, stage: stage.id, ignores });
      }
    }
  }
  return {
    config: afterCopy,
    createdModel,
    reusedModel,
    updatedModel,
    roles: changedRoles,
    stagesUpdated,
    stagesUnchanged,
    orphanedModels: orphans(before, afterCopy, workflows),
  };
}

export function patchConfigText(original: string, updated: Record<string, unknown>): string {
  if (original.includes("\t")) throw new ConfigEditError("Cannot edit a config that uses tabs.");
  const current = parseYamlDocument(original);
  if (!isRecord(current)) throw new ConfigEditError("Invalid configuration: expected a mapping.");
  const lines = splitLines(original);
  const unit = indentUnit(lines);
  const blocks = parseBlocks(lines, unit);
  const edits: Edit[] = [];
  syncSchemaVersion(lines, updated, edits);
  syncModels(lines, blocks, current, updated, unit, edits);
  syncRoles(lines, blocks, current, updated, unit, edits);
  const numbered = edits.map((edit, order) => ({ order, edit }));
  numbered.sort((left, right) => {
    if (left.edit[0] !== right.edit[0]) return right.edit[0] - left.edit[0];
    if (left.edit[1] !== right.edit[1]) return right.edit[1] - left.edit[1];
    return right.order - left.order;
  });
  for (const { edit } of numbered) {
    const [start, end, replacement] = edit;
    lines.splice(start, end - start, ...replacement);
  }
  let text = lines.join("\n");
  if (original.endsWith("\n") || original === "") text += "\n";
  return text;
}

/** Quote a scalar the way Python `_yaml_scalar` does. Plain tokens stay bare. */
export function yamlScalar(value: string): string {
  if (PLAIN_SCALAR.test(value) && value !== "true" && value !== "false" && value !== "null") {
    return value;
  }
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${escaped}"`;
}

function syncModels(
  lines: string[],
  blocks: Block[],
  current: Record<string, unknown>,
  updated: Record<string, unknown>,
  unit: number,
  edits: Edit[],
): void {
  const currentModels = mappingOrEmpty(current.models);
  const updatedModels = mappingOrEmpty(updated.models);
  const section = topSection(blocks, "models");
  const fresh: string[] = [];
  for (const [key, body] of Object.entries(updatedModels)) {
    if (!isRecord(body)) throw new ConfigurationError(`Missing or invalid models.${key}.`);
    if (!Object.hasOwn(currentModels, key)) {
      fresh.push(...modelLines(key, body, unit, unit));
      continue;
    }
    if (section === null) throw new ConfigEditError("Cannot edit models in this file.");
    const block = childBlock(section, key);
    if (block === null) throw new ConfigEditError(`Cannot edit models.${key} in this file.`);
    syncScalar(lines, block, "provider", body.provider, `models.${key}.provider`, edits);
    syncScalar(lines, block, "model", body.model, `models.${key}.model`, edits);
    syncOptions(lines, block, currentModels[key], body, key, unit, edits);
    dropRemovedScalars(block, currentModels[key], body, edits);
  }
  if (fresh.length === 0) return;
  if (section === null) edits.push([0, 0, ["models:", ...fresh]]);
  else edits.push([section.end, section.end, fresh]);
}

function syncRoles(
  lines: string[],
  blocks: Block[],
  current: Record<string, unknown>,
  updated: Record<string, unknown>,
  unit: number,
  edits: Edit[],
): void {
  const currentRoles = mappingOrEmpty(current.roles);
  const updatedRoles = mappingOrEmpty(updated.roles);
  const section = topSection(blocks, "roles");
  const fresh: string[] = [];
  for (const [key, body] of Object.entries(updatedRoles)) {
    if (!isRecord(body)) throw new ConfigurationError(`Missing or invalid roles.${key}.`);
    if (!Object.hasOwn(currentRoles, key)) {
      fresh.push(...roleLines(key, body, unit, unit));
      continue;
    }
    if (section === null) throw new ConfigEditError("Cannot edit roles in this file.");
    const block = childBlock(section, key);
    if (block === null) throw new ConfigEditError(`Cannot edit roles.${key} in this file.`);
    syncScalar(lines, block, "default_model", body.default_model, `roles.${key}.default_model`, edits);
    syncRoleOptions(lines, block, currentRoles[key], body, key, unit, edits);
    dropRemovedScalars(block, currentRoles[key], body, edits);
  }
  if (fresh.length === 0) return;
  if (section === null) {
    edits.push([lines.length, lines.length, ["roles:", ...fresh]]);
    return;
  }
  edits.push([section.end, section.end, fresh]);
}

function syncSchemaVersion(lines: string[], updated: Record<string, unknown>, edits: Edit[]): void {
  const value = updated.schema_version;
  if (typeof value === "boolean" || typeof value !== "number" || !Number.isInteger(value)) return;
  const rendered = `schema_version: ${value}`;
  for (const block of parseBlocks(lines, indentUnit(lines))) {
    if (block.indent !== 0 || block.key !== "schema_version") continue;
    if (scalarText(block.value) === String(value)) return;
    edits.push([block.line, block.line + 1, [withValue(lines[block.line] ?? "", String(value))]]);
    return;
  }
  let insert = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (contentIndent(lines[index] ?? "") !== null) {
      insert = index;
      break;
    }
  }
  edits.push([insert, insert, [rendered, ""]]);
}

function dropRemovedScalars(
  parent: Block,
  beforeBody: unknown,
  afterBody: Record<string, unknown>,
  edits: Edit[],
): void {
  if (!isRecord(beforeBody)) return;
  for (const [key, value] of Object.entries(beforeBody)) {
    if (Object.hasOwn(afterBody, key) || isRecord(value) || Array.isArray(value)) continue;
    const found = childBlock(parent, key);
    if (found === null || found.value.trim() === "") continue;
    edits.push([found.line, found.line + 1, []]);
  }
}

function syncScalar(
  lines: string[],
  parent: Block,
  key: string,
  value: unknown,
  field: string,
  edits: Edit[],
): void {
  const found = childBlock(parent, key);
  if (found === null) throw new ConfigEditError(`Cannot edit ${field} in this file.`);
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationError(`Missing or invalid ${field}.`);
  }
  if (scalarText(found.value) === value) return;
  edits.push([found.line, found.line + 1, [withValue(lines[found.line] ?? "", value)]]);
}

function syncOptions(
  lines: string[],
  parent: Block,
  beforeBody: unknown,
  afterBody: Record<string, unknown>,
  key: string,
  unit: number,
  edits: Edit[],
): void {
  syncOptionMap(
    lines,
    parent,
    optionsDict(beforeBody, key),
    optionsDict(afterBody, key),
    `models.${key}.options`,
    unit,
    edits,
  );
}

function syncRoleOptions(
  lines: string[],
  roleBlock: Block,
  beforeBody: unknown,
  afterBody: Record<string, unknown>,
  key: string,
  unit: number,
  edits: Edit[],
): void {
  syncOptionMap(
    lines,
    roleBlock,
    roleOptionMap(isRecord(beforeBody) ? beforeBody : {}),
    roleOptionMap(afterBody),
    `roles.${key}.options`,
    unit,
    edits,
  );
}

function syncOptionMap(
  lines: string[],
  parent: Block,
  before: Record<string, string>,
  after: Record<string, string>,
  field: string,
  unit: number,
  edits: Edit[],
): void {
  if (recordEqual(before, after)) return;
  const options = childBlock(parent, "options");
  if (options !== null && options.value.trim() !== "") {
    throw new ConfigEditError(`Cannot edit ${field} in this file.`);
  }
  if (Object.keys(after).length === 0) {
    if (options !== null) edits.push([options.line, options.end, []]);
    return;
  }
  if (options === null) {
    const indent = " ".repeat(parent.indent + unit);
    const nested = " ".repeat(parent.indent + unit * 2);
    const body = [`${indent}options:`];
    for (const name of sortedKeys(after)) body.push(`${nested}${name}: ${yamlScalar(after[name] ?? "")}`);
    edits.push([parent.end, parent.end, body]);
    return;
  }
  for (const name of sortedKeys(before).filter((key) => !Object.hasOwn(after, key))) {
    const found = childBlock(options, name);
    if (found !== null) edits.push([found.line, found.end, []]);
  }
  for (const name of sortedKeys(after)) {
    const found = childBlock(options, name);
    if (found === null) {
      const rendered = `${" ".repeat(options.indent + unit)}${name}: ${yamlScalar(after[name] ?? "")}`;
      edits.push([options.end, options.end, [rendered]]);
      continue;
    }
    if (scalarText(found.value) !== after[name]) {
      edits.push([found.line, found.line + 1, [withValue(lines[found.line] ?? "", after[name] ?? "")]]);
    }
  }
}

function modelLines(key: string, body: Record<string, unknown>, indent: number, unit: number): string[] {
  const parent = " ".repeat(indent);
  const child = " ".repeat(indent + unit);
  const lines = [
    `${parent}${key}:`,
    `${child}provider: ${yamlScalar(stringValue(body.provider, `models.${key}.provider`))}`,
    `${child}model: ${yamlScalar(stringValue(body.model, `models.${key}.model`))}`,
  ];
  const options = optionsDict(body, key);
  if (Object.keys(options).length > 0) {
    lines.push(`${child}options:`);
    const nested = " ".repeat(indent + unit * 2);
    for (const [option, value] of Object.entries(options)) {
      lines.push(`${nested}${option}: ${yamlScalar(value)}`);
    }
  }
  return lines;
}

function roleLines(key: string, body: Record<string, unknown>, indent: number, unit: number): string[] {
  const parent = " ".repeat(indent);
  const child = " ".repeat(indent + unit);
  const lines = [
    `${parent}${key}:`,
    `${child}default_model: ${yamlScalar(stringValue(body.default_model, `roles.${key}.default_model`))}`,
  ];
  const roleOptions = roleOptionMap(body);
  if (Object.keys(roleOptions).length > 0) {
    lines.push(`${child}options:`);
    const nested = " ".repeat(indent + unit * 2);
    for (const [name, value] of Object.entries(roleOptions)) {
      lines.push(`${nested}${name}: ${yamlScalar(value)}`);
    }
  }
  return lines;
}

function parseBlocks(lines: string[], unit: number): Block[] {
  return parseLevel(lines, 0, lines.length, 0, unit);
}

function parseLevel(lines: string[], start: number, end: number, indent: number, unit: number): Block[] {
  const blocks: Block[] = [];
  let index = start;
  while (index < end) {
    const found = nextContent(lines, index, end);
    if (found === null) break;
    const [lineIndex, lineIndent] = found;
    if (lineIndent < indent) break;
    if (lineIndent > indent) throw new ConfigEditError(`Invalid YAML indent at line ${lineIndex + 1}.`);
    const [key, value] = splitKey(lines[lineIndex] ?? "", lineIndex);
    let childEnd = lineIndex + 1;
    while (childEnd < end) {
      const later = nextContent(lines, childEnd, end);
      if (later === null) {
        childEnd = end;
        break;
      }
      const [laterIndex, laterIndent] = later;
      if (laterIndent <= indent) {
        childEnd = laterIndex;
        break;
      }
      childEnd = laterIndex + 1;
    }
    const children =
      value.trim() === "" && !isSequence(lines, lineIndex + 1, childEnd, indent + unit)
        ? parseLevel(lines, lineIndex + 1, childEnd, indent + unit, unit)
        : [];
    blocks.push({ key, indent, line: lineIndex, end: childEnd, value, children });
    index = childEnd;
  }
  return blocks;
}

function isSequence(lines: string[], start: number, end: number, indent: number): boolean {
  const found = nextContent(lines, start, end);
  if (found === null) return false;
  const [lineIndex, lineIndent] = found;
  if (lineIndent !== indent) return false;
  const [code] = splitComment(lines[lineIndex] ?? "");
  return code.trimStart().startsWith("-");
}

function nextContent(lines: string[], start: number, end: number): [number, number] | null {
  for (let index = start; index < end; index += 1) {
    const indent = contentIndent(lines[index] ?? "");
    if (indent !== null) return [index, indent];
  }
  return null;
}

function contentIndent(line: string): number | null {
  const [code] = splitComment(line);
  if (code.trim() === "") return null;
  return code.length - code.trimStart().length;
}

function splitKey(line: string, index: number): [string, string] {
  const [code] = splitComment(line);
  const colon = code.indexOf(":");
  if (colon < 0) throw new ConfigEditError(`Invalid YAML mapping at line ${index + 1}.`);
  const key = code.slice(0, colon).trim();
  if (key === "") throw new ConfigEditError(`Invalid YAML key at line ${index + 1}.`);
  return [key, code.slice(colon + 1).trim()];
}

function splitComment(line: string): [string, string] {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === "#" && !inSingle && !inDouble) {
      return [line.slice(0, index).trimEnd(), line.slice(index)];
    }
  }
  return [line.trimEnd(), ""];
}

function withValue(line: string, value: string): string {
  const [code, comment] = splitComment(line);
  const colon = code.indexOf(":");
  const key = colon < 0 ? code : code.slice(0, colon);
  const updated = `${key}: ${yamlScalar(value)}`;
  // Keep the space Python inserts before `#`. yaml Document emits only one.
  if (comment !== "") return `${updated} ${comment}`;
  return updated;
}

function topSection(blocks: Block[], key: string): Block | null {
  for (const block of blocks) {
    if (block.indent === 0 && block.key === key) return block;
  }
  return null;
}

function childBlock(parent: Block, key: string): Block | null {
  for (const child of parent.children) {
    if (child.key === key) return child;
  }
  return null;
}

function indentUnit(lines: string[]): number {
  const indents: number[] = [];
  for (const line of lines) {
    const indent = contentIndent(line);
    if (indent !== null && indent > 0) indents.push(indent);
  }
  if (indents.length === 0) return 2;
  return Math.min(...indents);
}

function stagesUsing(
  workflows: readonly WorkflowDocument[],
  roles: Record<string, unknown>,
  modelName: string,
): StageRef[] {
  const found: StageRef[] = [];
  for (const document of workflows) {
    for (const stage of Object.values(document.stages)) {
      let key: unknown = stage.modelName;
      if (key === null) {
        const role = roles[stage.role];
        if (isRecord(role)) key = role.default_model;
      }
      if (key === modelName) {
        found.push({ workflow: document.id, stage: stage.id, modelName: null, options: {} });
      }
    }
  }
  return found;
}

function roleStages(workflows: readonly WorkflowDocument[], role: string): StageRef[] {
  const found: StageRef[] = [];
  for (const document of workflows) {
    for (const stage of Object.values(document.stages)) {
      if (stage.role !== role) continue;
      found.push({
        workflow: document.id,
        stage: stage.id,
        modelName: stage.modelName,
        options: { ...stage.options },
      });
    }
  }
  return found;
}

function shields(
  stage: StageSpec,
  beforeRoles: Record<string, unknown>,
  afterRoles: Record<string, unknown>,
  beforeModels: Record<string, unknown>,
  afterModels: Record<string, unknown>,
  updatedModels: readonly string[],
): string[] {
  const beforeBinding = binding(beforeRoles[stage.role]);
  const afterBinding = binding(afterRoles[stage.role]);
  const ignores: string[] = [];
  if (stage.modelName !== null && beforeBinding[0] !== afterBinding[0]) ignores.push("role-model");
  if (
    Object.keys(stage.options).length > 0 &&
    (!deepEqual(beforeBinding[1], afterBinding[1]) ||
      modelOptionsChanged(stage, afterBinding, beforeModels, afterModels, updatedModels))
  ) {
    ignores.push("role-options");
  }
  return ignores;
}

function modelOptionsChanged(
  stage: StageSpec,
  afterBinding: Binding,
  beforeModels: Record<string, unknown>,
  afterModels: Record<string, unknown>,
  updatedModels: readonly string[],
): boolean {
  const named = stage.modelName ? stage.modelName : afterBinding[0];
  if (typeof named !== "string" || !updatedModels.includes(named)) return false;
  return !recordEqual(optionsDict(beforeModels[named], named), optionsDict(afterModels[named], named));
}

function orphans(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  workflows: readonly WorkflowDocument[],
): string[] {
  const afterRefs = references(after, workflows);
  const removed = new Set([...references(before, workflows)].filter((key) => !afterRefs.has(key)));
  const models = mappingOrEmpty(after.models);
  return Object.keys(models).filter((key) => removed.has(key));
}

function references(config: Record<string, unknown>, workflows: readonly WorkflowDocument[]): Set<string> {
  const found = new Set<string>();
  for (const role of Object.values(mappingOrEmpty(config.roles))) {
    if (isRecord(role) && typeof role.default_model === "string") found.add(role.default_model);
  }
  for (const document of workflows) {
    for (const stage of Object.values(document.stages)) {
      if (stage.modelName) found.add(stage.modelName);
    }
  }
  return found;
}

function resolvedRole(config: Record<string, unknown>, role: string): ResolvedTarget | null {
  const roles = config.roles;
  if (!isRecord(roles) || !Object.hasOwn(roles, role)) return null;
  try {
    const body = roles[role];
    const modelName = stringValue(
      isRecord(body) ? body.default_model : undefined,
      `roles.${role}.default_model`,
    );
    const target = loadModelTarget(config, modelName);
    const merged = { ...target.options };
    if (isRecord(body)) Object.assign(merged, roleOptionMap(body));
    return [target.provider, target.model, sortedItems(merged)];
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

function resolvedStage(config: Record<string, unknown>, stage: StageSpec): ResolvedTarget | null {
  try {
    const target = resolveStageSpec(config, stage);
    return [target.provider, target.model, sortedItems(target.options)];
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

function binding(role: unknown): Binding {
  if (!isRecord(role)) return [null, []];
  const modelName = Object.hasOwn(role, "default_model") ? role.default_model : null;
  return [modelName ?? null, sortedItems(roleOptionMap(role))];
}

function signature(body: unknown): unknown[] {
  if (!isRecord(body)) return [body];
  const options = body.options;
  const rendered = isRecord(options)
    ? Object.entries(options)
        .map(([key, value]) => [String(key), String(value)] as [string, string])
        .sort(comparePair)
    : [];
  return [body.provider ?? null, body.model ?? null, rendered];
}

function applyModelOptions(body: Record<string, unknown>, key: string, updates: unknown): void {
  if (!isRecord(updates)) throw new ConfigEditError("Options must be a mapping.");
  const options = optionRecord(body.options, `Missing or invalid models.${key}.options.`);
  writeOptions(options, updates);
  if (Object.keys(options).length > 0) body.options = options;
  else delete body.options;
}

function applyRoleOptions(role: Record<string, unknown>, name: string, updates: unknown): void {
  if (!isRecord(updates)) throw new ConfigEditError("Options must be a mapping.");
  const options = optionRecord(role.options, `Missing or invalid roles.${name}.options.`);
  writeOptions(options, updates);
  if (Object.keys(options).length > 0) role.options = options;
  else delete role.options;
}

function optionRecord(value: unknown, field: string): Record<string, unknown> {
  if (value == null) return {};
  if (!isRecord(value)) throw new ConfigurationError(field);
  return value;
}

function writeOptions(options: Record<string, unknown>, updates: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(updates)) {
    if (name.trim() === "") throw new ConfigEditError("Option name is required.");
    if (value === null) {
      delete options[name];
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") throw new ConfigEditError(`${name} is required.`);
    options[name] = value.trim();
  }
}

function roleOptionMap(role: Record<string, unknown>): Record<string, string> {
  const options = role.options;
  if (options == null) return {};
  if (!isRecord(options)) throw new ConfigurationError("Missing or invalid roles.<role>.options.");
  return stringMap(options);
}

function optionsDict(body: unknown, key: string): Record<string, string> {
  if (!isRecord(body)) return {};
  const options = body.options;
  if (options == null) return {};
  if (!isRecord(options)) throw new ConfigurationError(`Missing or invalid models.${key}.options.`);
  return stringMap(options);
}

function stringMap(options: Record<string, unknown>): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === "string" && value.trim() !== "") parsed[key] = value.trim();
  }
  return parsed;
}

function copyConfig(config: Record<string, unknown>): Record<string, unknown> {
  const copied = deepCopyRecord(config);
  modelsOf(copied);
  rolesOf(copied);
  return copied;
}

function modelsOf(config: Record<string, unknown>): Record<string, unknown> {
  const value = config.models;
  if (!isRecord(value)) throw new ConfigurationError("Missing or invalid models.");
  return value;
}

function rolesOf(config: Record<string, unknown>): Record<string, unknown> {
  const value = config.roles;
  if (!isRecord(value)) throw new ConfigurationError("Missing or invalid roles.");
  return value;
}

function mappingOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function roleNames(roles: readonly string[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const role of roles) {
    if (!role || role.trim() === "") continue;
    const trimmed = role.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    names.push(trimmed);
  }
  if (names.length === 0) throw new ConfigEditError("Pass a role.");
  for (const name of names) requireName(name, "role");
  return names;
}

function requireName(value: string, label: string): void {
  if (!NAME.test(value)) throw new ConfigEditError(`Invalid ${label}: ${value}.`);
}

function plain(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigEditError(`Missing or invalid ${field}.`);
  }
  return value.trim();
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationError(`Missing or invalid ${field}.`);
  }
  return value.trim();
}

function scalarText(value: string): string {
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function suggestModelName(config: Record<string, unknown>, role: string): string {
  const models = config.models;
  const taken = isRecord(models) ? models : {};
  const base = NAME.test(role) ? role : "model";
  if (!Object.hasOwn(taken, base)) return base;
  let index = 2;
  while (Object.hasOwn(taken, `${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function orderedKeys(...maps: Record<string, unknown>[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const map of maps) {
    for (const key of Object.keys(map)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

function sortedKeys(record: Record<string, string>): string[] {
  return Object.keys(record).sort(compareString);
}

function sortedItems(record: Record<string, string>): [string, string][] {
  return Object.entries(record).sort(comparePair);
}

function compareString(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function comparePair(left: [string, string], right: [string, string]): number {
  return compareString(left[0], right[0]) || compareString(left[1], right[1]);
}

function bindingsEqual(left: Binding, right: Binding): boolean {
  return left[0] === right[0] && deepEqual(left[1], right[1]);
}

function resolvedEqual(left: ResolvedTarget | null, right: ResolvedTarget | null): boolean {
  if (left === null || right === null) return left === right;
  return left[0] === right[0] && left[1] === right[1] && deepEqual(left[2], right[2]);
}

function recordEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

function deepCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => deepCopy(item));
  if (isRecord(value)) return deepCopyRecord(value);
  return value;
}

function deepCopyRecord(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) copy[key] = deepCopy(item);
  return copy;
}

// Python str.splitlines(): `\r\n` is one break, and a trailing break does not yield an empty line.
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
