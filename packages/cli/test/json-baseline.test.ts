import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { StageOutcome } from "@nodeint/migent-kernel";
import { SessionLock, SessionStore, createPreparedSession, createWorkflowSession } from "@nodeint/migent-session";
import { AgentToolRunner } from "@nodeint/migent-engine";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  CLI_CONTRACTS,
  LegacyLifecycleEvent,
  LifecycleEventV2,
  SealedMetrics,
  SealedMetricsCurrent,
  SealedMetricsHistorical,
  SessionFollowRecord,
  isValid,
  validationIssues,
} from "@nodeint/migent-contracts";
import { serviceApi } from "../src/commands/service.ts";
import { updateHooks } from "../src/commands/update.ts";
import { workspaceApi } from "../src/commands/workspace-registry.ts";
import { cliHooks } from "../src/hooks.ts";
import { main } from "../src/index.ts";
import { CancelOnCommand, ScriptedClient, capture, registryOf, removeWorkspace, writeFakeWorkflowWorkspace } from "./support.ts";

// Epic #97 step 1: baseline of every `--json` output on fixed fixtures. Later steps replace
// hand-written types with TypeBox schemas; these snapshots must not change except for error messages.

const CONFIG = `schema_version: 7
agents:
  planner-model:
    client:
      type: codex
    model: gpt-5
  reviewer-model:
    client:
      type: grok
    model: grok-4
roles:
  planner:
    agent: planner-model
  reviewer:
    agent: reviewer-model
`;

const WORKFLOW = `schema_version: 7
id: plan
stages:
  - id: draft
    role: planner
  - id: review
    role: reviewer
    depends_on: [draft]
`;

const BAD_WORKFLOW = `schema_version: 7
id: broken
stages:
  - id: draft
    role: nobody
    depends_on: [missing]
`;

let root: string;
let home: string;
const previousHome = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  MIGENT_HOME: process.env.MIGENT_HOME,
};
const serviceApiOriginal = { ...serviceApi };
const workspaceApiOriginal = { ...workspaceApi };
const extraWorkspaces: string[] = [];
beforeEach(() => {
  // Hermetic: skill checks read ~, the registry reads MIGENT_HOME.
  home = realpathSync(mkdtempSync(path.join(tmpdir(), "migent-json-home-")));
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows
  process.env.MIGENT_HOME = path.join(home, "migent");
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "migent-json-baseline-")));
  mkdirSync(path.join(root, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(root, ".migent", "config.yaml"), CONFIG);
  writeFileSync(path.join(root, ".migent", "workflows", "plan.yaml"), WORKFLOW);
});
afterEach(() => {
  cliHooks.runCommand = null;
  cliHooks.which = null as never;
  cliHooks.runner = null;
  updateHooks.fetchLatest = null;
  updateHooks.run = null;
  Object.assign(serviceApi, serviceApiOriginal);
  Object.assign(workspaceApi, workspaceApiOriginal);
  for (const workspace of extraWorkspaces.splice(0)) removeWorkspace(workspace);
  for (const [key, value] of Object.entries(previousHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** main() clears the hooks after each call, so every call starts from "no model list available". */
function installOffline(): void {
  if (cliHooks.runCommand === null) {
    cliHooks.runCommand = () => {
      throw new Error("offline");
    };
  }
  if (cliHooks.which === null) {
    cliHooks.which = (command: string) => (command === "codex" || command === "grok" ? `/bin/${command}` : null);
  }
}

async function json(argv: string[], stdin?: string, cwd: string = root): Promise<{ code: unknown; stdout: unknown; stderr: string }> {
  const args = argv.map((arg) => {
    if (arg !== "@draft") return arg;
    const draft = path.join(root, "draft.in");
    writeFileSync(draft, stdin ?? "");
    return draft;
  });
  installOffline();
  const result = await capture(() => main(args, cwd));
  return { code: result.value, stdout: scrub(parseOutput(result.stdout), cwd), stderr: scrubText(result.stderr, cwd) };
}

/** Replaces paths, ids, timestamps, and durations that differ between runs or platforms. */
function scrubText(text: string, cwd: string): string {
  let out = text;
  for (const [prefix, token] of [[cwd, "<root>"], [home, "<home>"]] as const) {
    if (!out.includes(prefix)) continue;
    // A path under the prefix uses the platform separator; the snapshot always uses "/".
    out = out.replace(new RegExp(`${escapeRegExp(prefix)}([^\\s"'\`]*)`, "g"), (_match, rest: string) => `${token}${rest.replace(/\\/g, "/")}`);
  }
  return out
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g, "<time>")
    .replace(/ · \d{2}:\d{2}:\d{2} · /g, " · <clock> · ")
    .replace(/(· )\d+(\.\d+)?s\b/g, "$1<dur>");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Scrubs every string in a parsed JSON value, and zeroes the volatile numeric fields. */
function scrub(value: unknown, cwd: string, key = ""): unknown {
  if (typeof value === "string") return scrubText(value, cwd);
  if (typeof value === "number") return ["pid", "cursor", "events_cursor"].includes(key) ? 0 : value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, cwd, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrub(item, cwd, name)]));
  }
  return value;
}

/** Whole-document JSON, else JSON lines, else the raw text (a command that ignores --json). */
function parseOutput(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // fall through
  }
  const lines = text.split("\n").filter((line) => line !== "");
  try {
    return lines.map((line) => JSON.parse(line) as unknown);
  } catch {
    return text;
  }
}

test("config --json", async () => {
  expect(await json(["config", "--json"])).toMatchSnapshot();
});

test("get --json", async () => {
  for (const type of ["workflows", "roles", "agents", "config"]) {
    expect({ type, ...(await json(["get", type, "--json"])) }).toMatchSnapshot();
  }
  expect(await json(["get", "workflow", "plan", "--json"])).toMatchSnapshot();
  expect(await json(["get", "role", "planner", "-o", "json"])).toMatchSnapshot();
  expect(await json(["get", "agent", "planner-model", "-o", "json"])).toMatchSnapshot();
});

test("doctor --json", async () => {
  expect(await json(["doctor", "--json"])).toMatchSnapshot();
});

test("config and workflow validate/render --json: valid and invalid drafts", async () => {
  const cases: Array<[string[], string]> = [
    [["config", "validate", "@draft", "--format", "yaml", "--json"], CONFIG],
    [["config", "validate", "@draft", "--format", "yaml", "--json"], CONFIG.replace("agent: reviewer-model", "agent: nope")],
    [["config", "validate", "@draft", "--format", "yaml", "--json"], "a: [\n"],
    [["config", "validate", "@draft", "--format", "json", "--json"], '{"a": 1, "a": 2}'],
    [["config", "validate", "@draft", "--format", "yaml", "--json"], "schema_version: 7\nroles: 3\n"],
    [["config", "validate", "@draft", "--format", "yaml", "--json"], "schema_version: 7\nunknown_key: 1\n"],
    [["config", "validate", "@draft", "--scope", "local", "--format", "yaml", "--json"], "agents:\n  planner-model:\n    model: x\n"],
    [["config", "render", "@draft", "--format", "yaml", "--json"], CONFIG],
    [["workflow", "validate", "@draft", "--format", "yaml", "--json"], WORKFLOW],
    [["workflow", "validate", "@draft", "--format", "yaml", "--json"], BAD_WORKFLOW],
    [["workflow", "validate", "@draft", "--format", "yaml", "--json"], "schema_version: 7\nid: x\nstages: {}\n"],
    [["workflow", "validate", "@draft", "--format", "yaml", "--json"], "schema_version: 7\nid: x\nstages:\n  - { id: a, role: planner, depends_on: [b] }\n  - { id: b, role: planner, depends_on: [a] }\n"],
    [["workflow", "validate", "@draft", "--format", "yaml", "--json"], "schema_version: 7\nid: x\nstages:\n  - { id: a, role: planner, bogus: true }\n"],
    [["workflow", "render", "@draft", "--format", "yaml", "--json"], WORKFLOW],
  ];
  const results = [];
  for (const [argv, draft] of cases) results.push({ argv: argv.slice(0, 2).concat(argv.slice(3)), draft, ...(await json(argv, draft)) });
  expect(results).toMatchSnapshot();
});

test("session list/show/metrics --json", async () => {
  const sessions = path.join(root, ".migent", "sessions", "s1");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    path.join(sessions, "status.json"),
    JSON.stringify({
      updated_at: "2026-09-19T00:00:00+00:00",
      workflow_id: "plan",
      status: "completed",
      latest_execution_id: "0001",
      latest_decision: "approved",
      outputs: { plan: {} },
      task: "old task",
    }),
  );
  expect(await json(["session", "list", "--json"])).toMatchSnapshot();
  expect(await json(["session", "list", "--latest", "--json"])).toMatchSnapshot();
  expect(await json(["session", "show", "s1", "--json"])).toMatchSnapshot();
});

test("service status and workspace list --json without a running service", async () => {
  expect(await json(["service", "status", "--json"])).toMatchSnapshot();
  expect(await json(["workspace", "list", "--json"])).toMatchSnapshot();
});

const CODEX_CATALOG = JSON.stringify({
  models: [{ slug: "gpt-5", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }],
});

test("get clients/models/options/efforts --json with a fake codex catalog", async () => {
  const calls: string[][] = [];
  // main() clears the hooks after every call, so install them again before each command.
  const install = (): void => {
    cliHooks.which = (command: string) => (command === "codex" ? "/bin/codex" : null);
    cliHooks.runCommand = (argv: string[]) => {
      calls.push(argv);
      if (path.basename(argv[0] ?? "") === "codex" && argv.includes("models")) return CODEX_CATALOG;
      if (argv.includes("--help")) return "Usage: codex exec [OPTIONS]\n";
      throw new Error("offline");
    };
  };
  for (const argv of [
    ["get", "clients", "-o", "json"],
    ["get", "client", "codex", "-o", "json"],
    ["get", "models", "--client", "codex", "-o", "json"],
    ["get", "options", "--client", "codex", "-o", "json"],
    ["get", "efforts", "--client", "codex", "-o", "json"],
    ["get", "effort", "gpt-5", "--client", "codex", "-o", "json"],
  ]) {
    install();
    expect({ argv, ...(await json(argv)) }).toMatchSnapshot();
  }
  // The snapshots must come from the fake catalog, never from a real CLI on this machine.
  expect(calls.length).toBeGreaterThan(0);
});

function fakeWorkspace(extra: Record<string, string> = {}): string {
  const workspace = realpathSync(
    writeFakeWorkflowWorkspace({
      plan: `schema_version: 7
id: plan
artifacts:
  plan: { file: plan.md }
stages:
  - id: draft
    role: planner
    artifacts: [plan]
downstream:
  - workflow: implement
    task: Implement the plan
    artifacts: { plan: plan }
`,
      implement: "schema_version: 7\nid: implement\nstages:\n  - { id: work, role: developer }\n",
      ...extra,
    }),
  );
  extraWorkspaces.push(workspace);
  return workspace;
}

test("session run --role --json prints the role result", async () => {
  const workspace = fakeWorkspace();
  cliHooks.runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient(["status: complete\n\nrole answer"]) }), 10);
  expect(await json(["session", "run", "--role", "planner", "--task", "demo", "--prompt", "hello", "--json"], undefined, workspace)).toMatchSnapshot();
});

test("session run --workflow completes and publishes outputs", async () => {
  const workspace = fakeWorkspace();
  cliHooks.runner = new AgentToolRunner(
    registryOf({ fake: new ScriptedClient(["status: complete\n\nplanned"], ["# Plan\n"]) }),
    10,
  );
  expect(await json(["session", "run", "--workflow", "plan", "--task", "Write a plan", "--skip-preflight"], undefined, workspace)).toMatchSnapshot();
});

const TWO_STAGE = `schema_version: 7
id: partial
artifacts:
  plan: { file: plan.md }
  notes: { file: notes.md }
stages:
  - id: draft
    role: planner
    artifacts: [plan]
  - id: extra
    role: planner
    depends_on: [draft]
    artifacts: [notes]
downstream:
  - workflow: implement
    task: Implement the plan
    artifacts: { plan: plan }
`;

test("session complete --json and session follow --json on a stopped session", async () => {
  const workspace = fakeWorkspace({ partial: TWO_STAGE });
  const sessionId = createWorkflowSession(workspace, "partial", "Write a plan");
  const directory = path.join(workspace, ".migent", "sessions", sessionId);
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "draft", null, null, "draft");
  const lock = SessionLock.acquire(directory);
  try {
    store.saveExecution(context, record, "running");
    writeFileSync(path.join(context.artifactDirectory, "plan.md"), "# Plan\n", "utf8");
    store.saveExecution(context, record, "completed", null, new StageOutcome("complete"));
  } finally {
    lock.release();
  }
  // "extra" never ran: the first complete finishes the session with a missing output.
  expect(await json(["session", "follow", sessionId, "--execution", "0001-draft--attempt-01", "--until", "--json"], undefined, workspace)).toMatchSnapshot();
  const first = await json(["session", "complete", sessionId, "--json"], undefined, workspace);
  expect((first.stdout as { already_completed: boolean }).already_completed).toBe(false);
  expect(first).toMatchSnapshot();
  const again = await json(["session", "complete", sessionId, "--json"], undefined, workspace);
  expect((again.stdout as { already_completed: boolean }).already_completed).toBe(true);
  expect(again).toMatchSnapshot();
  expect(await json(["session", "follow", sessionId, "--exit-when-done", "--json"], undefined, workspace)).toMatchSnapshot();
});

test("session rename --json", async () => {
  const workspace = fakeWorkspace({ partial: TWO_STAGE });
  const sessionId = createWorkflowSession(workspace, "partial", "Write a plan");
  const result = await json(["session", "rename", sessionId, "Better title", "--json"], undefined, workspace);
  expect(result.stdout).toEqual({ session_id: sessionId, title: "Better title", previous_title: "Write a plan" });
});

test("session metrics and cancel --json success payloads", async () => {
  const workspace = fakeWorkspace();
  const directory = path.join(workspace, ".migent", "sessions", "wave-3");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "status.json"), JSON.stringify({ session_id: "wave-3", workflow_id: "plan", status: "completed", updated_at: "2026-10-20T00:00:01.000+00:00" }));
  writeFileSync(path.join(directory, "events.jsonl"), `${JSON.stringify({ v: 2, seq: 1, event: "session.created", timestamp: "2026-10-20T00:00:01.000+00:00", data: {} })}\n`);
  writeFileSync(path.join(directory, "metrics.json"), JSON.stringify({ session_id: "wave-3", workflow_id: "plan", status: "completed", totals: { usage: { input_tokens: 4 } } }));
  expect(await json(["session", "metrics", "wave-3", "--json"], undefined, workspace)).toMatchSnapshot();
  expect(await json(["session", "metrics", "--json", "--workflow", "plan"], undefined, workspace)).toMatchSnapshot();

  const active = path.join(workspace, ".migent", "sessions", "s1");
  mkdirSync(active, { recursive: true });
  writeFileSync(path.join(active, "status.json"), JSON.stringify({ status: "active" }));
  const lock = SessionLock.acquire(active);
  lock.onCancelRequest(() => lock.release());
  expect(await json(["session", "cancel", "s1", "--json"], undefined, workspace)).toMatchSnapshot();
});

test("service status and workspace list --json with a running service", async () => {
  // The running payload is pinned by the real serviceStatus in packages/registry/test/service.test.ts
  // (state, host, port, pid and no token); the CLI only prints it, so the fake returns that shape.
  serviceApi.serviceStatus = (async () => ({
    state: "running",
    host: "127.0.0.1",
    port: 47321,
    pid: 4242,
  })) as unknown as typeof serviceApi.serviceStatus;
  const status = await json(["service", "status", "--json"]);
  expect(status).toMatchSnapshot();

  // workspace list reads the endpoint from service.json before it calls the service.
  const registry = path.join(home, "migent", "registry");
  mkdirSync(registry, { recursive: true });
  writeFileSync(
    path.join(registry, "service.json"),
    JSON.stringify({ schema_version: 2, instance_id: "instance", pid: 4242, host: "127.0.0.1", port: 47321, token: "token", started_at: "2026-09-26T08:07:57Z" }),
  );
  workspaceApi.callService = (async (...args: unknown[]) => {
    if (args[3] === "GET") return [200, { workspaces: [{ id: "ws_abc", name: "demo", path: "/tmp/demo", available: true }] }];
    return [404, { error: "workspace_not_found", message: "unknown id" }];
  }) as unknown as typeof workspaceApi.callService;
  expect(await json(["workspace", "list", "--json"])).toMatchSnapshot();
});

test("update --check --json", async () => {
  updateHooks.fetchLatest = async () => "99.0.0";
  updateHooks.run = () => {
    throw new Error("must not run");
  };
  const pin = (result: { stdout: unknown }) => ({ ...result, stdout: { ...(result.stdout as object), current: "<version>" } });
  expect(pin(await json(["update", "--check", "--json"]))).toMatchSnapshot();
  updateHooks.fetchLatest = async () => "0.0.1";
  expect(pin(await json(["update", "--check", "--json"]))).toMatchSnapshot();
});

test("config save and workflow save --json", async () => {
  const localDraft = "schema_version: 7\n# note\nagents:\n  planner-model:\n    client:\n      type: codex\n    model: gpt-5.1\n";
  const created = await json(["config", "save", "@draft", "--scope", "local", "--format", "yaml", "--json"], localDraft);
  expect(created).toMatchSnapshot();
  const hash = (created.stdout as { hash: string }).hash;
  expect(await json(["config", "save", "@draft", "--scope", "local", "--format", "yaml", "--json", "--base-hash", hash], localDraft + "# again\n")).toMatchSnapshot();
  expect(await json(["config", "save", "@draft", "--scope", "local", "--format", "yaml", "--json", "--base-hash", "0".repeat(64)], localDraft)).toMatchSnapshot();
  expect(await json(["config", "save", "@draft", "--format", "yaml", "--json"], CONFIG.replace("agent: reviewer-model", "agent: nope"))).toMatchSnapshot();

  const draft = WORKFLOW.replace("id: plan", "id: saved");
  const saved = await json(["workflow", "save", "@draft", "--format", "yaml", "--json"], draft);
  expect(saved).toMatchSnapshot();
  expect(await json(["workflow", "save", "@draft", "--format", "yaml", "--json"], draft)).toMatchSnapshot();
  expect(await json(["workflow", "save", "@draft", "--format", "yaml", "--json"], BAD_WORKFLOW)).toMatchSnapshot();
});

test("get options --native --json parses the CLI help", async () => {
  const run = (): void => {
    cliHooks.which = (command: string) => (command === "codex" ? "/bin/codex" : null);
    cliHooks.runCommand = (argv: string[]) => {
      if (argv.includes("--help")) return "Options:\n  --model <MODEL>  Model to use\n  -s, --sandbox <MODE>  Sandbox policy\n  --json  Print events\n";
      throw new Error("model service unavailable");
    };
  };
  run();
  expect(await json(["get", "options", "--native", "--client", "codex", "-o", "json"])).toMatchSnapshot();
});

test("doctor --session --json checks a prepared session's draft workflow", async () => {
  const sessionId = createPreparedSession(root, "Later", "plan");
  expect(await json(["doctor", "--session", sessionId, "--json"])).toMatchSnapshot();
  expect(await json(["doctor", "--session", "missing", "--json"])).toMatchSnapshot();
});

test("session prepare, session repair, and workspace register/remove", async () => {
  const workspace = fakeWorkspace();
  installOffline();
  const prepared = await capture(() => main(["session", "prepare", "A task", "--workflow", "plan"], workspace));
  expect(prepared.value).toBe(0);
  const sessionId = (JSON.parse(prepared.stdout) as { session_id: string }).session_id;
  installOffline();
  const repaired = await capture(() => main(["session", "repair", sessionId], workspace));
  expect(repaired.value).toBe(0);

  const registry = path.join(home, "migent", "registry");
  mkdirSync(registry, { recursive: true });
  writeFileSync(
    path.join(registry, "service.json"),
    JSON.stringify({ schema_version: 2, instance_id: "instance", pid: 4242, host: "127.0.0.1", port: 47321, token: "token", started_at: "2026-09-26T08:07:57Z" }),
  );
  workspaceApi.startDetached = (async () => ({ host: "127.0.0.1", port: 47321, token: "token" })) as unknown as typeof workspaceApi.startDetached;
  workspaceApi.callService = (async (...args: unknown[]) =>
    args[3] === "POST"
      ? [201, { id: "ws_abc", name: "demo", path: workspace, available: true }]
      : [200, { id: "ws_abc", name: "demo", path: workspace, available: true }]) as unknown as typeof workspaceApi.callService;
  expect((await json(["workspace", "register", "--path", workspace], undefined, workspace)).code).toBe(0);
  expect((await json(["workspace", "remove", "ws_abc"], undefined, workspace)).code).toBe(0);
});

test("session follow --json forwards historical lifecycle and provider stream lines unchanged", async () => {
  const workspace = fakeWorkspace();
  const directory = path.join(workspace, ".migent", "sessions", "old-1");
  mkdirSync(path.join(directory, "executions", "0001-draft--attempt-01"), { recursive: true });
  writeFileSync(path.join(directory, "status.json"), JSON.stringify({ session_id: "old-1", workflow_id: "plan", status: "completed", updated_at: "2026-10-20T00:00:01.000+00:00" }));
  const lines = [{ event: "session.created", odd: 42 }, { v: 2, seq: 2, event: "stage.started", timestamp: "2026-10-20T00:00:02.000+00:00", data: {} }];
  writeFileSync(path.join(directory, "events.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  // Provider stream records are opaque. Follow parses and re-serializes each line, as it always has.
  const streamLines = ['{"type":"assistant","message":{"text":"hi"},"usage":{"input_tokens":1.0,"n":1e3}}', '{"id":7,"tool":null}'];
  writeFileSync(path.join(directory, "executions", "0001-draft--attempt-01", "stream.jsonl"), streamLines.join("\n") + "\n");
  const result = await capture(() => main(["session", "follow", "old-1", "--exit-when-done", "--cursor", "0", "--json"], workspace));
  const outputLines = result.stdout.trim().split("\n");
  const records = outputLines.map((line) => JSON.parse(line));
  for (const line of [...lines.map((item) => JSON.stringify(item)), ...streamLines.map((item) => JSON.stringify(JSON.parse(item)))]) {
    expect(outputLines).toContain(line);
  }
  // Lines merge by timestamp; an unversioned line has none. Compare as a set.
  expect(records).toHaveLength(lines.length + streamLines.length);
  for (const line of lines) expect(records).toContainEqual(line);
  for (const line of streamLines) expect(records).toContainEqual(JSON.parse(line));
  expect(isValid(LegacyLifecycleEvent, lines[0])).toBe(true);
});

test("session run --role --session --json prints every resumed role execution", async () => {
  const workspace = fakeWorkspace();
  const sessionRoot = path.join(workspace, ".migent", "sessions");
  cliHooks.runner = new AgentToolRunner(registryOf({ fake: new CancelOnCommand([]) }), 10);
  installOffline();
  const cancelled = await capture(() => main(["session", "run", "--role", "planner", "--prompt", "Plan it", "--json"], workspace));
  expect(cancelled.value).toBe(130);
  const sessionId = readdirSync(sessionRoot)[0]!;
  // A second cancelled execution of the same role session, so the resume prints a list.
  const executions = path.join(sessionRoot, sessionId, "executions");
  const first = readdirSync(executions)[0]!;
  const second = first.replace("0001", "0002");
  cpSync(path.join(executions, first), path.join(executions, second), { recursive: true });
  const metadataPath = path.join(executions, second, "execution.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  Object.assign(metadata, { execution_id: second, execution_order: 2 });
  writeFileSync(metadataPath, JSON.stringify(metadata));
  // The copied prompt names the handoff file of the execution it was copied from.
  const promptPath = path.join(executions, second, "prompt.md");
  writeFileSync(promptPath, readFileSync(promptPath, "utf8").split(first).join(second));
  cliHooks.runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient(["status: complete\n\ndone", "status: complete\n\ndone"]) }), 10);
  installOffline();
  const resumed = await capture(() => main(["session", "run", "--role", "planner", "--session", sessionId, "--prompt", "again", "--json"], workspace));
  expect(resumed.value).toBe(0);
  expect(Array.isArray(JSON.parse(resumed.stdout))).toBe(true);
});

test("get model, get option, get option --native, and session list --latest with no session", async () => {
  const install = (): void => {
    cliHooks.which = (command: string) => (command === "codex" ? "/bin/codex" : null);
    cliHooks.runCommand = (argv: string[]) => {
      if (path.basename(argv[0] ?? "") === "codex" && argv.includes("models")) return CODEX_CATALOG;
      if (argv.includes("--help")) return "Options:\n  --model <MODEL>  Model to use\n";
      throw new Error("offline");
    };
  };
  for (const argv of [
    ["get", "model", "gpt-5", "--client", "codex", "-o", "json"],
    ["get", "option", "model_reasoning_effort", "--client", "codex", "-o", "json"],
    ["get", "option", "model", "--native", "--client", "codex", "-o", "json"],
  ]) {
    install();
    const result = await json(argv);
    expect([argv.join(" "), result.code]).toEqual([argv.join(" "), 0]);
  }
  const none = await json(["session", "list", "--latest", "--json"], undefined, fakeWorkspace());
  expect(none.stdout).toBeNull();
});

test("known shapes describe files written by a real scripted run", async () => {
  const workspace = fakeWorkspace();
  cliHooks.runner = new AgentToolRunner(
    registryOf({ fake: new ScriptedClient(["status: complete\n\nplanned"], ["# Plan\n"]) }),
    10,
  );
  const run = await json(["session", "run", "--workflow", "plan", "--task", "Write a plan", "--skip-preflight"], undefined, workspace);
  expect(run.code).toBe(0);
  const sessions = path.join(workspace, ".migent", "sessions");
  const directory = path.join(sessions, readdirSync(sessions)[0]!);
  const metrics = JSON.parse(readFileSync(path.join(directory, "metrics.json"), "utf8")) as unknown;
  expect(validationIssues(SealedMetricsCurrent, metrics)).toEqual([]);
  expect(validationIssues(SealedMetricsHistorical, metrics)).toEqual([]);
  expect(isValid(SealedMetrics, metrics)).toBe(true);
  const events = readFileSync(path.join(directory, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as unknown);
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(validationIssues(LifecycleEventV2, event)).toEqual([]);
    expect(isValid(SessionFollowRecord, event)).toBe(true);
  }
});

// Coverage guard: every contract in the index was emitted, and so validated, by this file.
test("every CLI output contract was exercised by a real command", () => {
  const emitted = (globalThis as { __migentEmittedContracts?: Set<string> }).__migentEmittedContracts ?? new Set<string>();
  const missing = CLI_CONTRACTS.filter((entry) => !emitted.has(String(entry.schema.$id))).map((entry) => entry.key);
  expect(missing).toEqual([]);
});

test("config validate --json: multi-error drafts keep diagnostic precedence", async () => {
  const drafts = [
    // unknown agent wins over malformed responsibilities in the same role
    "schema_version: 7\nroles:\n  developer:\n    agent: missing\n    responsibilities: 3\n",
    // one invalid named agent shared by several roles reports once
    "schema_version: 7\nagents:\n  a:\n    model: 3\nroles:\n  one:\n    agent: a\n  two:\n    agent: a\n",
    // invalid named agent used by a role whose other fields are also invalid
    "schema_version: 7\nagents:\n  a:\n    model: 3\nroles:\n  one:\n    agent: a\n    responsibilities: 3\n    description: 4\n",
    // malformed inline role agent next to an invalid named agent
    "schema_version: 7\nagents:\n  a:\n    model: 3\nroles:\n  one:\n    agent:\n      client: oops\n  two:\n    agent: a\n",
    // empty placeholder is the only diagnostic
    "schema_version: 7\nagents:\n  x: {}\nroles:\n  r:\n    agent: x\n",
    // bad client options and unknown client key
    "schema_version: 7\nroles:\n  r:\n    agent:\n      model: m\n      client:\n        type: codex\n        options:\n          1a: x\n",
    "schema_version: 7\nroles:\n  r:\n    agent:\n      model: m\n      client:\n        type: codex\n        extra: 1\n",
    // agents is not a mapping, roles empty, legacy role key
    "schema_version: 7\nagents: 3\nroles: {}\n",
    "schema_version: 7\nroles:\n  r:\n    instructions: [a]\n    agent: nope\n",
  ];
  const results = [];
  for (const draft of drafts) {
    results.push({ draft, ...(await json(["config", "validate", "@draft", "--format", "yaml", "--json"], draft)) });
  }
  expect(results).toMatchSnapshot();
});
