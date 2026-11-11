/** Rewrite config.yaml text in place so edits keep comments and key order. */
import { isRecord } from '@nodeint/migent-workflow';
import { parseYamlDocument } from '@nodeint/migent-workflow';
import { stringify } from 'yaml';

import { renderAuthoringYaml } from './authoring.js';
import { ConfigurationError } from './errors.js';
import { liftConfigAgents } from './migration-config.js';
import { applyEdits, ConfigEditError, deepEqual, type Edit, splitComment, splitLines, yamlScalar } from './yaml-patch.js';

export interface Block {
  key: string;
  indent: number;
  line: number;
  end: number;
  value: string;
  children: Block[];
}

/** The text being patched, shared by every sync step. Edits accumulate in `edits`. */
interface SyncContext {
  readonly lines: string[];
  readonly blocks: Block[];
  readonly unit: number;
  readonly edits: Edit[];
}

/** An agent or role body before and after the edit. */
interface BodyChange {
  readonly before: unknown;
  readonly after: Record<string, unknown>;
}

/** A line range at one indent level. */
interface Span {
  readonly start: number;
  readonly end: number;
  readonly indent: number;
}

interface Layout {
  readonly indent: number;
  readonly unit: number;
}

export function patchConfigText(original: string, updated: Record<string, unknown>): string {
  if (original.includes('\t')) throw new ConfigEditError('Cannot edit a config that uses tabs.');
  const parsed = parseYamlDocument(original);
  if (!isRecord(parsed)) throw new ConfigEditError('Invalid configuration: expected a mapping.');
  // Lift a schema_version 4 document to the v5 structure first, so the sync below sees one shape.
  const legacy = isLegacyShape(parsed);
  const source = legacy ? upgradeConfigText(original, parsed) : original;
  const target = legacy ? liftConfigAgents(updated).document : updated;
  const current = legacy ? parseYamlDocument(source) : parsed;
  if (!isRecord(current)) throw new ConfigEditError('Invalid configuration: expected a mapping.');
  const lines = splitLines(source);
  const unit = indentUnit(lines);
  const blocks = parseBlocks(lines, unit);
  const edits: Edit[] = [];
  syncSchemaVersion(lines, target, edits);
  const context: SyncContext = { lines, blocks, unit, edits };
  syncAgents(context, current, target);
  syncRoles(context, current, target);
  const text = applyEdits(source, lines, edits);
  if (!deepEqual(parseYamlDocument(text), target)) {
    throw new ConfigEditError('Config text does not match the updated document.');
  }
  return text;
}

function syncAgents(context: SyncContext, current: Record<string, unknown>, updated: Record<string, unknown>): void {
  const currentAgents = mappingOrEmpty(current.agents);
  const updatedAgents = mappingOrEmpty(updated.agents);
  const section = topSection(context.blocks, 'agents');
  const fresh: string[] = [];
  for (const [key, body] of Object.entries(updatedAgents)) {
    if (!isRecord(body)) throw new ConfigurationError(`Missing or invalid agents.${key}.`);
    if (!Object.hasOwn(currentAgents, key)) {
      fresh.push(...agentLines(key, body, { indent: context.unit, unit: context.unit }));
      continue;
    }
    if (section === null) throw new ConfigEditError('Cannot edit agents in this file.');
    const block = childBlock(section, key);
    if (block === null) throw new ConfigEditError(`Cannot edit agents.${key} in this file.`);
    if (Object.keys(body).length === 0 && isRecord(currentAgents[key]) && Object.keys(currentAgents[key]).length > 0) {
      context.edits.push([block.line, block.end, [withValue(context.lines[block.line] ?? '', '{}')]]);
      continue;
    }
    if (Object.hasOwn(body, 'model')) syncScalar(context, block, { key: 'model', value: body.model, field: `agents.${key}.model` });
    syncAgentClient(context, block, { key, before: currentAgents[key], after: body });
    dropRemovedScalars(context, block, { before: currentAgents[key], after: body });
  }
  if (fresh.length === 0) return;
  if (section === null) context.edits.push([0, 0, ['agents:', ...fresh]]);
  else context.edits.push([section.end, section.end, fresh]);
}

function syncRoles(context: SyncContext, current: Record<string, unknown>, updated: Record<string, unknown>): void {
  const { lines, blocks, unit, edits } = context;
  const currentRoles = mappingOrEmpty(current.roles);
  const updatedRoles = mappingOrEmpty(updated.roles);
  const section = topSection(blocks, 'roles');
  const fresh: string[] = [];
  for (const [key, body] of Object.entries(updatedRoles)) {
    if (!isRecord(body)) throw new ConfigurationError(`Missing or invalid roles.${key}.`);
    if (!Object.hasOwn(currentRoles, key)) {
      fresh.push(...roleLines(key, body, { indent: unit, unit }));
      continue;
    }
    if (section === null) throw new ConfigEditError('Cannot edit roles in this file.');
    const block = childBlock(section, key);
    if (block === null) throw new ConfigEditError(`Cannot edit roles.${key} in this file.`);
    const previous = currentRoles[key];
    if (isRecord(body.agent) || (isRecord(previous) && isRecord(previous.agent))) {
      const found = childBlock(block, 'agent');
      if (!found) throw new ConfigEditError(`Cannot edit roles.${key}.agent in this file.`);
      if (!isRecord(previous) || !deepEqual(previous.agent, body.agent)) {
        if (isRecord(previous) && isRecord(previous.agent) && isRecord(body.agent)) {
          // Reuse the field patchers so unchanged values keep their comments and order.
          if (body.agent.model !== previous.agent.model) {
            syncScalar(context, found, { key: 'model', value: body.agent.model, field: `roles.${key}.agent.model` });
          }
          syncAgentClient(context, found, { key, before: previous.agent, after: body.agent });
          dropRemovedScalars(context, found, { before: previous.agent, after: body.agent });
        } else {
          const indent = block.indent + unit;
          const base = lines.slice(found.line, found.end).map((line) => line.slice(indent)).join('\n');
          const result = renderAuthoringYaml({ agent: body.agent }, base);
          if (!result.preserved) throw new ConfigEditError(`Cannot preserve roles.${key}.agent: ${result.reason}.`);
          const rendered = result.text.trimEnd().split('\n').map((line) => ' '.repeat(indent) + line);
          edits.push([found.line, found.end, rendered]);
        }
      }
    } else if (Object.hasOwn(body, 'agent')) {
      syncScalar(context, block, { key: 'agent', value: body.agent, field: `roles.${key}.agent` });
    }
    syncRoleOptions(context, block, { key, before: currentRoles[key], after: body });
    dropRemovedScalars(context, block, { before: currentRoles[key], after: body });
  }
  if (fresh.length === 0) return;
  if (section === null) {
    edits.push([lines.length, lines.length, ['roles:', ...fresh]]);
    return;
  }
  edits.push([section.end, section.end, fresh]);
}

function syncSchemaVersion(lines: string[], updated: Record<string, unknown>, edits: Edit[]): void {
  const value = updated.schema_version;
  if (typeof value === 'boolean' || typeof value !== 'number' || !Number.isInteger(value)) return;
  const rendered = `schema_version: ${value}`;
  for (const block of parseBlocks(lines, indentUnit(lines))) {
    if (block.indent !== 0 || block.key !== 'schema_version') continue;
    if (scalarText(block.value) === String(value)) return;
    edits.push([block.line, block.line + 1, [withValue(lines[block.line] ?? '', String(value))]]);
    return;
  }
  let insert = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (contentIndent(lines[index] ?? '') !== null) {
      insert = index;
      break;
    }
  }
  edits.push([insert, insert, [rendered, '']]);
}

function dropRemovedScalars(context: SyncContext, parent: Block, change: BodyChange): void {
  const { edits } = context;
  const { before: beforeBody, after: afterBody } = change;
  if (!isRecord(beforeBody)) return;
  for (const [key, value] of Object.entries(beforeBody)) {
    if (Object.hasOwn(afterBody, key) || isRecord(value) || Array.isArray(value)) continue;
    const found = childBlock(parent, key);
    if (found === null || found.value.trim() === '') continue;
    edits.push([found.line, found.line + 1, []]);
  }
}

function syncScalar(context: SyncContext, parent: Block, scalar: { key: string; value: unknown; field: string }): void {
  const { lines, edits } = context;
  const { key, value, field } = scalar;
  const found = childBlock(parent, key);
  if (found === null) throw new ConfigEditError(`Cannot edit ${field} in this file.`);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigurationError(`Missing or invalid ${field}.`);
  }
  if (scalarText(found.value) === value) return;
  edits.push([found.line, found.line + 1, [withValue(lines[found.line] ?? '', value)]]);
}

function syncAgentClient(context: SyncContext, parent: Block, change: BodyChange & { key: string }): void {
  const { unit, edits } = context;
  const { key, before: beforeBody, after: afterBody } = change;
  const before = optionsDict(beforeBody, key);
  const after = optionsDict(afterBody, key);
  const afterClient = isRecord(afterBody.client) ? afterBody.client : {};
  const type = typeof afterClient.type === 'string' && afterClient.type.trim() !== ''
    ? afterClient.type.trim()
    : undefined;
  const beforeClient = isRecord(beforeBody) && isRecord(beforeBody.client) ? beforeBody.client : {};
  const beforeType = typeof beforeClient.type === 'string' && beforeClient.type.trim() !== ''
    ? beforeClient.type.trim()
    : undefined;
  if (recordEqual(before, after) && type === beforeType) return;
  const client = childBlock(parent, 'client');
  if (client !== null) {
    if (client.value.trim() !== '') throw new ConfigEditError(`Cannot edit agents.${key}.client in this file.`);
    if (type !== undefined) syncClientType(context, client, type);
    syncOptionMap(context, client, { before, after, field: `agents.${key}.client.options` });
    return;
  }
  if (type === undefined && Object.keys(after).length === 0) return;
  edits.push([parent.end, parent.end, clientLines({ type, options: after }, { indent: parent.indent + unit, unit })]);
}

function syncClientType(context: SyncContext, client: Block, value: string): void {
  const { lines, unit, edits } = context;
  const found = childBlock(client, 'type');
  if (found === null) {
    const indent = ' '.repeat(client.indent + unit);
    edits.push([client.line + 1, client.line + 1, [`${indent}type: ${yamlScalar(value)}`]]);
    return;
  }
  if (scalarText(found.value) === value) return;
  edits.push([found.line, found.line + 1, [withValue(lines[found.line] ?? '', value)]]);
}

function syncRoleOptions(context: SyncContext, roleBlock: Block, change: BodyChange & { key: string }): void {
  const { key, before: beforeBody, after: afterBody } = change;
  syncOptionMap(context, roleBlock, {
    before: roleOptionMap(isRecord(beforeBody) ? beforeBody : {}),
    after: roleOptionMap(afterBody),
    field: `roles.${key}.options`,
  });
}

function syncOptionMap(
  context: SyncContext,
  parent: Block,
  change: { before: Record<string, string>; after: Record<string, string>; field: string },
): void {
  const { lines, unit, edits } = context;
  const { before, after, field } = change;
  if (recordEqual(before, after)) return;
  const options = childBlock(parent, 'options');
  if (options !== null && options.value.trim() !== '') {
    throw new ConfigEditError(`Cannot edit ${field} in this file.`);
  }
  if (Object.keys(after).length === 0) {
    if (options !== null) edits.push([options.line, options.end, []]);
    return;
  }
  if (options === null) {
    const indent = ' '.repeat(parent.indent + unit);
    const nested = ' '.repeat(parent.indent + unit * 2);
    const body = [`${indent}options:`];
    for (const name of sortedKeys(after)) body.push(`${nested}${name}: ${yamlScalar(after[name] ?? '')}`);
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
      const rendered = `${' '.repeat(options.indent + unit)}${name}: ${yamlScalar(after[name] ?? '')}`;
      edits.push([options.end, options.end, [rendered]]);
      continue;
    }
    if (scalarText(found.value) !== after[name]) {
      edits.push([found.line, found.line + 1, [withValue(lines[found.line] ?? '', after[name] ?? '')]]);
    }
  }
}

function clientLines(client: { type: string | undefined; options: Record<string, string> }, layout: Layout): string[] {
  const { type, options } = client;
  const { indent, unit } = layout;
  const parent = ' '.repeat(indent);
  const child = ' '.repeat(indent + unit);
  const lines = [`${parent}client:`];
  if (type !== undefined) lines.push(`${child}type: ${yamlScalar(type)}`);
  if (Object.keys(options).length > 0) {
    lines.push(`${child}options:`);
    const nested = ' '.repeat(indent + unit * 2);
    for (const [option, value] of Object.entries(options)) {
      lines.push(`${nested}${option}: ${yamlScalar(value)}`);
    }
  }
  return lines;
}

function agentLines(key: string, body: Record<string, unknown>, layout: Layout): string[] {
  const { indent, unit } = layout;
  const parent = ' '.repeat(indent);
  const child = ' '.repeat(indent + unit);
  const lines = [
    `${parent}${key}:`,
    `${child}model: ${yamlScalar(stringValue(body.model, `agents.${key}.model`))}`,
  ];
  const client = isRecord(body.client) ? body.client : {};
  const type = typeof client.type === 'string' && client.type.trim() !== '' ? client.type.trim() : undefined;
  if (type === undefined) throw new ConfigEditError(`agents.${key} needs client.type before it can be written.`);
  const options = optionsDict(body, key);
  lines.push(...clientLines({ type, options }, { indent: indent + unit, unit }));
  return lines;
}

function roleLines(key: string, body: Record<string, unknown>, layout: Layout): string[] {
  const { indent, unit } = layout;
  const parent = ' '.repeat(indent);
  const child = ' '.repeat(indent + unit);
  const lines = [
    `${parent}${key}:`,
    ...stringify({ agent: body.agent }, { lineWidth: 0 }).trimEnd().split('\n').map((line) => child + line),
  ];
  const roleOptions = roleOptionMap(body);
  if (Object.keys(roleOptions).length > 0) {
    lines.push(`${child}options:`);
    const nested = ' '.repeat(indent + unit * 2);
    for (const [name, value] of Object.entries(roleOptions)) {
      lines.push(`${nested}${name}: ${yamlScalar(value)}`);
    }
  }
  return lines;
}

export function parseBlocks(lines: string[], unit: number): Block[] {
  return parseLevel(lines, { start: 0, end: lines.length, indent: 0 }, unit);
}

function parseLevel(lines: string[], span: Span, unit: number): Block[] {
  const { start, end, indent } = span;
  const blocks: Block[] = [];
  let index = start;
  while (index < end) {
    const found = nextContent(lines, index, end);
    if (found === null) break;
    const [lineIndex, lineIndent] = found;
    if (lineIndent < indent) break;
    if (lineIndent > indent) throw new ConfigEditError(`Invalid YAML indent at line ${lineIndex + 1}.`);
    const [key, value] = splitKey(lines[lineIndex] ?? '', lineIndex);
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
      value.trim() === '' && !isSequence(lines, { start: lineIndex + 1, end: childEnd, indent: indent + unit })
        ? parseLevel(lines, { start: lineIndex + 1, end: childEnd, indent: indent + unit }, unit)
        : [];
    blocks.push({ key, indent, line: lineIndex, end: childEnd, value, children });
    index = childEnd;
  }
  return blocks;
}

function isSequence(lines: string[], span: Span): boolean {
  const { start, end, indent } = span;
  const found = nextContent(lines, start, end);
  if (found === null) return false;
  const [lineIndex, lineIndent] = found;
  if (lineIndent !== indent) return false;
  const [code] = splitComment(lines[lineIndex] ?? '');
  return code.trimStart().startsWith('-');
}

function nextContent(lines: string[], start: number, end: number): [number, number] | null {
  for (let index = start; index < end; index += 1) {
    const indent = contentIndent(lines[index] ?? '');
    if (indent !== null) return [index, indent];
  }
  return null;
}

function contentIndent(line: string): number | null {
  const [code] = splitComment(line);
  if (code.trim() === '') return null;
  return code.length - code.trimStart().length;
}

function splitKey(line: string, index: number): [string, string] {
  const [code] = splitComment(line);
  const colon = code.indexOf(':');
  if (colon < 0) throw new ConfigEditError(`Invalid YAML mapping at line ${index + 1}.`);
  const key = code.slice(0, colon).trim();
  if (key === '') throw new ConfigEditError(`Invalid YAML key at line ${index + 1}.`);
  return [key, code.slice(colon + 1).trim()];
}

function withValue(line: string, value: string): string {
  const [code, comment] = splitComment(line);
  const colon = code.indexOf(':');
  const key = colon < 0 ? code : code.slice(0, colon);
  const updated = `${key}: ${yamlScalar(value)}`;
  // Keep the space Python inserts before `#`. yaml Document emits only one.
  if (comment !== '') return `${updated} ${comment}`;
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

/** True for a schema_version 4 document: it still has `models`, or a role with `default_model`. */
function isLegacyShape(config: Record<string, unknown>): boolean {
  if (Object.hasOwn(config, 'models')) return true;
  return isRecord(config.roles) && Object.values(config.roles).some((role) =>
    isRecord(role) && (Object.hasOwn(role, 'default_model') || Object.hasOwn(role, 'instructions')));
}

/**
 * Lifts a schema_version 4 config text to the v5 structure and keeps comments and layout: it renames
 * keys in place and moves `client` and `options` under the agent's `client` mapping. When a layout
 * cannot be edited line by line (flow mappings, for example), the result is the canonical rendering of
 * the lifted document, which does not carry comments.
 */
export function upgradeConfigText(original: string, parsed?: Record<string, unknown>): string {
  if (original.includes('\t')) throw new ConfigEditError('Cannot edit a config that uses tabs.');
  const current = parsed ?? parseYamlDocument(original);
  if (!isRecord(current)) throw new ConfigEditError('Invalid configuration: expected a mapping.');
  const expected = liftConfigAgents(current).document;
  let text: string;
  try {
    text = liftConfigLines(original);
  } catch (error) {
    if (!(error instanceof ConfigEditError)) throw error;
    text = '';
  }
  if (text !== '') {
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
  const context: SyncContext = { lines, blocks, unit, edits };
  const models = topSection(blocks, 'models');
  if (models !== null) {
    renameKey(context, models, 'agents');
    for (const agent of models.children) liftAgentLines(context, agent);
  }
  const roles = topSection(blocks, 'roles');
  if (roles !== null) {
    for (const role of roles.children) {
      for (const child of role.children) {
        if (child.key === 'default_model') {
          renameKey(context, child, 'agent');
          if (child.children.length > 0) liftAgentLines(context, child);
        } else if (child.key === 'instructions') {
          renameKey(context, child, 'responsibilities');
        }
      }
    }
  }
  return applyEdits(original, lines, edits);
}

function renameKey(context: SyncContext, block: Block, key: string): void {
  const { lines, edits } = context;
  const line = lines[block.line] ?? '';
  const match = /^(\s*)(["']?)([^\s"':]+)\2(\s*:)/.exec(line);
  if (match === null) throw new ConfigEditError(`Cannot rename ${block.key} in this file.`);
  edits.push([block.line, block.line + 1, [`${match[1]}${key}${line.slice(match[0].length - match[4]!.length)}`]]);
}

/** The end of a block's own content: trailing blank and comment-only lines belong to what follows. */
function contentEnd(lines: string[], block: Block): number {
  let {end} = block;
  while (end > block.line + 1 && contentIndent(lines[end - 1] ?? '') === null) end -= 1;
  return end;
}

function liftAgentLines(context: SyncContext, agent: Block): void {
  const client = childBlock(agent, 'client');
  const options = childBlock(agent, 'options');
  if (client === null && options === null) return;
  if (client !== null && client.value.trim() === '' ) return; // already a mapping
  if (client !== null && /^[{[]/.test(client.value.trim())) return;
  const {indent} = ((client ?? options)!);
  const moved: string[] = [];
  if (options !== null) {
    for (const line of context.lines.slice(options.line, contentEnd(context.lines, options))) {
      moved.push(line.trim() === '' ? line : ' '.repeat(context.unit) + line);
    }
  }
  if (client !== null) {
    const [code, comment] = splitComment(context.lines[client.line] ?? '');
    const colon = code.indexOf(':');
    const value = code.slice(colon + 1).trim();
    const head = `${' '.repeat(indent)}client:`;
    const type = `${' '.repeat(indent + context.unit)}type: ${value}${comment === '' ? '' : ` ${comment}`}`;
    context.edits.push([client.line, contentEnd(context.lines, client), [head, type, ...moved]]);
    if (options !== null) context.edits.push([options.line, contentEnd(context.lines, options), []]);
    return;
  }
  context.edits.push([options!.line, contentEnd(context.lines, options!), [`${' '.repeat(indent)}client:`, ...moved]]);
}

export function roleOptionMap(role: Record<string, unknown>): Record<string, string> {
  const {options} = role;
  if ((options === null || options === undefined)) return {};
  if (!isRecord(options)) throw new ConfigurationError('Missing or invalid roles.<role>.options.');
  return stringMap(options);
}

export function optionsDict(body: unknown, key: string): Record<string, string> {
  if (!isRecord(body)) return {};
  const {client} = body;
  if ((client === null || client === undefined)) return {};
  if (!isRecord(client)) throw new ConfigurationError(`Missing or invalid agents.${key}.client.`);
  const {options} = client;
  if ((options === null || options === undefined)) return {};
  if (!isRecord(options)) throw new ConfigurationError(`Missing or invalid agents.${key}.client.options.`);
  return stringMap(options);
}

export function stringMap(options: Record<string, unknown>): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'string' && value.trim() !== '') parsed[key] = value.trim();
  }
  return parsed;
}

export function mappingOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigurationError(`Missing or invalid ${field}.`);
  }
  return value.trim();
}

export function scalarText(value: string): string {
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function sortedKeys(record: Record<string, string>): string[] {
  return Object.keys(record).sort(compareString);
}

export function compareString(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function recordEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}
