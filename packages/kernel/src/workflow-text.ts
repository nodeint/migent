/** Rewrite workflow.yaml text in place so migrations keep comments and key order. */
import { documentVersion, isRecord, parseWorkflowMapping, SCHEMA_V2 } from '@nodeint/migent-workflow';
import { parseYamlDocument } from '@nodeint/migent-workflow';
import { stringify } from 'yaml';

import { renderAuthoringYaml } from './authoring.js';
import { LIST_MARKER_LENGTH, QUOTE_PAIR_LENGTH, YAML_DEFAULT_INDENT } from './constants.js';
import { ConfigurationError } from './errors.js';
import { applyEdits, ConfigEditError, deepEqual, type Edit, splitComment, splitLines, yamlScalar } from './yaml-patch.js';

/** An artifact id as a YAML flow scalar; words YAML may read as null or boolean stay strings. */
export function artifactIdScalar(id: string): string {
  return AMBIGUOUS_SCALAR.test(id) ? JSON.stringify(id) : yamlScalar(id);
}

/** The text being patched. Edits accumulate in `edits`. */
interface TextPatch {
  readonly lines: string[];
  readonly edits: Edit[];
}

/** A mapping before and after the migration. */
interface Change {
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
}

export function patchWorkflowText(original: string, updated: Readonly<Record<string, unknown>>): string {
  if (original.includes('\t')) throw new ConfigEditError('Cannot edit a workflow that uses tabs.');
  const current = parseYamlDocument(original);
  if (!isRecord(current)) throw new ConfigEditError('Workflow must be a mapping.');
  const lines = splitLines(original);
  const edits: Edit[] = [];
  insertSchemaVersion(lines, updated, edits);
  const patch: TextPatch = { lines, edits };
  syncChangedStages(patch, { before: current, after: updated });
  syncDocumentShape(patch, { before: current, after: updated });
  const text = applyEdits(original, lines, edits);
  assertMigratedWorkflow(text, updated);
  return text;
}

/** The migrated document must load and must not retain removed fields. */
function assertMigratedWorkflow(text: string, updated: Readonly<Record<string, unknown>>): void {
  if (documentVersion(updated) < SCHEMA_V2) return;
  const parsed = parseYamlDocument(text);
  if (!isRecord(parsed)) throw new ConfigEditError('Workflow must be a mapping.');
  if (Object.hasOwn(parsed, 'completion')) {
    throw new ConfigurationError('migration left completion in the workflow.');
  }
  const {requires} = parsed;
  if (isRecord(requires) && Object.hasOwn(requires, 'decision')) {
    throw new ConfigurationError('migration left requires.decision in the workflow.');
  }
  parseWorkflowMapping(parsed, 'migrated workflow');
  if (!deepEqual(parsed, updated)) {
    throw new ConfigEditError('Workflow text does not match the migrated document.');
  }
}

export function stagesById(raw: unknown): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(raw)) return found;
  for (const stage of raw) {
    if (!isRecord(stage)) continue;
    const stageId = stage.id;
    if (typeof stageId === 'string' && stageId.trim() !== '') found.set(stageId.trim(), stage);
  }
  return found;
}

function insertSchemaVersion(lines: string[], updated: Readonly<Record<string, unknown>>, edits: Edit[]): void {
  const value = updated[SCHEMA_VERSION_FIELD];
  if (typeof value === 'boolean' || typeof value !== 'number' || !Number.isInteger(value)) return;
  const rendered = `${SCHEMA_VERSION_FIELD}: ${value}`;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const [key] = mappingKey(line);
    if (key === SCHEMA_VERSION_FIELD && contentIndent(line) === 0) {
      const [current, comment] = splitComment(line);
      const raw = current.split(':').slice(1).join(':');
      if (raw.trim() === String(value)) return;
      let replacement = `${SCHEMA_VERSION_FIELD}: ${value}`;
      if (comment !== '') replacement = `${replacement} ${comment}`;
      edits.push([index, index + 1, [replacement]]);
      return;
    }
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

function syncChangedStages(patch: TextPatch, change: Change): void {
  const { lines } = patch;
  const { before, after } = change;
  const beforeStages = stagesById(before.stages);
  const afterStages = stagesById(after.stages);
  for (const [stageId, start, end] of stageSpans(lines)) {
    const previous = beforeStages.get(stageId);
    const updated = afterStages.get(stageId);
    if (previous === undefined || updated === undefined) continue;
    if (deepEqual(previous, updated)) continue;
    patchStage(patch, { start, end }, { before: previous, after: updated });
  }
}

function patchStage(patch: TextPatch, stage: LineSpan, change: Change): void {
  const { lines, edits } = patch;
  const { start, end } = stage;
  const { before, after } = change;
  const info = lines.slice(start, end).map((line) => lineInfo(line));
  const content: [number, LineInfo][] = [];
  for (let index = 0; index < info.length; index += 1) {
    const item = info[index];
    if (item !== null) content.push([index, item]);
  }
  if (content.length === 0) return;
  const [first] = content;
  if (first === undefined) return;
  const firstIndent = first[1].indent;
  const siblingIndent = siblingIndentOf(content, firstIndent);
  const unit = siblingIndent > firstIndent ? siblingIndent - firstIndent : YAML_DEFAULT_INDENT;
  if (!deepEqual(before.agent, after.agent) && Object.hasOwn(after, 'agent') && !Object.hasOwn(before, 'model')) {
    const span = nestedKeySpan(lines, { start, end }, 'agent');
    if (span === null) throw new ConfigEditError('Cannot locate the stage agent to migrate.');
    const base = lines.slice(span[0], span[1]).map((line) => line.slice(siblingIndent)).join('\n');
    const result = renderAuthoringYaml({ agent: after.agent }, base);
    if (!result.preserved) throw new ConfigEditError(`Cannot preserve the stage agent: ${result.reason}.`);
    edits.push([span[0], span[1], result.text.trimEnd().split('\n').map((line) => `${' '.repeat(siblingIndent)}${line}`)]);
  }
  if (Object.hasOwn(before, 'produces') && !Object.hasOwn(after, 'produces')) {
    const span = nestedKeySpan(lines, { start, end }, 'produces');
    if (span === null) throw new ConfigEditError('Cannot locate the stage produces to migrate.');
    const ids = Array.isArray(after.artifacts) ? after.artifacts : [];
    edits.push([span[0], span[1], ids.length > 0 ? [`${' '.repeat(siblingIndent)}artifacts: [${ids.map((id) => artifactIdScalar(String(id))).join(', ')}]`] : []]);
  }
  if (!deepEqual(before.decision, after.decision)) {
    const span = nestedKeySpan(lines, { start, end }, 'decision');
    if (span === null) throw new ConfigEditError('Cannot locate the stage decision to migrate.');
    const replacement = Object.hasOwn(after, 'decision')
      ? renderTopLevel('decision', after.decision).map((line) => `${' '.repeat(siblingIndent)}${line}`)
      : [];
    edits.push([span[0], span[1], replacement]);
  }
  if (Object.hasOwn(before, 'model') && Object.hasOwn(after, 'agent') && !Object.hasOwn(after, 'model')) {
    for (const [index, item] of content) {
      if (item.indent !== siblingIndent || item.key !== 'model') continue;
      const text = lines[start + index] ?? '';
      const match = /^(\s*)(["']?)model\2(\s*:)/.exec(text);
      if (match !== null) edits.push([start + index, start + index + 1, [`${match[1]}agent${text.slice(match[0].length - match[3]!.length)}`]]);
      break;
    }
  }
  if (Object.hasOwn(before, 'options') && !Object.hasOwn(after, 'options')) {
    for (const [index, item] of content) {
      if (item.indent !== siblingIndent || item.key !== 'options' || item.rest === '') continue;
      // A flow-style `options: {..}` has no nested lines to sync; drop the whole entry.
      edits.push([start + index, optionsEnd(lines, start + index, { siblingIndent, stageEnd: end }), []]);
      break;
    }
  }
  let optionsAt: number | null = null;
  let optionIndent: number | null = null;
  let inOptions = false;
  const optionLines = new Map<string, number>();
  let thinkingAt: number | null = null;
  for (const [index, item] of content) {
    if (inOptions && item.indent <= siblingIndent) inOptions = false;
    if (inOptions && item.key !== null && item.rest !== '') {
      if (optionIndent === null) optionIndent = item.indent;
      if (item.indent === optionIndent) optionLines.set(item.key, start + index);
      continue;
    }
    if (item.indent !== siblingIndent || item.key === null) continue;
    if (item.key === 'options' && item.rest === '') {
      optionsAt = start + index;
      inOptions = true;
      continue;
    }
    if (item.key === 'thinking' && item.rest !== '') thinkingAt = start + index;
  }
  const beforeOptions = isRecord(before.options) ? before.options : {};
  const afterOptions = isRecord(after.options) ? after.options : {};
  if (!deepEqual(beforeOptions, afterOptions)) {
    syncStageOptions(patch, { before: beforeOptions, after: afterOptions }, {
      optionLines,
      optionsAt,
      optionIndent: optionIndent ?? siblingIndent + unit,
      siblingIndent,
      stageEnd: end,
    });
  }
  if (Object.hasOwn(before, 'thinking') && !Object.hasOwn(after, 'thinking') && thinkingAt !== null) {
    edits.push([thinkingAt, thinkingAt + 1, []]);
  }
}

interface OptionsLayout {
  readonly optionLines: ReadonlyMap<string, number>;
  readonly optionsAt: number | null;
  readonly optionIndent: number;
  readonly siblingIndent: number;
  readonly stageEnd: number;
}

function syncStageOptions(patch: TextPatch, change: Change, layout: OptionsLayout): void {
  const { lines, edits } = patch;
  const { before, after } = change;
  const { optionLines, optionsAt, optionIndent, siblingIndent, stageEnd } = layout;
  const afterText = new Map<string, string>();
  for (const [key, value] of Object.entries(after)) {
    if (typeof value === 'string' && value.trim() !== '') afterText.set(key, value.trim());
  }
  const beforeKeys = new Set(Object.keys(before));
  if (afterText.size === 0) {
    if (optionsAt !== null) edits.push([optionsAt, optionsEnd(lines, optionsAt, { siblingIndent, stageEnd }), []]);
    return;
  }
  if (optionsAt === null) {
    const indent = ' '.repeat(siblingIndent);
    const nested = ' '.repeat(optionIndent);
    const block = [`${indent}options:`];
    for (const name of sorted(afterText.keys())) block.push(`${nested}${name}: ${yamlScalar(afterText.get(name) ?? '')}`);
    edits.push([stageEnd, stageEnd, block]);
    return;
  }
  const afterNames = new Set(afterText.keys());
  for (const name of sorted([...beforeKeys].filter((key) => !afterNames.has(key)))) {
    const lineIndex = optionLines.get(name);
    if (lineIndex !== undefined) edits.push([lineIndex, lineIndex + 1, []]);
  }
  for (const name of sorted(afterText.keys())) {
    const rendered = `${' '.repeat(optionIndent)}${name}: ${yamlScalar(afterText.get(name) ?? '')}`;
    const lineIndex = optionLines.get(name);
    if (lineIndex === undefined) {
      const insertAt = optionsEnd(lines, optionsAt, { siblingIndent, stageEnd });
      edits.push([insertAt, insertAt, [rendered]]);
      continue;
    }
    const [current] = splitComment(lines[lineIndex] ?? '');
    const raw = current.split(':').slice(1).join(':');
    if (unquote(raw.trim()) !== afterText.get(name)) {
      const [code, comment] = splitComment(lines[lineIndex] ?? '');
      const colon = code.indexOf(':');
      const key = colon < 0 ? code : code.slice(0, colon);
      let updated = `${key}: ${yamlScalar(afterText.get(name) ?? '')}`;
      if (comment !== '') updated = `${updated} ${comment}`;
      edits.push([lineIndex, lineIndex + 1, [updated]]);
    }
  }
}

function optionsEnd(lines: string[], optionsAt: number, bounds: { siblingIndent: number; stageEnd: number }): number {
  const { siblingIndent, stageEnd } = bounds;
  let end = optionsAt + 1;
  for (let index = optionsAt + 1; index < stageEnd; index += 1) {
    const item = lineInfo(lines[index] ?? '');
    if (item === null) continue;
    if (item.indent <= siblingIndent) break;
    end = index + 1;
  }
  return end;
}

function siblingIndentOf(content: [number, LineInfo][], firstIndent: number): number {
  let sibling: number | null = null;
  for (const [, item] of content.slice(1)) {
    if (item.indent <= firstIndent) continue;
    sibling = sibling === null ? item.indent : Math.min(sibling, item.indent);
  }
  return sibling === null ? firstIndent : sibling;
}

function stageSpans(lines: string[]): [string, number, number][] {
  const spans: [string, number, number][] = [];
  let inStages = false;
  let listIndent: number | null = null;
  let start: number | null = null;
  let stageId: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const item = lineInfo(line);
    if (item === null) continue;
    if (!inStages) {
      if (item.indent === 0 && item.key === 'stages' && item.rest === '') inStages = true;
      continue;
    }
    if (item.indent === 0) {
      if (start !== null && stageId !== null) spans.push([stageId, start, index]);
      start = null;
      break;
    }
    const text = codeOf(line);
    if (listIndent === null && (text.startsWith('- ') || text === '-')) listIndent = item.indent;
    if (listIndent !== null && item.indent === listIndent && (text.startsWith('- ') || text === '-')) {
      if (start !== null && stageId !== null) spans.push([stageId, start, index]);
      start = index;
      stageId = idOnDash(text);
      continue;
    }
    if (start !== null && stageId === null && item.key === 'id' && item.rest !== '') stageId = unquote(item.rest);
  }
  if (start !== null && stageId !== null) spans.push([stageId, start, lines.length]);
  return spans;
}

function idOnDash(text: string): string | null {
  const body = text.startsWith('- ') ? text.slice(LIST_MARKER_LENGTH).trim() : '';
  if (body === '') return null;
  const colon = body.indexOf(':');
  if (colon < 0) return null;
  const key = body.slice(0, colon).trim();
  const rest = body.slice(colon + 1);
  if (key !== 'id' || rest.trim() === '') return null;
  const [first] = rest.trim().split(/\s+/);
  return first === undefined ? null : unquote(first);
}

interface LineInfo {
  indent: number;
  key: string | null;
  rest: string;
  comment: string;
}

function lineInfo(line: string): LineInfo | null {
  const indent = contentIndent(line);
  if (indent === null) return null;
  const [key, rest, comment] = mappingKey(line);
  return { indent, key, rest, comment };
}

function mappingKey(line: string): [string | null, string, string] {
  const [code, comment] = splitComment(line);
  let text = code.trim();
  if (text.startsWith('- ')) text = text.slice(LIST_MARKER_LENGTH).trim();
  else if (text === '-') return [null, '', comment];
  const colon = text.indexOf(':');
  if (colon < 0) return [null, '', comment];
  const key = unquote(text.slice(0, colon).trim());
  if (key === '') return [null, '', comment];
  return [key, text.slice(colon + 1).trim(), comment];
}

function codeOf(line: string): string {
  const [code] = splitComment(line);
  return code.trim();
}

function contentIndent(line: string): number | null {
  const [code] = splitComment(line);
  if (code.trim() === '') return null;
  let index = 0;
  while (index < code.length && code[index] === ' ') index += 1;
  return index;
}

function unquote(value: string): string {
  if (value.length >= QUOTE_PAIR_LENGTH && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

interface LineSpan {
  start: number;
  end: number;
}

function syncDocumentShape(patch: TextPatch, change: Change): void {
  const { lines, edits } = patch;
  const { before, after } = change;
  const spans = topLevelSpans(lines);
  for (const [key, span] of spans) {
    if (key === 'stages') continue;
    if (!Object.hasOwn(after, key)) edits.push([span.start, span.end, []]);
  }
  for (const key of Object.keys(after)) {
    if (key === SCHEMA_VERSION_FIELD || key === 'stages') continue;
    if (spans.has(key) || Object.hasOwn(before, key)) continue;
    const rendered = renderTopLevel(key, after[key]);
    if (rendered.length > 0) edits.push([lines.length, lines.length, rendered]);
  }
  for (const [key, span] of spans) {
    if (key === 'stages' || !Object.hasOwn(after, key)) continue;
    const previous = before[key];
    const next = after[key];
    if (key === 'downstream' && !deepEqual(previous, next)) {
      edits.push([span.start, span.end, renderTopLevel(key, next)]);
      continue;
    }
    if (!isRecord(previous) || !isRecord(next)) continue;
    const removed = Object.keys(previous).filter((nested) => !Object.hasOwn(next, nested));
    if (removed.length === 0) continue;
    const header = lineInfo(lines[span.start] ?? '');
    const flow = header !== null && (header.rest.startsWith('{') || header.rest.startsWith('['));
    // A flow value has no nested key line. Rewrite the parent from the migrated mapping.
    if (flow || removed.some((nested) => nestedKeySpan(lines, span, nested) === null)) {
      edits.push([span.start, span.end, renderTopLevel(key, next)]);
      continue;
    }
    for (const nested of removed) {
      const range = nestedKeySpan(lines, span, nested);
      if (range !== null) edits.push([range[0], range[1], []]);
    }
  }
}

function topLevelSpans(lines: string[]): Map<string, LineSpan> {
  const spans = new Map<string, LineSpan>();
  let current: { key: string; start: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const item = lineInfo(lines[index] ?? '');
    if (item === null || item.indent !== 0 || item.key === null) continue;
    if (current !== null && !spans.has(current.key)) spans.set(current.key, { start: current.start, end: index });
    current = { key: item.key, start: index };
  }
  if (current !== null && !spans.has(current.key)) spans.set(current.key, { start: current.start, end: lines.length });
  return spans;
}

function nestedKeySpan(lines: string[], parent: LineSpan, key: string): [number, number] | null {
  let childIndent: number | null = null;
  for (let index = parent.start + 1; index < parent.end; index += 1) {
    const item = lineInfo(lines[index] ?? '');
    if (item === null || item.key === null) continue;
    if (childIndent === null || item.indent < childIndent) childIndent = item.indent;
  }
  if (childIndent === null) return null;
  for (let index = parent.start + 1; index < parent.end; index += 1) {
    const item = lineInfo(lines[index] ?? '');
    if (item === null || item.key !== key || item.indent !== childIndent) continue;
    return [index, nestedValueEnd(lines, parent.end, { index, item })];
  }
  return null;
}

function nestedValueEnd(lines: string[], parentEnd: number, key: { index: number; item: LineInfo }): number {
  const { index, item } = key;
  let end = index + 1;
  for (let nested = index + 1; nested < parentEnd; nested += 1) {
    const next = lineInfo(lines[nested] ?? '');
    // A blank or comment line stays in the value. The next sibling key ends it.
    if (next !== null && next.key !== null && next.indent <= item.indent) break;
    end = nested + 1;
  }
  return end;
}

function renderTopLevel(key: string, value: unknown): string[] {
  if ((value === null || value === undefined)) return [];
  return splitLines(stringify({ [key]: value }, { lineWidth: 0 }));
}

function sorted(keys: Iterable<string>): string[] {
  return [...keys].sort((left, right) => Number(left > right) - Number(left < right));
}

export const SCHEMA_VERSION_FIELD = 'schema_version';

const AMBIGUOUS_SCALAR = /^(null|true|false|yes|no|on|off|y|n)$/i;
