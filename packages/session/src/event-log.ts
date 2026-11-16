import path from 'node:path';

import { eventKindTraits } from '@nodeint/migent-contracts';
import { debugEnabled, logProgress, writeJsonAtomic } from '@nodeint/migent-kernel';

import { appendLifecycleEvent, appendRecordedEvent, type EventDraft } from './session-events.js';
import { commitFoldedStatus } from './session-fold.js';
import { assertSessionLockHeld, onSessionLockRelease, sessionLockHeldLocally } from './session-lock.js';

/** Receives the session id and the record exactly as it was written. */
export type SessionEventListener = (sessionId: string, record: Readonly<Record<string, unknown>>) => void;

/**
 * The one writer of session events. Appends are durable when `record` / `recordStream` return.
 * `commit` folds and writes `status.json`, then notifies subscribers of the records appended since the
 * last delivery, in sequence order. Notifications are an in-process signal: the log is the durable truth.
 *
 * - The operation that owns a fold boundary calls `commit`; the log never folds on its own, except
 *   through `recordProviderEvent`.
 * - Records are queued only while this process holds the session lock. Releasing the lock drops the queue.
 * - A failed append or fold propagates unchanged. A failed fold keeps the queue for the next `commit`.
 * - A throwing listener is logged and never fails the write.
 * - Listeners run synchronously inside the lock window. Calling `record`, `recordStream`, `commit` from a
 *   listener throws.
 */
export class SessionEventLog {
  private readonly listeners = new Set<SessionEventListener>();
  private readonly pending = new Map<string, Record<string, unknown>[]>();
  private delivering = false;

  constructor() {
    onSessionLockRelease((directory) => this.dropPending(directory));
  }

  /** Register a process-wide listener. Returns the function that removes it. */
  public subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Append a lifecycle event to `events.jsonl`. It is delivered by the next `commit`. */
  public record(sessionDirectory: string, draft: EventDraft): void {
    this.assertNotDelivering();
    this.assertLockHeld(sessionDirectory);
    this.enqueue(sessionDirectory, appendLifecycleEvent(sessionDirectory, draft));
  }

  /**
   * Append a provider or verify event. Stream kinds with an execution id go to that execution's `stream.jsonl`.
   * A kind that never folds (heartbeats, item traces) is delivered right after the append. A folding kind
   * waits for the `commit` of the operation that owns the fold boundary.
   */
  public recordStream(sessionDirectory: string, event: Record<string, unknown>): void {
    this.assertNotDelivering();
    this.assertLockHeld(sessionDirectory);
    const record = appendRecordedEvent(sessionDirectory, event);
    const traits = eventKindTraits(String(event.event));
    if (traits.folds && !traits.skipsStatusWrite) {
      this.enqueue(sessionDirectory, record);
      return;
    }
    const snapshot = this.snapshot(sessionDirectory, record);
    if (snapshot !== null) this.deliver(sessionDirectory, [snapshot]);
  }

  /** Append a provider or verify event, then fold when its kind folds. */
  public recordProviderEvent(workspace: string, sessionDirectory: string, event: Record<string, unknown>): void {
    this.recordStream(sessionDirectory, event);
    const traits = eventKindTraits(String(event.event));
    if (traits.folds && !traits.skipsStatusWrite) this.commit(workspace, sessionDirectory);
  }

  /** Fold, write `status.json` atomically, then deliver the queued records. Returns the folded status. */
  public commit(workspace: string, sessionDirectory: string): Record<string, unknown> {
    this.assertNotDelivering();
    this.assertLockHeld(sessionDirectory);
    const folded = commitFoldedStatus(workspace, sessionDirectory);
    this.flush(sessionDirectory);
    return folded;
  }

  /**
   * Write a status the caller already folded and validated (repair), then deliver the queued records.
   * Delivery follows the atomic write, exactly as in `commit`.
   */
  public commitFolded(sessionDirectory: string, folded: Record<string, unknown>): void {
    this.assertNotDelivering();
    this.assertLockHeld(sessionDirectory);
    writeJsonAtomic(path.join(sessionDirectory, 'status.json'), folded);
    this.flush(sessionDirectory);
  }

  private flush(sessionDirectory: string): void {
    const key = path.resolve(sessionDirectory);
    const queued = this.pending.get(key);
    if (queued === undefined || queued.length === 0) return;
    this.pending.delete(key);
    this.deliver(sessionDirectory, queued);
  }

  /** Every log mutation needs this process to hold the session lock, and the lock to still be ours. */
  private assertLockHeld(sessionDirectory: string): void {
    if (!sessionLockHeldLocally(sessionDirectory)) {
      throw new Error(`Session ${path.basename(path.resolve(sessionDirectory))} is not locked by this process.`);
    }
    assertSessionLockHeld(sessionDirectory);
  }

  private assertNotDelivering(): void {
    if (this.delivering) throw new Error('A session event listener cannot write session events.');
  }

  private isQueueing(sessionDirectory: string): boolean {
    return this.listeners.size > 0 && sessionLockHeldLocally(sessionDirectory);
  }

  /** A detached, deeply frozen copy of the record as serialized, or null when nobody can be notified. */
  private snapshot(sessionDirectory: string, record: Record<string, unknown>): Record<string, unknown> | null {
    if (!this.isQueueing(sessionDirectory)) return null;
    return deepFreeze(JSON.parse(JSON.stringify(record)) as Record<string, unknown>);
  }

  private enqueue(sessionDirectory: string, record: Record<string, unknown>): void {
    const snapshot = this.snapshot(sessionDirectory, record);
    if (snapshot === null) return;
    const key = path.resolve(sessionDirectory);
    const queue = this.pending.get(key);
    if (queue === undefined) this.pending.set(key, [snapshot]);
    else queue.push(snapshot);
  }

  private dropPending(directory: string): void {
    const dropped = this.pending.get(directory);
    if (dropped === undefined) return;
    this.pending.delete(directory);
    if (debugEnabled()) logProgress(`migent: dropped ${dropped.length} undelivered session event(s) for ${directory}`);
  }

  private deliver(sessionDirectory: string, records: readonly Record<string, unknown>[]): void {
    const sessionId = path.basename(path.resolve(sessionDirectory));
    this.delivering = true;
    try {
      for (const record of records) this.notify(sessionId, record);
    } finally {
      this.delivering = false;
    }
  }

  private notify(sessionId: string, record: Readonly<Record<string, unknown>>): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(sessionId, record);
      } catch (error) {
        logProgress(`migent: session event listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** The process-wide log. Every session event write goes through it. */
export const sessionEventLog = new SessionEventLog();

/** Register a process-wide listener on `sessionEventLog`. Returns the function that removes it. */
export function subscribeSessionEvents(listener: SessionEventListener): () => void {
  return sessionEventLog.subscribe(listener);
}
