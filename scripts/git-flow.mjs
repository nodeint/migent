import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function commitProblem(branch) {
  return !branch || branch === "main" || branch === "next"
    ? "Commit on a feature, fix, chore, or release branch. Develop through PRs into next; main advances only to a verified published release."
    : null;
}

export function pushProblems(input, currentRef, verifyRelease) {
  const problems = [];
  for (const line of input.trim().split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [source, localSha, target, remoteSha] = line.trim().split(/\s+/);
    if (target === "refs/heads/main" || target === "refs/heads/next") {
      if (target === "refs/heads/main" && /^refs\/tags\/v\d+\.\d+\.\d+$/.test(source) && verifyRelease) {
        try { verifyRelease(source, localSha, remoteSha); } catch (error) { problems.push(`Release synchronization blocked: ${error.message}`); }
        continue;
      }
      problems.push(`Direct pushes to ${target.slice("refs/heads/".length)} are blocked. Push your branch and open a pull request.`);
    } else if (target?.startsWith("refs/heads/") && source !== "(delete)") {
      const resolved = source === "HEAD" ? currentRef : source;
      if (resolved !== target) problems.push(`Branch destination mismatch: ${source} -> ${target}. Push to the same branch name.`);
    }
  }
  return problems;
}

// Called only for the explicit release-tag -> main refspec. Fail closed on every check.
export function verifyPublishedRelease(tag, localSha, remoteSha, remote, url) {
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, shell: process.platform === "win32" && command === "npm", ...options });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `${command} failed`);
    return result.stdout.trim();
  };
  const git = (...args) => run("git", args);
  if (remote !== "origin" || url !== git("remote", "get-url", "--push", "origin")) throw new Error("Use the configured origin remote.");
  if (git("status", "--porcelain")) throw new Error("Working tree must be clean.");
  const sha = git("rev-parse", `${tag}^{commit}`);
  if (sha !== localSha) throw new Error("Use a lightweight release tag.");
  const version = tag.slice("refs/tags/v".length);
  const refs = git("ls-remote", "origin", "refs/heads/main", "refs/heads/next", tag);
  const advertised = new Map(refs.split("\n").map(line => { const [hash, ref] = line.split(/\s+/); return [ref, hash]; }));
  if (advertised.get(tag) !== sha || advertised.get("refs/heads/main") !== remoteSha) throw new Error("Remote release tag or main changed.");
  git("fetch", "origin", "main", "next");
  if (git("rev-parse", "origin/main") !== remoteSha || git("rev-parse", "origin/next") !== advertised.get("refs/heads/next")) throw new Error("Remote branches changed; retry.");
  git("merge-base", "--is-ancestor", remoteSha, sha);
  git("merge-base", "--is-ancestor", sha, "origin/next");
  const notes = git("show", `${sha}:CHANGELOG.md`);
  if (!notes.includes(`\n## ${version}\n`)) throw new Error("Release notes missing.");
  const packages = ["kernel", "adapters", "registry", "cli"];
  for (const name of packages) {
    const manifest = JSON.parse(git("show", `${sha}:packages/${name}/package.json`));
    if (manifest.name !== (name === "cli" ? "@nodeint/migent" : `@nodeint/migent-${name}`)) throw new Error(`Unexpected package name in ${name}.`);
    if (manifest.version !== version) throw new Error(`Wrong version in ${name}.`);
    const published = run("npm", ["view", `${manifest.name}@${version}`, "version", "--registry=https://registry.npmjs.org", "--prefer-online"]);
    if (published !== version) throw new Error(`${manifest.name}@${version} is not public.`);
  }
  const directory = mkdtempSync(path.join(tmpdir(), "migent-release-verify-"));
  try {
    run("npm", ["install", "--prefix", directory, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online", "--registry=https://registry.npmjs.org", `@nodeint/migent@${version}`]);
    const actual = run(process.execPath, [path.join(directory, "node_modules/@nodeint/migent/dist/index.js"), "--version"]);
    if (actual !== version) throw new Error(`Installed CLI reports ${actual}.`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const head = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" });
  if (head.error || (head.status !== 0 && head.status !== 1)) throw new Error(head.stderr || "Cannot read HEAD.");
  const branch = head.stdout.trim();
  const problems = process.argv[2] === "pre-push"
    ? pushProblems(readFileSync(0, "utf8"), `refs/heads/${branch}`, (tag, localSha, remoteSha) => verifyPublishedRelease(tag, localSha, remoteSha, process.argv[3], process.argv[4]))
    : [commitProblem(branch)].filter(Boolean);
  for (const problem of problems) process.stderr.write(`migent: ${problem}\n`);
  process.exitCode = problems.length ? 1 : 0;
}
