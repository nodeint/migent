import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

test('installed hooks enforce PR flow in a real isolated clone', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'migent-git-flow-'));
  const repo = path.join(directory, 'repo');
  const remote = path.join(directory, 'remote.git');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
    const push = (...args) => spawnSync('git', ['push', ...args], { cwd: repo, encoding: 'utf8' });
    expect(push('origin', 'refs/heads/feat/work:refs/heads/main').stderr).toContain('Direct pushes to main are blocked');
    expect(push('origin', 'refs/heads/feat/work:refs/heads/wrong').stderr).toContain('Branch destination mismatch');
    expect(push('-u', 'origin', 'refs/heads/feat/work:refs/heads/feat/work').status).toBe(0);
    expect(git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')).toBe('origin/feat/work');
    git('commit', '--amend', '--allow-empty', '-m', 'feat: rewrite work');
    expect(push('--force', 'origin', 'refs/heads/feat/work:refs/heads/feat/work').stderr).toContain('Force-push to feat/work is blocked');
    git('branch', '--set-upstream-to=origin/main');
    const wrongUpstream = spawnSync('git', ['commit', '--allow-empty', '-m', 'feat: add more'], { cwd: repo, encoding: 'utf8' });
    expect(wrongUpstream.stderr).toContain('Upstream origin/main');
    git('branch', '--set-upstream-to=origin/feat/work');
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
    const checkPr = (title) => {
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
