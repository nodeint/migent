import { readFileSync } from 'node:fs';
import path from 'node:path';

import { SUMMARIZER_ARTIFACT_NAME, SUMMARIZER_PLUGIN_ID } from '@nodeint/migent-plugins';
import { readBasisSeq } from '@nodeint/migent-session';

import { printNotice } from '../display.js';

export interface SessionSummary {
  path: string;
  basis_seq: number;
  stale: boolean;
  text?: string;
}

const HEADER = /^<!-- migent-summary v1 basis_seq=(\d+) -->$/u;

/** The file's text, or `undefined` with a notice when it cannot be read or is not UTF-8. Missing is silent. */
function readText(filePath: string): string | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') printNotice(`Ignoring ${filePath}: it cannot be read.`);
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    printNotice(`Ignoring ${filePath}: it is not valid UTF-8.`);
    return undefined;
  }
}

/**
 * The stored summary of a session, or `undefined` when there is none or it cannot be read (then a notice goes to
 * stderr). It never consults config or the freeze, so a disabled plugin's summary is still shown. `text` is added
 * only with `withText`.
 */
export function readSummary(sessionDirectory: string, options: { withText: boolean }): SessionSummary | undefined {
  const filePath = path.join(sessionDirectory, 'plugins', SUMMARIZER_PLUGIN_ID, SUMMARIZER_ARTIFACT_NAME);
  const content = readText(filePath);
  if (content === undefined) return undefined;
  const newline = content.indexOf('\n');
  const first = (newline === -1 ? content : content.slice(0, newline)).replace(/\r$/u, '');
  const match = HEADER.exec(first);
  if (match === null) {
    printNotice(`Ignoring ${filePath}: its first line is not a summary header.`);
    return undefined;
  }
  const basisSeq = Number(match[1]);
  if (!Number.isSafeInteger(basisSeq)) {
    printNotice(`Ignoring ${filePath}: its basis_seq is out of range.`);
    return undefined;
  }
  const latest = readBasisSeq(path.resolve(sessionDirectory, '..', '..', '..'), path.basename(sessionDirectory));
  const summary: SessionSummary = {
    path: `plugins/${SUMMARIZER_PLUGIN_ID}/${SUMMARIZER_ARTIFACT_NAME}`,
    basis_seq: basisSeq,
    stale: latest !== null && latest > basisSeq,
  };
  if (options.withText) summary.text = newline === -1 ? '' : content.slice(newline + 1);
  return summary;
}
