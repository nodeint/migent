import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  buildSkillsArgv,
  clientsFromConfig,
  installSkill,
  quoteShellArg,
  skillSourceDirectory,
  updateSkill,
} from "../src/commands/skill.ts";
import { cliHooks } from "../src/hooks.ts";
import { main } from "../src/index.ts";
import { scanInstalledSkills, skillDigest } from "../src/skill-scan.ts";
import { SKILL_TARGETS, groupByDirectory } from "../src/skill-targets.ts";
import { capture } from "./support.ts";

const dirs: string[] = [];

function temp(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "migent-skill-"));
  dirs.push(directory);
  return directory;
}

function workspaceOf(models = "models: {}\nroles: {}\n"): string {
  const workspace = temp();
  mkdirSync(path.join(workspace, ".migent"));
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), models, "utf8");
  return workspace;
}

const withNpx = (command: string): string | null => (command === "npx" ? "/bin/npx" : null);

function recorder(code = 0): { calls: string[][]; run: (argv: string[]) => number } {
  const calls: string[][] = [];
  return {
    calls,
    run: (argv) => {
      calls.push(argv);
      return code;
    },
  };
}

function copyBundled(into: string): void {
  cpSync(skillSourceDirectory(), into, { recursive: true });
}

beforeEach(() => {
  cliHooks.which = null;
  cliHooks.skillRunner = null;
});

afterEach(() => {
  cliHooks.which = null;
  cliHooks.skillRunner = null;
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("skill path prints the bundled directory", async () => {
  const captured = await capture(() => main(["skill", "path"], process.cwd()));
  expect(captured.value).toBe(0);
  expect(captured.stdout).toBe(`${skillSourceDirectory()}\n`);
  expect(readFileSync(path.join(skillSourceDirectory(), "SKILL.md"), "utf8")).toContain("name: migent");
});

test("install builds the project command line", async () => {
  const workspace = workspaceOf();
  const { calls, run } = recorder();
  const code = await installSkill({ workspace, scope: "project", clients: ["claude-code"], yes: true, run, which: withNpx });
  expect(code).toBe(0);
  expect(calls).toEqual([
    ["-y", "skills", "add", skillSourceDirectory(), "-s", "migent", "--copy", "-a", "claude-code", "-y"],
  ]);
});

test("install global with several clients, deduplicating the agent list", async () => {
  const { calls, run } = recorder();
  const code = await installSkill({
    scope: "global",
    clients: ["codex,agy", "opencode"],
    run,
    which: withNpx,
    interactive: true,
  });
  expect(code).toBe(0);
  expect(calls[0]).toEqual([
    "-y", "skills", "add", skillSourceDirectory(), "-s", "migent", "--copy", "-g", "-a", "codex", "antigravity", "opencode",
  ]);
});

test("install defaults the clients to the ones in the config", async () => {
  const workspace = workspaceOf(
    "models:\n  a:\n    provider: grok\n    model: m\n  b:\n    provider: byteplus\n    model: m\n    client: claude-code\nroles: {}\n",
  );
  expect(clientsFromConfig(workspace).sort()).toEqual(["claude-code", "grok"]);
  const { calls, run } = recorder();
  await installSkill({ workspace, scope: "project", run, which: withNpx, interactive: false });
  expect(calls[0]).toContain("grok");
  expect(calls[0]).toContain("claude-code");
  expect(calls[0]?.at(-1)).toBe("-y");
});

test("install needs a scope when not interactive and a workspace for project scope", async () => {
  const { calls, run } = recorder();
  const noScope = await capture(() => installSkill({ run, which: withNpx }));
  expect(noScope.value).toBe(2);
  expect(noScope.stderr).toContain("--project or --global");
  const noWorkspace = await capture(() => installSkill({ scope: "project", run, which: withNpx }));
  expect(noWorkspace.value).toBe(1);
  expect(calls).toEqual([]);
});

test("install rejects an unknown client", async () => {
  const { calls, run } = recorder();
  const captured = await capture(() => installSkill({ scope: "global", clients: ["vim"], run, which: withNpx }));
  expect(captured.value).toBe(2);
  expect(captured.stderr).toContain("Unknown client: vim");
  expect(calls).toEqual([]);
});

test("install fails clearly on old Node, missing npx, or a failing skills run", async () => {
  const { calls, run } = recorder();
  const oldNode = await capture(() => installSkill({ scope: "global", run, which: withNpx, nodeVersion: "22.19.0" }));
  expect(oldNode.value).toBe(1);
  expect(oldNode.stderr).toContain("22.20");
  const noNpx = await capture(() => installSkill({ scope: "global", run, which: () => null }));
  expect(noNpx.value).toBe(1);
  expect(noNpx.stderr).toContain("npx");
  expect(calls).toEqual([]);
  const failing = recorder(3);
  const failed = await capture(() => installSkill({ scope: "global", run: failing.run, which: withNpx }));
  expect(failed.value).toBe(1);
  expect(failed.stderr).toContain("code 3");
});

test("quoteShellArg quotes an argument that holds a space", () => {
  expect(quoteShellArg("C:\\Users\\A B\\skills\\migent")).toBe('"C:\\Users\\A B\\skills\\migent"');
  expect(quoteShellArg("--copy")).toBe("--copy");
});

test("buildSkillsArgv omits -a without targets", () => {
  expect(buildSkillsArgv("project", [], false)).not.toContain("-a");
});

test("update reinstalls only copies that differ, per scope", async () => {
  const workspace = workspaceOf();
  const home = temp();
  copyBundled(path.join(workspace, ".claude", "skills", "migent"));
  copyBundled(path.join(home, ".agents", "skills", "migent"));
  writeFileSync(path.join(home, ".agents", "skills", "migent", "extra.md"), "x\n", "utf8");
  const { calls, run } = recorder();
  const code = await updateSkill({ workspace, home, yes: true, run, which: withNpx });
  expect(code).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("-g");
  expect(calls[0]).toEqual(expect.arrayContaining(["codex", "opencode", "antigravity"]));
});

test("update says so when everything is current or nothing is installed", async () => {
  const workspace = workspaceOf();
  const home = temp();
  const { calls, run } = recorder();
  const none = await capture(() => updateSkill({ workspace, home, yes: true, run, which: withNpx }));
  expect(none.value).toBe(1);
  expect(none.stderr).toContain("not installed");
  copyBundled(path.join(workspace, ".claude", "skills", "migent"));
  const current = await capture(() => updateSkill({ workspace, home, yes: true, run, which: withNpx }));
  expect(current.value).toBe(0);
  expect(current.stdout).toContain("Already up to date");
  expect(calls).toEqual([]);
});

test("update asks before overwriting and honours --client and scope filters", async () => {
  const workspace = workspaceOf();
  const home = temp();
  for (const dir of [".claude", ".grok"]) {
    copyBundled(path.join(workspace, dir, "skills", "migent"));
    writeFileSync(path.join(workspace, dir, "skills", "migent", "SKILL.md"), "---\nname: migent\n---\nold\n", "utf8");
  }
  const declined = recorder();
  expect(await updateSkill({ workspace, home, run: declined.run, which: withNpx, confirm: () => false })).toBe(0);
  expect(declined.calls).toEqual([]);
  const noTty = await capture(() => updateSkill({ workspace, home, run: declined.run, which: withNpx }));
  expect(noTty.value).toBe(2);
  const accepted = recorder();
  const code = await updateSkill({
    workspace,
    home,
    clients: ["grok"],
    scope: "project",
    run: accepted.run,
    which: withNpx,
    confirm: () => true,
  });
  expect(code).toBe(0);
  expect(accepted.calls).toHaveLength(1);
  expect(accepted.calls[0]).toContain("grok");
  expect(accepted.calls[0]).not.toContain("claude-code");
});

test("scanner: current, edited, extra file, CRLF, foreign directory", () => {
  const workspace = workspaceOf();
  const home = temp();
  const bundled = skillSourceDirectory();
  const scan = () => scanInstalledSkills({ workspace, home }, bundled);
  const claude = path.join(workspace, ".claude", "skills", "migent");
  copyBundled(claude);
  expect(scan()).toEqual([{ scope: "project", directory: claude, clients: ["claude-code"], state: "current" }]);
  expect(skillDigest(claude)).toBe(skillDigest(bundled));

  const skillFile = path.join(claude, "SKILL.md");
  const original = readFileSync(skillFile, "utf8");
  writeFileSync(skillFile, original.replace(/\r?\n/g, "\r\n"), "utf8");
  expect(scan()[0]?.state).toBe("current");
  writeFileSync(skillFile, `${original}edit\n`, "utf8");
  expect(scan()[0]?.state).toBe("different");
  writeFileSync(skillFile, original, "utf8");
  writeFileSync(path.join(claude, "extra.md"), "x\n", "utf8");
  expect(scan()[0]?.state).toBe("different");

  const foreign = path.join(workspace, ".grok", "skills", "migent");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(path.join(foreign, "SKILL.md"), "---\nname: other\n---\n", "utf8");
  expect(scan()).toHaveLength(1);
});

test("scanner reports a shared directory once with all its clients", () => {
  const workspace = workspaceOf();
  const home = temp();
  copyBundled(path.join(home, ".agents", "skills", "migent"));
  const found = scanInstalledSkills({ workspace, home }, skillSourceDirectory());
  expect(found).toHaveLength(1);
  expect(found[0]?.scope).toBe("global");
  expect(found[0]?.clients).toEqual(["codex", "opencode", "agy"]);
  expect(groupByDirectory(SKILL_TARGETS, "project", { workspace, home })).toHaveLength(3);
});


test("install detects clients from local inline role defaults without models", async () => {
  const workspace = workspaceOf("roles:\n  developer:\n    default_model:\n      provider: codex\n      model: test\n  reviewer:\n    default_model:\n      provider: grok\n      model: test\n");
  writeFileSync(path.join(workspace, ".migent", "config.local.yaml"),
    "roles:\n  developer:\n    default_model:\n      provider: byteplus\n      client: claude-code\n      model: local\n");
  expect(clientsFromConfig(workspace).sort()).toEqual(["claude-code", "grok"]);
  const { calls, run } = recorder();
  expect(await installSkill({ workspace, scope: "project", run, which: withNpx, interactive: false })).toBe(0);
  expect(calls[0]).toContain("claude-code");
  expect(calls[0]).toContain("grok");
  expect(calls[0]).not.toContain("codex");
});
