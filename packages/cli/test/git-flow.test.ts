import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { commitProblem, pushProblems } from "../../../scripts/git-flow.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sha = "a".repeat(40);
const update = (source: string, target: string) => `${source} ${sha} ${target} ${sha}\n`;

test("push guard rejects main updates, deletion, and mismatched branches", () => {
  expect(pushProblems(update("refs/heads/feat/work", "refs/heads/main"), "refs/heads/feat/work")).toHaveLength(1);
  expect(pushProblems(update("(delete)", "refs/heads/main"), "refs/heads/feat/work")).toHaveLength(1);
  expect(pushProblems(update("refs/heads/feat/work", "refs/heads/other"), "refs/heads/feat/work")).toHaveLength(1);
  expect(pushProblems(update("refs/heads/feat/work", "refs/heads/feat/work"), "refs/heads/feat/work")).toEqual([]);
  expect(pushProblems(update("HEAD", "refs/heads/feat/work"), "refs/heads/feat/work")).toEqual([]);
  expect(pushProblems(update("(delete)", "refs/heads/old"), "refs/heads/feat/work")).toEqual([]);
  expect(pushProblems(update("refs/tags/v1.0.0", "refs/tags/v1.0.0"), "")).toEqual([]);
  expect(commitProblem("main")).toBeTruthy();
  expect(commitProblem("next")).toBeTruthy();
  expect(pushProblems(update("refs/heads/next", "refs/heads/next"), "refs/heads/next")).toHaveLength(1);
  expect(pushProblems(update("(delete)", "refs/heads/next"), "refs/heads/feat/work")).toHaveLength(1);
  expect(commitProblem("")).toBeTruthy();
  expect(commitProblem("release/1.0.0")).toBeNull();
});

test("installed hooks enforce PR flow in a real isolated clone", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "migent-git-flow-"));
  const repo = path.join(directory, "repo");
  const remote = path.join(directory, "remote.git");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
    git("init", "-b", "main");
    git("config", "user.name", "Git flow test");
    git("config", "user.email", "test@example.invalid");
    writeFileSync(path.join(repo, "seed"), "test");
    git("add", "seed");
    git("-c", "core.hooksPath=", "commit", "-m", "Seed");
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "main");
    git("switch", "--track", "-c", "feat/work", "origin/main");
    for (const name of ["scripts/git-flow.mjs", "scripts/setup-git.mjs", ".githooks/pre-commit", ".githooks/pre-push"]) {
      const target = path.join(repo, name);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(root, name), target);
      if (name.startsWith(".githooks/")) chmodSync(target, 0o755);
    }
    const setup = () => execFileSync(process.execPath, ["scripts/setup-git.mjs"], { cwd: repo, encoding: "utf8" });
    expect(setup()).toContain("Removed incorrect origin/main upstream from feat/work");
    expect(setup()).not.toContain("Removed incorrect");
    expect(git("config", "--local", "push.default")).toBe("simple");
    expect(git("for-each-ref", "--format=%(upstream)", "refs/heads/feat/work")).toBe("");
    git("commit", "--allow-empty", "-m", "Work");
    const push = (...args: string[]) => spawnSync("git", ["push", ...args], { cwd: repo, encoding: "utf8" });
    expect(push("origin", "refs/heads/feat/work:refs/heads/main").stderr).toContain("Direct pushes to main are blocked");
    expect(push("origin", "refs/heads/feat/work:refs/heads/wrong").stderr).toContain("Branch destination mismatch");
    expect(push("-u", "origin", "refs/heads/feat/work:refs/heads/feat/work").status).toBe(0);
    expect(git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")).toBe("origin/feat/work");
    git("tag", "v-test");
    expect(push("origin", "refs/tags/v-test:refs/tags/v-test").status).toBe(0);
    git("switch", "--no-track", "-c", "next", "origin/main");
    expect(spawnSync("git", ["commit", "--allow-empty", "-m", "Wrong next"], { cwd: repo, encoding: "utf8" }).status).not.toBe(0);
    git("switch", "main");
    const commit = spawnSync("git", ["commit", "--allow-empty", "-m", "Wrong"], { cwd: repo, encoding: "utf8" });
    expect(commit.status).not.toBe(0);
    expect(commit.stderr).toContain("main changes through pull requests");
    git("switch", "--no-track", "-c", "feat/next", "origin/main");
    expect(git("for-each-ref", "--format=%(upstream)", "refs/heads/feat/next")).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
