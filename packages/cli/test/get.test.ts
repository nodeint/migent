import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { parse, stringify } from "yaml";
import { main } from "../src/index.ts";
import { capture } from "./support.ts";

const CONFIG = `\
schema_version: 6
agents:
  shared:
    client:
      type: grok
      options:
        max_turns: "4"
    model: grok-4.6
  plain:
    client:
      type: grok
    model: grok-4.7
roles:
  developer:
    agent: shared
  reviewer:
    agent: plain
`;

const WORKFLOW = `\
schema_version: 6
id: plan
stages:
  - id: implement
    role: developer
    depends_on: []
  - id: review
    role: reviewer
    agent: shared
    depends_on:
      - implement
`;

async function withProject(run: (workspace: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "migent-get-"));
  try {
    mkdirSync(path.join(root, ".migent", "workflows"), { recursive: true });
    writeFileSync(path.join(root, ".migent", "config.yaml"), CONFIG, "utf8");
    writeFileSync(path.join(root, ".migent", "workflows", "plan.yaml"), WORKFLOW, "utf8");
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const get = async (workspace: string, ...argv: string[]) => capture(() => main(["get", ...argv], workspace));

test("get workflows lists a table, json array, and names", async () => {
  await withProject(async (workspace) => {
    const table = await get(workspace, "workflows");
    expect(table.value).toBe(0);
    expect(table.stdout).toMatch(/^NAME\s+FILE\s+STAGES/);
    expect(table.stdout).toContain("plan");
    const json = await get(workspace, "wf", "-o", "json");
    expect(JSON.parse(json.stdout)).toMatchObject([{ kind: "workflow", name: "plan", stages: ["implement", "review"], roles: ["developer", "reviewer"], problems: [] }]);
    expect((await get(workspace, "workflows", "-o", "name")).stdout).toBe("plan\n");
  });
});

test("get workflow shows stages with resolved targets, and accepts --json", async () => {
  await withProject(async (workspace) => {
    const captured = await get(workspace, "workflow", "plan", "--json");
    expect(captured.value).toBe(0);
    const view = JSON.parse(captured.stdout);
    expect(view).toMatchObject({ kind: "workflow", name: "plan", source: { kind: "project" } });
    expect(view.stages[0]).toMatchObject({ id: "implement", role: "developer", agent: null, target: { client: "grok", model: "grok-4.6", options: { max_turns: "4" } } });
    expect(view.stages[1]).toMatchObject({ depends_on: ["implement"], agent: "shared", target: { model: "grok-4.6" } });
    const yaml = await get(workspace, "workflows", "plan");
    expect(yaml.stdout).toContain("name: plan");
  });
});

test("get roles and models resolve aliases and usage", async () => {
  await withProject(async (workspace) => {
    const roles = JSON.parse((await get(workspace, "roles", "-o", "json")).stdout);
    expect(roles[0]).toMatchObject({ name: "developer", agent: "shared", target: { model: "grok-4.6" }, used_by: [{ workflow: "plan", stage: "implement" }] });
    const model = JSON.parse((await get(workspace, "agent", "shared", "-o", "json")).stdout);
    expect(model).toMatchObject({ kind: "agent", name: "shared", client: "grok", local: false });
    expect(model.used_by).toEqual([{ role: "developer" }, { workflow: "plan", stage: "review" }]);
  });
});

test("get roles prints a table with agent and description, marking inline agents", async () => {
  await withProject(async (workspace) => {
    const configPath = path.join(workspace, ".migent", "config.yaml");
    writeFileSync(
      configPath,
      CONFIG.replace(
        "  reviewer:\n    agent: plain",
        "  reviewer:\n    description: Checks the work.\n    agent:\n      client:\n        type: grok\n      model: grok-4.7",
      ),
      "utf8",
    );
    const table = await get(workspace, "roles");
    expect(table.value).toBe(0);
    expect(table.stdout).toMatch(/^NAME\s+AGENT\s+CLIENT\s+MODEL\s+DESCRIPTION/);
    expect(table.stdout).toMatch(/developer\s+shared\s+grok\s+grok-4\.6\s+-/);
    expect(table.stdout).toMatch(/reviewer\s+\(inline\)\s+grok\s+grok-4\.7\s+Checks the work\./);
    const agents = await get(workspace, "agents");
    expect(agents.stdout).toMatch(/^NAME\s+CLIENT\s+MODEL\s+LOCAL/);
  });
});

test("get config matches the merged config", async () => {
  await withProject(async (workspace) => {
    const view = JSON.parse((await get(workspace, "config", "-o", "json")).stdout);
    const direct = JSON.parse((await capture(() => main(["config", "--json"], workspace))).stdout);
    expect(view).toMatchObject({ kind: "config", local_file: null, local_agents: [] });
    expect(view.config).toEqual(direct.config);
  });
});

test("get usage and lookup errors exit 2", async () => {
  await withProject(async (workspace) => {
    const cases: Array<[string[], string]> = [
      [["widgets"], "Unknown resource type"],
      [["workflow", "nope"], "Workflow not found: nope. Available: plan."],
      [["role", "nope"], "Role not found"],
      [["agent", "nope"], "Agent not found"],
      [["workflows", "-o", "xml"], "Invalid output format"],
      [["workflows", "--json", "-o", "yaml"], "conflicts"],
      [["config", "-o", "name"], "not valid for config"],
      [["roles", "--session", "x"], "--session is only valid"],
      [["workflow", "--session", "missing"], "Session not found"],
    ];
    for (const [argv, text] of cases) {
      const captured = await get(workspace, ...argv);
      expect(captured.value, argv.join(" ")).toBe(2);
      expect(captured.stderr).toContain(text);
    }
    const bare = await capture(() => main(["get"], workspace));
    expect(bare.value).toBe(2);
    expect(bare.stdout).toContain("Types:");
  });
});

test("get workflow --session reads a prepared session's draft", async () => {
  await withProject(async (workspace) => {
    const prepared = await capture(() => main(["session", "prepare", "some task title", "--workflow", "plan"], workspace));
    expect(prepared.value).toBe(0);
    const id = (JSON.parse(prepared.stdout) as { session_id: string }).session_id;
    const view = JSON.parse((await get(workspace, "workflow", "--session", id, "-o", "json")).stdout);
    expect(view).toMatchObject({ name: "plan", session: id, source: { kind: "draft" } });
    expect(view.stages[0].target).toMatchObject({ client: "grok" });
    const wrong = await get(workspace, "workflow", "other", "--session", id);
    expect(wrong.value).toBe(2);
  });
});

test("broken workflow files stay visible in lists and named lookups", async () => {
  await withProject(async (workspace) => {
    const broken = path.join(workspace, ".migent", "workflows", "broken.yaml");
    writeFileSync(broken, "schema_version: 6\nid: [unclosed\n", "utf8");
    const list = JSON.parse((await get(workspace, "workflows", "-o", "json")).stdout) as Array<Record<string, unknown>>;
    const entry = list.find((view) => view.name === "broken");
    expect(entry).toMatchObject({ kind: "workflow", file: ".migent/workflows/broken.yaml" });
    expect((entry!.problems as string[])[0]).toContain("broken.yaml:");
    expect(list.some((view) => view.name === "plan")).toBe(true);
    const named = await get(workspace, "workflow", "broken");
    expect(named.value).toBe(2);
    expect(named.stderr).toContain("broken.yaml");
    expect(named.stderr).not.toContain("not found");

    rmSync(path.join(workspace, ".migent", "workflows", "plan.yaml"));
    const only = JSON.parse((await get(workspace, "workflows", "-o", "json")).stdout) as Array<Record<string, unknown>>;
    expect(only.map((view) => view.name)).toEqual(["broken"]);
  });
});

test("get keeps authoring warnings out of stderr", async () => {
  await withProject(async (workspace) => {
    writeFileSync(path.join(workspace, ".migent", "workflows", "plan.yaml"), `extra_note: 1\n${WORKFLOW.replace("schema_version: 6", "schema_version: 4").replace("agent: shared", "model: shared")}`, "utf8");
    const list = await get(workspace, "workflows", "-o", "json");
    expect(list.stderr).toBe("");
    const one = await get(workspace, "workflow", "plan", "-o", "json");
    expect(one.stderr).toBe("");
    expect((JSON.parse(one.stdout) as { warnings: string[] }).warnings.join("\n")).toContain("extra_note");
  });
});

test("a frozen session view pins role instructions and targets against later config changes", async () => {
  await withProject(async (workspace) => {
    const prepared = await capture(() => main(["session", "prepare", "some task title", "--workflow", "plan"], workspace));
    const id = (JSON.parse(prepared.stdout) as { session_id: string }).session_id;
    const directory = path.join(workspace, ".migent", "sessions", id);
    const draft = parse(readFileSync(path.join(directory, "workflow.yaml"), "utf8"));
    writeFileSync(
      path.join(directory, "workflow.frozen.yaml"),
      stringify({
        source_sha256: null,
        workflow: draft,
        roles: { developer: ["PINNED INSTRUCTION"], reviewer: [] },
        targets: {
          implement: { client: "grok", model: "pinned-model", options: {} },
          review: { client: "grok", model: "pinned-model", options: {} },
        },
      }),
      "utf8",
    );
    writeFileSync(path.join(directory, "status.json"), JSON.stringify({ status: "running" }), "utf8");
    writeFileSync(
      path.join(workspace, ".migent", "config.yaml"),
      CONFIG.replace("grok-4.6", "changed-model").replace("agent: shared", "agent: shared\n    responsibilities:\n      - LIVE INSTRUCTION"),
      "utf8",
    );
    const view = JSON.parse((await get(workspace, "workflow", "--session", id, "-o", "json")).stdout);
    expect(view.source.kind).toBe("frozen");
    expect(view.role_responsibilities).toEqual({ developer: ["PINNED INSTRUCTION"], reviewer: [] });
    expect(view.stages[0].target.model).toBe("pinned-model");
    const project = JSON.parse((await get(workspace, "workflow", "plan", "-o", "json")).stdout);
    expect(project.stages[0].target.model).toBe("changed-model");
  });
});

test("duplicate workflow ids are reported even when no valid workflow remains", async () => {
  await withProject(async (workspace) => {
    writeFileSync(path.join(workspace, ".migent", "workflows", "copy.yaml"), WORKFLOW, "utf8");
    const list = JSON.parse((await get(workspace, "workflows", "-o", "json")).stdout) as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThan(0);
    expect(JSON.stringify(list)).toContain("id is declared by");
  });
});

test("invalid role instructions are reported as workflow problems", async () => {
  await withProject(async (workspace) => {
    writeFileSync(
      path.join(workspace, ".migent", "config.yaml"),
      CONFIG.replace("  developer:\n    agent: shared", "  developer:\n    agent: shared\n    responsibilities: not-a-list"),
      "utf8",
    );
    const view = JSON.parse((await get(workspace, "workflow", "plan", "-o", "json")).stdout);
    expect(view.problems.join("\n")).toContain("role developer:");
    expect(view.role_responsibilities.developer).toEqual([]);
  });
});
