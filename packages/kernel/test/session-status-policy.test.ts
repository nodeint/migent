import { SESSION_STATUS_CATALOG } from '@nodeint/migent-contracts';
import { describe, expect, test } from 'vitest';

import {
  acceptsBlockedResume,
  BLOCKED_RESUME_FROM,
  changeReason,
  endsScheduling,
  exitFor,
  foldStoppedStatus,
  hasTerminalFields,
  isClosed,
  isManifestMirrored,
  isManuallyCompletable,
  isRefreshable,
  isSessionStop,
  isStageStop,
  isStopped,
  isStopResolutionEvent,
  manifestStatusToSession,
  type ResolutionEvent,
  resolutionFrom,
  STAGE_STOP_DETECTORS,
  stageStopsByPrecedence,
  stageStopStatus,
  stopResolved,
} from '../src/session-status-policy.ts';

const ALL = ['active', 'prepared', 'completed', 'blocked', 'question', 'cancelled', 'corrupt'];
const setOf = (predicate: (status: string) => boolean) => ALL.filter(predicate).sort();
const sorted = (...names: string[]) => [...names].sort();

describe('derived sets equal the literal sets they replace', () => {
  test('flags', () => {
    expect(setOf(endsScheduling)).toEqual(sorted('blocked', 'question', 'cancelled', 'completed'));
    expect(setOf(isManuallyCompletable)).toEqual(sorted('active', 'blocked', 'question', 'cancelled'));
    expect(setOf(isRefreshable)).toEqual(sorted('active', 'blocked', 'question'));
    expect(setOf(isClosed)).toEqual(sorted('completed', 'cancelled'));
    expect(setOf(hasTerminalFields)).toEqual(sorted('blocked', 'completed', 'cancelled'));
    expect(setOf(isManifestMirrored)).toEqual(sorted('completed', 'blocked', 'question', 'cancelled'));
    expect(setOf(isStopped)).toEqual(sorted('blocked', 'question', 'cancelled'));
    expect(setOf(isStageStop)).toEqual(sorted('blocked', 'question'));
    expect(setOf(isSessionStop)).toEqual(['cancelled']);
  });

  test('unknown statuses match nothing', () => {
    expect(endsScheduling('nope')).toBe(false);
    expect(acceptsBlockedResume('nope')).toBe(false);
    expect(exitFor('nope')).toBeNull();
  });

  test('manifestStatusToSession', () => {
    expect(manifestStatusToSession('prepared')).toBe('prepared');
    for (const name of ['completed', 'blocked', 'question', 'cancelled']) expect(manifestStatusToSession(name)).toBe(name);
    for (const value of [null, 'running', 'weird', 'corrupt', 'active']) expect(manifestStatusToSession(value)).toBe('active');
  });

  test('exitFor equals the follow exits', () => {
    expect(Object.fromEntries(ALL.map((name) => [name, exitFor(name)]))).toEqual({
      active: null,
      prepared: null,
      completed: 0,
      blocked: 1,
      question: 9,
      cancelled: 130,
      corrupt: null,
    });
  });

  test('acceptsBlockedResume is exactly active and blocked', () => {
    expect(setOf(acceptsBlockedResume)).toEqual(sorted('active', 'blocked'));
    expect(BLOCKED_RESUME_FROM).toBe('blocked');
  });
});

describe('stage stops', () => {
  test('precedence and fold order', () => {
    expect(stageStopsByPrecedence()).toEqual(['blocked', 'question']);
    expect(foldStoppedStatus(['question', 'blocked'])).toBe('blocked');
    expect(foldStoppedStatus(['question'])).toBe('question');
    expect(foldStoppedStatus(['cancelled', 'completed'])).toBeNull();
  });

  test('one detector per stage-stop row', () => {
    const rows = SESSION_STATUS_CATALOG.filter((row) => row.kind === 'stage_stop').map((row) => row.name);
    expect(Object.keys(STAGE_STOP_DETECTORS).sort()).toEqual([...rows].sort());
    expect(stageStopStatus({ outcomeStatus: 'blocked' })).toBe('blocked');
    expect(stageStopStatus({ outcomeStatus: 'question' })).toBe('question');
    expect(stageStopStatus({ outcomeStatus: 'complete' })).toBeNull();
    expect(stageStopStatus({})).toBeNull();
  });
});

describe('resolution', () => {
  const active = (resumes: ResolutionEvent[]) => ({ sessionStatus: 'active', resumes });
  const resume = (from: unknown, executionId = 'e1', event = 'session.active') => ({ event, executionId, data: { from } });

  test('same-status and cross-status resume events resolve', () => {
    for (const status of ['blocked', 'question']) {
      for (const from of ['blocked', 'question']) expect(stopResolved(status, 'e1', active([resume(from)]))).toBe(true);
    }
  });

  test('other events do not resolve', () => {
    expect(stopResolved('blocked', 'e1', active([resume('blocked', 'e2')]))).toBe(false);
    expect(stopResolved('blocked', 'e1', active([resume('blocked', 'e1', 'session.blocked')]))).toBe(false);
    expect(stopResolved('blocked', 'e1', active([resume('failed')]))).toBe(false);
    expect(stopResolved('blocked', 'e1', active([resume('cancelled')]))).toBe(false);
    expect(stopResolved('blocked', 'e1', { sessionStatus: 'blocked', resumes: [resume('blocked')] })).toBe(false);
    expect(stopResolved('blocked', 'e1', { sessionStatus: 'active', resumes: null })).toBe(false);
    expect(stopResolved('blocked', 'e1', { sessionStatus: 'active', resumes: undefined })).toBe(false);
    expect(isStopResolutionEvent(null, 'blocked', 'e1')).toBe(false);
    expect(isStopResolutionEvent(undefined, 'blocked', 'e1')).toBe(false);
    expect(isStopResolutionEvent(resume('blocked'), 'completed', 'e1')).toBe(false);
  });

  test('resolutionFrom and the session.active family', () => {
    expect(resolutionFrom('blocked')).toBe('blocked');
    expect(resolutionFrom('question')).toBe('question');
    expect(resolutionFrom('cancelled')).toBe('cancelled');
    expect(() => resolutionFrom('completed')).toThrow();
    const family = SESSION_STATUS_CATALOG.filter((row) => row.kind === 'stage_stop' && row.resolution?.event === 'session.active');
    expect(family.map((row) => row.name)).toEqual(['blocked', 'question']);
  });
});

describe('changeReason', () => {
  test('each status with and without its outcome field', () => {
    expect(changeReason('question', { question: 'why?' })).toBe('why?');
    expect(changeReason('question', null)).toBe('question');
    expect(changeReason('blocked', { blocker: 'stuck' })).toBe('stuck');
    expect(changeReason('blocked', {})).toBe('blocked');
    expect(changeReason('cancelled', { blocker: 'x' })).toBe('cancelled');
    expect(changeReason('completed', { decision: 'ship' })).toBe('ship');
    expect(changeReason('completed', null)).toBe('completed');
    expect(changeReason('active', null)).toBeNull();
  });
});
