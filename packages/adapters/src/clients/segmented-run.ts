import type { CliRunOutput, CommandSpec } from '../types.js';

export interface SegmentedRun {
  segments: string[][];
  sessionId: string | null;
  errorMessage: string | null;
  sawEvent: boolean;
}

export function modelsCommandFor(command: string): CommandSpec {
  return { argv: [command, 'models'] };
}

export function versionCommandFor(command: string): CommandSpec {
  return { argv: [command, '--version'] };
}

/** Starts an empty run: one open text segment and no event seen yet. */
export function emptySegmentedRun(): SegmentedRun {
  return { segments: [[]], sessionId: null, errorMessage: null, sawEvent: false };
}

function trimToStatusHeader(text: string): string {
  const header = /(?:^|\n)[ \t]*status:[ \t]*(?:complete|blocked)\b/im.exec(text);
  if (header !== null) return text.slice(header.index).trimStart();
  const glued = /status:[ \t]*(?:complete|blocked)\b/i.exec(text);
  if (glued !== null) return text.slice(glued.index).trim();
  return text;
}

function hasStatusHeader(text: string): boolean {
  return (
    /(?:^|\n)[ \t]*status:[ \t]*(?:complete|blocked)\b/im.test(text) ||
    /status:[ \t]*(?:complete|blocked)\b/i.test(text)
  );
}

function textWithStatusHeader(segments: readonly (readonly string[])[]): string {
  let lastNonempty = '';
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const text = (segments[index] ?? []).join('').trim();
    if (!text) continue;
    if (!lastNonempty) lastNonempty = text;
    const trimmed = trimToStatusHeader(text);
    if (hasStatusHeader(trimmed)) return trimmed;
  }
  if (lastNonempty) return trimToStatusHeader(lastNonempty);
  return '';
}

/** Picks the run output: model text, else the reported error, else the raw stdout when no event parsed. */
export function segmentedRunOutput(stdout: string, parsed: SegmentedRun): CliRunOutput {
  const { segments, sessionId, errorMessage, sawEvent } = parsed;
  const text = textWithStatusHeader(segments);
  if (text) return { text, sessionId, source: 'model' };
  if (errorMessage) return { text: errorMessage, sessionId, source: 'error' };
  if (sawEvent) return { text: '', sessionId, source: 'none' };
  const raw = stdout.trim();
  return { text: raw, sessionId: null, source: raw === '' ? 'none' : 'error' };
}
