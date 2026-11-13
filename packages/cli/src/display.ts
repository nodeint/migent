import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { Check } from '@nodeint/migent-doctor';
import { CORRECTION_FAILURE_REASONS } from '@nodeint/migent-kernel';
import { FAILURE_FILENAME } from '@nodeint/migent-session';

import { sessionFields } from './session-row.js';

/** Column width of check names in doctor output. */
const CHECK_NAME_WIDTH = 12;

const require = createRequire(import.meta.url);
const pc = require('picocolors') as {
  bold: (value: string) => string;
  cyan: (value: string) => string;
  red: (value: string) => string;
  green: (value: string) => string;
  dim: (value: string) => string;
};

export function printError(message: string): void {
  const tty = Boolean(process.stderr.isTTY);
  const prefix = tty ? pc.red(pc.bold('migent: ')) : 'migent: ';
  process.stderr.write(`${prefix}${message}\n`);
}

export function printNotice(message: string): void {
  const tty = Boolean(process.stderr.isTTY);
  const prefix = tty ? pc.cyan(pc.bold('[migent] ')) : '[migent] ';
  process.stderr.write(`${prefix}${message}\n`);
}

export function printResumeCommand(sessionId: string): void {
  process.stderr.write(`Resume with:\nmigent session continue ${sessionId}\n`);
}

export function printReplyCommand(sessionId: string, stageId?: string): void {
  const stage = stageId ? ` --stage ${stageId}` : '';
  process.stderr.write(`Reply with:\nmigent session continue ${sessionId}${stage} --reply "<answer>"\n`);
}

export function formatQuestion(question: Record<string, unknown>): string {
  const mode = question.selection === 'multiple' ? 'choose one or more' : 'choose one';
  const stage = typeof question.stage_id === 'string' ? `; stage ${question.stage_id}` : '';
  const number = String(question.id);
  const lines = [`${number}. ${String(question.question)} (${mode}${stage})`, String(question.context)];
  const recommended = Array.isArray(question.recommended) ? question.recommended : [];
  for (const option of Array.isArray(question.options) ? question.options.filter(isRecord) : []) {
    const note = recommended.includes(option.id) ? ' (recommended)' : '';
    lines.push(`  ${String(option.id)}. ${String(option.label)}${note}${option.description ? ` — ${String(option.description)}` : ''}`);
  }
  lines.push('  A free-text answer is always allowed.');
  lines.push(`  Answer: ${number}${question.selection === 'multiple' ? 'A+B' : 'A'} or ${number} <free text>.`);
  return lines.join('\n');
}

export function printCreated(paths: readonly string[], summary: string): void {
  process.stdout.write('Created:\n');
  for (const filePath of paths) process.stdout.write(`  ${filePath}\n`);
  process.stdout.write(`Using ${summary}\n`);
}

export function printInitNextSteps(): void {
  process.stdout.write("Install the Migent skill for this project's clients (optional):\n");
  process.stdout.write('  migent skill install --project\n');
  process.stdout.write('Start a workflow, replacing the task text with what you want done:\n');
  process.stdout.write('  migent session run --workflow implement --task "<what you want done>"\n');
}

export function printAlreadyInitialized(): void {
  process.stdout.write('Already initialized.\n');
}

export function printInitConflicts(paths: readonly string[]): void {
  printError('existing files block init.');
  for (const filePath of paths) process.stderr.write(`  ${filePath}\n`);
}

export function printDoctor(checks: readonly Check[], out: NodeJS.WriteStream = process.stdout): void {
  const tty = Boolean(out.isTTY);
  for (const check of checks) printCheck(check, out, tty);
}

function checkStatus(ok: boolean, tty: boolean): string {
  if (ok) return tty ? pc.green('ok') : 'ok';
  return tty ? pc.red('failed') : 'failed';
}

function printCheck(check: Check, out: NodeJS.WriteStream, tty: boolean): void {
  out.write(`${check.name.padEnd(CHECK_NAME_WIDTH)}${checkStatus(check.ok, tty)}\n`);
  for (const item of check.items) {
    const line = `  ${item}`;
    out.write(`${tty ? pc.dim(line) : line}\n`);
  }
  for (const problem of check.problems) out.write(`  ${problem.replaceAll('\n', '\n  ')}\n`);
  for (const warning of check.warnings) out.write(`  warning: ${warning.replaceAll('\n', '\n  ')}\n`);
}

export function printSessions(rows: readonly string[][]): void {
  if (rows.length === 0) {
    process.stdout.write('No sessions.\n');
    return;
  }
  for (const row of rows) {
    const fields = sessionFields(row);
    const identity =
      fields.title !== '' && fields.title !== fields.session ? `${fields.title}  ${fields.session}` : fields.session;
    process.stdout.write(
      `${identity}  ${fields.workflow}  ${fields.status}  ${fields.execution}  ${fields.decision}  ${fields.outputs}  ${fields.task}\n`,
    );
  }
}

export function printAgent(
  result: Record<string, unknown>,
  run: { role: string; client: string; model: string },
  workspace: string | null = null,
): void {
  const { role, client, model } = run;
  const decision = String(result.outcome_decision ?? '');
  let outcome = String(result.outcome_status ?? 'failed');
  if (decision) outcome = `${outcome} ${decision}`;
  const rows: [string, string][] = [
    ['role', role],
    ['model', `${client}/${model}`],
    ['outcome', outcome],
    ['session', String(result.session_id ?? '')],
    ['execution', String(result.execution_id ?? '')],
  ];
  for (const [label, value] of rows) process.stdout.write(`${label}  ${value}\n`);
  const failurePath = failureArtifactPath(workspace, result);
  if (failurePath !== null) process.stdout.write(`failure  ${failurePath}\n`);
  if (result.outcome_status === 'question') printAgentQuestions(result);
  if (isCorrectionFailure(result)) process.stdout.write(`error  ${String(result.failure_detail)}\n`);
}

function printAgentQuestions(result: Record<string, unknown>): void {
  for (const question of recordList(result.questions)) process.stdout.write(`${formatQuestion(question)}\n`);
  if (typeof result.questions_file === 'string') process.stdout.write(`questions  ${result.questions_file}\n`);
}

function isCorrectionFailure(result: Record<string, unknown>): boolean {
  return (
    typeof result.failure_reason === 'string' &&
    CORRECTION_FAILURE_REASONS.includes(result.failure_reason) &&
    typeof result.failure_detail === 'string'
  );
}

function failureArtifactPath(workspace: string | null, result: Record<string, unknown>): string | null {
  if (workspace === null) return null;
  const failed =
    result.execution_status === 'failed' ||
    (typeof result.failure_reason === 'string' && result.failure_reason !== '');
  if (!failed) return null;
  const sessionId = typeof result.session_id === 'string' ? result.session_id : '';
  const executionId = typeof result.execution_id === 'string' ? result.execution_id : '';
  if (sessionId === '' || executionId === '') return null;
  const relative = `executions/${executionId}/${FAILURE_FILENAME}`;
  const absolute = path.join(workspace, '.migent', 'sessions', sessionId, relative);
  return existsSync(absolute) ? relative : null;
}

type Line = [string, string];

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function identityLines(snapshot: Record<string, unknown>): Line[] {
  const lines: Line[] = [
    ['session_id', String(snapshot.session_id ?? '--')],
    ['status', String(snapshot.status ?? 'unknown')],
  ];
  const {title} = snapshot;
  if (nonEmptyString(title) && title !== lines[0]?.[1]) lines.splice(1, 0, ['title', title]);
  if (nonEmptyString(snapshot.workflow_id)) lines.push(['workflow', snapshot.workflow_id]);
  if (nonEmptyString(snapshot.task)) lines.push(['task', snapshot.task]);
  return lines;
}

function runningStageLine(stage: Record<string, unknown>): Line {
  const stageId = nonEmptyString(stage.stage_id) ? stage.stage_id : 'stage';
  const executionId = typeof stage.execution_id === 'string' ? stage.execution_id : '';
  const summary = nonEmptyString(stage.summary) ? ` · ${stage.summary}` : '';
  return ['running', `${stageId} · ${executionId}${summary}`];
}

function executionLines(snapshot: Record<string, unknown>): Line[] {
  const running = recordList(snapshot.running_stages);
  if (running.length > 0) return running.map(runningStageLine);
  const executionId = snapshot.execution_id;
  if (!nonEmptyString(executionId)) return [];
  const executionStatus = snapshot.execution_status ?? snapshot.latest_execution_status;
  const value = nonEmptyString(executionStatus) ? `${executionId} · ${executionStatus}` : executionId;
  return [['execution', value]];
}

/** What a human needs to choose a resume: idle time against the threshold, policy, TTL, margin, and context size. */
export function describeResumeEstimate(decision: Record<string, unknown>): string {
  const estimate = isRecord(decision.estimate) ? decision.estimate : null;
  if (estimate === null) return 'no estimate recorded';
  const seconds = (value: unknown): string => (typeof value === 'number' ? `${value}s` : 'unknown');
  const context = typeof estimate.context_tokens === 'number' ? `${estimate.context_tokens} tokens` : 'unknown (no usage reported)';
  const policy = nonEmptyString(decision.policy) ? `policy ${decision.policy}, ` : '';
  return `${policy}idle ${seconds(estimate.idle_seconds)} of ${seconds(estimate.threshold_seconds)} allowed `
    + `(cache_ttl ${seconds(estimate.cache_ttl_seconds)}, margin ${seconds(estimate.margin_seconds)}), context ${context}`;
}

/** One pending resume decision: the waiting stage, its source, the evidence, and the command that decides it. */
export function formatResumeDecision(decision: Record<string, unknown>, sessionId: string): string {
  const stage = String(decision.stage_id ?? '');
  const source = String(decision.source_execution_id ?? '');
  const since = nonEmptyString(decision.raised_at) ? `, waiting since ${decision.raised_at}` : '';
  return `${stage} waits for a decision (prompt cache expired; source ${source}${since}; ${describeResumeEstimate(decision)}). `
    + `Run: migent session resume ${sessionId} <resume|fresh> --stage ${stage}`;
}

function attentionLines(snapshot: Record<string, unknown>): Line[] {
  const lines: Line[] = recordList(snapshot.exit_anomalies).map((anomaly) => ['exit_anomaly', formatExitAnomaly(anomaly)]);
  if (nonEmptyString(snapshot.blocker)) lines.push(['blocked', snapshot.blocker]);
  for (const item of recordList(snapshot.questions)) lines.push(['question', formatQuestion(item)]);
  for (const decision of recordList(snapshot.resume_decisions)) {
    lines.push(['resume', formatResumeDecision(decision, nonEmptyString(snapshot.session_id) ? snapshot.session_id : '<session>')]);
  }
  const skippedStages = recordList(snapshot.skipped_stages);
  if (skippedStages.length > 0) {
    lines.push(['skipped', skippedStages.map((stage) => String(stage.stage_id ?? '')).join(', ')]);
  }
  return lines;
}

function outcomeLines(snapshot: Record<string, unknown>): Line[] {
  const {outcome} = snapshot;
  if (!isRecord(outcome) || typeof outcome.status !== 'string') return [];
  const lines: Line[] = [['outcome', outcome.status]];
  if (nonEmptyString(outcome.decision)) lines.push(['decision', outcome.decision]);
  return lines;
}

function formatQuotaFailure(quota: Record<string, unknown>): string {
  const parts = [
    typeof quota.stage_id === 'string' ? quota.stage_id : '',
    typeof quota.message === 'string' ? quota.message : '',
    typeof quota.reset_at === 'string' ? `resets at ${quota.reset_at}` : '',
    typeof quota.window === 'string' ? `window ${quota.window}` : '',
  ].filter((item) => item !== '');
  return parts.join(' · ') || 'reported';
}

function outputsLine(snapshot: Record<string, unknown>): Line {
  const {outputs} = snapshot;
  const missing = Array.isArray(snapshot.outputs_not_produced) ? snapshot.outputs_not_produced.map(String) : [];
  const published = isRecord(outputs) ? Object.keys(outputs) : [];
  if (published.length === 0 && missing.length === 0) return ['outputs', 'none'];
  return ['outputs', [...published, ...missing.map((name) => `${name} (not produced)`)].join(', ')];
}

export function printWatchSnapshot(snapshot: Record<string, unknown>): void {
  const lines: Line[] = [
    ...identityLines(snapshot),
    ...executionLines(snapshot),
    ...attentionLines(snapshot),
    ...outcomeLines(snapshot),
    ...recordList(snapshot.quota_failures).map((quota): Line => ['quota', formatQuotaFailure(quota)]),
  ];
  if (nonEmptyString(snapshot.diagnostics)) lines.push(['diagnostics', snapshot.diagnostics]);
  lines.push(['updated_at', formatWatchTimestamp(snapshot.updated_at)], outputsLine(snapshot));
  lines.push(['events_cursor', String(snapshot.events_cursor ?? 0)]);
  for (const [label, value] of lines) process.stdout.write(`${label}  ${value}\n`);
}

/** A live `resume.expired` event as the pending decision it raises, so follow shows what show shows. */
function expiredDecision(event: Record<string, unknown>, sessionId: string): string | null {
  const data = isRecord(event.data) ? event.data : null;
  if (data === null || data.action !== 'ask' || !isRecord(data.estimate)) return null;
  const { estimate } = data;
  return formatResumeDecision({
    stage_id: data.stage_id,
    source_execution_id: data.source_execution_id,
    policy: data.policy,
    estimate: {
      idle_seconds: estimate.idleSec,
      threshold_seconds: estimate.thresholdSec,
      cache_ttl_seconds: estimate.cacheTtlSec,
      margin_seconds: estimate.marginSec,
      context_tokens: estimate.contextTokens,
    },
  }, sessionId);
}

export function printWatchEvent(event: Record<string, unknown>, sessionId = '<session>'): void {
  const eventName = event.event;
  const stageId = event.stage_id;
  if (typeof eventName !== 'string' || typeof stageId !== 'string') return;
  const decision = eventName === 'resume.expired' ? expiredDecision(event, sessionId) : null;
  const text = decision ?? (typeof event.summary === 'string' ? event.summary : '');
  const summary = text === '' ? '' : ` · ${text}`;
  const label = eventName.replace(/^provider\./, '').replaceAll('_', ' ');
  process.stdout.write(`${formatWatchTimestamp(event.timestamp)} ${stageId} ${label}${summary}\n`);
}

export function formatWatchTimestamp(timestamp: unknown): string {
  if (typeof timestamp !== 'string' || timestamp.trim() === '') return '--';
  let text = timestamp.trim();
  if (text.endsWith('Z')) text = `${text.slice(0, -1)}+00:00`;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return timestamp.trim();
  return parsed.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+00:00').replace('Z', '+00:00');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatExitAnomaly(anomaly: Record<string, unknown>): string {
  const parts = [String(anomaly.stage_id ?? ''), String(anomaly.execution_id ?? '')];
  if (typeof anomaly.turn === 'number') parts.push(`turn ${anomaly.turn}`);
  if (typeof anomaly.exit_code === 'number') parts.push(`exit ${anomaly.exit_code}`);
  parts.push(anomaly.accepted === true ? 'accepted' : 'rejected');
  if (typeof anomaly.count === 'number' && anomaly.count > 1) parts.push(`×${anomaly.count}`);
  if (typeof anomaly.diagnostics === 'string' && anomaly.diagnostics) parts.push(anomaly.diagnostics);
  return parts.join(' · ');
}
