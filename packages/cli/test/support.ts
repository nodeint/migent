import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, BuildCommandInput, CommandSpec } from "@nodeint/migent-kernel";

export interface AdapterCall {
  model: string;
  workspace: string;
  prompt: string;
  agent_id: string | null;
  new_agent_id: string | null;
  prompt_file: string;
  options: Record<string, string>;
}

export class FakeAdapter implements AgentAdapter {
  readonly command = "fake";
  readonly calls: AdapterCall[] = [];

  validateOptions(_options: Readonly<Record<string, string>>): void {}

  buildCommand(input: BuildCommandInput): CommandSpec {
    this.calls.push({
      model: input.model,
      workspace: input.workspace,
      prompt: input.prompt,
      agent_id: input.agentId,
      new_agent_id: input.newAgentId,
      prompt_file: input.promptFile,
      options: { ...input.options },
    });
    return { argv: [process.execPath, "-e", "process.exit(0)"] };
  }

  parseResponse(stdout: string, _lastMessageFile: string): [string, string | null] {
    const data = JSON.parse(stdout) as { text?: string; sessionId?: string | null };
    return [data.text ?? "", data.sessionId ?? null];
  }
}

export class ScriptedAdapter extends FakeAdapter {
  private responses: string[];
  private artifacts: Array<string | null>;

  constructor(responses: readonly string[], artifacts?: ReadonlyArray<string | null>) {
    super();
    this.responses = [...responses];
    this.artifacts = artifacts === undefined ? [] : [...artifacts];
  }

  parseResponse(_stdout: string, _lastMessageFile: string): [string, string | null] {
    if (this.artifacts.length > 0) {
      const body = this.artifacts.shift() ?? null;
      const prompt = this.calls.at(-1)?.prompt;
      if (body !== null && prompt) writePromptArtifact(prompt, body);
    }
    const response = this.responses.shift();
    if (response === undefined) throw new Error("ScriptedAdapter has no response left.");
    return [response, "native-session-1"];
  }
}

function writePromptArtifact(prompt: string, body: string): void {
  const marker = "Migent artifact directory:\n";
  const at = prompt.indexOf(marker);
  if (at === -1) return;
  const lines = prompt.slice(at + marker.length).split("\n");
  const directory = lines[0]?.trim() ?? "";
  if (!directory) return;
  let name: string | null = null;
  for (const line of lines.slice(1, 6)) {
    const markerAt = line.indexOf("as `");
    if (markerAt === -1) continue;
    const rest = line.slice(markerAt + 4);
    const end = rest.indexOf("`");
    if (end !== -1) name = rest.slice(0, end);
    break;
  }
  if (!name) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, name), body, "utf8");
}

export const FAKE_FLOW_CONFIG = `\
schema_version: 1
models:
  fake-model:
    provider: fake
    model: m1
    options:
      effort: medium
roles:
  planner:
    default_model: fake-model
  reviewer:
    default_model: fake-model
  developer:
    default_model: fake-model
`;

const FIXTURES = fileURLToPath(new URL("./fixtures/workflows/", import.meta.url));

export function repoWorkflowText(workflowId: string): string {
  return readFileSync(path.join(FIXTURES, `${workflowId}.yaml`), "utf8");
}

export function writeFakeWorkflowWorkspace(documents: Record<string, string>): string {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), FAKE_FLOW_CONFIG, "utf8");
  for (const [workflowId, document] of Object.entries(documents)) {
    writeFileSync(path.join(workflows, `${workflowId}.yaml`), document, "utf8");
  }
  return workspace;
}

export function removeWorkspace(workspace: string): void {
  rmSync(workspace, { recursive: true, force: true });
}

export async function capture(
  fn: () => Promise<unknown> | unknown,
): Promise<{ stdout: string; stderr: string; value: unknown }> {
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
