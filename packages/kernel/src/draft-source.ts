import { isMap, isNode, isSeq, LineCounter, parseDocument } from 'yaml';

/** One-based start and exclusive end of a node in the draft text. */
export interface DraftRange {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

/**
 * Resolves author-coordinate paths (`["stages", 0, "role"]`) to ranges in the draft text.
 * A path that does not exist — a missing key — has no range, rather than a guessed ancestor.
 */
export interface DraftSourceMap {
  /** Range of the value at `path`. */
  rangeOf(path: readonly (string | number)[]): DraftRange | null;
  /** Range of the key of the last segment, for diagnostics about a key itself. */
  keyRangeOf(path: readonly (string | number)[]): DraftRange | null;
}

const EMPTY: DraftSourceMap = { rangeOf: () => null, keyRangeOf: () => null };

interface Located {
  value: unknown;
  key: unknown;
}

function locate(contents: unknown, path: readonly (string | number)[]): Located | null {
  let value: unknown = contents;
  let key: unknown = null;
  for (const segment of path) {
    if (isMap(value) && typeof segment === 'string') {
      const pair = value.items.find((item) => isNode(item.key) && String(item.key.toJSON()) === segment);
      if (pair === undefined) return null;
      value = pair.value;
      key = pair.key;
      continue;
    }
    if (isSeq(value) && typeof segment === 'number') {
      if (segment < 0 || segment >= value.items.length) return null;
      value = value.items[segment];
      key = null;
      continue;
    }
    return null;
  }
  return value === null || value === undefined ? null : { value, key };
}

function rangeAt(counter: LineCounter, node: unknown): DraftRange | null {
  if (!isNode(node) || node.range === null || node.range === undefined) return null;
  const [start, end] = node.range;
  const from = counter.linePos(start);
  const to = counter.linePos(end);
  return { start: { line: from.line, column: from.col }, end: { line: to.line, column: to.col } };
}

/** Builds the range map once per run. Text that does not parse simply has no ranges. */
export function buildDraftSourceMap(text: string): DraftSourceMap {
  const counter = new LineCounter();
  let doc;
  try {
    doc = parseDocument(text, { lineCounter: counter });
  } catch {
    return EMPTY;
  }
  if (doc.contents === null || doc.errors.length > 0) return EMPTY;
  const {contents} = doc;
  return {
    rangeOf(path) {
      const found = locate(contents, path);
      return found === null ? null : rangeAt(counter, found.value);
    },
    keyRangeOf(path) {
      const found = locate(contents, path);
      return found === null ? null : rangeAt(counter, found.key);
    },
  };
}
