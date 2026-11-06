import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { AgentToolRunner } from "@nodeint/migent-kernel";
import { cliHooks } from "../src/hooks.ts";
import { main } from "../src/index.ts";
import { providerMap } from "../src/provider.ts";
import { ScriptedProvider, capture, removeWorkspace, repoWorkflowText, writeFakeWorkflowWorkspace } from "./support.ts";

const PLAN = ["session", "run", "--once", "--workflow", "plan", "--task", "do it"];

/** The planner (stage 1) maps to the fake provider; the reviewer (stage 2) is configurable. */
function config(reviewer: string): string {
  return `schema_version: 5
agents:
  good:
    provider: fake
    model: m1
  later:
${reviewer}
roles:
  planner:
    agent: good
  reviewer:
    agent: later
`;
}

const GROK_TYPO = "    provider: grok\n    model: grok-typo";
const GROK_OK = "    provider: grok\n    model: grok-ok";
const CATALOG = "Available models:\n  - grok-ok\n";

function setup(reviewer: string): { workspace: string; provider: ScriptedProvider } {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), config(reviewer), "utf8");
  const provider = new ScriptedProvider(["status: complete\n\ndone"], ["# Plan\n"]);
  cliHooks.runner = new AgentToolRunner({ ...providerMap(), fake: provider }, 10);
  cliHooks.runCommand = (argv) => {
    if (argv[0] === "grok") return CATALOG;
    throw new Error(`Unexpected command: ${argv.join(" ")}`);
  };
  return { workspace, provider };
}

function sessionDirectories(workspace: string): string[] {
  const directory = path.join(workspace, ".migent", "sessions");
  return existsSync(directory) ? readdirSync(directory) : [];
}

afterEach(() => {
  cliHooks.runner = null;
  cliHooks.runCommand = null;
});

test("a bad model in a later stage stops --workflow before anything is created", async () => {
  const { workspace, provider } = setup(GROK_TYPO);
  try {
    const result = await capture(() => main(PLAN, workspace));
    expect(result.value).toBe(2);
    expect(result.stderr).toContain('Invalid agents.later.model: "grok-typo"');
    expect(result.stderr).toContain("plan.review-plan:");
    expect(result.stderr).toContain("--skip-preflight");
    expect(result.stdout).toBe("");
    expect(sessionDirectories(workspace)).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  } finally {
    removeWorkspace(workspace);
  }
});

test.each([
  ["provider", "    provider: nope\n    model: m1", "is not supported"],
  ["client", "    provider: grok\n    client: bogus\n    model: grok-ok", "client"],
  ["option", "    provider: grok\n    model: grok-ok\n    options:\n      bogus_option: x", "options"],
])("an unsupported %s stops the run", async (_name, reviewer, message) => {
  const { workspace, provider } = setup(reviewer);
  try {
    const result = await capture(() => main(PLAN, workspace));
    expect(result.value).toBe(2);
    expect(result.stderr).toContain(message);
    expect(sessionDirectories(workspace)).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  } finally {
    removeWorkspace(workspace);
  }
});

test("a prepared session stays prepared and unfrozen until the problem is fixed", async () => {
  const { workspace, provider } = setup(GROK_TYPO);
  try {
    const prepared = await capture(() => main(["session", "prepare", "a title", "--workflow", "plan"], workspace));
    const sessionId = (JSON.parse(prepared.stdout) as { session_id: string }).session_id;
    const directory = path.join(workspace, ".migent", "sessions", sessionId);
    writeFileSync(path.join(directory, "task.md"), "do it\n", "utf8");

    // main() clears cliHooks when it returns, so reinstall them for the next invocation.
    cliHooks.runner = new AgentToolRunner({ ...providerMap(), fake: provider }, 10);
    cliHooks.runCommand = (argv) => {
      if (argv[0] === "grok") return CATALOG;
      throw new Error(`Unexpected command: ${argv.join(" ")}`);
    };
    const failed = await capture(() => main(["session", "run", "--once", "--session", sessionId], workspace));
    expect(failed.value).toBe(2);
    expect(failed.stderr).toContain('Invalid agents.later.model: "grok-typo"');
    expect(existsSync(path.join(directory, "workflow.frozen.yaml"))).toBe(false);
    expect((JSON.parse(readFileSync(path.join(directory, "status.json"), "utf8")) as { status: string }).status).toBe("prepared");
    expect(provider.calls).toHaveLength(0);

    writeFileSync(path.join(workspace, ".migent", "config.yaml"), config(GROK_OK), "utf8");
    cliHooks.runner = new AgentToolRunner({ ...providerMap(), fake: provider }, 10);
    cliHooks.runCommand = () => CATALOG;
    const fixed = await capture(() => main(["session", "run", "--once", "--session", sessionId], workspace));
    expect(fixed.value).toBe(0);
    expect(fixed.stderr).toContain("preflight ok");
    expect(existsSync(path.join(directory, "workflow.frozen.yaml"))).toBe(true);
    expect(provider.calls).toHaveLength(1);
  } finally {
    removeWorkspace(workspace);
  }
});

test("warnings go to stderr and do not block the run", async () => {
  const { workspace, provider } = setup(GROK_OK);
  try {
    cliHooks.runCommand = () => {
      throw new Error("catalog offline");
    };
    const result = await capture(() => main(PLAN, workspace));
    expect(result.value).toBe(0);
    expect(result.stderr).toContain("preflight warning: Could not validate agents.later.model");
    expect(result.stderr).toContain("preflight ok");
    expect(result.stdout).not.toContain("preflight");
    expect(provider.calls).toHaveLength(1);
  } finally {
    removeWorkspace(workspace);
  }
});

test("a clean run prints only a short preflight ok line", async () => {
  const { workspace } = setup(GROK_OK);
  try {
    const result = await capture(() => main(PLAN, workspace));
    expect(result.value).toBe(0);
    expect(result.stderr).toContain("preflight ok");
    expect(result.stderr).not.toContain("failed");
  } finally {
    removeWorkspace(workspace);
  }
});

test("--skip-preflight bypasses a failing check and says so", async () => {
  const { workspace, provider } = setup(GROK_TYPO);
  try {
    const result = await capture(() => main([...PLAN, "--skip-preflight"], workspace));
    expect(result.value).toBe(0);
    expect(result.stderr).toContain("preflight skipped (--skip-preflight)");
    expect(result.stderr).not.toContain("Invalid agents.later.model");
    expect(provider.calls).toHaveLength(1);
  } finally {
    removeWorkspace(workspace);
  }
});

test("session continue does not run the preflight", async () => {
  const { workspace, provider } = setup(GROK_OK);
  try {
    const started = await capture(() => main(PLAN, workspace));
    expect(started.value).toBe(0);
    const sessionId = /session_id: (\S+)/.exec(started.stderr)![1]!;
    writeFileSync(path.join(workspace, ".migent", "config.yaml"), config(GROK_TYPO), "utf8");
    const second = new ScriptedProvider(["status: complete\n\napproved"]);
    cliHooks.runner = new AgentToolRunner({ ...providerMap(), fake: second }, 10);
    const continued = await capture(() => main(["session", "continue", sessionId, "--once"], workspace));
    expect(continued.stderr).not.toContain("preflight");
    expect(continued.stderr).not.toContain("Preflight failed");
    expect(provider.calls).toHaveLength(1);
  } finally {
    removeWorkspace(workspace);
  }
});

test("--skip-preflight is rejected for a role run", async () => {
  const { workspace } = setup(GROK_OK);
  try {
    const result = await capture(() => main(["session", "run", "--role", "planner", "--prompt", "x", "--skip-preflight"], workspace));
    expect(result.value).toBe(2);
  } finally {
    removeWorkspace(workspace);
  }
});
