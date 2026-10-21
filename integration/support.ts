import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../packages/cli/src/index.ts";

const INTEGRATION_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PROVIDER_BIN = path.join(INTEGRATION_ROOT, "fixtures", "bin");
export const GROK_SESSION = "fake-grok-session";
export const CODEX_THREAD = "fake-codex-thread";

export const GROK_CONFIG = `\
schema_version: 2
models:
  grok-model:
    provider: grok
    model: grok-test
    options:
      reasoning-effort: low
roles:
  planner:
    default_model: grok-model
  reviewer:
    default_model: grok-model
`;

export const CODEX_CONFIG = `\
schema_version: 2
models:
  codex-model:
    provider: codex
    model: codex-test
    options:
      model_reasoning_effort: low
roles:
  writer:
    default_model: codex-model
`;

export const PLAN_REVIEW = `\
schema_version: 2
id: plan
description: Write and approve a plan before implementation.
stages:
  - id: plan
    role: planner
    max_revisions: 3
    depends_on: []
    produces:
      artifact: plan.md
  - id: review-plan
    role: reviewer
    depends_on:
      - plan
    decision:
      values:
        - approved
        - revise
      routes:
        approved: complete
        revise: plan
outputs:
  - name: plan
    from_stage: plan
    artifact: plan.md
`;

export const DRAFT_NOTE = `\
schema_version: 2
id: draft-note
stages:
  - id: draft
    role: writer
    depends_on: []
    produces:
      artifact: note.md
`;

export const SOLO = `\
schema_version: 2
id: solo
stages:
  - id: write
    role: planner
    depends_on: []
    produces:
      artifact: note.md
`;

export const FAKE_SCRIPT = ".migent-fake.json";
export const FAKE_CURSOR = ".migent-fake.cursor";
export const FAKE_LOG = ".migent-fake.log";

export const COMPLETE = "status: complete\n\nready";
export const APPROVED = "status: complete\ndecision: approved\n\nok";
export const REVISE = "status: complete\ndecision: revise\n\nagain";
export const BLOCKED = "status: blocked\nblocker: missing schema\n\nnope";

const FAKE_ENV = ["MIGENT_FAKE_OUTCOME", "MIGENT_FAKE_SCRIPT", "MIGENT_FAKE_CURSOR", "MIGENT_FAKE_LOG", "PATH"] as const;

export function resumedNotes(role: string): string {
  return `\
schema_version: 2
id: notes
stages:
  - id: draft
    role: ${role}
    depends_on: []
    produces:
      artifact: draft.md
  - id: follow
    role: ${role}
    session:
      resume_from: draft
    depends_on:
      - draft
    produces:
      artifact: follow.md
outputs:
  - name: draft
    from_stage: draft
    artifact: draft.md
`;
}

export function tempWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "migent-integration-"));
}

export function removeWorkspace(workspace: string): void {
  rmSync(workspace, { recursive: true, force: true });
}

export function installScript(root: string, steps: readonly unknown[]): void {
  writeFileSync(path.join(root, FAKE_SCRIPT), JSON.stringify(steps), "utf8");
  writeFileSync(path.join(root, FAKE_CURSOR), "0", "utf8");
  const log = path.join(root, FAKE_LOG);
  if (existsSync(log)) unlinkSync(log);
}

export function providerInvocations(root: string): Array<Record<string, unknown>> {
  const log = path.join(root, FAKE_LOG);
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function invocationArgv(root: string): string[][] {
  return providerInvocations(root).map((item) => {
    if (!Array.isArray(item.argv)) throw new Error("provider invocation is missing argv");
    return item.argv.map((part) => String(part));
  });
}

export function hasArgs(argv: readonly string[], ...parts: string[]): boolean {
  const width = parts.length;
  for (let index = 0; index <= argv.length - width; index += 1) {
    let matched = true;
    for (let offset = 0; offset < width; offset += 1) {
      if (argv[index + offset] !== parts[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

export function writeWorkspace(root: string, config: string, workflows: Record<string, string>): void {
  const workflowDir = path.join(root, ".migent", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(path.join(root, ".migent", "config.yaml"), config, "utf8");
  for (const [workflowId, document] of Object.entries(workflows)) {
    writeFileSync(path.join(workflowDir, `${workflowId}.yaml`), document, "utf8");
  }
}

export async function runMain(
  workspace: string,
  argv: string[],
  outcome = "complete",
): Promise<[number, Array<Record<string, unknown>>, string]> {
  const previous = new Map<string, string | undefined>();
  for (const name of FAKE_ENV) previous.set(name, process.env[name]);
  process.env.PATH = `${PROVIDER_BIN}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.MIGENT_FAKE_OUTCOME = outcome;
  const script = path.join(workspace, FAKE_SCRIPT);
  if (existsSync(script)) {
    process.env.MIGENT_FAKE_SCRIPT = script;
    process.env.MIGENT_FAKE_CURSOR = path.join(workspace, FAKE_CURSOR);
    process.env.MIGENT_FAKE_LOG = path.join(workspace, FAKE_LOG);
  } else {
    delete process.env.MIGENT_FAKE_SCRIPT;
    delete process.env.MIGENT_FAKE_CURSOR;
    delete process.env.MIGENT_FAKE_LOG;
  }
  const before = executionTexts(workspace);
  try {
    const captured = await capture(() => main(argv, workspace));
    const printed = jsonObjects(captured.stdout);
    const objects =
      printed.length > 0
        ? printed
        : [workflowResult(workspace, argv, captured.value as number, captured.stderr, before)];
    return [captured.value as number, objects, captured.stderr];
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

export function executionStatuses(workspace: string): string[] {
  return executionRecords(workspace).map((record) => String(record.status ?? ""));
}

export function executionRecords(workspace: string, sessionId?: string): Array<Record<string, unknown>> {
  const runs = path.join(workspace, ".migent", "sessions");
  if (!existsSync(runs)) return [];
  const sessions = sessionId === undefined ? readdirSync(runs) : [sessionId];
  const records: Array<Record<string, unknown>> = [];
  for (const id of sessions) {
    const executions = path.join(runs, id, "executions");
    if (!existsSync(executions)) continue;
    for (const executionId of readdirSync(executions)) {
      const filePath = path.join(executions, executionId, "execution.json");
      if (!existsSync(filePath)) continue;
      records.push(JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>);
    }
  }
  records.sort((left, right) => {
    const leftSession = String(left.session_id ?? "");
    const rightSession = String(right.session_id ?? "");
    if (leftSession < rightSession) return -1;
    if (leftSession > rightSession) return 1;
    return Number(left.execution_order ?? 0) - Number(right.execution_order ?? 0);
  });
  return records;
}

export function sessionStatus(workspace: string, sessionId: string): Record<string, unknown> {
  const filePath = path.join(workspace, ".migent", "sessions", sessionId, "status.json");
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

export function asRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value.map((item) => asRecord(item));
}

function executionTexts(workspace: string): Map<string, string> {
  const root = path.join(workspace, ".migent", "sessions");
  const files = new Map<string, string>();
  if (!existsSync(root)) return files;
  for (const sessionId of readdirSync(root)) {
    const executions = path.join(root, sessionId, "executions");
    if (!existsSync(executions)) continue;
    for (const executionId of readdirSync(executions)) {
      const filePath = path.join(executions, executionId, "execution.json");
      if (!existsSync(filePath)) continue;
      files.set(`${sessionId}/${executionId}`, readFileSync(filePath, "utf8"));
    }
  }
  return files;
}

function executionFingerprint(text: string): string {
  const record = JSON.parse(text) as Record<string, unknown>;
  return JSON.stringify({
    status: record.status ?? null,
    outcome: record.outcome ?? null,
    completed_at: record.completed_at ?? null,
    failure_reason: record.failure_reason ?? null,
  });
}

function sessionIdFromRun(workspace: string, argv: string[], stderr: string): string | null {
  const match = /session_id: (\S+)/.exec(stderr);
  if (match?.[1]) return match[1];
  const continueAt = argv.indexOf("continue");
  if (continueAt >= 0 && argv[continueAt + 1] && !argv[continueAt + 1].startsWith("-")) return argv[continueAt + 1] ?? null;
  const sessionAt = argv.indexOf("--session");
  if (sessionAt >= 0 && argv[sessionAt + 1] && !argv[sessionAt + 1].startsWith("-")) return argv[sessionAt + 1] ?? null;
  const root = path.join(workspace, ".migent", "sessions");
  if (!existsSync(root)) return null;
  const ids = readdirSync(root).filter((name) => existsSync(path.join(root, name, "status.json")));
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

function stopReasonFor(code: number, status: string): string {
  if (code === 130) return "cancelled";
  if (code === 8) return "quota";
  if (code === 7) return "verify_failed";
  if (code === 6) return "verify_exhausted";
  if (code === 5) return "dispatch_limit";
  if (code === 4) return "revisions_exhausted";
  if (code === 3) return "stage_failed";
  if (code === 2) return "configuration";
  if (status === "completed") return "completed";
  if (status === "blocked") return "blocked";
  if (status === "cancelled") return "cancelled";
  return "stage";
}

function workflowResult(
  workspace: string,
  argv: string[],
  code: number,
  stderr: string,
  before: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const sessionId = sessionIdFromRun(workspace, argv, stderr);
  if (sessionId === null) return {};
  const stages: Array<Record<string, unknown>> = [];
  for (const [key, text] of executionTexts(workspace)) {
    if (!key.startsWith(`${sessionId}/`)) continue;
    const previous = before.get(key);
    if (previous !== undefined && executionFingerprint(previous) === executionFingerprint(text)) continue;
    const record = JSON.parse(text) as Record<string, unknown>;
    const executionId = String(record.execution_id ?? key.slice(sessionId.length + 1));
    const outcome =
      typeof record.outcome === "object" && record.outcome !== null && !Array.isArray(record.outcome)
        ? (record.outcome as Record<string, unknown>)
        : {};
    stages.push({
      execution_id: executionId,
      execution_order: record.execution_order,
      agent_id: record.agent_id ?? "",
      outcome_status: typeof outcome.status === "string" ? outcome.status : "",
      outcome_decision: typeof outcome.decision === "string" ? outcome.decision : "",
      artifact_directory: path.join(workspace, ".migent", "sessions", sessionId, "executions", executionId, "artifacts"),
      response: executionResponse(workspace, sessionId, executionId),
    });
  }
  stages.sort((left, right) => Number(left.execution_order ?? 0) - Number(right.execution_order ?? 0));
  let status: Record<string, unknown> = {};
  try {
    status = sessionStatus(workspace, sessionId);
  } catch {
    status = {};
  }
  const sessionStatusText = typeof status.status === "string" ? status.status : "";
  return {
    session_id: sessionId,
    session_status: sessionStatusText,
    stop_reason: stopReasonFor(code, sessionStatusText),
    outputs: status.outputs ?? {},
    stages,
  };
}

function executionResponse(workspace: string, sessionId: string, executionId: string): string {
  const filePath = path.join(workspace, ".migent", "sessions", sessionId, "executions", executionId, "response.md");
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf8");
}

function jsonObjects(text: string): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (!stripped.startsWith("{")) continue;
    objects.push(JSON.parse(stripped) as Record<string, unknown>);
  }
  return objects;
}

async function capture(fn: () => Promise<unknown> | unknown): Promise<{ stdout: string; stderr: string; value: unknown }> {
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    const value = await fn();
    return { stdout, stderr, value };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}
