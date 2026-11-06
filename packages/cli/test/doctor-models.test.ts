import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { stringifyConfig as stringify } from "@nodeint/migent-kernel";
import { runDoctor } from "../src/commands/doctor.ts";
import { closest } from "@nodeint/migent-doctor";
import type { RunCommand } from "../src/provider.ts";
import { capture } from "./support.ts";

const levels = ["low", "medium", "high"];
const which = (command: string) => `/fake/${command}`;

function catalog(argv: string[]): string {
  if (argv[0] === "grok") return "Available models:\n  - grok-4\n  - grok-4-fast\n  - grok-code\n";
  if (argv[0] === "codex") return JSON.stringify({ models: [{ slug: "gpt-5", supported_reasoning_levels: levels }] });
  throw new Error(`Unexpected command: ${argv.join(" ")}`);
}

async function inspect(
  agents: Record<string, unknown>,
  options: { run?: RunCommand; json?: boolean; which?: (command: string) => string | null } = {},
) {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-doctor-models-"));
  try {
    mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
    writeFileSync(path.join(workspace, ".migent", "config.yaml"), stringify({
      schema_version: 5, agents, roles: { developer: { agent: Object.keys(agents)[0] } },
    }));
    writeFileSync(path.join(workspace, ".migent", "workflows", "flow.yaml"), stringify({
      schema_version: 5, stages: [{ id: "work", role: "developer" }],
    }));
    return await capture(() => runDoctor(workspace, {
      asJson: options.json ?? true, which: options.which ?? which, runCommand: options.run ?? catalog, home: workspace,
    }));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

const problems = (stdout: string): string[] =>
  JSON.parse(stdout).checks.flatMap((check: { problems: string[] }) => check.problems);
const warnings = (stdout: string): string[] =>
  JSON.parse(stdout).checks.flatMap((check: { warnings: string[] }) => check.warnings)
    .filter((warning: string) => !warning.startsWith("Migent skill"));

test("a listed model passes without findings", async () => {
  const result = await inspect({ fast: { provider: "grok", model: "grok-4" } });
  expect(result.value).toBe(0);
  expect(warnings(result.stdout).join(" ")).not.toContain("Could not validate");
});

test("a typo on a reliable catalog fails with the closest matches", async () => {
  const result = await inspect({ fast: { provider: "grok", model: "grok-4x" } });
  expect(result.value).toBe(1);
  expect(problems(result.stdout)).toEqual([
    'Invalid agents.fast.model: "grok-4x"\nUnknown model: grok-4x.\nDid you mean: grok-4',
  ]);
});

test("the human output carries the same message", async () => {
  const result = await inspect({ fast: { provider: "grok", model: "grok-4x" } }, { json: false });
  expect(result.value).toBe(1);
  expect(result.stdout).toContain('  Invalid agents.fast.model: "grok-4x"\n  Unknown model: grok-4x.');
});

test("a model missing from a warning-only catalog warns without failing", async () => {
  const result = await inspect({ fast: { provider: "codex", model: "gpt-5x" } });
  expect(result.value).toBe(0);
  expect(warnings(result.stdout)).toEqual([expect.stringContaining('Could not validate agents.fast.model: "gpt-5x"')]);
});

test("an unavailable CLI or failing command only warns", async () => {
  const missing = await inspect({ fast: { provider: "grok", model: "grok-4x" } }, { which: () => null });
  expect(problems(missing.stdout).join("\n")).not.toContain("Unknown model");
  expect(warnings(missing.stdout)[0]).toContain("Could not validate agents.fast.model");
  const timeout = await inspect({ fast: { provider: "grok", model: "grok-4x" } }, {
    run: () => { throw new Error("request timed out"); },
  });
  expect(timeout.value).toBe(0);
  expect(warnings(timeout.stdout)).toEqual([expect.stringContaining('Could not validate agents.fast.model: "grok-4x"')]);
  expect(warnings(timeout.stdout)[0]).toContain("request timed out");
});

test("an empty catalog only warns", async () => {
  const result = await inspect({ fast: { provider: "grok", model: "grok-4x" } }, { run: () => "Available models:\n" });
  expect(result.value).toBe(0);
  expect(warnings(result.stdout)[0]).toContain("Could not validate agents.fast.model");
});

test("each catalog is fetched once, shared with the effort check", async () => {
  const calls: string[][] = [];
  const result = await inspect({
    first: { provider: "codex", model: "gpt-5", effort: "high" },
    second: { provider: "codex", model: "gpt-5", effort: "low" },
  }, { run: (argv) => { calls.push(argv); return catalog(argv); } });
  expect(result.value).toBe(0);
  expect(calls).toHaveLength(1);
});

test("an unknown model suppresses its effort message", async () => {
  const result = await inspect({ fast: { provider: "grok", model: "grok-4x", effort: "bad" } });
  expect(result.value).toBe(1);
  expect(problems(result.stdout)).toHaveLength(1);
  expect(problems(result.stdout)[0]).toContain("Unknown model: grok-4x.");
});

test("an unreadable catalog yields one warning per model", async () => {
  const result = await inspect({ fast: { provider: "codex", model: "gpt-5", effort: "high" } }, {
    run: () => { throw new Error("offline"); },
  });
  expect(result.value).toBe(0);
  expect(warnings(result.stdout)).toHaveLength(1);
  expect(warnings(result.stdout)[0]).toContain('Could not validate agents.fast.model: "gpt-5"');
  expect(warnings(result.stdout)[0]).not.toContain("effort");
});

test("an unmapped alias is skipped by the model check", async () => {
  const calls: string[][] = [];
  const result = await inspect({ fast: {} }, { run: (argv) => { calls.push(argv); return catalog(argv); } });
  expect(result.value).toBe(1);
  expect(problems(result.stdout)[0]).toContain("has no provider and model on this machine.");
  expect(calls).toHaveLength(0);
});

test("closest suggests prefix and near-edit matches only", () => {
  expect(closest("claude-sonet-5-5", ["claude-sonnet-5-5", "gpt-5"])).toEqual(["claude-sonnet-5-5"]);
  expect(closest("grok", ["grok-4", "other-model"])).toEqual(["grok-4"]);
  expect(closest("zzz", ["grok-4"])).toEqual([]);
});

test("an unlisted model on a warning-only provider skips its effort check", async () => {
  const calls: string[][] = [];
  const result = await inspect({ fast: { provider: "codex", model: "gpt-5x", effort: "bad" } }, {
    run: (argv) => { calls.push(argv); return catalog(argv); },
  });
  expect(result.value).toBe(0);
  expect(problems(result.stdout)).toEqual([]);
  expect(warnings(result.stdout)).toHaveLength(1);
  expect(warnings(result.stdout)[0]).toContain('Could not validate agents.fast.model: "gpt-5x"');
  expect(calls).toHaveLength(1);
});
