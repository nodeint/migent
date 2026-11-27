import type { PluginSessionSnapshot } from '@nodeint/migent-contracts';

/** The first line of `summary.md`: the only machine-read part. Inspection parses it, so keep the format stable. */
export function summaryHeader(basisSeq: number | null): string {
  const seq = basisSeq === null ? 0 : basisSeq;
  return `<!-- migent-summary v1 basis_seq=${seq} -->`;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

/** The timestamp of the event at `basis_seq`, or of the last event when it is not found; empty without events. */
function basisTimestamp(snapshot: PluginSessionSnapshot): string {
  const { events, basis_seq: basis } = snapshot;
  const found = events.find((event) => event.seq === basis);
  return found?.timestamp ?? events.at(-1)?.timestamp ?? '';
}

/** `# Session <id> · <workflow> · <status> · <time>`, from the snapshot and never from agent output. */
export function summaryTitle(sessionId: string, snapshot: PluginSessionSnapshot): string {
  const { status } = snapshot;
  const parts = [
    `Session ${text(status.session_id, sessionId)}`,
    text(status.workflow_id, 'no workflow'),
    text(status.status, 'unknown'),
    basisTimestamp(snapshot),
  ].filter((part) => part !== '');
  return `# ${parts.join(' · ')}`;
}

/** The whole file: header, title line, then the sections the agent wrote. */
export function renderSummary(sessionId: string, snapshot: PluginSessionSnapshot, body: string): string {
  const sections = body.trim().replace(/^# .*\n+/u, '');
  return `${summaryHeader(snapshot.basis_seq)}\n${summaryTitle(sessionId, snapshot)}\n\n${sections}\n`;
}
