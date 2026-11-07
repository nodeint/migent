import { stringify } from "yaml";
import type { ClientRegistry } from "./cli-client.js";
import { loadAgentTarget, loadRoleDescription, loadRoleResponsibilities, resolveRoleCascade, resolveStageSpec } from "./config.js";
import { ConfigurationError } from "./errors.js";
import { isRecord } from "./record.js";
import { isRoleStage, type RoleStageSpec, type WorkflowDocument } from "./workflow.js";
import { liftConfigAgents } from "./migration-config.js";
import { parseYamlDocument } from "./yaml.js";
import { renderAuthoringYaml } from "./authoring.js";

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
  agent: string | null;
  options: Record<string, string>;
}

export interface AgentView {
  key: string;
  client: string;
  model: string;
  options: Record<string, string>;
  roles: readonly string[];
  stages: readonly StageRef[];
}

export interface RoleView {
  role: string;
  description: string | null;
  agentName: string | null;
  client: string;
  model: string;
  options: Record<string, string>;
  responsibilities: readonly string[];
  sharedWith: readonly string[];
  stages: readonly StageRef[];
}

export interface ConfigView {
  agents: readonly AgentView[];
  roles: readonly RoleView[];
}

export interface StageShield {
  workflow: string;
  stage: string;
  ignores: readonly string[];
}

export interface ConfigChange {
  config: Record<string, unknown>;
  createdAgent: string | null;
  reusedAgent: string | null;
  updatedAgent: string | null;
  roles: readonly string[];
  stagesUpdated: readonly (readonly [string, string])[];
  stagesUnchanged: readonly StageShield[];
  orphanedAgents: readonly string[];
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
  registry?: ClientRegistry,
): ConfigView {
  const agents = agentsOf(config);
  const roles = rolesOf(config);
  const agentViews: AgentView[] = [];
  for (const key of Object.keys(agents)) {
    const target = loadAgentTarget(config, key, registry);
    const usedBy = Object.keys(roles).filter((name) => {
      const role = roles[name];
      return isRecord(role) && role.agent === key;
    });
    agentViews.push({
      key,
      client: target.client,
      model: target.model,
      options: { ...target.options },
      roles: usedBy,
      stages: stagesUsing(workflows, roles, key),
    });
  }
  const roleViews: RoleView[] = [];
  for (const [name, role] of Object.entries(roles)) {
    if (!isRecord(role)) throw new ConfigurationError(`Missing or invalid roles.${name}.`);
    const agentName = typeof role.agent === "string" ? role.agent : null;
    const target = resolveRoleCascade(config, name, undefined, registry);
    const shared = Object.keys(roles).filter((other) => {
      if (other === name) return false;
      const otherRole = roles[other];
      return agentName !== null && isRecord(otherRole) && otherRole.agent === agentName;
    });
    roleViews.push({
      role: name,
      description: loadRoleDescription(config, name),
      agentName,
      client: target.client,
      model: target.model,
      options: { ...target.options },
      responsibilities: loadRoleResponsibilities(config, name),
      sharedWith: shared,
      stages: roleStages(workflows, name),
    });
  }
  return { agents: agentViews, roles: roleViews };
}

export function upsertAgent(
  config: Record<string, unknown>,
  key: string,
  args: {
    client?: string | null;
    model?: string | null;
    options?: Record<string, string | null>;
    workflows?: readonly WorkflowDocument[];
    registry?: ClientRegistry;
  } = {},
): ConfigChange {
  const client = args.client === undefined ? null : args.client;
  const model = args.model === undefined ? null : args.model;
  const options = args.options === undefined ? UNSET : args.options;
  if ((client === null) !== (model === null)) {
    throw new ConfigEditError("Pass both --client and --model, or omit both.");
  }
  const updated = copyConfig(config);
  const agents = agentsOf(updated);
  const exists = Object.hasOwn(agents, key);
  if (!exists) requireName(key, "name");
  if (!exists && client === null) {
    throw new ConfigEditError("Pass --client and --model to add an agent.");
  }
  let body: Record<string, unknown>;
  if (exists) {
    const current = agents[key];
    if (!isRecord(current)) throw new ConfigurationError(`Missing or invalid agents.${key}.`);
    body = current;
  } else {
    body = {};
    agents[key] = body;
  }
  if (client !== null && model !== null) {
    setAgentClient(body, plain(client, "--client"));
    body.model = plain(model, "--model");
  }
  if (options !== UNSET) applyAgentOptions(body, key, options);
  return describeChange(config, updated, args.workflows ?? [], { registry: args.registry });
}

export function assignRoles(
  config: Record<string, unknown>,
  roles: readonly string[],
  agentName: string,
  args: { workflows?: readonly WorkflowDocument[]; registry?: ClientRegistry } = {},
): ConfigChange {
  const names = roleNames(roles);
  const updated = copyConfig(config);
  const agents = agentsOf(updated);
  if (!Object.hasOwn(agents, agentName)) throw new ConfigEditError(`Unknown name: ${agentName}.`);
  const roleMap = rolesOf(updated);
  for (const name of names) {
    if (!Object.hasOwn(roleMap, name)) {
      requireName(name, "role");
      roleMap[name] = { agent: agentName };
      continue;
    }
    const role = roleMap[name];
    if (!isRecord(role)) throw new ConfigurationError(`Missing or invalid roles.${name}.`);
    role.agent = agentName;
  }
  return describeChange(config, updated, args.workflows ?? [], { registry: args.registry });
}

export function placeRoleAgent(
  config: Record<string, unknown>,
  role: string,
  args: {
    client: string;
    model: string;
    options?: Record<string, string | null>;
    workflows?: readonly WorkflowDocument[];
    registry?: ClientRegistry;
  },
): ConfigChange {
  requireName(role, "role");
  const clientName = plain(args.client, "--client");
  const modelId = plain(args.model, "--model");
  const options = args.options === undefined ? UNSET : args.options;
  const workflows = args.workflows ?? [];
  const updated = copyConfig(config);
  const agents = agentsOf(updated);
  const definition: Record<string, unknown> = { client: { type: clientName }, model: modelId };
  if (options !== UNSET) applyAgentOptions(definition, role, options);
  let match = matchingAgentName(updated, {
    client: clientName, model: modelId, options: optionsDict(definition, role),
  }, args.registry);
  let created: string | null = null;
  let reused: string | null = null;
  if (match === null) {
    match = suggestAgentName(updated, role);
    agents[match] = definition;
    created = match;
  } else {
    reused = match;
  }
  const roleMap = rolesOf(updated);
  if (!Object.hasOwn(roleMap, role)) {
    roleMap[role] = { agent: match };
  } else {
    const body = roleMap[role];
    if (!isRecord(body)) throw new ConfigurationError(`Missing or invalid roles.${role}.`);
    body.agent = match;
  }
  const change = describeChange(config, updated, workflows, { reusedAgent: reused, registry: args.registry });
  if (created !== null) return { ...change, createdAgent: created, reusedAgent: null };
  return change;
}

export function matchingAgentName(
  config: Record<string, unknown>,
  args: { client: string; model: string; options: Record<string, string> },
  registry?: ClientRegistry,
): string | null {
  const agents = agentsOf(config);
  const wanted = { ...args.options };
  for (const key of Object.keys(agents)) {
    let target;
    try {
      target = loadAgentTarget(config, key, registry);
    } catch (error) {
      if (error instanceof ConfigurationError) continue;
      throw error;
    }
    if (
      target.client === args.client &&
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
  args: { reusedAgent?: string | null; registry?: ClientRegistry } = {},
): ConfigChange {
  const afterCopy = deepCopyRecord(after);
  const beforeRoles = mappingOrEmpty(before.roles);
  const afterRoles = mappingOrEmpty(afterCopy.roles);
  const beforeAgents = mappingOrEmpty(before.agents);
  const afterAgents = mappingOrEmpty(afterCopy.agents);
  const changedRoles = orderedKeys(afterRoles, beforeRoles).filter(
    (name) =>
      !bindingsEqual(binding(beforeRoles[name]), binding(afterRoles[name])) ||
      !resolvedEqual(resolvedRole(before, name, args.registry), resolvedRole(afterCopy, name, args.registry)),
  );
  const created = Object.keys(afterAgents).filter((key) => !Object.hasOwn(beforeAgents, key));
  const updated = Object.keys(afterAgents).filter(
    (key) =>
      Object.hasOwn(beforeAgents, key) &&
      !deepEqual(signature(beforeAgents[key]), signature(afterAgents[key])),
  );
  const createdAgent = created.length === 1 ? created[0]! : null;
  const updatedAgent = updated.length === 1 ? updated[0]! : null;
  let reusedAgent = args.reusedAgent ?? null;
  if (createdAgent !== null || updatedAgent !== null) reusedAgent = null;
  const stagesUpdated: [string, string][] = [];
  const stagesUnchanged: StageShield[] = [];
  for (const document of workflows) {
    for (const stage of Object.values(document.stages)) {
      if (!isRoleStage(stage)) continue;
      const beforeTarget = resolvedStage(before, stage, args.registry);
      const afterTarget = resolvedStage(afterCopy, stage, args.registry);
      if (!resolvedEqual(beforeTarget, afterTarget)) {
        stagesUpdated.push([document.id, stage.id]);
        continue;
      }
      const ignores = shields(stage, beforeRoles, afterRoles, beforeAgents, afterAgents, updated);
      if (ignores.length > 0) {
        stagesUnchanged.push({ workflow: document.id, stage: stage.id, ignores });
      }
    }
  }
  return {
    config: afterCopy,
    createdAgent,
    reusedAgent,
    updatedAgent,
    roles: changedRoles,
    stagesUpdated,
    stagesUnchanged,
    orphanedAgents: orphans(before, afterCopy, workflows),
  };
}

export function patchConfigText(original: string, updated: Record<string, unknown>): string {
  if (original.includes("\t")) throw new ConfigEditError("Cannot edit a config that uses tabs.");
  let current = parseYamlDocument(original);
  if (!isRecord(current)) throw new ConfigEditError("Invalid configuration: expected a mapping.");
  if (isLegacyShape(current)) {
    // Lift a schema_version 4 document to the v5 structure first, so the sync below sees one shape.
    original = upgradeConfigText(original, current);
    updated = deepCopyRecord(updated);
    liftConfigAgents(updated);
    current = parseYamlDocument(original);
    if (!isRecord(current)) throw new ConfigEditError("Invalid configuration: expected a mapping.");
  }
  const lines = splitLines(original);
  const unit = indentUnit(lines);
  const blocks = parseBlocks(lines, unit);
  const edits: Edit[] = [];
  syncSchemaVersion(lines, updated, edits);
  syncAgents(lines, blocks, current, updated, unit, edits);
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
  if (!deepEqual(parseYamlDocument(text), updated)) {
    throw new ConfigEditError("Config text does not match the updated document.");
  }
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

function syncAgents(
  lines: string[],
  blocks: Block[],
  current: Record<string, unknown>,
  updated: Record<string, unknown>,
  unit: number,
  edits: Edit[],
): void {
  const currentAgents = mappingOrEmpty(current.agents);
  const updatedAgents = mappingOrEmpty(updated.agents);
  const section = topSection(blocks, "agents");
  const fresh: string[] = [];
  for (const [key, body] of Object.entries(updatedAgents)) {
    if (!isRecord(body)) throw new ConfigurationError(`Missing or invalid agents.${key}.`);
    if (!Object.hasOwn(currentAgents, key)) {
      fresh.push(...agentLines(key, body, unit, unit));
      continue;
    }
    if (section === null) throw new ConfigEditError("Cannot edit agents in this file.");
    const block = childBlock(section, key);
    if (block === null) throw new ConfigEditError(`Cannot edit agents.${key} in this file.`);
    if (Object.keys(body).length === 0 && isRecord(currentAgents[key]) && Object.keys(currentAgents[key]).length > 0) {
      edits.push([block.line, block.end, [withValue(lines[block.line] ?? "", "{}")]]);
      continue;
    }
    if (Object.hasOwn(body, "model")) syncScalar(lines, block, "model", body.model, `agents.${key}.model`, edits);
    syncAgentClient(lines, block, key, currentAgents[key], body, unit, edits);
    dropRemovedScalars(block, currentAgents[key], body, edits);
  }
  if (fresh.length === 0) return;
  if (section === null) edits.push([0, 0, ["agents:", ...fresh]]);
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
    const previous = currentRoles[key];
    if (isRecord(body.agent) || (isRecord(previous) && isRecord(previous.agent))) {
      const found = childBlock(block, "agent");
      if (!found) throw new ConfigEditError(`Cannot edit roles.${key}.agent in this file.`);
      if (!isRecord(previous) || !deepEqual(previous.agent, body.agent)) {
        if (isRecord(previous) && isRecord(previous.agent) && isRecord(body.agent)) {
          // Reuse the field patchers so unchanged values keep their comments and order.
          if (body.agent.model !== previous.agent.model) {
            syncScalar(lines, found, "model", body.agent.model, `roles.${key}.agent.model`, edits);
          }
          syncAgentClient(lines, found, key, previous.agent, body.agent, unit, edits);
          dropRemovedScalars(found, previous.agent, body.agent, edits);
        } else {
          const indent = block.indent + unit;
          const base = lines.slice(found.line, found.end).map((line) => line.slice(indent)).join("\n");
          const result = renderAuthoringYaml({ agent: body.agent }, base);
          if (!result.preserved) throw new ConfigEditError(`Cannot preserve roles.${key}.agent: ${result.reason}.`);
          const rendered = result.text.trimEnd().split("\n").map((line) => " ".repeat(indent) + line);
          edits.push([found.line, found.end, rendered]);
        }
      }
    } else if (Object.hasOwn(body, "agent")) {
      syncScalar(lines, block, "agent", body.agent, `roles.${key}.agent`, edits);
    }
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

function syncAgentClient(
  lines: string[],
  parent: Block,
  key: string,
  beforeBody: unknown,
  afterBody: Record<string, unknown>,
  unit: number,
  edits: Edit[],
): void {
  const before = optionsDict(beforeBody, key);
  const after = optionsDict(afterBody, key);
  const afterClient = isRecord(afterBody.client) ? afterBody.client : {};
  const type = typeof afterClient.type === "string" && afterClient.type.trim() !== ""
    ? afterClient.type.trim()
    : undefined;
  const beforeClient = isRecord(beforeBody) && isRecord(beforeBody.client) ? beforeBody.client : {};
  const beforeType = typeof beforeClient.type === "string" && beforeClient.type.trim() !== ""
    ? beforeClient.type.trim()
    : undefined;
  if (recordEqual(before, after) && type === beforeType) return;
  const client = childBlock(parent, "client");
  if (client !== null) {
    if (client.value.trim() !== "") throw new ConfigEditError(`Cannot edit agents.${key}.client in this file.`);
    if (type !== undefined) syncClientType(lines, client, type, key, unit, edits);
    syncOptionMap(lines, client, before, after, `agents.${key}.client.options`, unit, edits);
    return;
  }
  if (type === undefined && Object.keys(after).length === 0) return;
  edits.push([parent.end, parent.end, clientLines(type, after, parent.indent + unit, unit)]);
}

function syncClientType(
  lines: string[],
  client: Block,
  value: string,
  key: string,
  unit: number,
  edits: Edit[],
): void {
  const found = childBlock(client, "type");
  if (found === null) {
    const indent = " ".repeat(client.indent + unit);
    edits.push([client.line + 1, client.line + 1, [`${indent}type: ${yamlScalar(value)}`]]);
    return;
  }
  if (scalarText(found.value) === value) return;
  edits.push([found.line, found.line + 1, [withValue(lines[found.line] ?? "", value)]]);
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

function clientLines(
  type: string | undefined,
  options: Record<string, string>,
  indent: number,
  unit: number,
): string[] {
  const parent = " ".repeat(indent);
  const child = " ".repeat(indent + unit);
  const lines = [`${parent}client:`];
  if (type !== undefined) lines.push(`${child}type: ${yamlScalar(type)}`);
  if (Object.keys(options).length > 0) {
    lines.push(`${child}options:`);
    const nested = " ".repeat(indent + unit * 2);
    for (const [option, value] of Object.entries(options)) {
      lines.push(`${nested}${option}: ${yamlScalar(value)}`);
    }
  }
  return lines;
}

function agentLines(key: string, body: Record<string, unknown>, indent: number, unit: number): string[] {
  const parent = " ".repeat(indent);
  const child = " ".repeat(indent + unit);
  const lines = [
    `${parent}${key}:`,
    `${child}model: ${yamlScalar(stringValue(body.model, `agents.${key}.model`))}`,
  ];
  const client = isRecord(body.client) ? body.client : {};
  const type = typeof client.type === "string" && client.type.trim() !== "" ? client.type.trim() : undefined;
  if (type === undefined) throw new ConfigEditError(`agents.${key} needs client.type before it can be written.`);
  const options = optionsDict(body, key);
  lines.push(...clientLines(type, options, indent + unit, unit));
  return lines;
}

function roleLines(key: string, body: Record<string, unknown>, indent: number, unit: number): string[] {
  const parent = " ".repeat(indent);
  const child = " ".repeat(indent + unit);
  const lines = [
    `${parent}${key}:`,
    ...stringify({ agent: body.agent }, { lineWidth: 0 }).trimEnd().split("\n").map((line) => child + line),
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
  agentName: string,
): StageRef[] {
  const found: StageRef[] = [];
  for (const document of workflows) {
    for (const stage of Object.values(document.stages)) {
      if (!isRoleStage(stage)) continue;
      let key: unknown = stage.agent?.kind === "named" ? stage.agent.name : null;
      if (stage.agent === null) {
        const role = roles[stage.role];
        if (isRecord(role)) key = role.agent;
      }
      if (key === agentName) {
        found.push({ workflow: document.id, stage: stage.id, agent: null, options: {} });
      }
    }
  }
  return found;
}

function roleStages(workflows: readonly WorkflowDocument[], role: string): StageRef[] {
  const found: StageRef[] = [];
  for (const document of workflows) {
    for (const stage of Object.values(document.stages)) {
      if (!isRoleStage(stage) || stage.role !== role) continue;
      found.push({
        workflow: document.id,
        stage: stage.id,
        agent: stage.agent?.kind === "named" ? stage.agent.name : null,
        options: { ...stage.options },
      });
    }
  }
  return found;
}

function shields(
  stage: RoleStageSpec,
  beforeRoles: Record<string, unknown>,
  afterRoles: Record<string, unknown>,
  beforeAgents: Record<string, unknown>,
  afterAgents: Record<string, unknown>,
  updatedAgents: readonly string[],
): string[] {
  const beforeBinding = binding(beforeRoles[stage.role]);
  const afterBinding = binding(afterRoles[stage.role]);
  const ignores: string[] = [];
  if (stage.agent !== null && !deepEqual(beforeBinding[0], afterBinding[0])) ignores.push("role-agent");
  if (
    Object.keys(stage.options).length > 0 &&
    (!deepEqual(beforeBinding[1], afterBinding[1]) ||
      agentOptionsChanged(stage, afterBinding, beforeAgents, afterAgents, updatedAgents))
  ) {
    ignores.push("role-options");
  }
  return ignores;
}

function agentOptionsChanged(
  stage: RoleStageSpec,
  afterBinding: Binding,
  beforeAgents: Record<string, unknown>,
  afterAgents: Record<string, unknown>,
  updatedAgents: readonly string[],
): boolean {
  const named = stage.agent?.kind === "named" ? stage.agent.name : afterBinding[0];
  if (typeof named !== "string" || !updatedAgents.includes(named)) return false;
  return !recordEqual(optionsDict(beforeAgents[named], named), optionsDict(afterAgents[named], named));
}

function orphans(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  workflows: readonly WorkflowDocument[],
): string[] {
  const afterRefs = references(after, workflows);
  const removed = new Set([...references(before, workflows)].filter((key) => !afterRefs.has(key)));
  const agents = mappingOrEmpty(after.agents);
  return Object.keys(agents).filter((key) => removed.has(key));
}

function references(config: Record<string, unknown>, workflows: readonly WorkflowDocument[]): Set<string> {
  const found = new Set<string>();
  for (const role of Object.values(mappingOrEmpty(config.roles))) {
    if (isRecord(role) && typeof role.agent === "string") found.add(role.agent);
  }
  for (const document of workflows) {
    for (const stage of Object.values(document.stages)) {
      if (stage.agent?.kind === "named") found.add(stage.agent.name);
    }
  }
  return found;
}

function resolvedRole(config: Record<string, unknown>, role: string, registry?: ClientRegistry): ResolvedTarget | null {
  const roles = config.roles;
  if (!isRecord(roles) || !Object.hasOwn(roles, role)) return null;
  try {
    const target = resolveRoleCascade(config, role, undefined, registry);
    return [target.client, target.model, sortedItems(target.options)];
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

function resolvedStage(config: Record<string, unknown>, stage: RoleStageSpec, registry?: ClientRegistry): ResolvedTarget | null {
  try {
    const target = resolveStageSpec(config, stage, undefined, registry);
    return [target.client, target.model, sortedItems(target.options)];
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

function binding(role: unknown): Binding {
  if (!isRecord(role)) return [null, []];
  const agentName = Object.hasOwn(role, "agent") ? role.agent : null;
  return [agentName ?? null, sortedItems(roleOptionMap(role))];
}

function signature(body: unknown): unknown[] {
  if (!isRecord(body)) return [body];
  const client = isRecord(body.client) ? body.client : {};
  const options = client.options;
  const rendered = isRecord(options)
    ? Object.entries(options)
        .map(([key, value]) => [String(key), String(value)] as [string, string])
        .sort(comparePair)
    : [];
  return [body.model ?? null, client.type ?? null, rendered];
}

function setAgentClient(body: Record<string, unknown>, type: string): void {
  const client = isRecord(body.client) ? body.client : {};
  const { type: _previous, ...rest } = client;
  body.client = { type, ...rest };
}

function applyAgentOptions(body: Record<string, unknown>, key: string, updates: unknown): void {
  if (!isRecord(updates)) throw new ConfigEditError("Options must be a mapping.");
  const client = optionRecord(body.client, `Missing or invalid agents.${key}.client.`);
  const options = optionRecord(client.options, `Missing or invalid agents.${key}.client.options.`);
  writeOptions(options, updates);
  if (Object.keys(options).length > 0) client.options = options;
  else delete client.options;
  if (Object.keys(client).length > 0) body.client = client;
  else delete body.client;
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
  const client = body.client;
  if (client == null) return {};
  if (!isRecord(client)) throw new ConfigurationError(`Missing or invalid agents.${key}.client.`);
  const options = client.options;
  if (options == null) return {};
  if (!isRecord(options)) throw new ConfigurationError(`Missing or invalid agents.${key}.client.options.`);
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
  if (copied.agents === undefined) copied.agents = {};
  agentsOf(copied);
  rolesOf(copied);
  return copied;
}

function agentsOf(config: Record<string, unknown>): Record<string, unknown> {
  const value = config.agents === undefined ? {} : config.agents;
  if (!isRecord(value)) throw new ConfigurationError("Missing or invalid agents.");
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

function suggestAgentName(config: Record<string, unknown>, role: string): string {
  const agents = config.agents;
  const taken = isRecord(agents) ? agents : {};
  const base = NAME.test(role) ? role : "agent";
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
  return deepEqual(left[0], right[0]) && deepEqual(left[1], right[1]);
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

/** True for a schema_version 4 document: it still has `models`, or a role with `default_model`. */
function isLegacyShape(config: Record<string, unknown>): boolean {
  if (Object.hasOwn(config, "models")) return true;
  return isRecord(config.roles) && Object.values(config.roles).some((role) =>
    isRecord(role) && (Object.hasOwn(role, "default_model") || Object.hasOwn(role, "instructions")));
}

/**
 * Lifts a schema_version 4 config text to the v5 structure and keeps comments and layout: it renames
 * keys in place and moves `client` and `options` under the agent's `client` mapping. When a layout
 * cannot be edited line by line (flow mappings, for example), the result is the canonical rendering of
 * the lifted document, which does not carry comments.
 */
export function upgradeConfigText(original: string, parsed?: Record<string, unknown>): string {
  if (original.includes("\t")) throw new ConfigEditError("Cannot edit a config that uses tabs.");
  const current = parsed ?? parseYamlDocument(original);
  if (!isRecord(current)) throw new ConfigEditError("Invalid configuration: expected a mapping.");
  const expected = deepCopyRecord(current);
  liftConfigAgents(expected);
  let text: string;
  try {
    text = liftConfigLines(original);
  } catch (error) {
    if (!(error instanceof ConfigEditError)) throw error;
    text = "";
  }
  if (text !== "") {
    const reparsed = parseYamlDocument(text);
    if (isRecord(reparsed) && deepEqual(reparsed, expected)) return text;
  }
  return stringify(expected, { lineWidth: 0 });
}

function liftConfigLines(original: string): string {
  const lines = splitLines(original);
  const unit = indentUnit(lines);
  const blocks = parseBlocks(lines, unit);
  const edits: Edit[] = [];
  const models = topSection(blocks, "models");
  if (models !== null) {
    renameKey(lines, models, "agents", edits);
    for (const agent of models.children) liftAgentLines(lines, agent, unit, edits);
  }
  const roles = topSection(blocks, "roles");
  if (roles !== null) {
    for (const role of roles.children) {
      for (const child of role.children) {
        if (child.key === "default_model") {
          renameKey(lines, child, "agent", edits);
          if (child.children.length > 0) liftAgentLines(lines, child, unit, edits);
        } else if (child.key === "instructions") {
          renameKey(lines, child, "responsibilities", edits);
        }
      }
    }
  }
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

function renameKey(lines: string[], block: Block, key: string, edits: Edit[]): void {
  const line = lines[block.line] ?? "";
  const match = /^(\s*)(["']?)([^\s"':]+)\2(\s*:)/.exec(line);
  if (match === null) throw new ConfigEditError(`Cannot rename ${block.key} in this file.`);
  edits.push([block.line, block.line + 1, [`${match[1]}${key}${line.slice(match[0].length - match[4]!.length)}`]]);
}

/** The end of a block's own content: trailing blank and comment-only lines belong to what follows. */
function contentEnd(lines: string[], block: Block): number {
  let end = block.end;
  while (end > block.line + 1 && contentIndent(lines[end - 1] ?? "") === null) end -= 1;
  return end;
}

function liftAgentLines(lines: string[], agent: Block, unit: number, edits: Edit[]): void {
  const client = childBlock(agent, "client");
  const options = childBlock(agent, "options");
  if (client === null && options === null) return;
  if (client !== null && client.value.trim() === "" ) return; // already a mapping
  if (client !== null && /^[{\[]/.test(client.value.trim())) return;
  const indent = (client ?? options)!.indent;
  const moved: string[] = [];
  if (options !== null) {
    for (const line of lines.slice(options.line, contentEnd(lines, options))) {
      moved.push(line.trim() === "" ? line : " ".repeat(unit) + line);
    }
  }
  if (client !== null) {
    const [code, comment] = splitComment(lines[client.line] ?? "");
    const colon = code.indexOf(":");
    const value = code.slice(colon + 1).trim();
    const head = `${" ".repeat(indent)}client:`;
    const type = `${" ".repeat(indent + unit)}type: ${value}${comment === "" ? "" : ` ${comment}`}`;
    edits.push([client.line, contentEnd(lines, client), [head, type, ...moved]]);
    if (options !== null) edits.push([options.line, contentEnd(lines, options), []]);
    return;
  }
  edits.push([options!.line, contentEnd(lines, options!), [`${" ".repeat(indent)}client:`, ...moved]]);
}
