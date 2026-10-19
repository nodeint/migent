import { expect, test } from "vitest";
import {
  ConfigEditError,
  assignRoles,
  inspectConfig,
  loadRoleInstructions,
  loadYamlMapping,
  patchConfigText,
  placeRoleModel,
  setRoleOptions,
  upsertModel,
  type StageSpec,
  type WorkflowDocument,
} from "../src/index.ts";
import { writeConfig } from "./support.ts";

const SHARED = `\
# project models
models:
  shared:
    provider: grok
    model: grok-4.6
    options:
      reasoning-effort: medium
      temperature: "0.2"  # stable
  other:
    provider: codex
    model: gpt-5
roles:
  developer:
    default_model: shared
  planner:
    default_model: shared
  reviewer:
    default_model: shared
    options:
      reasoning-effort: low
`;

function stage(input: {
  id: string;
  role: string;
  modelName?: string | null;
  options?: Record<string, string>;
}): StageSpec {
  return {
    id: input.id,
    role: input.role,
    artifact: null,
    decisionValues: [],
    dependsOn: [],
    resumeFrom: null,
    instructions: [],
    modelName: input.modelName ?? null,
    options: input.options ?? {},
    maxRevisions: null,
    verify: [],
    maxVerify: 3,
    verifyTimeoutSec: null,
    routes: {},
  };
}

function workflow(): WorkflowDocument {
  return {
    id: "plan",
    stages: {
      implement: stage({ id: "implement", role: "developer" }),
      review: stage({ id: "review", role: "reviewer", modelName: "other" }),
      audit: stage({
        id: "audit",
        role: "reviewer",
        modelName: "shared",
        options: { "reasoning-effort": "high" },
      }),
      "plain-review": stage({ id: "plain-review", role: "reviewer" }),
    },
    completion: null,
    requires: null,
    constraints: [],
    source: null,
  };
}

function config(text: string = SHARED): Record<string, unknown> {
  return loadYamlMapping(writeConfig(text));
}

function mapping(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a mapping");
  }
  return value as Record<string, unknown>;
}

test("assign role keeps the shared model", () => {
  const change = assignRoles(config(), ["reviewer"], "other", { workflows: [workflow()] });
  const models = mapping(change.config.models);
  const roles = mapping(change.config.roles);
  const reviewer = mapping(roles.reviewer);
  expect(change.roles).toEqual(["reviewer"]);
  expect(mapping(models.shared).model).toBe("grok-4.6");
  expect(mapping(roles.developer).default_model).toBe("shared");
  expect(mapping(roles.planner).default_model).toBe("shared");
  expect(reviewer.default_model).toBe("other");
  expect(mapping(reviewer.options)["reasoning-effort"]).toBe("low");
  expect(change.stagesUpdated).toEqual([["plan", "plain-review"]]);
  expect(change.stagesUnchanged[0]?.stage).toBe("review");
  expect(change.stagesUnchanged[0]?.ignores).toEqual(["role-model"]);
  expect(change.stagesUnchanged.map((item) => item.stage)).toContain("audit");
});

test("place role model creates a private entry", () => {
  const change = placeRoleModel(config(), "reviewer", {
    provider: "grok",
    model: "grok-4.7",
    options: { "reasoning-effort": "high" },
    workflows: [workflow()],
  });
  const models = mapping(change.config.models);
  const roles = mapping(change.config.roles);
  const created = mapping(models.reviewer);
  expect(change.createdModel).toBe("reviewer");
  expect(change.reusedModel).toBeNull();
  expect(mapping(models.shared).model).toBe("grok-4.6");
  expect(created.model).toBe("grok-4.7");
  expect(created).not.toHaveProperty("options");
  expect(mapping(roles.reviewer).default_model).toBe("reviewer");
  expect(mapping(mapping(roles.reviewer).options)["reasoning-effort"]).toBe("high");
  expect(mapping(roles.developer).default_model).toBe("shared");
  expect(change.orphanedModels).toEqual([]);
});

test("place role model reuses an identical entry", () => {
  const text = `\
models:
  plain:
    provider: grok
    model: grok-4.7
  shared:
    provider: grok
    model: grok-4.6
    options:
      reasoning-effort: medium
roles:
  developer:
    default_model: shared
  reviewer:
    default_model: shared
`;
  const change = placeRoleModel(config(text), "reviewer", { provider: "grok", model: "grok-4.7" });
  const models = mapping(change.config.models);
  expect(change.reusedModel).toBe("plain");
  expect(change.createdModel).toBeNull();
  expect(mapping(mapping(change.config.roles).reviewer).default_model).toBe("plain");
  expect(Object.keys(models).sort()).toEqual(["plain", "shared"]);
});

test("upsert option preserves other options", () => {
  const change = upsertModel(config(), "shared", {
    options: { "reasoning-effort": "high" },
    workflows: [workflow()],
  });
  const options = mapping(mapping(mapping(change.config.models).shared).options);
  expect(options["reasoning-effort"]).toBe("high");
  expect(options.temperature).toBe("0.2");
  expect(change.updatedModel).toBe("shared");
  expect(change.roles).toEqual(["developer", "planner"]);
  expect(change.stagesUpdated).toContainEqual(["plan", "implement"]);
  const shielded = Object.fromEntries(change.stagesUnchanged.map((item) => [item.stage, item.ignores]));
  expect(shielded.audit).toEqual(["role-options"]);
});

test("clear option removes only that option", () => {
  const change = upsertModel(config(), "shared", { options: { "reasoning-effort": null } });
  expect(mapping(mapping(mapping(change.config.models).shared).options)).toEqual({ temperature: "0.2" });
});

test("stage following a model name tracks that model", () => {
  const change = upsertModel(config(), "shared", {
    provider: "grok",
    model: "grok-4.7",
    workflows: [workflow()],
  });
  expect(change.stagesUpdated).toContainEqual(["plan", "audit"]);
  expect(change.stagesUpdated).not.toContainEqual(["plan", "review"]);
});

test("orphan model is reported and kept", () => {
  const text = `\
models:
  shared:
    provider: grok
    model: grok-4.6
  review:
    provider: codex
    model: gpt-5
roles:
  developer:
    default_model: shared
  reviewer:
    default_model: review
`;
  const change = assignRoles(config(text), ["reviewer"], "shared");
  expect(change.orphanedModels).toEqual(["review"]);
  expect(mapping(change.config.models)).toHaveProperty("review");
});

test("patch keeps role instructions when the model changes", () => {
  const text = SHARED.replace(
    "  developer:\n    default_model: shared\n",
    "  developer:\n    default_model: shared\n    instructions:\n      - Write production code.\n",
  );
  const change = assignRoles(config(text), ["developer"], "other");
  const patched = patchConfigText(text, change.config);
  const parsed = loadYamlMapping(writeConfig(patched));
  expect(loadRoleInstructions(parsed, "developer")).toEqual(["Write production code."]);
  expect(mapping(mapping(parsed.roles).developer).default_model).toBe("other");
  const view = inspectConfig(parsed);
  expect(view.roles.find((role) => role.role === "developer")?.instructions).toEqual([
    "Write production code.",
  ]);
});

test("patch preserves comments and sibling options", () => {
  const change = assignRoles(config(), ["reviewer"], "other");
  const patched = patchConfigText(SHARED, change.config);
  expect(patched).toContain("# project models");
  expect(patched).toContain('temperature: "0.2"  # stable');
  const parsed = loadYamlMapping(writeConfig(patched));
  const roles = mapping(parsed.roles);
  expect(mapping(roles.developer).default_model).toBe("shared");
  expect(mapping(roles.reviewer).default_model).toBe("other");
  expect(mapping(mapping(roles.reviewer).options)["reasoning-effort"]).toBe("low");
  expect(mapping(mapping(mapping(parsed.models).shared).options).temperature).toBe("0.2");
});

test("patch adds a model and a role", () => {
  const created = upsertModel(config(), "fast", {
    provider: "codex",
    model: "gpt-5",
    options: { "reasoning-effort": "low" },
  });
  const assigned = assignRoles(created.config, ["security"], "fast");
  const patched = patchConfigText(SHARED, assigned.config);
  const parsed = loadYamlMapping(writeConfig(patched));
  const models = mapping(parsed.models);
  const roles = mapping(parsed.roles);
  expect(mapping(models.fast).provider).toBe("codex");
  expect(mapping(mapping(models.fast).options)["reasoning-effort"]).toBe("low");
  expect(mapping(roles.security).default_model).toBe("fast");
  expect(patched).toContain("# project models");
  expect(mapping(roles.developer).default_model).toBe("shared");
});

test("rejects a partial provider update", () => {
  expect(() => upsertModel(config(), "shared", { provider: "grok" })).toThrow(ConfigEditError);
  expect(() => upsertModel(config(), "shared", { provider: "grok" })).toThrow(
    /both --provider and --model/,
  );
});

test("role option does not change the model", () => {
  const change = setRoleOptions(config(), "developer", { "reasoning-effort": "high" }, {
    workflows: [workflow()],
  });
  expect(change.roles).toEqual(["developer"]);
  expect(mapping(mapping(mapping(change.config.models).shared).options)["reasoning-effort"]).toBe("medium");
  expect(mapping(mapping(mapping(change.config.roles).developer).options)["reasoning-effort"]).toBe("high");
  expect(change.stagesUpdated).toContainEqual(["plan", "implement"]);
});

test("new role points at an existing model", () => {
  const change = assignRoles(config(), ["security", "planner"], "other");
  const roles = mapping(change.config.roles);
  expect(mapping(roles.security).default_model).toBe("other");
  expect(mapping(roles.planner).default_model).toBe("other");
  expect(mapping(change.config.models)).not.toHaveProperty("security");
});

test("inspect shows the model name and stage override", () => {
  const view = inspectConfig(config(), [workflow()]);
  const reviewer = view.roles.find((role) => role.role === "reviewer");
  expect(reviewer).toBeDefined();
  expect(reviewer?.modelName).toBe("shared");
  expect(reviewer?.options["reasoning-effort"]).toBe("low");
  expect(reviewer?.sharedWith).toEqual(["developer", "planner"]);
  const overrides = Object.fromEntries(
    (reviewer?.stages ?? []).map((item) => [item.stage, [item.modelName, item.options]]),
  );
  expect(overrides.review).toEqual(["other", {}]);
  expect(overrides.audit).toEqual(["shared", { "reasoning-effort": "high" }]);
  expect(overrides["plain-review"]).toEqual([null, {}]);
});
