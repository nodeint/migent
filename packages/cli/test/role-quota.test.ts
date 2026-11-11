import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { AgentToolRunner, type RunResult } from '@nodeint/migent-engine';
import { type BuildCommandInput, raiseCancellation,type RawFailure, resetCancellation } from '@nodeint/migent-kernel';
import { expect, test } from 'vitest';

import { dispatchAgent } from '../src/commands/agent.ts';
import { printWatchSnapshot } from '../src/display.ts';
import { registryOf, removeWorkspace, repoWorkflowText, ScriptedClient, writeFakeWorkflowWorkspace } from './support.ts';

const FUTURE = '2099-01-01T00:00:00.000Z';

class ClassifiedProvider extends ScriptedClient {
  private readonly kinds: (RawFailure | null)[];

  constructor(responses: string[], kinds: (RawFailure | null)[]) {
    super(responses);
    this.kinds = [...kinds];
  }

  override extractFailure(): RawFailure | null {
    const next = this.kinds.shift();
    return next === undefined ? null : next;
  }
}

function quota(resetAt: string | null): RawFailure {
  return { origin: 'provider-error', message: 'limited', exitCode: 1, rateLimit: { resetAt, window: null } };
}

function workspace(): string {
  return writeFakeWorkflowWorkspace({ plan: repoWorkflowText('plan') });
}

function runner(provider: ClassifiedProvider) {
  return new AgentToolRunner(registryOf({ fake: provider }), 10);
}

test('a role quota fails the run once and does not rerun', async () => {
  const root = workspace();
  const provider = new ClassifiedProvider(
    ['status: complete\n\nlimited', 'status: complete\n\nunused'],
    [quota(FUTURE), null],
  );
  try {
    const code = await dispatchAgent(root, { role: 'reviewer', prompt: 'Review', runner: runner(provider) });
    expect(code).toBe(1);
    expect(provider.calls).toHaveLength(1);
    const sessionId = readSessionId(root);
    const executions = readdirSync(path.join(root, '.migent', 'sessions', sessionId, 'executions'));
    expect(executions).toHaveLength(1);
    const record = JSON.parse(
      readFileSync(path.join(root, '.migent', 'sessions', sessionId, 'executions', executions[0]!, 'execution.json'), 'utf8'),
    ) as { failure_reason?: string; retry_at?: string };
    expect(record.failure_reason).toBe('quota');
    expect(record.retry_at).toBe(FUTURE);
    const events = readFileSync(path.join(root, '.migent', 'sessions', sessionId, 'events.jsonl'), 'utf8');
    expect(events).toContain('provider.quota');
  } finally {
    resetCancellation();
    removeWorkspace(root);
  }
});

test('a role quota without reset_at and a provider failure return 1', async () => {
  const root = workspace();
  try {
    const missing = new ClassifiedProvider(['status: complete\n\nx'], [quota(null)]);
    expect(await dispatchAgent(root, { role: 'reviewer', prompt: 'Review', runner: runner(missing) })).toBe(1);
    expect(missing.calls).toHaveLength(1);
    const provider = new ClassifiedProvider(['status: complete\n\nx'], [{ origin: 'provider-error', message: 'down', exitCode: 1 }]);
    expect(await dispatchAgent(root, { role: 'reviewer', prompt: 'Review', runner: runner(provider) })).toBe(1);
  } finally {
    resetCancellation();
    removeWorkspace(root);
  }
});

test('a single verify-exhausted role result returns 1', async () => {
  const root = workspace();
  const result: RunResult = {
    agent_id: 'a',
    options: {},
    session_id: 's',
    execution_id: 'e',
    artifact_directory: '',
    outcome_status: '',
    outcome_decision: '',
    session_status: 'active',
    response: '',
    failure_reason: 'verify_exhausted',
    failure_kind: '',
    reset_at: '',
    client: 'fake',
  };
  const runner = {
    run: async () => result,
  } as unknown as AgentToolRunner;
  try {
    expect(await dispatchAgent(root, { role: 'reviewer', prompt: 'Review', runner })).toBe(1);
  } finally {
    removeWorkspace(root);
  }
});

test('a cancelled role that hits quota on resume fails without a rerun', async () => {
  const root = workspace();
  class HangProvider extends ScriptedClient {
    override buildCommand(input: BuildCommandInput) {
      super.buildCommand(input);
      return { argv: [process.execPath, '-e', 'setTimeout(() => {}, 30000)'] };
    }
  }
  const hanging = new HangProvider(['status: complete\n\nunused']);
  const timer = setTimeout(() => {
    try {
      raiseCancellation(15);
    } catch {
      // The flag stays set for the command.
    }
  }, 200);
  try {
    const cancelled = await dispatchAgent(root, {
      role: 'reviewer',
      prompt: 'Review the saved turn',
      runner: new AgentToolRunner(registryOf({ fake: hanging }), 10),
    });
    expect(cancelled).toBe(130);
    resetCancellation();
    const provider = new ClassifiedProvider(
      ['status: complete\n\nlimited', 'status: complete\n\ndone'],
      [quota(FUTURE), null],
    );
    const code = await dispatchAgent(root, {
      role: 'reviewer',
      prompt: 'this prompt must not be read',
      promptFile: null,
      runner: new AgentToolRunner(registryOf({ fake: provider }), 10),
      sessionId: readSessionId(root),
    });
    expect(code).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.prompt).toContain('Review the saved turn');
    expect(provider.calls[0]?.prompt).not.toContain('this prompt must not be read');
  } finally {
    clearTimeout(timer);
    resetCancellation();
    removeWorkspace(root);
  }
});

function readSessionId(root: string): string {
  const names = readdirSync(path.join(root, '.migent', 'sessions')).filter((name) => !name.startsWith('.'));
  const [session] = names;
  if (!session) throw new Error('missing session');
  return session;
}

test('watch output shows a recorded quota with its reset time and window', () => {
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    printWatchSnapshot({
      session_id: 's',
      status: 'active',
      quota_failures: [{ stage_id: 'a', message: 'limited', reset_at: FUTURE, window: 'five_hour' }],
    });
  } finally {
    process.stdout.write = write;
  }
  expect(lines.join('')).toContain(`quota  a · limited · resets at ${FUTURE} · window five_hour`);
});
