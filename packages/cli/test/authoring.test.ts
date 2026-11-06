import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256Hex } from "@nodeint/migent-kernel";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "../src/index.ts";
import { capture } from "./support.ts";

const CONFIG = `schema_version: 5
agents:
  fast:
    provider: grok
    model: grok-4.6
roles:
  developer:
    agent: fast
`;

const WORKFLOW = `schema_version: 5
id: build
stages:
  - id: implement
    role: developer
    depends_on: []
`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "migent-authoring-"));
  mkdirSync(path.join(root, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(root, ".migent", "config.yaml"), CONFIG);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function run(argv: string[], stdin?: string) {
  const draft = stdin === undefined ? null : path.join(root, "draft.in");
  if (draft !== null) writeFileSync(draft, stdin);
  const args = argv.map((arg) => (arg === "@draft" ? draft! : arg));
  const result = await capture(() => main(args, root));
  const lastLine = result.stdout.trim();
  return { code: result.value as number, out: result.stdout, json: lastLine.startsWith("{") ? JSON.parse(lastLine) : null };
}

test("config validate accepts a valid draft and reports an unknown model", async () => {
  const ok = await run(["config", "validate", "@draft", "--format", "yaml", "--json"], CONFIG);
  expect(ok.code).toBe(0);
  expect(ok.json.valid).toBe(true);
  const bad = await run(["config", "validate", "@draft", "--format", "yaml", "--json"], CONFIG.replace("agent: fast", "agent: nope"));
  expect(bad.code).toBe(1);
  expect(bad.json.diagnostics[0]).toMatchObject({ severity: "error", source: "project", draft: true });
});

test("syntax errors carry a position; strict JSON rejects trailing commas", async () => {
  const yaml = await run(["config", "validate", "@draft", "--format", "yaml", "--json"], "a: [\n");
  expect(yaml.code).toBe(1);
  expect(yaml.json.diagnostics[0]).toMatchObject({ code: "yaml-syntax", source: "project" });
  expect(yaml.json.diagnostics[0].line).toBeTypeOf("number");
  const json = await run(["config", "validate", "@draft", "--format", "json", "--json"], '{"schema_version": 4,}');
  expect(json.json.diagnostics[0].code).toBe("json-syntax");
  const dup = await run(["config", "validate", "@draft", "--format", "json", "--json"], '{"a": 1, "a": 2}');
  expect(dup.json.diagnostics[0].code).toBe("duplicate-key");
});

test("a local draft needs schema_version and a project config", async () => {
  const local = await run(["config", "validate", "@draft", "--scope", "local", "--format", "yaml", "--json"], "agents:\n  fast:\n    provider: grok\n    model: grok-4.7\n");
  expect(local.code).toBe(1);
  expect(local.json.diagnostics.map((d: { code: string }) => d.code)).toContain("schema-outdated");
  const fine = await run(["config", "validate", "@draft", "--scope", "local", "--format", "yaml", "--json"], "schema_version: 5\nagents:\n  fast:\n    provider: grok\n    model: grok-4.7\n");
  expect(fine.code).toBe(0);
});

test("render and save write the same bytes, and save guards conflicts", async () => {
  const rendered = await run(["config", "render", "@draft", "--format", "yaml", "--json"], CONFIG);
  const target = path.join(root, ".migent", "config.local.yaml");
  const created = await run(["config", "save", "@draft", "--scope", "local", "--format", "yaml", "--json"], "schema_version: 5\n# note\nagents:\n  fast:\n    provider: grok\n    model: grok-4.7\n");
  expect(created.code).toBe(0);
  expect(created.json).toMatchObject({ written: true, file: "config.local.yaml" });
  expect(created.json.hash).toBe(sha256Hex(readFileSync(target, "utf8")));
  expect(rendered.json.rendered).toBe(CONFIG);

  const again = await run(["config", "save", "@draft", "--scope", "local", "--format", "yaml", "--json"], "schema_version: 5\n");
  expect(again.code).toBe(3);
  expect(again.json.diagnostics.at(-1).code).toBe("already-exists");

  const stale = await run(["config", "save", "@draft", "--scope", "local", "--format", "yaml", "--json", "--base-hash", "0".repeat(64)], "schema_version: 5\n");
  expect(stale.code).toBe(3);
  expect(stale.json.diagnostics.at(-1).code).toBe("stale-base");

  const before = created.json.hash as string;
  const replaced = await run(["config", "save", "@draft", "--scope", "local", "--format", "yaml", "--json", "--base-hash", before], "schema_version: 5\n");
  expect(replaced.code).toBe(0);
  expect(replaced.json.hash).not.toBe(before);
  expect(readdirSync(path.join(root, ".migent")).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
});

test("replacing a file with comments warns", async () => {
  const target = path.join(root, ".migent", "config.yaml");
  const hash = sha256Hex(CONFIG);
  writeFileSync(target, `# keep me\n${CONFIG}`);
  const res = await run(["config", "save", "@draft", "--format", "yaml", "--json", "--base-hash", sha256Hex(`# keep me\n${CONFIG}`)], CONFIG);
  expect(res.code).toBe(0);
  expect(res.json.diagnostics.map((d: { code: string }) => d.code)).toContain("comments-dropped");
  expect(readFileSync(target, "utf8")).toBe(CONFIG);
  expect(hash).toBe(res.json.hash);
});

test("workflow validate reports unknown roles by stage index", async () => {
  const ok = await run(["workflow", "validate", "@draft", "--format", "yaml", "--json"], WORKFLOW);
  expect(ok.code).toBe(0);
  const bad = await run(["workflow", "validate", "@draft", "--format", "yaml", "--json"], WORKFLOW.replace("role: developer", "role: ghost"));
  expect(bad.code).toBe(1);
  expect(bad.json.diagnostics[0]).toMatchObject({ source: "workflow", file: "build.yaml", draft: true, path: ["stages", 0, "role"] });
});

test("workflow save creates the file once and refuses duplicate ids", async () => {
  const saved = await run(["workflow", "save", "@draft", "--format", "yaml", "--json"], WORKFLOW);
  expect(saved.code).toBe(0);
  expect(saved.json.file).toBe("workflows/build.yaml");
  expect(existsSync(path.join(root, ".migent", "workflows", "build.yaml"))).toBe(true);
  const dup = await run(["workflow", "validate", "@draft", "--format", "yaml", "--target", "other.yaml", "--json"], WORKFLOW);
  expect(dup.code).toBe(1);
  expect(dup.json.diagnostics[0].code).toBe("duplicate-id");
  const exists = await run(["workflow", "save", "@draft", "--format", "yaml", "--json"], WORKFLOW);
  expect(exists.code).toBe(3);
});

test("invocation errors are reported in the envelope", async () => {
  const res = await run(["config", "validate", "@draft", "--json"], CONFIG);
  expect(res.code).toBe(2);
  expect(res.json.diagnostics[0].code).toBe("invalid-invocation");
  const missing = await run(["config", "validate", path.join(root, "missing.yaml"), "--json"]);
  expect(missing.code).toBe(2);
  expect(missing.json.diagnostics[0].code).toBe("draft-unreadable");
});

test("workflow validation applies catalog and companion schema rules", async () => {
  const wf = (dir: string) => path.join(root, ".migent", "workflows", dir);
  writeFileSync(wf("empty.yaml"), "schema_version: 5\nid: empty\nstages: []\n");
  const downstream = WORKFLOW + "downstream:\n  - workflow: empty\n    task: go\n";
  const empty = await run(["workflow", "validate", "@draft", "--format", "yaml", "--json"], downstream);
  expect(empty.json.diagnostics[0]).toMatchObject({ code: "no-stages", severity: "warning", source: "workflow", file: "empty.yaml", draft: false });
  writeFileSync(wf("broken.yaml"), "schema_version: 5\nid: broken\nstages: 123\n");
  const broken = await run(["workflow", "validate", "@draft", "--format", "yaml", "--json"], downstream.replace("workflow: empty", "workflow: broken"));
  // Like the runtime, a sibling whose stages are not a list is a workflow with no stages.
  expect(broken.json.diagnostics.map((d: { code: string }) => d.code)).toContain("no-stages");
  const missing = await run(["workflow", "validate", "@draft", "--format", "yaml", "--json"], downstream.replace("workflow: empty", "workflow: nowhere"));
  expect(missing.code).toBe(1);
  expect(missing.json.diagnostics.find((d: { code: string }) => d.code === "unknown-downstream")).toMatchObject({ code: "unknown-downstream", path: ["downstream"], draft: true });
  writeFileSync(path.join(root, ".migent", "config.local.yaml"), "schema_version: 999\n");
  const newer = await run(["workflow", "validate", "@draft", "--format", "yaml", "--json"], WORKFLOW);
  expect(newer.code).toBe(1);
  expect(newer.json.diagnostics.find((d: { code: string }) => d.code === "schema-newer")).toMatchObject({ code: "schema-newer", source: "local", draft: false });
});

test("parser errors carry codes and index paths; syntax errors mark the draft", async () => {
  const dup = await run(["workflow", "validate", "@draft", "--format", "yaml", "--json"], WORKFLOW + "  - id: implement\n    role: developer\n");
  expect(dup.json.diagnostics[0]).toMatchObject({ code: "duplicate-stage-id", source: "workflow" });
  const unknown = await run(["workflow", "validate", "@draft", "--format", "yaml", "--json"], WORKFLOW.replace("depends_on: []", "depends_on: []\n    colour: red"));
  // From schema_version 5 an unknown key is an error, not a warning.
  expect(unknown.code).toBe(1);
  expect(unknown.json.diagnostics[0]).toMatchObject({ code: "unknown-key", severity: "error" });
  const renamed = await run(["workflow", "validate", "@draft", "--format", "yaml", "--json"], WORKFLOW.replace("depends_on: []", "depends_on: []\n    model: shared"));
  expect(renamed.code).toBe(1);
  expect(JSON.stringify(renamed.json.diagnostics)).toContain("stages.implement.model was renamed to stages.implement.agent in schema_version 5");
  const syntax = await run(["workflow", "validate", "@draft", "--format", "yaml", "--json"], "a: [\n");
  expect(syntax.json.diagnostics[0]).toMatchObject({ code: "yaml-syntax", source: "workflow", draft: true });
  expect(syntax.json.diagnostics[0].file).toBeUndefined();
});

test("usage errors with --json use the envelope", async () => {
  const res = await run(["workflow", "validate", "--json"]);
  expect(res.code).toBe(2);
  expect(res.json).toMatchObject({ valid: false, command: "workflow.validate" });
  expect(res.json.diagnostics[0].code).toBe("invalid-invocation");
  const unknown = await run(["config", "validate", "x", "--bogus", "--json"]);
  expect(unknown.json.diagnostics[0].code).toBe("invalid-invocation");
});

test("parser paths use exact stage ids and data-backed field paths", async () => {
  const check = async (text: string) => (await run(["workflow", "validate", "@draft", "--format", "yaml", "--json"], text)).json.diagnostics[0];
  const stage = (id: string, extra = "") => `  - id: ${id}\n    role: developer\n    depends_on: []\n${extra}`;
  const head = "schema_version: 5\nid: build\nstages:\n";
  expect(await check(head + stage("a") + stage("a"))).toMatchObject({ code: "duplicate-stage-id", path: ["stages", 1, "id"] });
  expect(await check(head + stage("a") + "  - role: developer\n    depends_on: []\n")).toMatchObject({ path: ["stages", 1, "id"] });
  const dotted = await check(head + stage("a") + stage("a.b", "    session:\n      resume_from: 1\n"));
  expect(dotted.path.slice(0, 2)).toEqual(["stages", 1]);
  const nested = await check(head + stage("a", "    session:\n      resume_from: 1\n"));
  expect(nested.path).toEqual(["stages", 0, "session", "resume_from"]);
});

test("config faults reached through a stage stay with the config", async () => {
  writeFileSync(path.join(root, ".migent", "config.yaml"), CONFIG.replace("agent: fast", "agent: ghost"));
  const inherited = await run(["workflow", "validate", "@draft", "--format", "yaml", "--json"], WORKFLOW);
  expect(inherited.code).toBe(1);
  expect(inherited.json.diagnostics[0]).toMatchObject({ code: "unknown-agent", source: "project", draft: false, path: ["roles", "developer", "agent"] });
  writeFileSync(path.join(root, ".migent", "config.yaml"), CONFIG);
  const explicit = await run(["workflow", "validate", "@draft", "--format", "yaml", "--json"], WORKFLOW.replace("depends_on: []", "depends_on: []\n    agent: ghost"));
  expect(explicit.json.diagnostics[0]).toMatchObject({ code: "unknown-agent", source: "workflow", draft: true, path: ["stages", 0, "agent"] });
});

test("parent-level --json still yields an envelope for usage errors", async () => {
  const res = await run(["config", "--json", "validate"]);
  expect(res.code).toBe(2);
  expect(res.json).toMatchObject({ valid: false, command: "config.validate" });
  const ok = await run(["config", "--json", "validate", "@draft", "--format", "yaml"], CONFIG);
  expect(ok.json.valid).toBe(true);
});

test("an ambiguous or blank stage id never sends the path to another stage", async () => {
  const check = async (text: string) => (await run(["workflow", "validate", "@draft", "--format", "yaml", "--json"], text)).json.diagnostics[0];
  const head = "schema_version: 5\nid: build\nstages:\n";
  const stage = (id: string, extra = "") => `  - id: ${JSON.stringify(id)}\n    role: developer\n    depends_on: []\n${extra}`;
  const first = await check(head + stage("a", "    session:\n      resume_from: 1\n") + stage("a.options"));
  expect(first.path).toEqual(["stages", 0, "session", "resume_from"]);
  const second = await check(head + stage("a") + stage("a.options", "    session:\n      resume_from: 1\n"));
  expect(second.path).toEqual(["stages", 1, "session", "resume_from"]);
  expect((await check(head + stage("a") + stage("  ")))?.path).toEqual(["stages", 1, "id"]);
});

test("paths use the draft's own coordinates for routes and for a stage named id", async () => {
  const check = async (text: string) => (await run(["workflow", "validate", "@draft", "--format", "yaml", "--json"], text)).json.diagnostics[0];
  const head = "schema_version: 5\nid: build\nstages:\n";
  const route = await check(head + "  - id: a\n    role: developer\n    depends_on: []\n    decision:\n      - approved:\n          navigate: ghost\n");
  expect(route.path).toEqual(["stages", 0, "decision", 0, "approved", "navigate"]);
  const afterVerify = await check(head + "  - id: v\n    verify: [\"true\"]\n    depends_on: []\n  - id: a\n    role: developer\n    depends_on: [v]\n    decision:\n      - approved:\n          navigate: ghost\n");
  expect(afterVerify.path).toEqual(["stages", 1, "decision", 0, "approved", "navigate"]);
  const named = await check(head + "  - id: id\n    role: developer\n    depends_on: []\n    session:\n      resume_from: 1\n");
  expect(named.path).toEqual(["stages", 0, "session", "resume_from"]);
});

test("provider option errors keep the origin of the bad options", async () => {
  const local = (options: string) => writeFileSync(path.join(root, ".migent", "config.local.yaml"), `schema_version: 5\nagents:\n  fast:\n    client:\n      options:\n        ${options}\n`);
  const validate = async (text: string) => (await run(["workflow", "validate", "@draft", "--format", "yaml", "--json"], text)).json.diagnostics;
  local("max_turns: abc");
  const plain = (await validate(WORKFLOW)).find((d: { code: string }) => d.code === "options-invalid");
  expect(plain).toMatchObject({ source: "local", draft: false, path: ["agents", "fast", "client", "options"] });
  const withOwn = (await validate(WORKFLOW.replace("depends_on: []", "depends_on: []\n    agent:\n      provider: grok\n      model: grok-4.7\n      client:\n        options:\n          max_turns: \"3\"")))
    .find((d: { code: string }) => d.code === "options-invalid");
  // The stage overrides the bad value, so nothing is wrong any more.
  expect(withOwn).toBeUndefined();
  local("max_turns: \"3\"");
  const own = (await validate(WORKFLOW.replace("depends_on: []", "depends_on: []\n    agent:\n      provider: grok\n      model: grok-4.7\n      client:\n        options:\n          max_turns: abc")))
    .find((d: { code: string }) => d.code === "options-invalid");
  expect(own).toMatchObject({ source: "workflow", draft: true, path: ["stages", 0, "agent"] });
});

test("an intentionally empty shared agent is a warning, not an error", async () => {
  const draft = CONFIG.replace("agents:\n", "agents:\n  waiting: {}\n");
  const res = await run(["config", "validate", "@draft", "--format", "yaml", "--json"], draft);
  expect(res.code).toBe(0);
  expect(res.json.diagnostics.find((d: { code: string }) => d.code === "agent-unmapped")).toMatchObject({ severity: "warning" });
});
