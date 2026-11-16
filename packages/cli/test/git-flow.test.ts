import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { branchProblem, commitProblem, pullRequestProblems, pushProblems, subjectProblem } from '../../../scripts/git-flow.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = 'a'.repeat(40);
const update = (source: string, target: string) => `${source} ${sha} ${target} ${sha}\n`;

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

test('installed hooks enforce PR flow in a real isolated clone', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'migent-git-flow-'));
  const repo = path.join(directory, 'repo');
  const remote = path.join(directory, 'remote.git');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Git flow test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(path.join(repo, 'seed'), 'test');
    git('add', 'seed');
    git('-c', 'core.hooksPath=', 'commit', '-m', 'Seed');
    git('remote', 'add', 'origin', remote);
    git('push', '-u', 'origin', 'main');
    git('switch', '--track', '-c', 'feat/work', 'origin/main');
    for (const name of [
      'scripts/git-flow.mjs', 'scripts/setup-git.mjs',
      '.githooks/pre-commit', '.githooks/commit-msg', '.githooks/pre-push',
    ]) {
      const target = path.join(repo, name);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(root, name), target);
      if (name.startsWith('.githooks/')) chmodSync(target, 0o755);
    }
    const setup = () => execFileSync(process.execPath, ['scripts/setup-git.mjs'], { cwd: repo, encoding: 'utf8' });
    expect(setup()).toContain('Removed incorrect origin/main upstream from feat/work');
    expect(setup()).not.toContain('Removed incorrect');
    expect(git('config', '--local', 'push.default')).toBe('simple');
    expect(git('for-each-ref', '--format=%(upstream)', 'refs/heads/feat/work')).toBe('');
    const initialHead = git('rev-parse', 'HEAD');
    const invalidCommit = spawnSync('git', ['commit', '--allow-empty', '-m', 'Work'], { cwd: repo, encoding: 'utf8' });
    expect(invalidCommit.status).not.toBe(0);
    expect(invalidCommit.stderr).toContain('<type>: <imperative summary>');
    expect(git('rev-parse', 'HEAD')).toBe(initialHead);
    git('commit', '--allow-empty', '-m', 'feat: add work', '-m', 'Body and attribution remain unrestricted.');
    const push = (...args: string[]) => spawnSync('git', ['push', ...args], { cwd: repo, encoding: 'utf8' });
    expect(push('origin', 'refs/heads/feat/work:refs/heads/main').stderr).toContain('Direct pushes to main are blocked');
    expect(push('origin', 'refs/heads/feat/work:refs/heads/wrong').stderr).toContain('Branch destination mismatch');
    expect(push('-u', 'origin', 'refs/heads/feat/work:refs/heads/feat/work').status).toBe(0);
    expect(git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')).toBe('origin/feat/work');
    git('tag', 'v-test');
    expect(push('origin', 'refs/tags/v-test:refs/tags/v-test').status).toBe(0);
    git('switch', '--no-track', '-c', 'next', 'origin/main');
    expect(spawnSync('git', ['commit', '--allow-empty', '-m', 'Wrong next'], { cwd: repo, encoding: 'utf8' }).status).not.toBe(0);
    git('switch', 'main');
    const commit = spawnSync('git', ['commit', '--allow-empty', '-m', 'Wrong'], { cwd: repo, encoding: 'utf8' });
    expect(commit.status).not.toBe(0);
    expect(commit.stderr).toContain('the release workflow advances main');
    git('switch', '--no-track', '-c', 'feat/next', 'origin/main');
    expect(git('for-each-ref', '--format=%(upstream)', 'refs/heads/feat/next')).toBe('');
    git('switch', '-c', 'wrong/branch');
    expect(spawnSync('git', ['commit', '--allow-empty', '-m', 'fix: restore work'], {
      cwd: repo, encoding: 'utf8',
    }).status).not.toBe(0);
    git('switch', '-c', 'release/1.2.3');
    git('commit', '--allow-empty', '-m', 'Release 1.2.3');
    expect(spawnSync('git', ['commit', '--allow-empty', '-m', 'Release 1.2.4'], {
      cwd: repo, encoding: 'utf8',
    }).status).not.toBe(0);

    const eventPath = path.join(directory, 'event.json');
    const checkPr = (title: string) => {
      writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { ref: 'fix/123-resume' }, title } }));
      return spawnSync(process.execPath, ['scripts/git-flow.mjs', 'pr'], {
        cwd: repo, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
      });
    };
    expect(checkPr('fix: restore resume').status).toBe(0);
    expect(checkPr('Restore resume').status).not.toBe(0);
    const marker = path.join(directory, 'injected');
    expect(checkPr(`fix: handle $(touch ${marker}) and backticks`).status).toBe(0);
    expect(spawnSync(process.execPath, ['-e', 'process.exit(require("node:fs").existsSync(process.argv[1]) ? 1 : 0)', marker]).status).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

