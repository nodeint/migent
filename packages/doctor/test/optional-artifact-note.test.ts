import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { mergeConfigLayers } from "@nodeint/migent-kernel";
import { createPreparedSession, selectSessionWorkflow } from "@nodeint/migent-session";
import { diagnose, diagnoseSession, validateWorkflowDraft, type ConfigLoad } from "../src/index.ts";
import { defaultClients, STAGE_CONFIG, tempDir, whichFound } from "./support.ts";

const WORKFLOW = {
  schema_version: 7,
  id: "notes",
  artifacts: {
    main: { file: "main.md" },
    extra: { file: "extra.md", required: false },
  },
  stages: [
    { id: "write", role: "developer", artifacts: ["main"] },
    {
      id: "review",
      role: "reviewer",
      depends_on: ["write"],
      decision: [
        { approved: { navigate: "complete", artifacts: ["extra"] } },
        { revise: { navigate: "write" } },
      ],
    },
  ],
  downstream: [{ workflow: "notes", task: "Again", artifacts: { context: "extra", required_one: "main" } }],
};

const TEXT = `schema_version: 7
id: notes
artifacts:
  main: { file: main.md }
  extra: { file: extra.md, required: false }
stages:
  - id: write
    role: developer
    artifacts: [main]
  - id: review
    role: reviewer
    depends_on: [write]
    decision:
      - approved:
          navigate: complete
          artifacts: [extra]
      - revise:
          navigate: write
downstream:
  - workflow: notes
    task: Again
    artifacts:
      context: extra
      required_one: main
`;

const NOTE = "downstream.artifacts.context maps to optional artifact extra; the target receives it only when it was produced.";

function workspaceWithNotes(): string {
  const workspace = tempDir("migent-optional-note-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), STAGE_CONFIG, "utf8");
  writeFileSync(path.join(workspace, ".migent", "workflows", "notes.yaml"), TEXT, "utf8");
  return workspace;
}

test("draft validation warns once at the mapping and still passes", () => {
  const project = { schema_version: 7, agents: { fast: { client: { type: "grok" }, model: "grok-4.6" } }, roles: { developer: { agent: "fast" }, reviewer: { agent: "fast" } } };
  const config: ConfigLoad = { ...mergeConfigLayers(project, null), layers: { project, local: null } };
  const out = validateWorkflowDraft({ draft: WORKFLOW, file: "notes.yaml", siblings: [], config }, defaultClients());
  const notes = out.filter((item) => item.code === "downstream-optional-artifact");
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ severity: "warning", path: ["downstream", 0, "artifacts", "context"], message: NOTE });
  expect(out.some((item) => item.severity === "error")).toBe(false);
});

test("project doctor reports the note as a warning on a passing workflows check", () => {
  const workspace = workspaceWithNotes();
  const [, workflows] = diagnose(workspace, { clients: defaultClients(), which: whichFound(new Set(["codex", "grok"])) });
  expect(workflows.ok).toBe(true);
  expect(workflows.warnings).toContain(`notes.yaml: ${NOTE}`);
  expect(workflows.warnings.filter((item) => item.includes("required_one"))).toEqual([]);
});

test("session doctor reports the same note for a prepared draft", () => {
  const workspace = workspaceWithNotes();
  const sessionId = createPreparedSession(workspace, "wave", "notes");
  const diagnosis = diagnoseSession(workspace, selectSessionWorkflow(workspace, sessionId), {
    clients: defaultClients(),
    which: whichFound(new Set(["codex", "grok"])),
  });
  const workflow = diagnosis.checks.find((item) => item.name === "workflow");
  expect(workflow?.warnings.some((item) => item.includes(NOTE))).toBe(true);
});
