import { isValid, SESSION_CLIENT_EVENT_FORMS, SESSION_EVENTS, SessionEvent, validationIssues } from '@nodeint/migent-contracts';
import { expect } from 'vitest';

/** Validates every event record against the envelope, its per-event schema and, for client events, the Current form. */
export function assertEventsValid(events: readonly Record<string, unknown>[]): Set<string> {
  const byName = new Map(SESSION_EVENTS.map((entry) => [entry.event, entry.schema]));
  const seen = new Set<string>();
  for (const event of events) {
    const name = String(event.event);
    expect(isValid(SessionEvent, event), `${name} envelope`).toBe(true);
    const schema = byName.get(name);
    if (schema === undefined) throw new Error(`unregistered event ${name}`);
    expect(validationIssues(schema, event), `${name} schema`).toEqual([]);
    type Forms = Record<string, { current: Parameters<typeof isValid>[0] } | undefined>;
    const clientForms: Forms = SESSION_CLIENT_EVENT_FORMS;
    const forms = clientForms[name];
    if (forms !== undefined) expect(validationIssues(forms.current, event), `${name} current form`).toEqual([]);
    seen.add(name);
  }
  return seen;
}
