import { execFileSync, spawnSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const existing = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], { encoding: "utf8" });
if (existing.status !== 0 && existing.status !== 1) throw new Error(existing.stderr || "Cannot read repository Git config.");
if (existing.stdout.trim() && existing.stdout.trim() !== ".githooks") {
  throw new Error(`Existing hooksPath ${existing.stdout.trim()}; integrate the repository hooks before changing it.`);
}
for (const [key, value] of [
  ["core.hooksPath", ".githooks"],
  ["branch.autoSetupMerge", "false"],
  ["push.default", "simple"],
  ["push.autoSetupRemote", "true"],
]) git("config", "--local", key, value);
for (const line of git("for-each-ref", "--format=%(refname:short) %(upstream)", "refs/heads").split("\n")) {
  const [branch, upstream] = line.split(" ");
  if (branch !== "main" && upstream === "refs/remotes/origin/main") {
    git("branch", "--unset-upstream", branch);
    process.stdout.write(`Removed incorrect origin/main upstream from ${branch}.\n`);
  }
}
process.stdout.write("Installed repository Git hooks and branch/push defaults (local config only).\n");
