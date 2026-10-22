import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Provider, BuildCommandInput, ProviderInfo, TurnUsage, UsageCapture } from "../src/provider-contract.ts";
import type { CommandSpec } from "../src/command-executor.ts";
import { createWorkflowSession } from "../src/session-records.ts";

const optionKey = /^[A-Za-z][A-Za-z0-9_.-]*$/;

const grokOptions = new Set([
  "reasoning-effort",
  "max_turns",
  "tools",
  "disallowed_tools",
  "permission_mode",
  "rules",
  "allow",
  "deny",
  "sandbox",
]);

export function defaultProviders(): Record<string, ProviderInfo> {
  return {
    codex: {
      command: "codex",
      validateOptions(options) {
        for (const [key, value] of Object.entries(options)) {
          if (!optionKey.test(key)) throw new Error(`${key} is not a codex option.`);
          if (value.trim() === "") throw new Error(`${key} is empty.`);
        }
      },
    },
    grok: {
      command: "grok",
      validateOptions(options) {
        for (const [key, value] of Object.entries(options)) {
          if (!grokOptions.has(key)) throw new Error(`${key} is not a grok option.`);
          if (value.trim() === "") throw new Error(`${key} is empty.`);
        }
      },
    },
  };
}

export function whichFound(found: ReadonlySet<string>): (command: string) => string | null {
  return (command) => (found.has(command) ? `/bin/${command}` : null);
}

export const SESSION_CONFIG = `\
models:
  grok:
    provider: grok
    model: grok-4
roles:
  planner:
    default_model: grok
  reviewer:
    default_model: grok
  developer:
    default_model: grok
`;

export function writeSessionConfig(workspace: string): void {
  mkdirSync(path.join(workspace, ".migent"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), SESSION_CONFIG, "utf8");
}

export const STAGE_CONFIG = `\
models:
  grok:
    provider: grok
    model: grok-4.6
    options:
      reasoning-effort: high
  gpt-terra:
    provider: codex
    model: gpt-5.6-terra
    options:
      model_reasoning_effort: medium
      temperature: "0.2"
roles:
  developer:
    default_model: grok
  reviewer:
    default_model: gpt-terra
    options:
      model_reasoning_effort: medium
`;

export const STAGE_WORKFLOW = `\
id: plan-implement
stages:
  - id: implement
    role: developer
    depends_on: []
    produces:
      artifact: implementation-result.md
  - id: review-work
    role: reviewer
    model: gpt-terra
    options:
      model_reasoning_effort: high
    depends_on:
      - implement
`;

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function writeConfig(contents: string): string {
  const directory = tempDir("migent-config-");
  const filePath = path.join(directory, "config.yaml");
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

export function writeStageWorkspace(): string {
  const workspace = tempDir("migent-stage-");
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), STAGE_CONFIG, "utf8");
  writeFileSync(path.join(workflows, "plan-implement.yaml"), STAGE_WORKFLOW, "utf8");
  return workspace;
}

export function writeRoleWorkspace(): string {
  const workspace = tempDir("migent-role-");
  const migent = path.join(workspace, ".migent");
  mkdirSync(migent);
  writeFileSync(path.join(migent, "config.yaml"), STAGE_CONFIG, "utf8");
  return workspace;
}

export interface ProviderCall {
  model: string;
  workspace: string;
  prompt: string;
  agentId: string | null;
  newAgentId: string | null;
  promptFile: string;
  options: Record<string, string>;
}

export class FakeProvider implements Provider {
  readonly command = "fake";
  readonly calls: ProviderCall[] = [];
  captureUsage?: (stdout: string) => UsageCapture | null;
  normalizeUsage?: (current: UsageCapture, previous: UsageCapture | null) => TurnUsage;
  versionCommand?: () => string[];
  parseVersion?: (stdout: string) => string | null;

  providerOptions() {
    return [{ name: "effort", prompt: true, allowDefault: true, overridable: true }];
  }

  validateOptions(): void {}

  buildCommand(input: BuildCommandInput): CommandSpec {
    this.calls.push({
      model: input.model,
      workspace: input.workspace,
      prompt: input.prompt,
      agentId: input.agentId,
      newAgentId: input.newAgentId,
      promptFile: input.promptFile,
      options: { ...input.options },
    });
    const responseInput = (input.prompt.split(/\r\n|\n|\r/)[0] ?? "").replace(/^user: /, "");
    const payload = JSON.stringify({
      text: `status: complete\necho:${responseInput}`,
      sessionId: "native-session-1",
    });
    return {
      argv: [process.execPath, "-e", "process.stdout.write(process.argv[1])", payload],
    };
  }

  parseResponse(stdout: string): [string, string | null] {
    const data = JSON.parse(stdout) as { text: string; sessionId?: string };
    return [data.text, data.sessionId ?? null];
  }
}

export class BlockedProvider extends FakeProvider {
  override parseResponse(): [string, string | null] {
    return ["status: blocked\nblocker: missing approved design", "native-session-1"];
  }
}

export class MissingOutcomeProvider extends FakeProvider {
  override parseResponse(): [string, string | null] {
    return ["implementation report without a status header", "native-session-1"];
  }
}

export class ScriptedProvider extends FakeProvider {
  private responses: string[];
  private artifacts: Array<string | null>;

  constructor(responses: string[], artifacts?: Array<string | null> | null) {
    super();
    this.responses = [...responses];
    this.artifacts = artifacts ? [...artifacts] : [];
  }

  override parseResponse(): [string, string | null] {
    if (this.artifacts.length > 0) {
      const body = this.artifacts.shift() ?? null;
      const prompt = this.calls.at(-1)?.prompt;
      if (body !== null && prompt !== undefined) writePromptArtifact(prompt, body);
    }
    const response = this.responses.shift();
    if (response === undefined) throw new Error("scripted provider has no response left");
    return [response, "native-session-1"];
  }
}

function writePromptArtifact(prompt: string, body: string): void {
  const marker = "Migent artifact directory:\n";
  const markerAt = prompt.indexOf(marker);
  if (markerAt < 0) return;
  const rest = prompt.slice(markerAt + marker.length);
  const lines = rest.split(/\r\n|\n|\r/);
  if (lines.length === 0 || lines[0] === undefined) return;
  const directory = lines[0].trim();
  let name: string | null = null;
  for (const line of lines.slice(1, 6)) {
    const start = line.indexOf("as `");
    if (start >= 0) {
      const tail = line.slice(start + 4);
      const end = tail.indexOf("`");
      if (end >= 0) name = tail.slice(0, end);
      break;
    }
  }
  if (!name) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, name), body, "utf8");
}

export const PLAN_REVIEW_WORKFLOW = `\
id: plan
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

export function writePlanReviewSession(): [string, string] {
  const workspace = tempDir("migent-plan-");
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workflows, "plan.yaml"), PLAN_REVIEW_WORKFLOW, "utf8");
  writeSessionConfig(workspace);
  return [workspace, createWorkflowSession(workspace, "plan", "Write a plan")];
}

export function repoWorkflowText(workflowId: string): string {
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workflows");
  return readFileSync(path.join(fixtures, `${workflowId}.yaml`), "utf8");
}
