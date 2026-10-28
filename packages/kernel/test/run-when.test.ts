import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { ConfigurationError, createWorkflowSession } from "../src/index.ts";
import {
  changedPathsSinceBaseline,
  compileChangedPathPattern,
  ensureSessionBaseline,
  evaluateRunWhen,
  matchesChangedPaths,
  readSessionBaseline,
} from "../src/run-when.ts";
import { appendLifecycleEvent } from "../src/session-events.ts";
import { SessionLock } from "../src/session-lock.ts";
import { parseWorkflowMapping, type WorkflowDocument } from "../src/workflow.ts";
import { parseYamlDocument } from "../src/yaml.ts";
import { tempDir } from "./support.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
}

function repository(): string {
  const repo = tempDir("migent-run-when-");
  git(repo, "init", "-b", "main");
  writeFileSync(path.join(repo, ".gitignore"), "ignored.log\n.migent/config.yaml\n.migent/workflows/\n");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "guide.md"), "guide\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "initial");
  return repo;
}

function head(repo: string): string {
  return git(repo, "rev-parse", "HEAD");
}

function changes(repo: string, commit: string): string[] {
  return changedPathsSinceBaseline(repo, commit, "test");
}

const CONFIG = `models:
  fake:
    provider: fake
    model: m1
roles:
  developer:
    default_model: fake
  reviewer:
    default_model: fake
`;

const WORKFLOW = `\
schema_version: 2
id: flow
stages:
  - id: build
    role: developer
  - id: review_docs
    role: reviewer
    depends_on: [build]
    run_when:
      changed_paths:
        - "docs/**/*"
        - "**/README.md"
`;

const PLAIN = `\
schema_version: 2
id: flow
stages:
  - id: build
    role: developer
`;

function workflowFrom(text: string): WorkflowDocument {
  return parseWorkflowMapping(parseYaml(text), "flow.yaml");
}

function parseYaml(text: string): Record<string, unknown> {
  return parseYamlDocument(text) as Record<string, unknown>;
}

test("glob table", () => {
  const match = (pattern: string, candidate: string): boolean => matchesChangedPaths([pattern], candidate);
  expect(match("docs/**/*", "docs")).toBe(false);
  expect(match("docs/**/*", "docs/a.md")).toBe(true);
  expect(match("docs/**/*", "docs/x/y.md")).toBe(true);
  expect(match("docs/**/*", "src/docs/a.md")).toBe(false);
  expect(match("docs/**/*", "docs/.nojekyll")).toBe(true);
  expect(match("**/README.md", "README.md")).toBe(true);
  expect(match("**/README.md", "a/README.md")).toBe(true);
  expect(match("**/README.md", "a/b/README.md")).toBe(true);
  expect(match("**/README.md", "readme.md")).toBe(false);
  expect(match("**/README.md", "README.mdx")).toBe(false);
  expect(match("**/README.md", "a/README.md.bak")).toBe(false);
  expect(match("*.md", "CHANGELOG.md")).toBe(true);
  expect(match("*.md", "docs/CHANGELOG.md")).toBe(false);
  expect(match("src/*", "src/a.ts")).toBe(true);
  expect(match("src/*", "src/a/b.ts")).toBe(false);
  expect(match("a?c", "abc")).toBe(true);
  expect(match("a?c", "a/c")).toBe(false);
  expect(match("a?c", "ac")).toBe(false);
  expect(match("a+b.md", "a+b.md")).toBe(true);
  expect(match("a+b.md", "aab.md")).toBe(false);
  expect(match("(x).md", "(x).md")).toBe(true);
  expect(match("a/**/b", "a/b")).toBe(true);
  expect(match("a/**/b", "a/x/y/b")).toBe(true);
  expect(match("a/**", "a")).toBe(true);
  expect(match("a/**", "a/x/y")).toBe(true);
  expect(match("**", "anything/at/all")).toBe(true);
  expect(match("a/**/**/b", "a/b")).toBe(true);
  expect(match("README.md", "readme.md")).toBe(false);
});

test("rejected glob forms name their reason", () => {
  const reasons: Array<[string, string]> = [
    ["a\\b", "use /"],
    ["/a", "patterns are relative to the repository root"],
    ["a/", "use dir/**"],
    ["a//b", "empty segment"],
    ["./a", ". and .. segments are not supported"],
    ["a/../b", ". and .. segments are not supported"],
    ["a**", "** must be a whole segment"],
    ["**.md", "** must be a whole segment"],
    ["[ab].md", "character classes and braces are not supported"],
    ["{a,b}", "character classes and braces are not supported"],
    ["!a", "negative patterns are not supported"],
  ];
  for (const [pattern, reason] of reasons) {
    expect(compileChangedPathPattern(pattern)).toEqual({ error: reason });
  }
});

test("change set: committed, staged, unstaged, untracked, ignored", () => {
  const repo = repository();
  const base = head(repo);
  expect(changes(repo, base)).toEqual([]);
  writeFileSync(path.join(repo, "committed.txt"), "c\n");
  git(repo, "add", "committed.txt");
  git(repo, "commit", "-m", "later");
  writeFileSync(path.join(repo, "staged.txt"), "s\n");
  git(repo, "add", "staged.txt");
  writeFileSync(path.join(repo, "a.txt"), "changed\n");
  writeFileSync(path.join(repo, "untracked.txt"), "u\n");
  writeFileSync(path.join(repo, "ignored.log"), "i\n");
  expect(changes(repo, base)).toEqual(["a.txt", "committed.txt", "staged.txt", "untracked.txt"]);
});

test("change set: deletion, rename, add then remove, restore", () => {
  const repo = repository();
  const base = head(repo);
  rmSync(path.join(repo, "a.txt"));
  expect(changes(repo, base)).toEqual(["a.txt"]);
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  expect(changes(repo, base)).toEqual([]);
  git(repo, "mv", "docs/guide.md", "docs/moved.md");
  expect(changes(repo, base)).toEqual(["docs/guide.md", "docs/moved.md"]);
  git(repo, "mv", "docs/moved.md", "docs/guide.md");
  expect(changes(repo, base)).toEqual([]);
  writeFileSync(path.join(repo, "temp.txt"), "t\n");
  rmSync(path.join(repo, "temp.txt"));
  expect(changes(repo, base)).toEqual([]);
  writeFileSync(path.join(repo, "a.txt"), "edited\n");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  expect(changes(repo, base)).toEqual([]);
  writeFileSync(path.join(repo, "a.txt"), "staged edit\n");
  git(repo, "add", "a.txt");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  expect(changes(repo, base)).toEqual([]);
});

test.skipIf(process.platform === "win32")("change set: a file name with a newline", () => {
  const repo = repository();
  const base = head(repo);
  writeFileSync(path.join(repo, "odd name\nline.txt"), "x\n");
  writeFileSync(path.join(repo, "with space.txt"), "x\n");
  expect(changes(repo, base)).toEqual(["odd name\nline.txt", "with space.txt"]);
});

test("change set: file names with spaces", () => {
  const repo = repository();
  const base = head(repo);
  writeFileSync(path.join(repo, "with space.txt"), "x\n");
  expect(changes(repo, base)).toEqual(["with space.txt"]);
});

test("change set drops Migent session files and nested workspaces use repository paths", () => {
  const repo = repository();
  const base = head(repo);
  mkdirSync(path.join(repo, ".migent", "sessions", "s1"), { recursive: true });
  writeFileSync(path.join(repo, ".migent", "sessions", "s1", "events.jsonl"), "{}\n");
  expect(changes(repo, base)).toEqual([]);
  const nested = path.join(repo, "sub");
  mkdirSync(path.join(nested, ".migent", "sessions", "s2"), { recursive: true });
  writeFileSync(path.join(nested, ".migent", "sessions", "s2", "events.jsonl"), "{}\n");
  writeFileSync(path.join(nested, "file.txt"), "x\n");
  expect(changedPathsSinceBaseline(nested, base, "test")).toEqual([".migent/sessions/s1/events.jsonl", "sub/file.txt"]);
});

test("git problems are errors, never a skip", () => {
  const plain = tempDir("migent-run-when-plain-");
  expect(() => changedPathsSinceBaseline(plain, "0".repeat(40), "stages.x.run_when")).toThrow(
    /^stages\.x\.run_when: the workspace is not in a Git work tree \(/,
  );
  const repo = repository();
  expect(() => changedPathsSinceBaseline(repo, "0123456789012345678901234567890123456789", "stages.x.run_when")).toThrow(
    "stages.x.run_when: baseline commit 0123456789012345678901234567890123456789 is not in this repository (rewritten history or garbage collection).",
  );
});

function sessionIn(workspace: string, workflowText: string): string {
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), CONFIG, "utf8");
  writeFileSync(path.join(workflows, "flow.yaml"), workflowText, "utf8");
  return createWorkflowSession(workspace, "flow", "task");
}

function withLock<T>(workspace: string, sessionId: string, run: () => T): T {
  const lock = SessionLock.acquire(path.join(workspace, ".migent", "sessions", sessionId));
  try {
    return run();
  } finally {
    lock.release();
  }
}

test("baseline is captured once, at the first dispatch", () => {
  const repo = repository();
  const sessionId = sessionIn(repo, PLAIN);
  const early = head(repo);
  writeFileSync(path.join(repo, "later.txt"), "x\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "between create and run");
  const later = head(repo);
  expect(later).not.toBe(early);
  const workflow = workflowFrom(PLAIN);
  withLock(repo, sessionId, () => {
    expect(ensureSessionBaseline(repo, sessionId, workflow)).toBe(true);
    expect(ensureSessionBaseline(repo, sessionId, workflow)).toBe(false);
  });
  const sessionDirectory = path.join(repo, ".migent", "sessions", sessionId);
  expect(readSessionBaseline(sessionDirectory)).toEqual({ commit: later, error: null });
  const events = readFileSync(path.join(sessionDirectory, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.includes("baseline.captured"));
  expect(events).toHaveLength(1);
});

test("baseline is not invented for a session that already ran", () => {
  const repo = repository();
  const sessionId = sessionIn(repo, PLAIN);
  const sessionDirectory = path.join(repo, ".migent", "sessions", sessionId);
  mkdirSync(path.join(sessionDirectory, "executions", "0001-build--attempt-01"), { recursive: true });
  withLock(repo, sessionId, () => {
    expect(ensureSessionBaseline(repo, sessionId, workflowFrom(PLAIN))).toBe(false);
  });
  expect(readSessionBaseline(sessionDirectory)).toBeNull();
  expect(() => evaluateRunWhen(repo, sessionId, workflowFrom(WORKFLOW).stages.review_docs!)).toThrow(
    `stages.review_docs.run_when: session ${sessionId} has no Git baseline. It started before Migent recorded one; start a new session.`,
  );
});

test("a non-Git workspace records a null baseline unless the workflow uses run_when", () => {
  const plain = tempDir("migent-run-when-nogit-");
  const sessionId = sessionIn(plain, PLAIN);
  withLock(plain, sessionId, () => {
    expect(ensureSessionBaseline(plain, sessionId, workflowFrom(PLAIN))).toBe(true);
  });
  const sessionDirectory = path.join(plain, ".migent", "sessions", sessionId);
  const baseline = readSessionBaseline(sessionDirectory);
  expect(baseline?.commit).toBeNull();
  expect(baseline?.error).toMatch(/^not a Git work tree: /);
  expect(() => evaluateRunWhen(plain, sessionId, workflowFrom(WORKFLOW).stages.review_docs!)).toThrow(
    new RegExp(`^stages\\.review_docs\\.run_when: session ${sessionId} recorded no Git baseline \\(not a Git work tree: `),
  );

  const second = tempDir("migent-run-when-nogit2-");
  const secondSession = sessionIn(second, WORKFLOW);
  const secondDirectory = path.join(second, ".migent", "sessions", secondSession);
  withLock(second, secondSession, () => {
    expect(() => ensureSessionBaseline(second, secondSession, workflowFrom(WORKFLOW))).toThrow(
      new RegExp(`^Session ${secondSession} needs a Git commit for run_when: not a Git work tree: `),
    );
  });
  expect(readSessionBaseline(secondDirectory)).toBeNull();
  expect(readFileSync(path.join(secondDirectory, "events.jsonl"), "utf8")).not.toContain("baseline.captured");
});

test("evaluateRunWhen matches or skips against the baseline", () => {
  const repo = repository();
  const sessionId = sessionIn(repo, WORKFLOW);
  const workflow = workflowFrom(WORKFLOW);
  const stage = workflow.stages.review_docs!;
  const base = head(repo);
  withLock(repo, sessionId, () => ensureSessionBaseline(repo, sessionId, workflow));
  writeFileSync(path.join(repo, "a.txt"), "changed\n");
  const skipped = evaluateRunWhen(repo, sessionId, stage);
  expect(skipped).toEqual({
    skip: {
      reason: "no changed path matches run_when.changed_paths",
      baseline: base,
      patterns: ["docs/**/*", "**/README.md"],
      changedPaths: 1,
    },
  });
  writeFileSync(path.join(repo, "README.md"), "root readme\n");
  expect(evaluateRunWhen(repo, sessionId, stage)).toEqual({ matched: "README.md" });
  rmSync(path.join(repo, "README.md"));
  writeFileSync(path.join(repo, "docs", "guide.md"), "changed\n");
  expect(evaluateRunWhen(repo, sessionId, stage)).toEqual({ matched: "docs/guide.md" });
});

test("a ConfigurationError is what Git failures raise", () => {
  const repo = repository();
  const sessionId = sessionIn(repo, WORKFLOW);
  const workflow = workflowFrom(WORKFLOW);
  withLock(repo, sessionId, () => ensureSessionBaseline(repo, sessionId, workflow));
  rmSync(path.join(repo, ".git"), { recursive: true, force: true });
  expect(() => evaluateRunWhen(repo, sessionId, workflow.stages.review_docs!)).toThrow(ConfigurationError);
});

test("a null-commit baseline event reads back as E2 input", () => {
  const repo = repository();
  const sessionId = sessionIn(repo, WORKFLOW);
  const sessionDirectory = path.join(repo, ".migent", "sessions", sessionId);
  withLock(repo, sessionId, () => {
    appendLifecycleEvent(sessionDirectory, {
      event: "baseline.captured",
      timestamp: "2026-01-01T00:00:00.000Z",
      data: { commit: null, error: "HEAD has no commit" },
    });
  });
  expect(() => evaluateRunWhen(repo, sessionId, workflowFrom(WORKFLOW).stages.review_docs!)).toThrow(
    `stages.review_docs.run_when: session ${sessionId} recorded no Git baseline (HEAD has no commit).`,
  );
});
