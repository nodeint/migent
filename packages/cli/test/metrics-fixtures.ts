import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { TurnUsage, UsageCapture } from '@nodeint/migent-kernel';

const created: string[] = [];

/** A temporary directory that `removeTempDirs` deletes. Call it from `afterEach`. */
export function tempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  created.push(directory);
  return directory;
}

export function removeTempDirs(): void {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
}

// Session fixtures shared with the plugin equivalence baseline. Copied from the engine metrics tests so the
// comparison runs on the same scenarios. Retired with the equivalence baseline in P3.

export const PLAN = `\
id: plan
stages:
  - id: plan
    role: planner
    max_revisions: 3
    depends_on: []
    produces:
      artifact: plan.md
  - id: review
    role: reviewer
    depends_on:
      - plan
    decision:
      values:
        - approved
        - revise
      routes:
        approved: complete
        revise: plan
completion:
  stage: review
  decision: approved
  outputs:
    - name: plan
      from_stage: plan
      artifact: plan.md
`;

export const ONCE = `\
id: once
stages:
  - id: implement
    role: developer
    depends_on: []
    produces:
      artifact: notes.md
completion:
  stage: implement
`;

export const CHECK = `\
id: check
stages:
  - id: implement
    role: developer
    depends_on: []
    produces:
      artifact: notes.md
    verify:
      - pnpm gate
completion:
  stage: implement
`;

const SECOND_WIDTH = 2;
const DEFAULT_COMPLETED_SECOND = 10;

export function at(second: number): string {
  return `2026-10-20T00:00:${String(second).padStart(SECOND_WIDTH, '0')}.000+00:00`;
}

export function blank(): TurnUsage {
  return {
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
  };
}

export function cumulative(current: UsageCapture): { values: TurnUsage; cumulative: string[] } {
  const total = typeof current.total === 'number' ? current.total : 0;
  return { values: { ...blank(), input_tokens: total }, cumulative: ['input_tokens'] };
}

export interface ExecInput {
  id: string;
  order: number;
  stage: string;
  status: string;
  client?: string | null;
  provider?: string;
  createdAt?: string;
  completedAt?: string | null;
  outcome?: Record<string, unknown> | null;
  resumeSkipped?: Record<string, unknown>;
}

export interface SessionSpec {
  status: Record<string, unknown>;
  executions: ExecInput[];
  events: Record<string, unknown>[];
}

export function writeSession(workspace: string, sessionId: string, spec: SessionSpec): void {
  const { status, executions, events } = spec;
  const sessionDirectory = path.join(workspace, '.migent', 'sessions', sessionId);
  mkdirSync(path.join(sessionDirectory, 'executions'), { recursive: true });
  writeFileSync(path.join(sessionDirectory, 'status.json'), JSON.stringify(status));
  const lines = events.map((event) => JSON.stringify(event));
  writeFileSync(path.join(sessionDirectory, 'events.jsonl'), lines.length === 0 ? '' : `${lines.join('\n')}\n`);
  for (const execution of executions) {
    const directory = path.join(sessionDirectory, 'executions', execution.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'execution.json'),
      JSON.stringify({
        execution_id: execution.id,
        execution_order: execution.order,
        stage_id: execution.stage,
        stage_attempt: execution.order,
        client: execution.client === null ? undefined : execution.client ?? execution.provider ?? 'fake',
        provider: execution.provider ?? null,
        model: 'm1',
        agent_id: 'agent-1',
        resumes_execution_id: null,
        status: execution.status,
        created_at: execution.createdAt ?? at(0),
        completed_at: execution.completedAt === undefined ? at(DEFAULT_COMPLETED_SECOND) : execution.completedAt,
        outcome: execution.outcome === undefined ? { status: 'complete' } : execution.outcome,
        error: null,
        failure_reason: null,
        ...(execution.resumeSkipped ? { resume_skipped: execution.resumeSkipped } : {}),
      }),
    );
  }
}

export interface EventHead {
  seq: number;
  name: string;
  executionId: string | null;
}

export function event(head: EventHead, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { seq, name, executionId } = head;
  return {
    v: 2,
    seq,
    event: name,
    timestamp: at(0),
    ...(executionId === null ? {} : { execution_id: executionId }),
    provider: 'fake',
    data: {},
    ...extra,
  };
}

export interface TurnSpec {
  seq: number;
  executionId: string;
  usage: Record<string, unknown> | null;
  provider?: string;
  agentId?: string;
}

export function turn(spec: TurnSpec): Record<string, unknown> {
  const { seq, executionId, usage, provider = 'fake', agentId = 'agent-1' } = spec;
  const details: Record<string, unknown> = { turn: 1, agent_id: agentId, argv: [provider] };
  if (usage !== null) details.usage = usage;
  return event({ seq, name: 'provider.turn_completed', executionId }, { provider, details });
}

export function workspaceWith(name: string, text: string): string {
  const workspace = tempDir('migent-metrics-');
  const workflows = path.join(workspace, '.migent', 'workflows');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workflows, name), text, 'utf8');
  return workspace;
}

