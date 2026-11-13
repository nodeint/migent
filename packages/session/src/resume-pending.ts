import path from 'node:path';

import { type PendingResumeStop, pendingResumeStops } from '@nodeint/migent-kernel';

import { type ParsedEvent, readParsedEvents } from './session-events.js';

/** The resume decisions a session waits for, projected from its events in order. */
export function pendingResumesOf(events: readonly ParsedEvent[]): PendingResumeStop[] {
  return pendingResumeStops(events);
}

/** The same projection, read from the event log of a session directory. */
export function readPendingResumes(sessionDirectory: string): PendingResumeStop[] {
  return pendingResumesOf(readParsedEvents(path.join(sessionDirectory, 'events.jsonl')));
}
