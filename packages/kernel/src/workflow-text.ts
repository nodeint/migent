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

interface StageOptionsScan {
  optionsAt: number | null;
  optionIndent: number | null;
  optionLines: Map<string, number>;
  thinkingAt: number | null;
}

/** Where the stage's block `options:` mapping, its entries and its `thinking` line sit, as absolute lines. */
function scanStageOptions(
  content: readonly [number, LineInfo][],
  layout: { start: number; siblingIndent: number },
): StageOptionsScan {
  const { start, siblingIndent } = layout;
  const optionsAt = siblingLineWith(content, layout, (item) => item.key === 'options' && item.rest === '');
  const thinkingAt = siblingLineWith(content, layout, (item) => item.key === 'thinking' && item.rest !== '');
  const optionLines = new Map<string, number>();
  if (optionsAt === null) return { optionsAt, optionIndent: null, optionLines, thinkingAt };
  let optionIndent: number | null = null;
  for (const [index, item] of content) {
    if (start + index <= optionsAt) continue;
    if (item.indent <= siblingIndent) break;
    if (item.key === null || item.rest === '') continue;
    optionIndent ??= item.indent;
    if (item.indent === optionIndent) optionLines.set(item.key, start + index);
  }
  return { optionsAt, optionIndent, optionLines, thinkingAt };
}

/** The last sibling-level line matching the predicate, as an absolute line. */
function siblingLineWith(
  content: readonly [number, LineInfo][],
  layout: { start: number; siblingIndent: number },
  matches: (item: LineInfo) => boolean,
): number | null {
  let found: number | null = null;
  for (const [index, item] of content) {
    if (item.indent === layout.siblingIndent && item.key !== null && matches(item)) found = layout.start + index;
  }
  return found;
}

interface StageContext {
  readonly patch: TextPatch;
  readonly span: LineSpan;
  readonly change: Change;
  readonly content: [number, LineInfo][];
  readonly siblingIndent: number;
}

function stageContent(lines: string[], stage: LineSpan): [number, LineInfo][] {
  const content: [number, LineInfo][] = [];
  lines.slice(stage.start, stage.end).forEach((line, index) => {
    const item = lineInfo(line);
    if (item !== null) content.push([index, item]);
  });
  return content;
}

function patchStage(patch: TextPatch, stage: LineSpan, change: Change): void {
  const content = stageContent(patch.lines, stage);
  const [first] = content;
  if (first === undefined) return;
  const firstIndent = first[1].indent;
  const siblingIndent = siblingIndentOf(content, firstIndent);
  const unit = siblingIndent > firstIndent ? siblingIndent - firstIndent : YAML_DEFAULT_INDENT;
  const context: StageContext = { patch, span: stage, change, content, siblingIndent };
  migrateStageAgent(context);
  migrateStageProduces(context);
  migrateStageDecision(context);
  renameStageModelKey(context);
  dropFlowStageOptions(context);
  patchStageOptions(context, unit);
}

function locateStageKey(context: StageContext, key: string): [number, number] {
  const span = nestedKeySpan(context.patch.lines, context.span, key);
  if (span === null) throw new ConfigEditError(`Cannot locate the stage ${key} to migrate.`);
  return span;
}

function migrateStageAgent(context: StageContext): void {
  const { patch, change: { before, after }, siblingIndent } = context;
  if (deepEqual(before.agent, after.agent) || !Object.hasOwn(after, 'agent') || Object.hasOwn(before, 'model')) return;
  const span = locateStageKey(context, 'agent');
  const base = patch.lines.slice(span[0], span[1]).map((line) => line.slice(siblingIndent)).join('\n');
  const result = renderAuthoringYaml({ agent: after.agent }, base);
  if (!result.preserved) throw new ConfigEditError(`Cannot preserve the stage agent: ${result.reason}.`);
  patch.edits.push([span[0], span[1], result.text.trimEnd().split('\n').map((line) => `${' '.repeat(siblingIndent)}${line}`)]);
}

function migrateStageProduces(context: StageContext): void {
  const { patch, change: { before, after }, siblingIndent } = context;
  if (!Object.hasOwn(before, 'produces') || Object.hasOwn(after, 'produces')) return;
  const span = locateStageKey(context, 'produces');
  const ids = Array.isArray(after.artifacts) ? after.artifacts : [];
  patch.edits.push([span[0], span[1], ids.length > 0 ? [`${' '.repeat(siblingIndent)}artifacts: [${ids.map((id) => artifactIdScalar(String(id))).join(', ')}]`] : []]);
}

function migrateStageDecision(context: StageContext): void {
  const { patch, change: { before, after }, siblingIndent } = context;
  if (deepEqual(before.decision, after.decision)) return;
  const span = locateStageKey(context, 'decision');
  const replacement = Object.hasOwn(after, 'decision')
    ? renderTopLevel('decision', after.decision).map((line) => `${' '.repeat(siblingIndent)}${line}`)
    : [];
  patch.edits.push([span[0], span[1], replacement]);
}

function siblingKeyLine(context: StageContext, key: string, requireValue: boolean): number | null {
  for (const [index, item] of context.content) {
    if (item.indent !== context.siblingIndent || item.key !== key) continue;
    if (requireValue && item.rest === '') continue;
    return context.span.start + index;
  }
  return null;
}

function renameStageModelKey(context: StageContext): void {
  const { patch, change: { before, after } } = context;
  if (!Object.hasOwn(before, 'model') || !Object.hasOwn(after, 'agent') || Object.hasOwn(after, 'model')) return;
  const at = siblingKeyLine(context, 'model', false);
  if (at === null) return;
  const text = patch.lines[at] ?? '';
  const match = /^(\s*)(["']?)model\2(\s*:)/.exec(text);
  if (match !== null) patch.edits.push([at, at + 1, [`${match[1]}agent${text.slice(match[0].length - match[3].length)}`]]);
}

function dropFlowStageOptions(context: StageContext): void {
  const { patch, change: { before, after }, siblingIndent, span } = context;
  if (!Object.hasOwn(before, 'options') || Object.hasOwn(after, 'options')) return;
  // A flow-style `options: {..}` has no nested lines to sync; drop the whole entry.
  const at = siblingKeyLine(context, 'options', true);
  if (at !== null) patch.edits.push([at, optionsEnd(patch.lines, at, { siblingIndent, stageEnd: span.end }), []]);
}

function patchStageOptions(context: StageContext, unit: number): void {
  const { patch, change: { before, after }, siblingIndent, span } = context;
  const layout = { start: span.start, siblingIndent };
  const { optionsAt, optionIndent, optionLines, thinkingAt } = scanStageOptions(context.content, layout);
  const beforeOptions = isRecord(before.options) ? before.options : {};
  const afterOptions = isRecord(after.options) ? after.options : {};
  if (!deepEqual(beforeOptions, afterOptions)) {
    syncStageOptions(patch, { before: beforeOptions, after: afterOptions }, {
      optionLines,
      optionsAt,
      optionIndent: optionIndent ?? siblingIndent + unit,
      siblingIndent,
      stageEnd: span.end,
    });
  }
  if (Object.hasOwn(before, 'thinking') && !Object.hasOwn(after, 'thinking') && thinkingAt !== null) {
    patch.edits.push([thinkingAt, thinkingAt + 1, []]);
  }
}

interface OptionsLayout {
  readonly optionLines: ReadonlyMap<string, number>;
  readonly optionsAt: number | null;
  readonly optionIndent: number;
  readonly siblingIndent: number;
  readonly stageEnd: number;
}

function nonEmptyOptionText(options: Record<string, unknown>): Map<string, string> {
  const text = new Map<string, string>();
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'string' && value.trim() !== '') text.set(key, value.trim());
  }
  return text;
}

function syncStageOptions(patch: TextPatch, change: Change, layout: OptionsLayout): void {
  const { lines, edits } = patch;
  const { optionsAt, siblingIndent, stageEnd } = layout;
  const afterText = nonEmptyOptionText(change.after);
  if (afterText.size === 0) {
    if (optionsAt !== null) edits.push([optionsAt, optionsEnd(lines, optionsAt, { siblingIndent, stageEnd }), []]);
    return;
  }
  if (optionsAt === null) {
    appendOptionsBlock(patch, afterText, layout);
    return;
  }
  removeStaleOptions(patch, Object.keys(change.before).filter((key) => !afterText.has(key)), layout);
  for (const name of sorted(afterText.keys())) upsertOptionLine(patch, [name, afterText.get(name) ?? ''], { ...layout, optionsAt });
}

function appendOptionsBlock(patch: TextPatch, afterText: Map<string, string>, layout: OptionsLayout): void {
  const nested = ' '.repeat(layout.optionIndent);
  const block = [`${' '.repeat(layout.siblingIndent)}options:`];
  for (const name of sorted(afterText.keys())) block.push(`${nested}${name}: ${yamlScalar(afterText.get(name) ?? '')}`);
  patch.edits.push([layout.stageEnd, layout.stageEnd, block]);
}

function removeStaleOptions(patch: TextPatch, stale: string[], layout: OptionsLayout): void {
  for (const name of sorted(stale)) {
    const lineIndex = layout.optionLines.get(name);
    if (lineIndex !== undefined) patch.edits.push([lineIndex, lineIndex + 1, []]);
  }
}

type PlacedOptions = OptionsLayout & { readonly optionsAt: number };

function upsertOptionLine(patch: TextPatch, [name, value]: [string, string], layout: PlacedOptions): void {
  const { lines, edits } = patch;
  const { optionsAt } = layout;
  const lineIndex = layout.optionLines.get(name);
  if (lineIndex === undefined) {
    const insertAt = optionsEnd(lines, optionsAt, { siblingIndent: layout.siblingIndent, stageEnd: layout.stageEnd });
    edits.push([insertAt, insertAt, [`${' '.repeat(layout.optionIndent)}${name}: ${yamlScalar(value)}`]]);
    return;
  }
  const [code, comment] = splitComment(lines[lineIndex] ?? '');
  const raw = code.split(':').slice(1).join(':');
  if (unquote(raw.trim()) === value) return;
  const colon = code.indexOf(':');
  const key = colon < 0 ? code : code.slice(0, colon);
  let updated = `${key}: ${yamlScalar(value)}`;
  if (comment !== '') updated = `${updated} ${comment}`;
  edits.push([lineIndex, lineIndex + 1, [updated]]);
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

interface StageCursor {
  readonly listIndent: number | null;
  readonly start: number | null;
  readonly stageId: string | null;
}

function stagesHeaderIndex(lines: string[]): number | null {
  for (let index = 0; index < lines.length; index += 1) {
    const item = lineInfo(lines[index] ?? '');
    if (item !== null && item.indent === 0 && item.key === 'stages' && item.rest === '') return index;
  }
  return null;
}

function closeStage(spans: [string, number, number][], cursor: StageCursor, end: number): void {
  if (cursor.start !== null && cursor.stageId !== null) spans.push([cursor.stageId, cursor.start, end]);
}

function isListItem(text: string): boolean {
  return text.startsWith('- ') || text === '-';
}

/** Advances the cursor over one line; a new list item at the stage indent opens a stage. */
function advanceStage(cursor: StageCursor, item: LineInfo, text: string): { cursor: StageCursor; opened: boolean } {
  const listIndent = cursor.listIndent ?? (isListItem(text) ? item.indent : null);
  if (listIndent !== null && item.indent === listIndent && isListItem(text)) {
    return { cursor: { listIndent, start: -1, stageId: idOnDash(text) }, opened: true };
  }
  const named = cursor.start !== null && cursor.stageId === null && item.key === 'id' && item.rest !== '';
  return { cursor: { ...cursor, listIndent, stageId: named ? unquote(item.rest) : cursor.stageId }, opened: false };
}

function stageSpans(lines: string[]): [string, number, number][] {
  const spans: [string, number, number][] = [];
  let cursor: StageCursor = { listIndent: null, start: null, stageId: null };
  const header = stagesHeaderIndex(lines);
  if (header === null) return spans;
  for (let index = header + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const item = lineInfo(line);
    if (item === null) continue;
    if (item.indent === 0) {
      closeStage(spans, cursor, index);
      return spans;
    }
    const next = advanceStage(cursor, item, codeOf(line));
    if (next.opened) {
      closeStage(spans, cursor, index);
      cursor = { ...next.cursor, start: index };
    } else {
      cursor = next.cursor;
    }
  }
  closeStage(spans, cursor, lines.length);
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
    syncTopLevelEntry(patch, { key, span }, { before: before[key], after: after[key] });
  }
}

function syncTopLevelEntry(
  patch: TextPatch,
  entry: { key: string; span: LineSpan },
  values: { before: unknown; after: unknown },
): void {
  const { lines, edits } = patch;
  const { key, span } = entry;
  const { before: previous, after: next } = values;
  if (key === 'downstream' && !deepEqual(previous, next)) {
    edits.push([span.start, span.end, renderTopLevel(key, next)]);
    return;
  }
  if (!isRecord(previous) || !isRecord(next)) return;
  const removed = Object.keys(previous).filter((nested) => !Object.hasOwn(next, nested));
  if (removed.length === 0) return;
  const header = lineInfo(lines[span.start] ?? '');
  const flow = header !== null && (header.rest.startsWith('{') || header.rest.startsWith('['));
  // A flow value has no nested key line. Rewrite the parent from the migrated mapping.
  if (flow || removed.some((nested) => nestedKeySpan(lines, span, nested) === null)) {
    edits.push([span.start, span.end, renderTopLevel(key, next)]);
    return;
  }
  for (const nested of removed) {
    const range = nestedKeySpan(lines, span, nested);
    if (range !== null) edits.push([range[0], range[1], []]);
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
