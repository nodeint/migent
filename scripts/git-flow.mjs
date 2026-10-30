import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function commitProblem(branch) {
  return !branch || branch === "main" || branch === "next"
    ? "Commit on a feature, fix, chore, or release branch; main changes through pull requests. Develop through PRs into next."
    : null;
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
    }
  }
  return problems;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const head = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" });
  if (head.error || (head.status !== 0 && head.status !== 1)) throw new Error(head.stderr || "Cannot read HEAD.");
  const branch = head.stdout.trim();
  const problems = process.argv[2] === "pre-push"
    ? pushProblems(readFileSync(0, "utf8"), `refs/heads/${branch}`)
    : [commitProblem(branch)].filter(Boolean);
  for (const problem of problems) process.stderr.write(`migent: ${problem}\n`);
  process.exitCode = problems.length ? 1 : 0;
}
