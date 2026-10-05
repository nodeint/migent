import { expect, test } from "vitest";
import { CodexAdapter, GrokAdapter } from "@migent/adapters";
import {
  ConfigurationError,
  SCHEMA_VERSION,
  documentVersion,
  loadWorkflowDocument,
  loadYamlMapping,
  migrateConfig,
  migrateWorkflow,
  patchConfigText,
  patchWorkflowText,
} from "../src/index.ts";
import { parseYamlDocument } from "../src/yaml.ts";
import { writeConfig } from "./support.ts";

const LEGACY = `\
# project
project: "Local Multi-Model Agent System"
version: "1.0"

models:
  grok:
    provider: grok
    model: grok-4.6
    options:
      thinking: medium
  gpt-terra:
    provider: codex
    model: gpt-5.6-terra
    options:
      thinking: medium
      temperature: "0.2"

roles:
  planner:
    role: "System Architect & Planner"
    description: "Break the task down."
    default_model: grok
    thinking: high
  reviewer:
    role: "Reviewer"
    default_model: gpt-terra
`;

const WORKFLOW = `\
# review flow
id: plan
stages:
  - id: plan
    role: planner
    depends_on: []
    instructions:
      - Keep the word thinking in the prose.
    thinking: high
  - id: review
    role: reviewer
    model: gpt-terra
    depends_on:
      - plan
    options:
      thinking: low
completion:
  stage: review
`;

class StepAdapter {
  readonly models: string[] = [];
  readonly roles: string[] = [];
  readonly stages: string[] = [];
  readonly modelMigrations = {
    0: (body: Record<string, unknown>) => {
      this.models.push(body.model as string);
    },
  };
  readonly roleMigrations = {
    0: (body: Record<string, unknown>) => {
      this.roles.push(body.default_model as string);
    },
  };
  readonly stageMigrations = {
    0: (body: Record<string, unknown>) => {
      this.stages.push(body.id as string);
    },
  };
}

class ChainAdapter {
  readonly trace: Array<[string, number]> = [];
  readonly modelMigrations: Record<number, (body: Record<string, unknown>) => void>;
  readonly roleMigrations: Record<number, (body: Record<string, unknown>) => void>;
  readonly stageMigrations: Record<number, (body: Record<string, unknown>) => void>;

  constructor() {
    const mark = (kind: string, version: number) => () => {
      this.trace.push([kind, version]);
    };
    this.modelMigrations = {
      0: mark("model", 0),
      1: mark("model", 1),
      2: mark("model", 2),
    };
    this.roleMigrations = {
      0: mark("role", 0),
      1: mark("role", 1),
      2: mark("role", 2),
    };
    this.stageMigrations = {
      0: mark("stage", 0),
      1: mark("stage", 1),
      2: mark("stage", 2),
    };
  }
}

function adapters(): { grok: GrokAdapter; codex: CodexAdapter } {
  return { grok: new GrokAdapter(), codex: new CodexAdapter() };
}

function mapping(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a mapping");
  }
  return value as Record<string, unknown>;
}

test("version steps follow each model's provider", () => {
  const config = loadYamlMapping(writeConfig(LEGACY));
  const grok = new StepAdapter();
  const codex = new StepAdapter();
  const notes = migrateConfig(config, { grok, codex });
  expect(notes[0]).toBe("schema_version -> 1");
  expect(grok.models).toEqual(["grok-4.6"]);
  expect(codex.models).toEqual(["gpt-5.6-terra"]);
  expect(grok.roles).toEqual(["grok"]);
  expect(codex.roles).toEqual(["gpt-terra"]);
  expect(config.schema_version).toBe(1);
  const workflow = {
    id: "plan",
    stages: [
      { id: "plan", role: "planner" },
      { id: "review", role: "reviewer", model: "gpt-terra" },
    ],
  };
  migrateWorkflow(workflow, config, { grok, codex });
  expect(grok.stages).toEqual(["plan"]);
  expect(codex.stages).toEqual(["review"]);
});

test("current version is left alone", () => {
  const config = { schema_version: "1", models: {}, roles: {} };
  const grok = new StepAdapter();
  expect(migrateConfig(config, { grok })).toEqual([]);
  expect(grok.models).toEqual([]);
  expect(documentVersion(config)).toBe(SCHEMA_VERSION);
});

test("an unknown provider is skipped and the version still advances", () => {
  const config = {
    models: { custom: { provider: "other", model: "x", options: { thinking: "medium" } } },
    roles: {},
  };
  const notes = migrateConfig(config, {});
  expect(notes).toEqual(["schema_version -> 1"]);
  expect(mapping(mapping(mapping(config.models).custom).options).thinking).toBe("medium");
  expect(config.schema_version).toBe(1);
});

test("newer version is rejected", () => {
  expect(() => migrateConfig({ schema_version: 2 }, {})).toThrow(
    new ConfigurationError("config schema_version 2 is newer than this Migent (1)."),
  );
});

test("thinking moves to the provider option and keeps the file", () => {
  const config = loadYamlMapping(writeConfig(LEGACY));
  const notes = migrateConfig(config, adapters());
  expect(notes).toContain("models.grok.options.thinking -> reasoning-effort");
  expect(notes).toContain("models.gpt-terra.options.thinking -> model_reasoning_effort");
  expect(notes).toContain("roles.planner.thinking -> options.reasoning-effort");
  expect(mapping(mapping(config.models).grok).options).toEqual({ "reasoning-effort": "medium" });
  expect(mapping(mapping(config.models)["gpt-terra"]).options).toEqual({
    model_reasoning_effort: "medium",
    temperature: "0.2",
  });
  const planner = mapping(mapping(config.roles).planner);
  expect(planner.options).toEqual({ "reasoning-effort": "high" });
  expect(planner).not.toHaveProperty("thinking");
  expect(planner.description).toBe("Break the task down.");
  const rewritten = patchConfigText(LEGACY, config);
  const parsed = loadYamlMapping(writeConfig(rewritten));
  expect(parsed.version).toBe("1.0");
  expect(parsed.schema_version).toBe(1);
  expect(mapping(mapping(mapping(parsed.models).grok).options)["reasoning-effort"]).toBe("medium");
  expect(rewritten).not.toContain("thinking");
  expect(rewritten).toContain("# project");
  expect(rewritten).toContain('role: "System Architect & Planner"');
});

test("workflow stage keeps instructions and records its version", () => {
  const config = loadYamlMapping(writeConfig(LEGACY));
  migrateConfig(config, adapters());
  const parsed = mapping(parseYamlDocument(WORKFLOW));
  const notes = migrateWorkflow(parsed, config, adapters());
  expect(notes).toContain("stages.plan.thinking -> options.reasoning-effort");
  expect(notes).toContain("stages.review.options.thinking -> model_reasoning_effort");
  const rewritten = patchWorkflowText(WORKFLOW, parsed);
  expect(rewritten).toContain("Keep the word thinking in the prose.");
  expect(rewritten).toContain("# review flow");
  const document = loadWorkflowDocument(writeConfig(rewritten));
  expect(document.stages.plan?.options).toEqual({ "reasoning-effort": "high" });
  expect(document.stages.review?.options).toEqual({ model_reasoning_effort: "low" });
  expect(rewritten).toContain("schema_version: 1");
});

test("an upgrade runs each version and skips versions already passed", () => {
  const adapter = new ChainAdapter();
  const config = {
    schema_version: 1,
    models: { m: { provider: "grok", model: "x" } },
    roles: { dev: { default_model: "m" } },
  };
  migrateConfig(config, { grok: adapter }, 3);
  expect(adapter.trace.filter((item) => item[0] === "model")).toEqual([
    ["model", 1],
    ["model", 2],
  ]);
  expect(adapter.trace.filter((item) => item[0] === "role")).toEqual([
    ["role", 1],
    ["role", 2],
  ]);
  expect(config.schema_version).toBe(3);
  const workflow = { schema_version: 1, stages: [{ id: "plan", role: "dev" }] };
  migrateWorkflow(workflow, config, { grok: adapter }, 3);
  expect(adapter.trace.filter((item) => item[0] === "stage")).toEqual([
    ["stage", 1],
    ["stage", 2],
  ]);
  expect(workflow.schema_version).toBe(3);
});

test("an existing option wins over thinking", () => {
  const body: Record<string, unknown> = {
    options: { thinking: "medium", "reasoning-effort": "low" },
    thinking: "high",
  };
  const step = new GrokAdapter().modelMigrations[0];
  if (step === undefined) throw new Error("missing grok model migration 0");
  step(body);
  expect(body).toEqual({ options: { "reasoning-effort": "low" } });
});
