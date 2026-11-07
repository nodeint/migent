import { expect, test } from "vitest";
import {
  ConfigEditError,
  assignRoles,
  inspectConfig,
  loadRoleResponsibilities,
  loadYamlMapping,
  patchConfigText,
  placeRoleAgent,
  upsertAgent,
  type RoleStageSpec,
  type WorkflowDocument,
} from "../src/index.ts";
import { writeConfig } from "./support.ts";

const SHARED = `\
# project models
agents:
  shared:
    client:
      type: grok
      options:
        reasoning-effort: medium
        temperature: "0.2"  # stable
    model: grok-4.6
  other:
    client:
      type: codex
    model: gpt-5
roles:
  developer:
    agent: shared
  planner:
    agent: shared
  reviewer:
    agent: shared
`;

function stage(input: {
  id: string;
  role: string;
  modelName?: string | null;
  options?: Record<string, string>;
}): RoleStageSpec {
  return {
    kind: "role",
    description: null,
    id: input.id,
    role: input.role,
    artifacts: [],
    decisionArtifacts: {},
    decisionValues: [],
    dependsOn: [],
    resumeFrom: null,
    instructions: [],
    agent: input.modelName === undefined || input.modelName === null ? null : { kind: "named" as const, name: input.modelName },
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
  const models = mapping(change.config.agents);
  const roles = mapping(change.config.roles);
  const reviewer = mapping(roles.reviewer);
  expect(change.roles).toEqual(["reviewer"]);
  expect(mapping(models.shared).model).toBe("grok-4.6");
  expect(mapping(roles.developer).agent).toBe("shared");
  expect(mapping(roles.planner).agent).toBe("shared");
  expect(reviewer.agent).toBe("other");
  expect(reviewer).not.toHaveProperty("options");
  expect(change.stagesUpdated).toEqual([["plan", "plain-review"]]);
  expect(change.stagesUnchanged[0]?.stage).toBe("review");
  expect(change.stagesUnchanged[0]?.ignores).toEqual(["role-agent"]);
  expect(change.stagesUnchanged.map((item) => item.stage)).toContain("audit");
});

test("place role model creates a private entry", () => {
  const change = placeRoleAgent(config(), "reviewer", {
    client: "grok",
    model: "grok-4.7",
    options: { "reasoning-effort": "high" },
    workflows: [workflow()],
  });
  const models = mapping(change.config.agents);
  const roles = mapping(change.config.roles);
  const created = mapping(models.reviewer);
  expect(change.createdAgent).toBe("reviewer");
  expect(change.reusedAgent).toBeNull();
  expect(mapping(models.shared).model).toBe("grok-4.6");
  expect(created.model).toBe("grok-4.7");
  expect(mapping(roles.reviewer)).not.toHaveProperty("options");
  expect(mapping(roles.reviewer).agent).toBe("reviewer");
  expect(mapping(mapping(created.client).options)["reasoning-effort"]).toBe("high");
  expect(mapping(roles.developer).agent).toBe("shared");
  expect(change.orphanedAgents).toEqual([]);
});

test("place role model reuses an identical entry", () => {
  const text = `\
agents:
  plain:
    client:
      type: grok
    model: grok-4.7
  shared:
    client:
      type: grok
      options:
        reasoning-effort: medium
    model: grok-4.6
roles:
  developer:
    agent: shared
  reviewer:
    agent: shared
`;
  const change = placeRoleAgent(config(text), "reviewer", { client: "grok", model: "grok-4.7" });
  const models = mapping(change.config.agents);
  expect(change.reusedAgent).toBe("plain");
  expect(change.createdAgent).toBeNull();
  expect(mapping(mapping(change.config.roles).reviewer).agent).toBe("plain");
  expect(Object.keys(models).sort()).toEqual(["plain", "shared"]);
});

test("upsert option preserves other options", () => {
  const change = upsertAgent(config(), "shared", {
    options: { "reasoning-effort": "high" },
    workflows: [workflow()],
  });
  const options = mapping(mapping(mapping(mapping(change.config.agents).shared).client).options);
  expect(options["reasoning-effort"]).toBe("high");
  expect(options.temperature).toBe("0.2");
  expect(change.updatedAgent).toBe("shared");
  expect(change.roles).toEqual(["developer", "planner", "reviewer"]);
  expect(change.stagesUpdated).toContainEqual(["plan", "implement"]);
  const shielded = Object.fromEntries(change.stagesUnchanged.map((item) => [item.stage, item.ignores]));
  expect(shielded.audit).toEqual(["role-options"]);
});

test("clear option removes only that option", () => {
  const change = upsertAgent(config(), "shared", { options: { "reasoning-effort": null } });
  expect(mapping(mapping(mapping(mapping(change.config.agents).shared).client).options)).toEqual({ temperature: "0.2" });
});

test("stage following a model name tracks that model", () => {
  const change = upsertAgent(config(), "shared", {
    client: "grok",
    model: "grok-4.7",
    workflows: [workflow()],
  });
  expect(change.stagesUpdated).toContainEqual(["plan", "audit"]);
  expect(change.stagesUpdated).not.toContainEqual(["plan", "review"]);
});

test("orphan model is reported and kept", () => {
  const text = `\
agents:
  shared:
    client:
      type: grok
    model: grok-4.6
  review:
    client:
      type: codex
    model: gpt-5
roles:
  developer:
    agent: shared
  reviewer:
    agent: review
`;
  const change = assignRoles(config(text), ["reviewer"], "shared");
  expect(change.orphanedAgents).toEqual(["review"]);
  expect(mapping(change.config.agents)).toHaveProperty("review");
});

test("patch keeps role instructions when the model changes", () => {
  const text = SHARED.replace(
    "  developer:\n    agent: shared\n",
    "  developer:\n    agent: shared\n    instructions:\n      - Write production code.\n",
  );
  const change = assignRoles(config(text), ["developer"], "other");
  const patched = patchConfigText(text, change.config);
  const parsed = loadYamlMapping(writeConfig(patched));
  expect(loadRoleResponsibilities(parsed, "developer")).toEqual(["Write production code."]);
  expect(mapping(mapping(parsed.roles).developer).agent).toBe("other");
  const view = inspectConfig(parsed);
  expect(view.roles.find((role) => role.role === "developer")?.responsibilities).toEqual([
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
  expect(mapping(roles.developer).agent).toBe("shared");
  expect(mapping(roles.reviewer).agent).toBe("other");
  expect(mapping(roles.reviewer)).not.toHaveProperty("options");
  expect(mapping(mapping(mapping(mapping(parsed.agents).shared).client).options).temperature).toBe("0.2");
});

test("patch adds a model and a role", () => {
  const created = upsertAgent(config(), "fast", {
    client: "codex",
    model: "gpt-5",
    options: { "reasoning-effort": "low" },
  });
  const assigned = assignRoles(created.config, ["security"], "fast");
  const patched = patchConfigText(SHARED, assigned.config);
  const parsed = loadYamlMapping(writeConfig(patched));
  const models = mapping(parsed.agents);
  const roles = mapping(parsed.roles);
  expect(mapping(mapping(models.fast).client).type).toBe("codex");
  expect(mapping(mapping(mapping(models.fast).client).options)["reasoning-effort"]).toBe("low");
  expect(mapping(roles.security).agent).toBe("fast");
  expect(patched).toContain("# project models");
  expect(mapping(roles.developer).agent).toBe("shared");
});

test("rejects a partial client update", () => {
  expect(() => upsertAgent(config(), "shared", { client: "grok" })).toThrow(ConfigEditError);
  expect(() => upsertAgent(config(), "shared", { client: "grok" })).toThrow(
    /both --client and --model/,
  );
});

test("new role points at an existing model", () => {
  const change = assignRoles(config(), ["security", "planner"], "other");
  const roles = mapping(change.config.roles);
  expect(mapping(roles.security).agent).toBe("other");
  expect(mapping(roles.planner).agent).toBe("other");
  expect(mapping(change.config.agents)).not.toHaveProperty("security");
});

test("inspect shows the model name and stage override", () => {
  const view = inspectConfig(config(), [workflow()]);
  const reviewer = view.roles.find((role) => role.role === "reviewer");
  expect(reviewer).toBeDefined();
  expect(reviewer?.agentName).toBe("shared");
  expect(reviewer?.options["reasoning-effort"]).toBe("medium");
  expect(reviewer?.sharedWith).toEqual(["developer", "planner"]);
  const overrides = Object.fromEntries(
    (reviewer?.stages ?? []).map((item) => [item.stage, [item.agent, item.options]]),
  );
  expect(overrides.review).toEqual(["other", {}]);
  expect(overrides.audit).toEqual(["shared", { "reasoning-effort": "high" }]);
  expect(overrides["plain-review"]).toEqual([null, {}]);
});
