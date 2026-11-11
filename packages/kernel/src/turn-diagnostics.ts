import { statSync } from 'node:fs';

import { isRecord } from '@nodeint/migent-workflow';

import type { FailureClassification, ResponseSource } from './cli-client.js';
import type { ExecutionFailure, ProcessFacts } from './command-executor.js';
import { KERNEL_VERSION } from './package-version.js';
import { leadingHeaders, outcomeStatuses } from './stage-outcome.js';

/** Schema of `diagnostics.json`. 2: `provider-exit` no longer implies stderr; adds `provider-error`, `stream_summary`, `result_state`. */
export const DIAGNOSTICS_SCHEMA_VERSION = 2;

const MAX_DISTINCT_LABELS = 32;
const MAX_LABEL_CHARS = 40;
const LAST_EVENTS = 10;
const MAX_ERROR_MESSAGES = 3;
const MAX_ERROR_CHARS = 300;
const LABEL_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const OTHER = 'other';

export function truncateText(text: string, limit = MAX_ERROR_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function jsonObjectLine(line: string): boolean {
  const text = line.trim();
  if (!text.startsWith('{')) return false;
  try {
    return isRecord(JSON.parse(text) as unknown);
  } catch {
    return false;
  }
}

export interface StreamSummary {
  stdout_bytes: number;
  lines: number;
  non_json_lines: number;
  events: Record<string, number>;
  last_events: string[];
  labelled: boolean;
  error_messages: string[];
}

/**
 * Accumulates the shape of one provider stream: label counts, never line content. A label is
 * the client's own vocabulary word; anything that does not look like one is counted as `other`.
 */
export class StreamSummarizer {
  private readonly counts = new Map<string, number>();
  private readonly recent: string[] = [];
  private nonJson = 0;

  constructor(private readonly labelled: boolean) {}

  public add(line: string, label: string | null): void {
    if (label === null) {
      if (line.trim() !== '' && !jsonObjectLine(line)) this.nonJson += 1;
      return;
    }
    const safe = this.safeLabel(label);
    this.counts.set(safe, (this.counts.get(safe) ?? 0) + 1);
    this.recent.push(safe);
    if (this.recent.length > LAST_EVENTS) this.recent.shift();
  }

  private safeLabel(label: string): string {
    const clean = label.length <= MAX_LABEL_CHARS && LABEL_PATTERN.test(label) ? label : OTHER;
    if (this.counts.has(clean) || this.counts.size < MAX_DISTINCT_LABELS) return clean;
    return OTHER;
  }

  public finish(raw: { bytes: number; lines: number }, errorMessages: readonly string[]): StreamSummary {
    return {
      stdout_bytes: raw.bytes,
      lines: raw.lines,
      non_json_lines: this.nonJson,
      events: Object.fromEntries(this.counts),
      last_events: [...this.recent],
      labelled: this.labelled,
      error_messages: errorMessages.slice(0, MAX_ERROR_MESSAGES).map((message) => truncateText(message)),
    };
  }
}

export type GateResult =
  | { state: 'passed'; status?: string }
  | { state: 'failed'; reason: string }
  | { state: 'not-evaluated' }
  | { state: 'not-applicable' };

export interface Gates {
  outcome: GateResult;
  artifact: GateResult;
  completion_outputs: GateResult;
}

export interface ObservedTurn {
  reply: {
    source: ResponseSource | 'unknown';
    bytes: number;
    status_header: { state: 'present'; status: string } | { state: 'invalid' } | { state: 'absent' } | { state: 'not-applicable' };
  };
  artifact: { state: 'present'; bytes: number } | { state: 'empty' } | { state: 'absent' } | { state: 'not-applicable' };
  response_written: boolean;
  conversation_turns: number;
}

/**
 * What a provider turn left behind, read without running any acceptance gate: no question
 * resolution, no writes, no events. The status token is copied only when it is a protocol value.
 */
export function observeTurn(input: {
  source: ResponseSource | undefined;
  responseText: string;
  /** Absolute path of the declared artifact, or null when the stage declares none. */
  artifactPath: string | null;
  responseWritten: boolean;
  conversationTurns: number;
}): ObservedTurn {
  const source = input.source ?? 'unknown';
  let statusHeader: ObservedTurn['reply']['status_header'] = { state: 'not-applicable' };
  if (source === 'model') {
    const raw = leadingHeaders(input.responseText).get('status');
    if (raw === undefined) statusHeader = { state: 'absent' };
    else {
      const token = raw.toLowerCase();
      statusHeader = outcomeStatuses.has(token) ? { state: 'present', status: token } : { state: 'invalid' };
    }
  }
  return {
    reply: { source, bytes: Buffer.byteLength(input.responseText), status_header: statusHeader },
    artifact: observeArtifact(input.artifactPath),
    response_written: input.responseWritten,
    conversation_turns: input.conversationTurns,
  };
}

function observeArtifact(artifactPath: string | null): ObservedTurn['artifact'] {
  if (artifactPath === null) return { state: 'not-applicable' };
  try {
    const stat = statSync(artifactPath);
    if (!stat.isFile()) return { state: 'absent' };
    return stat.size === 0 ? { state: 'empty' } : { state: 'present', bytes: stat.size };
  } catch {
    return { state: 'absent' };
  }
}

export interface ResultState {
  observed: ObservedTurn;
  gates: Gates;
  turn_verdict: 'accepted' | 'failed';
  reason: string | null;
}

export type DiagnosticsOrigin = 'start' | 'provider-error' | 'exit-only';

export interface TurnDiagnosticsInput {
  turn: number;
  agentId: string | null;
  failure?: ExecutionFailure;
  facts?: ProcessFacts;
  classification: FailureClassification | null;
  stream: StreamSummary | null;
  resultState: ResultState;
}

/** The `diagnostics.json` document of one abnormal provider turn. Pure. */
export function buildTurnDiagnostics(input: TurnDiagnosticsInput): Record<string, unknown> {
  const { failure, facts, classification } = input;
  const base = failure ?? facts;
  if (base === undefined) throw new Error('A diagnostics record needs a process failure or process facts.');
  const stderrTail = failure?.stderrTail ?? facts?.stderrTail ?? '';
  const kind = failure?.kind ?? 'provider-error';
  const origin: DiagnosticsOrigin = kind === 'start' ? 'start' : (classification?.origin ?? 'exit-only');
  const exitCode = failure ? failure.exitCode : (facts?.exitCode ?? null);
  const signal = failure ? failure.signal : (facts?.signal ?? null);
  const recordedAt = failure?.failedAt ?? facts?.endedAt ?? new Date().toISOString();
  const drain = failure?.drain ?? facts?.drain ?? 'closed';
  return {
    schema_version: DIAGNOSTICS_SCHEMA_VERSION,
    turn: input.turn,
    recorded_at: recordedAt,
    agent_id: input.agentId,
    failure: {
      kind,
      origin,
      phase: failure?.phase ?? null,
      code: failure?.code ?? null,
      errno: failure?.errno ?? null,
      syscall: failure?.syscall ?? null,
      path: failure?.path ?? null,
      exit_code: exitCode,
      signal,
      message: failure?.message ?? truncateText(classification?.message ?? 'provider reported an error'),
    },
    stderr_tail: stderrTail,
    stderr: {
      tail_bytes: Buffer.byteLength(stderrTail),
      total_bytes: failure?.stderrTotalBytes ?? facts?.stderrTotalBytes ?? 0,
      drain,
    },
    stream_summary: input.stream,
    result_state: input.resultState,
    // Only the executable and the argument count: other tokens may carry secrets or prompt text.
    command: { executable: base.executable, argument_count: base.argCount },
    cwd: base.cwd,
    endpoint: base.endpoint,
    endpoint_length: Buffer.byteLength(base.endpoint),
    migent_version: KERNEL_VERSION,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    timings: { spawned_at: base.spawnedAt, failed_at: recordedAt },
  };
}

// ---- failure.md attribution ---------------------------------------------------------------

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** One sentence on what the recorded evidence suggests. Pure. */
export function providerVerdictLine(diagnostics: Record<string, unknown>): string {
  const failure = record(diagnostics.failure);
  const state = record(diagnostics.result_state);
  const observed = record(state.observed);
  const reply = record(observed.reply);
  const header = record(reply.status_header);
  const artifact = record(observed.artifact);
  const origin = text(failure.origin);
  const exit = typeof failure.exit_code === 'number' ? `exited ${failure.exit_code}` : 'ended';
  if (origin === 'start') {
    return `The provider process did not start or was killed (${text(failure.message) ?? 'see message'}); no reply is attributable to the model.`;
  }
  const completeReply = header.state === 'present' && header.status === 'complete';
  const hasArtifact = artifact.state === 'present';
  const what = origin === 'provider-error' ? 'reported an error' : exit;
  if (completeReply && (hasArtifact || artifact.state === 'not-applicable')) {
    return `The provider ${what} after producing a complete reply${hasArtifact ? ' and the artifact exists' : ''}; the work was likely finished — inspect \`diagnostics.json\` → \`result_state.observed\` and \`stream_summary\`.`;
  }
  if (reply.source === 'model' && typeof reply.bytes === 'number' && reply.bytes > 0) {
    return `The provider ${what} after a model reply that did not pass the stage checks; inspect \`result_state\` and \`stderr_tail\`.`;
  }
  return `The provider ${what} without a usable model reply; inspect \`stderr_tail\` and \`stream_summary\`.`;
}

/**
 * The failure.md lines for a provider diagnostics record, placed by turn against the
 * execution's final provider turn. Returns the section lines (without a leading blank).
 */
export function renderProviderDiagnostics(input: {
  diagnostics: Record<string, unknown>;
  finalTurn: number | null;
  failureReason: string | null;
  link: string;
}): string[] {
  const { diagnostics, finalTurn, failureReason, link } = input;
  const failure = record(diagnostics.failure);
  const state = record(diagnostics.result_state);
  const stderr = record(diagnostics.stderr);
  const turn = typeof diagnostics.turn === 'number' ? diagnostics.turn : null;
  const verdict = text(state.turn_verdict);
  const origin = text(failure.origin) ?? 'unknown';
  const exit = typeof failure.exit_code === 'number' ? failure.exit_code : null;
  const pointer = `See [\`${link}\`](${link}).`;
  const turnLabel = turn === null ? 'an unknown turn' : `turn ${turn}`;
  if (finalTurn === null || turn === null) {
    return [
      '## Provider diagnostics',
      '',
      `A provider record exists for ${turnLabel} (origin \`${origin}\`, verdict \`${verdict ?? 'unknown'}\`). ` +
        'Whether it relates to this failure is unknown: this execution does not record its final provider turn.',
      '',
      pointer,
    ];
  }
  if (turn < finalTurn) {
    return [
      '## Earlier provider anomaly',
      '',
      `Turn ${turn} had a provider anomaly (origin \`${origin}\`, verdict \`${verdict ?? 'unknown'}\`). ` +
        `It is not the cause of this failure, which happened on turn ${finalTurn}.`,
      '',
      pointer,
    ];
  }
  if (verdict === 'accepted') {
    return [
      '## Earlier in this turn',
      '',
      `Provider ${exit === null ? 'ended abnormally' : `exited ${exit}`} on turn ${turn}; the reply was accepted. ` +
        `The execution failed later${failureReason === null ? '' : ` at \`${failureReason}\``}. The cause is the error above.`,
      '',
      pointer,
    ];
  }
  const drain = text(stderr.drain) ?? 'closed';
  const lines = [
    '## Provider failure',
    '',
    `- Turn: ${turn}`,
    `- Origin: \`${origin}\``,
    `- Exit code: ${exit === null ? 'none' : exit}${text(failure.signal) === null ? '' : ` (signal ${String(failure.signal)})`}`,
    `- Stderr: ${typeof stderr.total_bytes === 'number' ? stderr.total_bytes : 0} bytes seen, drain \`${drain}\``,
  ];
  const agentId = text(diagnostics.agent_id);
  if (agentId !== null) lines.push(`- Provider session: \`${agentId}\``);
  const observed = record(state.observed);
  const reply = record(observed.reply);
  const artifact = record(observed.artifact);
  lines.push(
    `- Reply: source \`${text(reply.source) ?? 'unknown'}\`, ${typeof reply.bytes === 'number' ? reply.bytes : 0} bytes`,
    `- Artifact: \`${text(artifact.state) ?? 'unknown'}\``,
    `- Response written: ${observed.response_written === true ? 'yes' : 'no'}`,
    '',
    providerVerdictLine(diagnostics),
    '',
    pointer,
  );
  return lines;
}
