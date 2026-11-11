import { readFileSync } from 'node:fs';
import path from 'node:path';

import { writeJsonAtomic } from '@nodeint/migent-kernel';
import { ConfigurationError } from '@nodeint/migent-kernel';
import { withFileLockSync } from '@nodeint/migent-kernel';
import { isRecord, parseYamlDocument } from '@nodeint/migent-workflow';

/**
 * Leaf module: owns a session's display title. It imports no session, fold, query, or lock module,
 * so the fold, the readers, and the store can all depend on it.
 */
export const TITLE_FILENAME = 'title.json';

export interface TitleHistoryEntry {
  title: string;
  changed_at: string;
}

export interface TitleRecord {
  title: string;
  updated_at: string;
  history: TitleHistoryEntry[];
}

export function assertSessionTitle(title: string): void {
  if (title.includes('\n') || title.includes('\r')) {
    throw new ConfigurationError('Session title must be one line.');
  }
  if (title.trim() === '') throw new ConfigurationError('Session title must not be empty.');
}

/** Rename validation: line breaks are rejected on the raw input, then the title is trimmed. */
export function normalizeRenameTitle(raw: string): string {
  if (raw.includes('\n') || raw.includes('\r')) {
    throw new ConfigurationError('Session title must be one line.');
  }
  const title = raw.trim();
  if (title === '') throw new ConfigurationError('Session title must not be empty.');
  return title;
}

function titlePath(sessionDirectory: string): string {
  return path.join(sessionDirectory, TITLE_FILENAME);
}

function parseRecord(text: string): TitleRecord | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  if (typeof payload.title !== 'string' || payload.title.trim() === '') return null;
  if (payload.title.includes('\n') || payload.title.includes('\r')) return null;
  const history = Array.isArray(payload.history)
    ? payload.history.filter(
        (entry): entry is TitleHistoryEntry =>
          isRecord(entry) && typeof entry.title === 'string' && typeof entry.changed_at === 'string',
      )
    : [];
  return {
    title: payload.title,
    updated_at: typeof payload.updated_at === 'string' ? payload.updated_at : '',
    history,
  };
}

/** The title record, or null when it is missing, unreadable, or invalid. */
export function readTitleRecord(sessionDirectory: string): TitleRecord | null {
  try {
    return parseRecord(readFileSync(titlePath(sessionDirectory), 'utf8'));
  } catch {
    return null;
  }
}

/** The creation title in manifest.yaml, or null. Never throws. */
export function readManifestTitle(sessionDirectory: string): string | null {
  try {
    const parsed = parseYamlDocument(readFileSync(path.join(sessionDirectory, 'manifest.yaml'), 'utf8'));
    return isRecord(parsed) && typeof parsed.title === 'string' && parsed.title !== '' ? parsed.title : null;
  } catch {
    return null;
  }
}

/** Record, then manifest, then null. Callers fall back to the session id. */
export function effectiveTitleFrom(record: TitleRecord | null, manifestTitle: string | null): string | null {
  return record?.title ?? manifestTitle ?? null;
}

export function effectiveTitle(sessionDirectory: string): string | null {
  return effectiveTitleFrom(readTitleRecord(sessionDirectory), readManifestTitle(sessionDirectory));
}

/** A copy of `status` whose `title` is the effective title, or has no `title` when there is none. */
export function overlayTitle(
  status: Readonly<Record<string, unknown>>,
  sessionDirectory: string,
): Record<string, unknown> {
  const title = effectiveTitle(sessionDirectory);
  if (title !== null) return { ...status, title };
  return Object.fromEntries(Object.entries(status).filter(([key]) => key !== 'title'));
}

/**
 * Write the title record under a short per-file lock, never the session lock. The previous title is
 * read inside the lock, so concurrent renames report the predecessor they really replaced.
 */
export function writeTitleRecord(
  sessionDirectory: string,
  title: string,
  now: string,
): { previousTitle: string | null } {
  const file = titlePath(sessionDirectory);
  return withFileLockSync(file, () => {
    const existing = readTitleRecord(sessionDirectory);
    const previousTitle = effectiveTitleFrom(existing, readManifestTitle(sessionDirectory));
    const history = [...(existing?.history ?? [])];
    if (previousTitle !== null) history.push({ title: previousTitle, changed_at: now });
    writeJsonAtomic(file, { title, updated_at: now, history } satisfies TitleRecord);
    return { previousTitle };
  });
}
