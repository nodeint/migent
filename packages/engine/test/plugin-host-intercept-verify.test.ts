import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Plugin, PluginInterceptor, PluginRegistry, TSchema } from '@nodeint/migent-contracts';
import { raiseCancellation, resetCancellation } from '@nodeint/migent-kernel';
import { readParsedEvents } from '@nodeint/migent-session';
import { describe, expect, it, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { HostInterceptorChain } from '../src/plugin-host/interception.ts';
import { registryOf, ScriptedClient, tempDir } from './support.ts';

const schema = { type: 'object' } as unknown as TSchema;
const CONFIG = 'agents:\n  fake:\n    client: { type: fake }\n    model: m1\nroles:\n  developer:\n    agent: fake\n'
  + 'plugins:\n  demo:\n    enabled: true\n';
const WORKFLOW = 'schema_version: 2\nid: wf\nstages:\n  - id: prepare\n    verify:\n      - "node -e \\"process.exit(0)\\""\n';

const plugin = (interceptor: PluginInterceptor): Plugin => ({
  manifest: {
    id: 'demo', version: '1.0.0', apiVersion: { major: 1, minor: 0 }, advisory: false, configSchema: schema,
    uses: { operations: [{ target: 'run.verify', phases: ['before', 'after'] }], events: [], session: [], artifacts: [], agents: false, config: [] },
  },
  activate: (_options, migent) => { migent.operations.intercept('run.verify', interceptor); },
});

async function verifyRun(interceptor: PluginInterceptor, timeoutSec?: number) {
  const workspace = tempDir('migent-intercept-verify-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  const extra = timeoutSec === undefined ? '' : `    timeout_sec: ${timeoutSec}\n`;
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG + extra, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), WORKFLOW, 'utf8');
  const runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient([]) }), 10);
  const demo = plugin(interceptor);
  runner.pluginRegistry = { ids: () => ['demo'], get: () => demo } satisfies PluginRegistry;
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', task: 'go' }, runner);
  const events = readParsedEvents(path.join(workspace, '.migent', 'sessions', result.sessionId, 'events.jsonl'));
  const verifyReport = path.join(
    workspace, '.migent', 'sessions', result.sessionId, 'executions', '0001-prepare--attempt-01', 'artifacts', 'verify.md',
  );
  return { result, verifyReport, events: events.filter((event) => event.event.startsWith('plugin.')) };
}

test('before and after continue hooks run on a verify-only stage and leave its result intact', async () => {
  const phases: string[] = [];
  const { result, events } = await verifyRun({
    before: async () => { phases.push('before'); return { kind: 'continue' }; },
    after: async () => { phases.push('after'); return { kind: 'continue' }; },
  });
  expect(phases).toEqual(['before', 'after']);
  expect(result.code).toBe(0);
  expect(result.status).toBe('completed');
  expect(events.filter((event) => event.event === 'plugin.decision')).toHaveLength(2);
});

test('an unauthorized patch on a verify-only stage is rejected and the verify result stands', async () => {
  const { result, events } = await verifyRun({
    before: async () => ({ kind: 'patch', fields: { commands: [] } }),
    after: async () => ({ kind: 'patch', fields: { passed: false } }),
  });
  expect(result.code).toBe(0);
  expect(result.status).toBe('completed');
  const failed = events.filter((event) => event.event === 'plugin.failed');
  expect(failed.map((event) => event.data.reason)).toEqual(['invalid_intent', 'invalid_intent']);
});

test('the input handed to an interceptor is deeply frozen and detached', async () => {
  const value = { a: { b: [1, { c: 2 }] } };
  const seen: unknown[] = [];
  const interceptor: PluginInterceptor = {
    before: async (request) => {
      seen.push(request, request.a, (request.a as { b: unknown[] }).b);
      expect(() => { ((request.a as { b: unknown[] }).b[1] as { c: number }).c = 9; }).toThrow(TypeError);
      expect(() => { (request.a as { b: unknown[] }).b.push(3); }).toThrow(TypeError);
      return { kind: 'continue' };
    },
  };
  const host = {
    invokeInterceptor: async (_plugin: unknown, spec: { run(call: never): Promise<unknown> }) => {
      await spec.run({} as never);
      return null;
    },
  };
  const selected: unknown = { id: 'demo' };
  const registrations: unknown = [{ target: 'x.y', interceptor }];
  const scope: unknown = { stageId: 's' };
  const identity: unknown = { operationId: 'x.y' };
  const entry = { plugin: selected as never, registrations: registrations as never };
  const chain = new HostInterceptorChain([entry], host as never);
  await chain.run({
    phase: 'before', scope: scope as never, identity: identity as never,
    value: value as never, judge: () => ({ kind: 'rejected', reason: 'n/a' }),
  });
  expect(seen.every((item) => Object.isFrozen(item))).toBe(true);
  expect(value).toEqual({ a: { b: [1, { c: 2 }] } });
  expect(Object.isFrozen(value)).toBe(false);
});

const hang = (): Promise<never> => new Promise<never>(() => {});
const FAILURES = {
  throw: { hook: (): Promise<never> => Promise.reject(new Error('boom')), reason: 'error' },
  timeout: { hook: hang, reason: 'timeout' },
  cancel: {
    hook: (): Promise<never> => {
      setTimeout(() => { try { raiseCancellation(2); } catch { /* flag stays */ } }, 10);
      return hang();
    },
    reason: 'cancelled',
  },
} as const;

describe.each(['before', 'after'] as const)('a failing %s interceptor on a verify-only stage', (phase) => {
  it.each(Object.keys(FAILURES) as (keyof typeof FAILURES)[])('%s keeps the handler change applied', async (kind) => {
    const { hook, reason } = FAILURES[kind];
    const config = kind === 'timeout' ? 0.05 : undefined;
    try {
      const { result, events, verifyReport } = await verifyRun({ [phase]: hook }, config);
      const failed = events.filter((event) => event.event === 'plugin.failed');
      expect(failed.map((event) => event.data.reason)).toContain(reason);
      expect(events.some((event) => event.event === 'plugin.decision')).toBe(false);
      if (kind === 'cancel' && phase === 'before') {
        // Cancelled before dispatch: the handler's own cancellation path runs and nothing is published.
        expect(existsSync(verifyReport)).toBe(false);
        expect(result.code).not.toBe(0);
        return;
      }
      expect(existsSync(verifyReport)).toBe(true);
      expect(readFileSync(verifyReport, 'utf8')).toContain('process.exit(0)');
      if (kind !== 'cancel') expect(result.code).toBe(0);
    } finally {
      resetCancellation();
    }
  });
});
