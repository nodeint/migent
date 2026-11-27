import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import type { PluginArtifactSkip, PluginSessionArtifact, PluginSessionArtifacts } from '@nodeint/migent-contracts';
import { BYTES_PER_KIB, EXECUTIONS_DIRNAME, isAtomicTempName, MIGENT_DIRNAME, SESSIONS_DIRNAME } from '@nodeint/migent-kernel';

import { orderedEvents, readExecutions, sessionIsCorrupt } from './session-facts.js';
import { lastBasisSeq } from './session-snapshot.js';

/** Core bounds of the `artifacts` read. Not configurable. */
const ARTIFACT_FILE_KIB = 32;
const ARTIFACT_TOTAL_KIB = 128;
export const ARTIFACT_FILE_BYTES = ARTIFACT_FILE_KIB * BYTES_PER_KIB;
export const ARTIFACT_TOTAL_BYTES = ARTIFACT_TOTAL_KIB * BYTES_PER_KIB;
const UTF8_CONTINUATION_MASK = 0b1100_0000;
const UTF8_CONTINUATION_BITS = 0b1000_0000;

const ARTIFACTS_DIRNAME = 'artifacts';
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Regular files under `root`, as sorted relative paths with `/` separators. Symbolic links are not followed. */
function listFiles(root: string, relative = ''): string[] {
  let entries;
  try {
    entries = readdirSync(path.join(root, relative), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (isAtomicTempName(entry.name)) continue;
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

/** Up to `limit + 1` bytes of a file: the extra byte shows whether more follow and where a cut falls. */
function readHead(file: string, limit: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(statSync(file).size, limit + 1));
    const read = buffer.length === 0 ? 0 : readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

type Content = Pick<PluginSessionArtifact, 'content' | 'truncated' | 'skipped'>;
const skipped = (reason: PluginArtifactSkip): Content => ({ content: null, truncated: false, skipped: reason });

/** The cut position for `limit` bytes: a continuation byte at the cut means a character is split, so cut earlier. */
function boundary(buffer: Buffer, limit: number): number {
  let cut = Math.min(limit, buffer.length);
  const splits = (index: number): boolean => ((buffer[index] ?? 0) & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BITS;
  while (cut > 0 && cut < buffer.length && splits(cut)) cut -= 1;
  return cut;
}

function readOne(file: string, limit: number): { content: Content; used: number } {
  if (limit <= 0) return { content: skipped('too_large_total'), used: 0 };
  let buffer: Buffer;
  try {
    buffer = readHead(file, limit);
  } catch {
    return { content: skipped('unreadable'), used: 0 };
  }
  const bytes = buffer.subarray(0, boundary(buffer, limit));
  if (bytes.includes(0)) return { content: skipped('binary'), used: 0 };
  try {
    return {
      content: { content: decoder.decode(bytes), truncated: buffer.length > limit, skipped: null },
      used: bytes.length,
    };
  } catch {
    return { content: skipped('binary'), used: 0 };
  }
}

/** Whether `child` really lies inside `parent`: both resolved, so linked path components cannot escape. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(realpathSync(parent), realpathSync(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

const isRealDirectory = (target: string): boolean => {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The artifacts root of one execution, or null. The id comes from `execution.json`, so it must name a plain child
 * of `executions/`; the execution directory and its `artifacts` directory must be real directories (not links)
 * that resolve inside the session's executions directory.
 */
function artifactsRoot(sessionDirectory: string, executionId: string): string | null {
  if (executionId === '' || executionId !== path.basename(executionId) || executionId === '..' || executionId === '.') {
    return null;
  }
  const executions = path.join(sessionDirectory, EXECUTIONS_DIRNAME);
  const executionDirectory = path.join(executions, executionId);
  const root = path.join(executionDirectory, ARTIFACTS_DIRNAME);
  if (!isRealDirectory(executionDirectory) || !isRealDirectory(root)) return null;
  try {
    return isInside(executions, root) && isInside(executionDirectory, root) ? root : null;
  } catch {
    return null;
  }
}

/**
 * The bounded content of every execution's stage artifacts. It reads only `executions/<id>/artifacts/`. The
 * total budget goes to the newest executions first; entries are returned in execution order.
 */
export function readSessionArtifacts(workspace: string, sessionId: string): PluginSessionArtifacts {
  const sessionDirectory = path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME, sessionId);
  const basisSeq = lastBasisSeq(orderedEvents(sessionDirectory));
  if (sessionIsCorrupt(sessionDirectory)) return { basis_seq: basisSeq, entries: [] };
  const executions = readExecutions(sessionDirectory);
  let remaining = ARTIFACT_TOTAL_BYTES;
  const perExecution = new Map<string, PluginSessionArtifact[]>();
  for (const execution of [...executions].reverse()) {
    const root = artifactsRoot(sessionDirectory, execution.id);
    const entries: PluginSessionArtifact[] = [];
    perExecution.set(execution.id, entries);
    if (root === null) continue;
    for (const relative of listFiles(root)) {
      const { content, used } = readOne(path.join(root, ...relative.split('/')), Math.min(ARTIFACT_FILE_BYTES, remaining));
      remaining -= used;
      entries.push({ execution_id: execution.id, stage_id: execution.stageId, path: relative, ...content });
    }
  }
  return { basis_seq: basisSeq, entries: executions.flatMap((execution) => perExecution.get(execution.id) ?? []) };
}
