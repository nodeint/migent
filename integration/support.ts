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
schema_version: 1
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
schema_version: 1
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
schema_version: 1
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
completion:
  stage: review-plan
  decision: approved
  outputs:
    - name: plan
      from_stage: plan
      artifact: plan.md
`;

export const DRAFT_NOTE = `\
schema_version: 1
id: draft-note
stages:
  - id: draft
    role: writer
    depends_on: []
    produces:
      artifact: note.md
`;

export const SOLO = `\
schema_version: 1
id: solo
stages:
  - id: write
    role: planner
    depends_on: []
    produces:
      artifact: note.md
completion:
  stage: write
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
schema_version: 1
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
completion:
  stage: follow
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
  try {
    const captured = await capture(() => main(argv, workspace));
    return [captured.value as number, jsonObjects(captured.stdout), captured.stderr];
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
