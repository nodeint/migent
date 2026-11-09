import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GrokClient, clientIds } from "@nodeint/migent-adapters";
import { documentVersion, loadAgentTarget, loadRoleDescription, loadRoleResponsibilities, loadYamlMapping, migrateConfig, resolveRoleTarget } from "@nodeint/migent-kernel";
import { loadWorkflowDocument } from "@nodeint/migent-workflow";
import { expect, test } from "vitest";
import { clientRegistry } from "../src/client.ts";

const TEMPLATES = fileURLToPath(new URL("../../../skills/migent/references/", import.meta.url));
const WORKFLOW_SRC = fileURLToPath(new URL("../../workflow/src/", import.meta.url));
/** Modules that were `workflow.ts` before it was split; the key scan reads them together. */
const WORKFLOW_PARSER_MODULES = ["model", "schema", "graph", "stage-fields", "artifacts", "parse", "catalog", "load", "draft/problems", "draft/stage", "draft/outputs", "draft/graph", "draft/index"];
const CONFIG_PARSER = fileURLToPath(new URL("../../kernel/src/config.ts", import.meta.url));
const CONFIG_STRUCTURE = fileURLToPath(new URL("../../kernel/src/config-structure.ts", import.meta.url));
const RECORD_PARSER = fileURLToPath(new URL("../../workflow/src/record.ts", import.meta.url));

const CONFIG_KEYS = [
  "agent",
  "agents",
  "client",
  "description",
  "effort",
  "model",
  "options",
  "responsibilities",
  "roles",
  "schema_version",
  "type",
];
// Keys the parser still names only to reject them with a pointer to the v5 replacement.
const LEGACY_CONFIG_KEYS = ["models", "provider"];
const WORKFLOW_KEYS = [
  "agent",
  "artifact",
  "artifacts",
  "ask",
  "changed_paths",
  "completion",
  "concurrency",
  "constraints",
  "decision",
  "depends_on",
  "description",
  "downstream",
  "file",
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
  "task",
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
    const reference = loadYamlMapping(configPath);
    expect(documentVersion(reference)).toBe(7);
    const config = structuredClone(reference);
    migrateConfig(config, 7, config, { layer: "project", clientIds: clientIds() });
    expect(documentVersion(config)).toBe(7);
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const clients = clientRegistry();
    expect(loadAgentTarget(config, "deep_reasoning", clients)).toEqual({
      client: "grok",
      model: "grok-4.7",
      options: { "reasoning-effort": "high" },
    });
    expect(loadAgentTarget(config, "code_generation", clients)).toMatchObject({
      client: "opencode",
      model: "coding-plan/deepseek-v4-pro",
    });
    expect(loadRoleDescription(config, "planner")).toBe("Designs the approach and writes the plan.");
    expect(resolveRoleTarget(workspace, "planner", undefined, clients)).toEqual({
      client: "grok",
      model: "grok-4.7",
      options: { "reasoning-effort": "medium", max_turns: "10" },
    });
    expect(resolveRoleTarget(workspace, "reviewer", undefined, clients)).toEqual({
      client: "grok",
      model: "grok-4.7",
      options: { "reasoning-effort": "high" },
    });
    expect(text).toContain("config.local.yaml");
    expect(loadRoleResponsibilities(config, "planner")).toEqual(["Break the task into a reviewable plan."]);
    expect(loadRoleResponsibilities(config, "reviewer")).toEqual([]);
    new GrokClient().validateOptions({ "reasoning-effort": "high" });
    new GrokClient().validateOptions({ "reasoning-effort": "medium" });
    const configParser = `${readFileSync(CONFIG_PARSER, "utf8")}\n${readFileSync(CONFIG_STRUCTURE, "utf8")}\n${readFileSync(RECORD_PARSER, "utf8")}`;
    expect(parserKeys(configParser, "config").filter((key) => !LEGACY_CONFIG_KEYS.includes(key))).toEqual(CONFIG_KEYS);
    expect(yamlKeys(text)).toEqual([...CONFIG_KEYS, "code_generation", "deep_reasoning", "developer", "planner", "max_turns", "reviewer"].sort());
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("workflow reference parses and names every key the workflow parser reads", () => {
  const text = readFileSync(path.join(TEMPLATES, "schema-workflow.yaml"), "utf8");
  const filePath = path.join(TEMPLATES, "schema-workflow.yaml");
  const document = loadWorkflowDocument(filePath);
  expect(documentVersion(loadYamlMapping(filePath))).toBe(7);
  expect(document.schemaVersion).toBe(7);
  expect(document.concurrency).toBe(1);
  expect(document.id).toBe("reference");
  expect(document.constraints).toEqual(["Stay within the task."]);
  expect(document.requires).toBeNull();
  expect(document.downstream).toEqual([{ workflow: "implement", task: "Implement the approved draft.", artifacts: { plan: "draft" } }]);
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
    agent: { kind: "named", name: "deep_reasoning" },
    options: {},
    dependsOn: ["prepare"],
    maxRevisions: 2,
    instructions: ["Write the draft."],
    artifacts: [{ id: "draft", file: "draft.md", description: "The draft for review.", required: true, scope: "published" }],
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
    routes: { approved: "check_docs", revise: "draft" },
  });
  expect(document.stages.check_docs).toMatchObject({
    kind: "role",
    role: "reviewer",
    description: null,
    dependsOn: ["review"],
    agent: { kind: "inline", value: { model: "gpt-5", effort: "low", client: { type: "codex" } } },
    instructions: ["Review documentation changes."],
    verify: [],
    decisionValues: [],
    artifacts: [],
    runWhen: { changedPaths: ["docs/**/*", "**/README.md"] },
  });
  expect(document.completion).toBeNull();
  expect(document.outputs?.map((output) => output.name)).toEqual(["draft", "draft-notes"]);
  const scanned = new Set(parserKeys(WORKFLOW_PARSER_MODULES.map((name) => readFileSync(`${WORKFLOW_SRC}${name}.ts`, "utf8")).join("\n"), "workflow"));
  scanned.add("schema_version");
  expect([...scanned].sort()).toEqual(WORKFLOW_KEYS);
  const sampleKeys = WORKFLOW_KEYS.filter((key) => !["completion", "requires", "stage", "values", "routes", "options", "artifact", "from_stage", "name", "outputs", "produces"].includes(key));
  expect(yamlKeys(text)).toEqual([...sampleKeys, "approved", "client", "draft", "draft-notes", "effort", "fixes", "plan", "required", "revise", "type"].sort());
});

function parserKeys(source: string, kind: "config" | "workflow"): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(/Object\.hasOwn\(\w+, "([^"]+)"\)/g)) keys.add(match[1] ?? "");
  if (kind === "config") {
    for (const match of source.matchAll(/\bconfig\.(agents|roles)\b/g)) keys.add(match[1] ?? "");
    for (const match of source.matchAll(/\bagentConfig\.(provider|model|client)\b/g)) keys.add(match[1] ?? "");
    for (const match of source.matchAll(/\bclientConfig\.(type|options)\b/g)) keys.add(match[1] ?? "");
    for (const match of source.matchAll(/\brole\.(agent|description|responsibilities)\b/g)) keys.add(match[1] ?? "");
  } else {
    for (const match of source.matchAll(/(?:requiredString|stringItems|filename)\(\w+\.(\w+)/g)) keys.add(match[1] ?? "");
    for (const match of source.matchAll(/optionalStageString\(\w+, "([^"]+)"/g)) keys.add(match[1] ?? "");
    for (const match of source.matchAll(/\bdata\.(stages|completion|requires|outputs|concurrency)\b/g)) keys.add(match[1] ?? "");
    for (const match of source.matchAll(/\bdecision\.(values|routes)\b/g)) keys.add(match[1] ?? "");
    if (source.includes("body.navigate")) keys.add("navigate");
    if (source.includes("entry.artifacts")) keys.add("artifacts");
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
