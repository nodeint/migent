import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workBranch = /^(feat|fix|refactor|docs|chore)\/(?:[1-9]\d*-)?[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const releaseBranch = /^release\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const workSubject = /^(feat|fix|refactor|docs|chore): [^\s.](?:[^\r\n]*[^\s.])?$/;

export function branchProblem(branch) {
  return workBranch.test(branch) || releaseBranch.test(branch)
    ? null
    : "Use <type>/<issue-number>-<slug> (issue number optional), or release/X.Y.Z; see CONTRIBUTING.md.";
}

export function subjectProblem(subject, branch) {
  if (releaseBranch.test(branch) && subject === `Release ${branch.slice("release/".length)}`) return null;
  return workSubject.test(subject)
    ? null
    : "Use <type>: <imperative summary> without a final period; release subjects must match release/X.Y.Z. See CONTRIBUTING.md.";
}

export function pullRequestProblems(branch, title) {
  const problems = [branchProblem(branch), subjectProblem(title, branch)].filter(Boolean);
  if (releaseBranch.test(branch) && title !== `Release ${branch.slice("release/".length)}`) {
    problems.push("Release PR title must be Release X.Y.Z matching its branch.");
  }
  return problems;
}

export function commitProblem(branch) {
  return !branch || branch === "main" || branch === "next"
    ? "Commit on a feature, fix, chore, or release branch. Develop through PRs into next; the release workflow advances main."
    : branchProblem(branch);
}

export function pushProblems(input, currentRef) {
  const problems = [];
  for (const line of input.trim().split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [source, , target] = line.trim().split(/\s+/);
    if (target === "refs/heads/main" || target === "refs/heads/next") {
      problems.push(`Direct pushes to ${target.slice("refs/heads/".length)} are blocked. Push your branch and open a pull request.`);
    } else if (target?.startsWith("refs/heads/") && source !== "(delete)") {
      const resolved = source === "HEAD" ? currentRef : source;
      if (resolved !== target) problems.push(`Branch destination mismatch: ${source} -> ${target}. Push to the same branch name.`);
      const problem = branchProblem(target.slice("refs/heads/".length));
      if (problem) problems.push(problem);
    }
  }
  return problems;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2];
  if (mode === "pr") {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const problems = pullRequestProblems(event.pull_request.head.ref, event.pull_request.title);
    for (const problem of problems) process.stderr.write(`migent: ${problem}\n`);
    process.exitCode = problems.length ? 1 : 0;
  } else {
    const head = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" });
    if (head.error || (head.status !== 0 && head.status !== 1)) throw new Error(head.stderr || "Cannot read HEAD.");
    const branch = head.stdout.trim();
    let problems;
    if (mode === "pre-push") {
      problems = pushProblems(readFileSync(0, "utf8"), `refs/heads/${branch}`);
    } else if (mode === "commit-msg") {
      const subject = readFileSync(process.argv[3], "utf8").split(/\r?\n/)[0];
      problems = [commitProblem(branch), subjectProblem(subject, branch)].filter(Boolean);
    } else {
      problems = [commitProblem(branch)].filter(Boolean);
    }
    for (const problem of problems) process.stderr.write(`migent: ${problem}\n`);
    process.exitCode = problems.length ? 1 : 0;
  }
}
