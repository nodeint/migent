import { expect, test } from "vitest";
import { CodexAdapter, GrokAdapter } from "@nodeint/migent-adapters";
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
  expect(notes[0]).toBe("schema_version -> 2");
  expect(grok.models).toEqual(["grok-4.6"]);
  expect(codex.models).toEqual(["gpt-5.6-terra"]);
  expect(grok.roles).toEqual(["grok"]);
  expect(codex.roles).toEqual(["gpt-terra"]);
  expect(config.schema_version).toBe(2);
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
  const config = { schema_version: "2", models: {}, roles: {} };
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
  expect(notes).toEqual(["schema_version -> 2"]);
  expect(mapping(mapping(mapping(config.models).custom).options).thinking).toBe("medium");
  expect(config.schema_version).toBe(2);
});

test("newer version is rejected", () => {
  expect(() => migrateConfig({ schema_version: 3 }, {})).toThrow(
    new ConfigurationError("config schema_version 3 is newer than this Migent (2)."),
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
  expect(parsed.schema_version).toBe(2);
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
  expect(rewritten).toContain("schema_version: 2");
  expect(document.schemaVersion).toBe(2);
  expect(document.completion).toBeNull();
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

const PLAN_V1 = `schema_version: 1
id: plan
constraints:
  - Do not write implementation code.
  - Do not edit repository files. Write only the stage artifact.
  - Only the decision header routes this workflow. Review prose is feedback, not a route.
stages:
  - id: plan
    role: planner
    depends_on: []
    max_revisions: 3
    instructions:
      - Read task.md and the code it depends on, then write plan.md in this execution's artifacts directory.
      - Write the plan in English. Include scope and paths, current behavior with path:line evidence, decisions the task already fixed, ordered tasks, tests to add or run, and what is out of scope.
      - Each task names the file to change and the behavior to add or keep. Do not mark a task done unless it is already merged.
      - When a review routes back, start from the previous plan.md and write the updated file in this execution's artifacts directory. Address every review point and keep the sections the review did not reject.
    produces:
      artifact: plan.md
  - id: review-plan
    role: reviewer
    depends_on:
      - plan
    options:
      reasoning-effort: high
    instructions:
      - Read plan.md and open the code behind each path:line claim.
      - Check correctness, missing risks, unnecessary scope, and any step an implementer would have to guess.
      - Approve only when the plan can be implemented as written. Otherwise decide revise and list each required edit once.
    decision:
      values:
        - approved
        - revise
      routes:
        approved: complete
        revise: plan
completion:
  stage: review-plan
  decision: approved
  outputs:
    - name: plan
      from_stage: plan
      artifact: plan.md
`;
const IMPLEMENT_V1 = `schema_version: 1
id: implement
requires:
  workflow: plan
  decision: approved
constraints:
  - Implement the approved plan. Do not redesign it.
  - Do not commit or push.
  - Do not edit files the plan does not name.
stages:
  - id: implement
    role: developer
    depends_on: []
    max_revisions: 3
    instructions:
      - Read task.md and the prior session output named plan, then implement that plan.
      - If the plan and the code disagree, stop and name the disagreement. Do not invent a design.
      - Run the tests the plan names. Fix failures your change caused before you report complete.
      - Write implementation.md in English. Record what changed, which tests ran and their results, and any deviation with its reason.
    produces:
      artifact: implementation.md
  - id: review-work
    role: reviewer
    depends_on:
      - implement
    instructions:
      - Read the prior plan, implementation.md, and the diff.
      - Check for missing plan items, extra scope, and tests that skip a case the plan requires.
      - Approve only when the code matches the plan and the named tests passed. Otherwise decide revise and list the files and changes still required.
    decision:
      values:
        - approved
        - revise
      routes:
        approved: complete
        revise: implement
completion:
  stage: review-work
  decision: approved
  outputs:
    - name: implementation
      from_stage: implement
      artifact: implementation.md
`;
const CONFIG_V1 = `schema_version: 1
models:
  opus:
    provider: claude
    model: opus

  grok:
    provider: grok
    model: grok-4.7
    options:
      reasoning-effort: high

  sonnet:
    provider: claude
    model: sonnet

roles:
  planner:
    default_model: opus
    instructions:
      - Read the task and the code it depends on before you write. Cite path:line for every claim about current behavior, and mark anything you did not check as "(verify)".
      - Stay inside the task. Do not add scope, product ideas, or refactors the task did not ask for.
      - Do not edit the repository and do not write implementation code. When a stage asks for an artifact, that file is the only one you write.
      - Leave a result another agent can carry out. Name the files, the behavior change, the tests, and what is out of scope. Do not leave a decision for the implementer to invent.
  reviewer:
    default_model: grok
    instructions:
      - Check the work against the code and the task. Cite path:line for each finding. Do not approve a claim you did not open.
      - Report every gap of the same kind in one response. For each problem, name the evidence and the concrete change required.
      - Do not edit the repository unless the task tells you to. Do not rewrite the document or the diff you are reviewing.
      - Approve only when the work matches the task and the next agent can carry it out without guessing. A missing test, an unchecked claim, or extra scope is revise.
  developer:
    default_model: sonnet
    instructions:
      - Implement only what the task or the approved plan asks. Do not redesign it. If the plan and the code disagree, stop and name the disagreement.
      - Change only the files that work names. Match the style of the code around the edit.
      - Follow CONTRIBUTING.md. Never call a real provider CLI from a test, use a fresh temporary directory per test, import workspace packages by name, and do not add native dependencies.
      - Do not commit or push. Run the tests that work names and fix failures your change caused before you report complete.
`;

test("repo plan and implement workflows migrate to version 2", () => {
  const planBefore = loadWorkflowDocument(writeConfig(PLAN_V1));
  const planParsed = mapping(parseYamlDocument(PLAN_V1));
  const planNotes = migrateWorkflow(planParsed, { models: {}, roles: {} });
  expect(planNotes).toContain("schema_version -> 2");
  expect(planNotes).toContain("completion removed");
  expect(planNotes).toContain("completion.outputs -> outputs");
  const planText = patchWorkflowText(PLAN_V1, planParsed);
  const planAfter = loadWorkflowDocument(writeConfig(planText));
  expect(planAfter.schemaVersion).toBe(2);
  expect(planAfter.completion).toBeNull();
  expect(planAfter.concurrency).toBe(1);
  expect(planAfter.requires).toBeNull();
  expect(planAfter.outputs).toEqual([{ name: "plan", fromStage: "plan", artifact: "plan.md" }]);
  expect(planAfter.stages.plan?.instructions).toEqual(planBefore.stages.plan?.instructions);
  expect(planAfter.stages["review-plan"]?.instructions).toEqual(planBefore.stages["review-plan"]?.instructions);
  expect(planAfter.stages["review-plan"]?.options).toEqual({ "reasoning-effort": "high" });

  const implementBefore = loadWorkflowDocument(writeConfig(IMPLEMENT_V1));
  const implementParsed = mapping(parseYamlDocument(IMPLEMENT_V1));
  const implementNotes = migrateWorkflow(implementParsed, { models: {}, roles: {} });
  expect(implementNotes).toContain("requires.decision removed");
  expect(implementNotes).toContain("completion.outputs -> outputs");
  const implementText = patchWorkflowText(IMPLEMENT_V1, implementParsed);
  const implementAfter = loadWorkflowDocument(writeConfig(implementText));
  expect(implementAfter.schemaVersion).toBe(2);
  expect(implementAfter.completion).toBeNull();
  expect(implementAfter.requires).toEqual({ workflow: "plan", decision: null });
  expect(implementAfter.outputs).toEqual([
    { name: "implementation", fromStage: "implement", artifact: "implementation.md" },
  ]);
  expect(implementAfter.stages.implement?.instructions).toEqual(implementBefore.stages.implement?.instructions);
  expect(implementAfter.stages["review-work"]?.instructions).toEqual(
    implementBefore.stages["review-work"]?.instructions,
  );
});

test("config version 2 changes nothing but the version", () => {
  const parsed = loadYamlMapping(writeConfig(CONFIG_V1));
  const notes = migrateConfig(parsed, {});
  expect(notes).toEqual(["schema_version -> 2"]);
  expect(patchConfigText(CONFIG_V1, parsed)).toBe(CONFIG_V1.replace("schema_version: 1\n", "schema_version: 2\n"));
});

test("a route to complete from another stage or decision is refused", () => {
  const otherStage = `\
schema_version: 1
id: bad
stages:
  - id: draft
    role: writer
    depends_on: []
    decision:
      values:
        - go
      routes:
        go: complete
completion:
  stage: review
`;
  expect(() => migrateWorkflow(mapping(parseYamlDocument(otherStage)), { models: {}, roles: {} })).toThrow(
    new ConfigurationError(
      "stages.draft.decision.routes.go routes to complete, but completion.stage is review.",
    ),
  );
  const otherDecision = `\
schema_version: 1
id: bad
stages:
  - id: review
    role: reviewer
    depends_on: []
    decision:
      values:
        - approved
        - revise
      routes:
        approved: stay
        revise: complete
  - id: stay
    role: reviewer
    depends_on: []
completion:
  stage: review
  decision: approved
`;
  expect(() => migrateWorkflow(mapping(parseYamlDocument(otherDecision)), { models: {}, roles: {} })).toThrow(
    new ConfigurationError(
      "stages.review.decision.routes.revise routes to complete, but completion.decision is approved.",
    ),
  );
});
