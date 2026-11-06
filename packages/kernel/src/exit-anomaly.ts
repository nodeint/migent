import path from "node:path";
import { isRecord } from "./record.js";
import { readParsedEvents, type ParsedEvent } from "./session-events.js";

export const EXIT_ANOMALY_EVENT = "provider.exit_anomaly";

/** One provider process that exited non-zero without reporting an error. */
export interface ExitAnomaly {
  executionId: string;
  stageId: string | null;
  turn: number | null;
  provider: string | null;
  exitCode: number | null;
  signal: string | null;
  origin: string | null;
  accepted: boolean;
  reason: string | null;
}

/** Parse one event. A malformed event (no execution id, no boolean `accepted`) is rejected, not guessed. */
export function parseExitAnomaly(event: ParsedEvent): ExitAnomaly | null {
  if (event.event !== EXIT_ANOMALY_EVENT || event.executionId === null) return null;
  const details = isRecord(event.raw.details) ? event.raw.details : {};
  if (typeof details.accepted !== "boolean") return null;
  return {
    executionId: event.executionId,
    stageId: event.stageId,
    turn: typeof details.turn === "number" ? details.turn : null,
    provider: typeof details.provider === "string" ? details.provider : null,
    exitCode: typeof details.exit_code === "number" ? details.exit_code : null,
    signal: typeof details.signal === "string" ? details.signal : null,
    origin: typeof details.origin === "string" ? details.origin : null,
    accepted: details.accepted,
    reason: typeof details.reason === "string" ? details.reason : null,
  };
}

/** Anomalies in event order. Never deduplicated: a resumed execution can reuse a turn number. */
export function exitAnomaliesOf(events: ParsedEvent[]): ExitAnomaly[] {
  const anomalies: ExitAnomaly[] = [];
  for (const event of events) {
    const anomaly = parseExitAnomaly(event);
    if (anomaly !== null) anomalies.push(anomaly);
  }
  return anomalies;
}

/** Anomalies recorded in a session directory's `events.jsonl`. */
export function readExitAnomalies(sessionDirectory: string): ExitAnomaly[] {
  return exitAnomaliesOf(readParsedEvents(path.join(sessionDirectory, "events.jsonl")));
}
