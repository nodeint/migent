import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultProviders, GrokProvider } from "@nodeint/migent-adapters";
import {
  createProviderResolver,
  documentVersion,
  loadModelTarget,
  loadRoleInstructions,
  loadWorkflowDocument,
  loadYamlMapping,
  resolveRoleTarget,
} from "@nodeint/migent-kernel";
import { expect, test } from "vitest";

const TEMPLATES = fileURLToPath(new URL("../../../skills/migent/references/", import.meta.url));
const WORKFLOW_PARSER = fileURLToPath(new URL("../../kernel/src/workflow.ts", import.meta.url));
const CONFIG_PARSER = fileURLToPath(new URL("../../kernel/src/config.ts", import.meta.url));
const RECORD_PARSER = fileURLToPath(new URL("../../kernel/src/record.ts", import.meta.url));

const CONFIG_KEYS = [
  "default_model",
  "effort",
  "instructions",
  "model",
  "models",
  "options",
  "provider",
  "roles",
  "schema_version",
];
const WORKFLOW_KEYS = [
  "artifact",
  "ask",
  "changed_paths",
  "completion",
  "concurrency",
  "constraints",
  "decision",
  "depends_on",
  "description",
  "from_stage",
  "id",
  "instructions",
  "max_revisions",
  "max_verify",
  "model",
  "name",
  "navigate",
  "options",
  "outputs",
  "produces",
  "requires",
  "resume_from",
  "role",
  "routes",
  "run_when",
  "schema_version",
  "session",
  "stage",
  "stages",
  "values",
  "verify",
  "verify_timeout",
  "when",
  "workflow",
];

test("config reference parses and names every key the config parser reads", () => {
  const text = readFileSync(path.join(TEMPLATES, "schema-config.yaml"), "utf8");
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-schema-config-"));
  try {
    const configPath = path.join(workspace, ".migent", "config.yaml");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, text, "utf8");
    const config = loadYamlMapping(configPath);
    expect(documentVersion(config)).toBe(3);
    expect(loadModelTarget(config, "deep_reasoning", createProviderResolver(defaultProviders()))).toEqual({
      provider: "grok",
      model: "grok-4.7",
      options: { "reasoning-effort": "high" },
    });
    expect(resolveRoleTarget(workspace, "planner", undefined, createProviderResolver(defaultProviders()))).toEqual({
      provider: "grok",
      model: "grok-4.7",
      options: { "reasoning-effort": "medium", max_turns: "10" },
    });
    expect(resolveRoleTarget(workspace, "reviewer", undefined, createProviderResolver(defaultProviders()))).toEqual({
      provider: "grok",
      model: "grok-4.7",
      options: { "reasoning-effort": "high" },
    });
    expect(text).toContain("config.local.yaml");
    expect(loadRoleInstructions(config, "planner")).toEqual(["Break the task into a reviewable plan."]);
    expect(loadRoleInstructions(config, "reviewer")).toEqual([]);
    new GrokProvider().validateOptions({ "reasoning-effort": "high" });
    new GrokProvider().validateOptions({ "reasoning-effort": "medium" });
    const configParser = `${readFileSync(CONFIG_PARSER, "utf8")}\n${readFileSync(RECORD_PARSER, "utf8")}`;
    expect(parserKeys(configParser, "config")).toEqual(CONFIG_KEYS);
    expect(yamlKeys(text)).toEqual([...CONFIG_KEYS, "client", "code_generation", "deep_reasoning", "developer", "planner", "max_turns", "reviewer"].sort());
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("workflow reference parses and names every key the workflow parser reads", () => {
  const text = readFileSync(path.join(TEMPLATES, "schema-workflow.yaml"), "utf8");
  const filePath = path.join(TEMPLATES, "schema-workflow.yaml");
  const document = loadWorkflowDocument(filePath);
  expect(documentVersion(loadYamlMapping(filePath))).toBe(3);
  expect(document.schemaVersion).toBe(3);
  expect(document.concurrency).toBe(1);
  expect(document.id).toBe("reference");
  expect(document.constraints).toEqual(["Stay within the task."]);
  expect(document.requires).toEqual({ workflow: "plan", decision: null });
  expect(document.stages.prepare).toMatchObject({
    kind: "verify",
    role: null,
    description: "Check the tree before the draft.",
    verify: ["pnpm build"],
    verifyTimeoutSec: 1800,
    dependsOn: [],
  });
  expect(document.stages.draft).toMatchObject({
    kind: "role",
    role: "planner",
    description: null,
    modelName: "deep_reasoning",
    options: { "reasoning-effort": "high" },
    dependsOn: ["prepare"],
    maxRevisions: 2,
    instructions: ["Write the draft."],
    artifact: "draft.md",
    resumeFrom: null,
    verify: [],
  });
  expect(document.stages.review).toMatchObject({
    role: "reviewer",
    dependsOn: ["draft"],
    resumeFrom: "draft",
    instructions: ["Review the draft."],
    verify: ["pnpm test"],
    maxVerify: 3,
    verifyTimeoutSec: 900,
    decisionValues: ["approved", "revise"],
    routes: { approved: "complete", revise: "draft" },
  });
  expect(document.stages.check_docs).toMatchObject({
    kind: "role",
    role: "reviewer",
    description: null,
    dependsOn: ["review"],
    instructions: ["Review documentation changes."],
    verify: [],
    decisionValues: [],
    artifact: null,
    runWhen: { changedPaths: ["docs/**/*", "**/README.md"] },
  });
  expect(document.completion).toBeNull();
  expect(document.outputs).toEqual([{ name: "draft", fromStage: "draft", artifact: "draft.md" }]);
  const scanned = new Set(parserKeys(readFileSync(WORKFLOW_PARSER, "utf8"), "workflow"));
  scanned.add("schema_version");
  expect([...scanned].sort()).toEqual(WORKFLOW_KEYS);
  const sampleKeys = WORKFLOW_KEYS.filter((key) => !["completion", "stage", "values", "routes"].includes(key));
  expect(yamlKeys(text)).toEqual([...sampleKeys, "approved", "reasoning-effort", "revise"].sort());
});

function parserKeys(source: string, kind: "config" | "workflow"): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(/Object\.hasOwn\(\w+, "([^"]+)"\)/g)) keys.add(match[1] ?? "");
  if (kind === "config") {
    for (const match of source.matchAll(/\bconfig\.(models|roles)\b/g)) keys.add(match[1] ?? "");
    for (const match of source.matchAll(/\bmodelConfig\.(provider|model|options)\b/g)) keys.add(match[1] ?? "");
    for (const match of source.matchAll(/\brole\.(default_model|options|instructions)\b/g)) keys.add(match[1] ?? "");
  } else {
    for (const match of source.matchAll(/(?:requiredString|stringItems|filename)\(\w+\.(\w+)/g)) keys.add(match[1] ?? "");
    for (const match of source.matchAll(/optionalStageString\(\w+, "([^"]+)"/g)) keys.add(match[1] ?? "");
    for (const match of source.matchAll(/\bdata\.(stages|completion|requires|outputs|concurrency)\b/g)) keys.add(match[1] ?? "");
    for (const match of source.matchAll(/\bdecision\.(values|routes)\b/g)) keys.add(match[1] ?? "");
    if (source.includes("body.navigate")) keys.add("navigate");
    for (const match of source.matchAll(/\braw\.outputs\b/g)) keys.add("outputs");
  }
  keys.delete("");
  return [...keys].sort();
}

function yamlKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^(?:-\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(trimmed);
    if (match?.[1]) keys.add(match[1]);
  }
  return [...keys].sort();
}
