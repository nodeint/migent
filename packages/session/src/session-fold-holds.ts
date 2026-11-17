import { isStopped } from '@nodeint/migent-kernel';

import type { ParsedEvent } from './session-events.js';
import { later, textOr } from './session-fold-util.js';
import type { StatusDraft } from './session-status-draft.js';

/** `session.active` with this `data.from` resolves every plugin hold recorded before it. */
export const PLUGIN_HOLD_RESOLUTION = 'plugin_hold';

/** One unresolved plugin hold: a `plugin.failed` whose applied `on_error` is `stop` or `fail`. */
export interface PluginHold {
  readonly plugin: string;
  readonly hook: string | null;
  readonly invocation_id: string | null;
  readonly on_error: 'stop' | 'fail';
  readonly error: string | null;
  readonly recorded_at: string;
}

/** The holds no `session.active` (`from: 'plugin_hold'`) has resolved, in log order. */
export function unresolvedPluginHolds(events: readonly ParsedEvent[]): PluginHold[] {
  let holds: PluginHold[] = [];
  for (const event of events) {
    if (event.event === 'session.active' && event.data.from === PLUGIN_HOLD_RESOLUTION) {
      holds = [];
    } else if (event.event === 'plugin.failed' && (event.data.on_error === 'stop' || event.data.on_error === 'fail')) {
      holds.push({
        plugin: textOr(event.data.plugin) ?? '',
        hook: textOr(event.data.hook),
        invocation_id: textOr(event.data.invocation_id),
        on_error: event.data.on_error,
        error: textOr(event.data.error),
        recorded_at: event.timestamp,
      });
    }
  }
  return holds;
}

function blockerOf(hold: PluginHold): string {
  const where = hold.hook === null ? hold.plugin : `${hold.plugin} (${hold.hook})`;
  return hold.error === null ? `plugin ${where} failed` : `plugin ${where} failed: ${hold.error}`;
}

/** Whether holds touch a session of this status. `prepared`, `expired` and `corrupt` are not affected. */
const holdsApply = (status: string): boolean => status === 'active' || status === 'completed' || stageStopped(status);
const stageStopped = (status: string): boolean => status !== 'expired' && isStopped(status);

function latestOf(draft: StatusDraft, holds: readonly PluginHold[]): void {
  let updatedAt = textOr(draft.get('updated_at'));
  for (const hold of holds) updatedAt = later(updatedAt, hold.recorded_at);
  if (updatedAt !== null) draft.set('updated_at', updatedAt);
}

/**
 * Applies the holds after the execution-derived status and before manual completion. A `stop` hold turns
 * `active` or `completed` into `blocked` and joins the blockers of a stage stop. A `fail` hold turns
 * `completed` into `active`. `plugin_holds` exists only while a hold does.
 */
export function applyPluginHolds(draft: StatusDraft, events: readonly ParsedEvent[]): void {
  draft.clear('plugin_holds');
  const holds = unresolvedPluginHolds(events);
  const status = draft.get('status');
  if (holds.length === 0 || typeof status !== 'string' || !holdsApply(status)) return;
  latestOf(draft, holds);
  draft.set('plugin_holds', holds.map(({ recorded_at: _recorded, ...row }) => row));
  const blockers = holds.filter((hold) => hold.on_error === 'stop').map(blockerOf);
  if (blockers.length > 0 && stageStopped(status)) {
    const existing = textOr(draft.get('blocker'));
    draft.set('blocker', [...(existing === null ? [] : [existing]), ...blockers].join('; '));
    return;
  }
  if (status !== 'completed' && blockers.length === 0) return;
  draft.clear('completion_method');
  const next = blockers.length > 0 ? 'blocked' : 'active';
  draft.set('status', next);
  draft.applyTerminalFields(next, { source: null, reason: blockers.join('; ') || null });
}
