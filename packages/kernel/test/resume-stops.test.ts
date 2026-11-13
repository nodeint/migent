import type { RoleStageSpec, WorkflowDocument } from '@nodeint/migent-workflow';
import { describe, expect, test } from 'vitest';

import {
  type ExecutionSnapshot,
  hasPendingResume,
  NextStage,
  nextStage,
  type PendingResumeStop,
  pendingResumeStops,
  readyOutsideStoppedBranches,
  readyStages,
  type ResolutionEvent,
  Stop,
  stopReasonFor,
  unresolvedStageStops,
} from '../src/index.ts';
import { version2GraphQuiet, version2IdleReason } from '../src/selection.ts';
import { stopResolved } from '../src/session-status-policy.ts';

function stage(id: string, extra: Partial<RoleStageSpec> = {}): RoleStageSpec {
  const base: RoleStageSpec = {
    kind: 'role',
    description: null,
    id,
    role: 'developer',
    artifacts: [],
    decisionArtifacts: {},
    decisionValues: [],
    dependsOn: [],
    resumeFrom: null,
    onExpired: null,
    instructions: [],
    modelName: null,
    options: {},
    maxRevisions: null,
    verify: [],
    maxVerify: 3,
    verifyTimeoutSec: null,
    routes: {},
  };
  return { ...base, ...extra };
}

const workflowOf = (stages: RoleStageSpec[], schemaVersion = 7): WorkflowDocument =>
  ({
    id: 'w',
    schemaVersion,
    stages: Object.fromEntries(stages.map((item) => [item.id, item])),
    completion: null,
    requires: null,
    constraints: [],
    source: null,
  }) as unknown as WorkflowDocument;

function snap(stageId: string, order: number, extra: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    executionId: `${String(order).padStart(4, '0')}-${stageId}`,
    stageId,
    executionOrder: order,
    status: 'completed',
    outcomeStatus: 'complete',
    artifactDirectory: '/tmp',
    outcomeDecision: null,
    ...extra,
  };
}

const pending = (stageId: string, sourceExecutionId: string): PendingResumeStop => ({
  stageId,
  sourceExecutionId,
  raisedAt: null,
});
const expired = (stageId: string, source: string, action = 'ask') => ({
  event: 'resume.expired',
  data: { stage_id: stageId, source_execution_id: source, action },
});
const decided = (stageId: string, source: string, choice = 'resume') => ({
  event: 'resume.decided',
  data: { stage_id: stageId, source_execution_id: source, choice },
});
const reply = (executionId: string, from: string): ResolutionEvent => ({ event: 'session.active', executionId, data: { from } });

describe('pendingResumeStops', () => {
  test('ask without a decision is pending', () => {
    expect(pendingResumeStops([expired('b', 'e1')])).toEqual([{ stageId: 'b', sourceExecutionId: 'e1', raisedAt: null, policy: null, estimate: null }]);
  });
  test('a decision for the same pair clears it; another source does not', () => {
    expect(pendingResumeStops([expired('b', 'e1'), decided('b', 'e1')])).toEqual([]);
    expect(pendingResumeStops([expired('b', 'e1'), decided('b', 'e2')])).toHaveLength(1);
    expect(pendingResumeStops([expired('b', 'e1'), decided('c', 'e1')])).toHaveLength(1);
  });
  test('fresh and resume verdicts are never pending', () => {
    expect(pendingResumeStops([expired('b', 'e1', 'fresh'), expired('c', 'e1', 'resume')])).toEqual([]);
  });
  test('a pair raised again after a decision is pending again', () => {
    expect(pendingResumeStops([expired('b', 'e1'), decided('b', 'e1'), expired('b', 'e1')])).toHaveLength(1);
  });
  test('events without a pair are ignored', () => {
    expect(pendingResumeStops([{ event: 'resume.expired', data: { action: 'ask' } }, { event: 'session.active' }])).toEqual([]);
    expect(hasPendingResume([pending('b', 'e1')], 'b')).toBe(true);
    expect(hasPendingResume(null, 'b')).toBe(false);
  });
});

describe('stop reasons are exit names', () => {
  test('existing rows keep their name; expired maps to the exit name', () => {
    expect(stopReasonFor('blocked')).toBe('blocked');
    expect(stopReasonFor('question')).toBe('question');
    expect(stopReasonFor('expired')).toBe('resume_expired');
  });
});

describe('resume_from target with no execution', () => {
  const workflow = workflowOf([stage('a'), stage('b', { dependsOn: ['a'], resumeFrom: 'a' })]);
  const snapshots = [snap('a', 1)];
  const state = { sessionStatus: 'active', pendingResumes: [pending('b', '0001-a')] };

  test('B is not ready, is stopped, and the idle reason is resume_expired; A is not stopped', () => {
    expect(readyStages(workflow, snapshots, { sessionStatus: 'active' })).toEqual(['b']);
    expect(readyStages(workflow, snapshots, state)).toEqual([]);
    expect(readyOutsideStoppedBranches(workflow, snapshots, state)).toEqual([]);
    expect(version2IdleReason(workflow, snapshots, state)).toBe('resume_expired');
    expect(version2GraphQuiet(workflow, snapshots, state)).toBe(false);
  });
  test('after the decision B is ready again', () => {
    expect(readyStages(workflow, snapshots, { sessionStatus: 'active', pendingResumes: [] })).toEqual(['b']);
  });
});

describe('a reply or resume masked by a pending expiry', () => {
  const workflow = workflowOf([stage('a'), stage('c')]);
  const stops = [pending('a', '0001-a')];

  for (const [name, outcome, from] of [['question', 'question', 'question'], ['blocked', 'blocked', 'blocked']] as const) {
    describe(`${name} -> reply -> expiry`, () => {
      const snapshots = [snap('a', 1, { outcomeStatus: outcome })];
      for (const sessionStatus of ['active', 'expired']) {
        test(`the stage is held by the expiry (session ${sessionStatus})`, () => {
          const state = { sessionStatus, resumes: [reply('0001-a', from)], pendingResumes: stops };
          expect(readyStages(workflow, snapshots, state)).toEqual(['c']);
          expect(readyStages(workflowOf([stage('a')]), snapshots, state)).toEqual([]);
          expect(version2IdleReason(workflowOf([stage('a')]), snapshots, state)).toBe('resume_expired');
        });
      }
      test('another ready branch stays ready and the expired stage does not', () => {
        const state = { sessionStatus: 'active', resumes: [reply('0001-a', from)], pendingResumes: stops };
        expect(readyOutsideStoppedBranches(workflow, snapshots, state)).toEqual(['c']);
      });
    });
  }
});

describe('unresolvedStageStops', () => {
  const resolved = (from: string) => [reply('e1', from)];
  test('without a pending stop it equals stopResolved (the old boundary)', () => {
    const facts = { outcomeStatus: 'blocked' };
    const blockedWithResume = { sessionStatus: 'blocked', resumes: resolved('blocked') };
    expect(stopResolved('blocked', 'e1', blockedWithResume)).toBe(false);
    expect(unresolvedStageStops(facts, 'e1', blockedWithResume)).toEqual(['blocked']);
    expect(unresolvedStageStops(facts, 'e1', { sessionStatus: 'active', resumes: resolved('blocked') })).toEqual([]);
    expect(unresolvedStageStops({}, 'e1', { sessionStatus: 'active' })).toEqual([]);
  });
  test('with a pending expiry and a reply, the list is only expired, under any session status', () => {
    const facts = { outcomeStatus: 'question', pendingResume: true };
    for (const sessionStatus of ['expired', 'blocked', 'question', 'active']) {
      expect(unresolvedStageStops(facts, 'e1', { sessionStatus, resumes: resolved('question') })).toEqual(['expired']);
    }
  });
  test('without the reply the question stays, and wins', () => {
    const facts = { outcomeStatus: 'question', pendingResume: true };
    expect(unresolvedStageStops(facts, 'e1', { sessionStatus: 'question' })).toEqual(['question', 'expired']);
  });
  test('a stage with no execution holds only expired', () => {
    expect(unresolvedStageStops({ pendingResume: true }, null, { sessionStatus: 'active' })).toEqual(['expired']);
  });
});

describe('v1 nextStage', () => {
  const workflow = workflowOf([stage('a'), stage('b', { dependsOn: ['a'] })], 1);
  test('a pending stop on the next candidate stops with the exit name', () => {
    const result = nextStage(workflow, [snap('a', 1)], { sessionStatus: 'active', pendingResumes: [pending('b', '0001-a')] });
    expect(result).toBeInstanceOf(Stop);
    expect((result as Stop).reason).toBe('resume_expired');
    expect(nextStage(workflow, [snap('a', 1)], { sessionStatus: 'active' })).toEqual(new NextStage('b'));
  });
  test('a session already in expired stops with the exit name', () => {
    const result = nextStage(workflow, [snap('a', 1)], { sessionStatus: 'expired' });
    expect((result as Stop).reason).toBe('resume_expired');
  });
});
