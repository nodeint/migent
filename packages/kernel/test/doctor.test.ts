import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { diagnose } from "../src/index.ts";
import { defaultAdapters, STAGE_CONFIG, STAGE_WORKFLOW, tempDir, whichFound } from "./support.ts";

test("reports roles, workflows, and provider paths", () => {
  const workspace = tempDir("migent-doctor-");
  writeStageProject(workspace);
  const [config, workflows, providers] = diagnose(workspace, {
    adapters: defaultAdapters(),
    which: whichFound(new Set(["codex", "grok"])),
  });
  expect(config.ok).toBe(true);
  expect(config.items).toEqual(["developer", "reviewer"]);
  expect(workflows.ok).toBe(true);
  expect(workflows.items).toEqual(["plan-implement"]);
  expect(providers.ok).toBe(true);
  expect(providers.items).toEqual(["codex  /bin/codex", "grok  /bin/grok"]);
});

test("rejects an unsupported provider without checking its command", () => {
  const calls: string[] = [];
  const which = (command: string): string | null => {
    calls.push(command);
    return `/bin/${command}`;
  };
  const workspace = tempDir("migent-doctor-");
  writeStageProject(workspace);
  const configPath = path.join(workspace, ".migent", "config.yaml");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8").replace("provider: grok", "provider: claude"),
    "utf8",
  );
  const [config, _workflows, providers] = diagnose(workspace, {
    adapters: defaultAdapters(),
    which,
  });
  expect(config.ok).toBe(false);
  expect(config.problems).toContain("models.grok.provider is not supported: claude");
  expect(calls).toEqual(["codex"]);
  expect(providers.ok).toBe(true);
  expect(providers.items).toEqual(["codex  /bin/codex"]);
});

test("reports a missing provider command", () => {
  const workspace = tempDir("migent-doctor-");
  writeStageProject(workspace);
  const [_config, _workflows, providers] = diagnose(workspace, {
    adapters: defaultAdapters(),
    which: whichFound(new Set(["codex"])),
  });
  expect(providers.ok).toBe(false);
  expect(providers.problems).toEqual(["grok is not on PATH"]);
  expect(providers.items).toEqual(["codex  /bin/codex"]);
});

test("reports a workflow role and a requires mismatch", () => {
  const workspace = tempDir("migent-doctor-");
  writeStageProject(workspace);
  const workflowsDir = path.join(workspace, ".migent", "workflows");
  writeFileSync(
    path.join(workflowsDir, "plan.yaml"),
    "id: plan\n" +
      "stages:\n" +
      "  - id: plan\n" +
      "    role: missing-role\n" +
      "completion:\n" +
      "  stage: plan\n" +
      "  decision: revise\n",
    "utf8",
  );
  writeFileSync(
    path.join(workflowsDir, "follow-on.yaml"),
    "id: follow-on\n" +
      "requires:\n" +
      "  workflow: plan\n" +
      "  decision: approved\n" +
      "stages:\n" +
      "  - id: implement\n" +
      "    role: developer\n",
    "utf8",
  );
  writeFileSync(path.join(workflowsDir, "notes.txt"), "ignore", "utf8");
  const [config, workflows] = diagnose(workspace, {
    adapters: defaultAdapters(),
    which: whichFound(new Set(["codex", "grok"])),
  });
  expect(config.ok).toBe(true);
  expect(workflows.ok).toBe(false);
  expect(workflows.items).toContain("plan-implement");
  expect(workflows.items).not.toContain("plan");
  expect(workflows.items).not.toContain("follow-on");
  expect(workflows.problems).toContain("plan.plan: Missing or invalid roles.missing-role.");
  expect(workflows.problems).toContain(
    "follow-on: requires plan to complete with approved, but it completes with revise.",
  );
});

test("accepts a file whose id differs from its name", () => {
  const workspace = tempDir("migent-doctor-");
  writeStageProject(workspace);
  writeFileSync(
    path.join(workspace, ".migent", "workflows", "plan-implement.yaml"),
    "id: other\nstages:\n  - id: implement\n    role: developer\n",
    "utf8",
  );
  const [_config, workflows] = diagnose(workspace, {
    adapters: defaultAdapters(),
    which: whichFound(new Set(["codex", "grok"])),
  });
  expect(workflows.ok).toBe(true);
  expect(workflows.problems).toEqual([]);
  expect(workflows.items).toEqual(["other"]);
});

test("reports invalid config and an unreadable workflow together", () => {
  const workspace = tempDir("migent-doctor-");
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), "- not-a-map\n", "utf8");
  writeFileSync(path.join(workflows, "broken.yaml"), "stages: [\n", "utf8");
  const [config, workflowCheck, providers] = diagnose(workspace, {
    adapters: defaultAdapters(),
    which: whichFound(new Set(["grok"])),
  });
  expect(config.ok).toBe(false);
  expect(config.problems).toContain("Invalid configuration: expected a mapping.");
  expect(workflowCheck.ok).toBe(false);
  expect(workflowCheck.problems.length).toBeGreaterThan(0);
  expect(providers.ok).toBe(false);
  expect(providers.problems).toEqual(["No providers could be resolved from config."]);
});

test("reports an option the adapter rejects", () => {
  const workspace = tempDir("migent-doctor-");
  writeStageProject(workspace);
  const configPath = path.join(workspace, ".migent", "config.yaml");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8").replace(
      "      reasoning-effort: high\n",
      '      reasoning-effort: high\n      nope: "1"\n',
    ),
    "utf8",
  );
  const [config, workflows] = diagnose(workspace, {
    adapters: defaultAdapters(),
    which: whichFound(new Set(["codex", "grok"])),
  });
  expect(config.ok).toBe(false);
  expect(config.problems).toContain("models.grok.options: nope is not a grok option.");
  expect(config.problems).toContain("roles.developer: nope is not a grok option.");
  expect(workflows.ok).toBe(true);
});

test("does not reject an unlisted effort value", () => {
  const workspace = tempDir("migent-doctor-");
  writeStageProject(workspace);
  const workflow = path.join(workspace, ".migent", "workflows", "plan-implement.yaml");
  writeFileSync(
    workflow,
    readFileSync(workflow, "utf8").replace("model_reasoning_effort: high", "model_reasoning_effort: banana"),
    "utf8",
  );
  const [config, workflows] = diagnose(workspace, {
    adapters: defaultAdapters(),
    which: whichFound(new Set(["codex", "grok"])),
  });
  expect(config.ok).toBe(true);
  expect(workflows.ok).toBe(true);
});

test("reports a missing workflows directory", () => {
  const workspace = tempDir("migent-doctor-");
  mkdirSync(path.join(workspace, ".migent"));
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), STAGE_CONFIG, "utf8");
  const [_config, workflows] = diagnose(workspace, {
    adapters: defaultAdapters(),
    which: whichFound(new Set(["codex", "grok"])),
  });
  expect(workflows.ok).toBe(false);
  expect(workflows.problems).toEqual(["Workflows directory not found: .migent/workflows"]);
});

function writeStageProject(workspace: string): void {
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), STAGE_CONFIG, "utf8");
  writeFileSync(path.join(workflows, "plan-implement.yaml"), STAGE_WORKFLOW, "utf8");
}
