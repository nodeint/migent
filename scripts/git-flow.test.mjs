import { expect, test } from 'vitest';

import { branchProblem, commitProblem, pullRequestProblems, pushProblems, subjectProblem } from './git-flow.mjs';

const sha = 'a'.repeat(40);
const update = (source, target) => `${source} ${sha} ${target} ${sha}\n`;

test.each([
  'feat/123-session-export', 'fix/1-resume', 'refactor/session-store',
  'docs/session-guide', 'chore/update-ci', 'release/0.8.1',
])('accepts branch %s', (branch) => {
  expect(branchProblem(branch)).toBeNull();
});

test.each([
  '', 'main', 'next', 'feature/export', 'fix/0-resume', 'fix/01-resume',
  'fix/123', 'fix/Session', 'fix/session_resume', 'fix/session--resume',
  'fix/session-', 'fix/nested/resume', 'release/01.2.3', 'release/1.2.3-beta',
])('rejects branch %s', (branch) => {
  expect(branchProblem(branch)).toBeTruthy();
});

test.each([
  'feat: add session export', 'fix: restore resume', 'refactor: simplify storage',
  'docs: explain resume', 'chore: update CI',
])('accepts subject %s independently of branch type', (subject) => {
  expect(subjectProblem(subject, 'feat/session-export')).toBeNull();
});

test.each([
  '', 'Fix resume', 'fix: ', 'fix: restore resume.', 'fix(cli): restore resume',
  'test: cover resume', 'fix: restore resume ', 'fix: restore\nresume', 'Release 1.2.3',
])('rejects subject %s on a work branch', (subject) => {
  expect(subjectProblem(subject, 'fix/resume')).toBeTruthy();
});

test('release subjects and PR titles preserve the publishing convention', () => {
  expect(subjectProblem('Release 1.2.3', 'release/1.2.3')).toBeNull();
  expect(subjectProblem('Release 1.2.4', 'release/1.2.3')).toBeTruthy();
  expect(subjectProblem('docs: clarify notes', 'release/1.2.3')).toBeNull();
  expect(pullRequestProblems('release/1.2.3', 'Release 1.2.3')).toEqual([]);
  expect(pullRequestProblems('release/1.2.3', 'Release 1.2.3 (#42)')).not.toEqual([]);
  expect(pullRequestProblems('release/1.2.3', 'docs: clarify notes')).not.toEqual([]);
  expect(pullRequestProblems('fix/resume', 'fix: restore resume')).toEqual([]);
  expect(pullRequestProblems('wrong/resume', 'fix: restore resume')).not.toEqual([]);
  expect(pullRequestProblems('fix/resume', 'Restore resume')).not.toEqual([]);
});

test('push guard rejects main updates, deletion, and mismatched branches', () => {
  expect(pushProblems(update('refs/heads/feat/work', 'refs/heads/main'), 'refs/heads/feat/work')).toHaveLength(1);
  expect(pushProblems(update('(delete)', 'refs/heads/main'), 'refs/heads/feat/work')).toHaveLength(1);
  expect(pushProblems(update('refs/heads/feat/work', 'refs/heads/feat/other'), 'refs/heads/feat/work')).toHaveLength(1);
  expect(pushProblems(update('refs/heads/feat/work', 'refs/heads/feat/work'), 'refs/heads/feat/work')).toEqual([]);
  expect(pushProblems(update('HEAD', 'refs/heads/feat/work'), 'refs/heads/feat/work')).toEqual([]);
  expect(pushProblems(update('refs/heads/wrong/work', 'refs/heads/wrong/work'), 'refs/heads/wrong/work')).not.toEqual([]);
  expect(pushProblems(update('(delete)', 'refs/heads/old'), 'refs/heads/feat/work')).toEqual([]);
  expect(pushProblems(update('refs/tags/v1.0.0', 'refs/tags/v1.0.0'), '')).toEqual([]);
  expect(commitProblem('main')).toBeTruthy();
  expect(commitProblem('next')).toBeTruthy();
  expect(pushProblems(update('refs/heads/next', 'refs/heads/next'), 'refs/heads/next')).toHaveLength(1);
  expect(pushProblems(update('(delete)', 'refs/heads/next'), 'refs/heads/feat/work')).toHaveLength(1);
  expect(commitProblem('')).toBeTruthy();
  expect(commitProblem('release/1.0.0')).toBeNull();
});

test('hooks reject force-pushes and mismatched upstreams', () => {
  const old = 'b'.repeat(40);
  const input = `refs/heads/feat/work ${sha} refs/heads/feat/work ${old}\n`;
  expect(pushProblems(input, 'refs/heads/feat/work', () => false)).toEqual([expect.stringContaining('Force-push')]);
  expect(pushProblems(input, 'refs/heads/feat/work', () => true)).toEqual([]);
  const created = `refs/heads/feat/work ${sha} refs/heads/feat/work ${'0'.repeat(40)}\n`;
  expect(pushProblems(created, 'refs/heads/feat/work', () => false)).toEqual([]);
  expect(commitProblem('feat/work', 'origin/feat/work')).toBeNull();
  expect(commitProblem('feat/work', 'origin/next')).toContain('Upstream origin/next');
  expect(commitProblem('feat/work', 'fork/feat/work')).toBeTruthy();
});
