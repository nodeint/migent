import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BuildCommandInput, CliClient, ClientOption, ClientRegistry, CliModelCatalog, CliRunOutput, CliUsage, CommandSpec, UsageCapture } from '@nodeint/migent-kernel';

import { createWorkflowSession } from '../src/session-records.ts';

const optionKey = /^[A-Za-z][A-Za-z0-9_.-]*$/;

export function defaultClients(): ClientRegistry {
  return registryOf({
    codex: new FakeClient('codex', 'codex'),
    grok: new FakeClient('grok', 'grok'),
  });
}

export function registryOf(clients: Record<string, CliClient>): ClientRegistry {
  return {
    ids: () => Object.keys(clients).sort(),
    get: (id: string): CliClient => {
      const client = Object.hasOwn(clients, id) ? clients[id] : undefined;
      if (client === undefined) {
        throw new Error(`Unknown CLI client: ${id}. Supported: ${Object.keys(clients).join(', ')}.`);
      }
      return client;
    },
  };
}

export function whichFound(found: ReadonlySet<string>): (command: string) => string | null {
  return (command) => (found.has(command) ? `/bin/${command}` : null);
}

export const SESSION_CONFIG = `\
schema_version: 7
agents:
  grok:
    client:
      type: grok
    model: grok-4
roles:
  planner:
    agent: grok
  reviewer:
    agent: grok
  developer:
    agent: grok
`;

export function writeSessionConfig(workspace: string): void {
  mkdirSync(path.join(workspace, '.migent'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), SESSION_CONFIG, 'utf8');
}

export const STAGE_CONFIG = `\
schema_version: 7
agents:
  grok:
    client:
      type: grok
      options:
        reasoning-effort: high
    model: grok-4.6
  gpt-terra:
    client:
      type: codex
      options:
        model_reasoning_effort: medium
        temperature: "0.2"
    model: gpt-5.6-terra
roles:
  developer:
    agent: grok
  reviewer:
    agent: gpt-terra
`;

export const STAGE_WORKFLOW = `\
schema_version: 7
id: plan-implement
artifacts:
  implement:
    file: implementation-result.md
stages:
  - id: implement
    role: developer
    depends_on: []
    artifacts: [implement]
  - id: review-work
    role: reviewer
    agent:
      client:
        type: codex
        options:
          model_reasoning_effort: high
          temperature: "0.2"
      model: gpt-5.6-terra
    depends_on:
      - implement
`;

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function writeConfig(contents: string): string {
  const directory = tempDir('migent-config-');
  const filePath = path.join(directory, 'config.yaml');
  writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

export function writeStageWorkspace(): string {
  const workspace = tempDir('migent-stage-');
  const workflows = path.join(workspace, '.migent', 'workflows');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), STAGE_CONFIG, 'utf8');
  writeFileSync(path.join(workflows, 'plan-implement.yaml'), STAGE_WORKFLOW, 'utf8');
  return workspace;
}

export function writeRoleWorkspace(): string {
  const workspace = tempDir('migent-role-');
  const migent = path.join(workspace, '.migent');
  mkdirSync(migent);
  writeFileSync(path.join(migent, 'config.yaml'), STAGE_CONFIG, 'utf8');
  return workspace;
}

export interface ClientCall {
  model: string;
  workspace: string;
  prompt: string;
  agentId: string | null;
  newAgentId: string | null;
  promptFile: string;
  options: Record<string, string>;
}

/** A CLI client a test fully controls: it launches a node one-liner that prints its reply. */
export class FakeClient implements CliClient {
  public readonly id: string;
  public readonly command: string;
  public readonly calls: ClientCall[] = [];
  public captureUsage: (stdout: string) => UsageCapture | null = () => null;
  public readUsage: (capture: UsageCapture) => CliUsage = () => ({
    values: {
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      cost_usd: null,
    },
    cumulative: [],
  });
  public versionCommand: () => CommandSpec = () => ({ argv: [this.command, '--version'] });
  public parseVersion: (stdout: string) => string | null = (stdout) => stdout.trim() || null;

  constructor(id = 'fake', command = 'fake') {
    this.id = id;
    this.command = command;
  }

  public options(): readonly ClientOption[] {
    return [{ name: 'effort', prompt: true, allowDefault: true, overridable: true }];
  }

  public validateOptions(options: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(options)) {
      if (!optionKey.test(key)) throw new Error(`${key} is not a ${this.id} option.`);
      if (value.trim() === '') throw new Error(`${key} is empty.`);
    }
  }

  public buildCommand(input: BuildCommandInput): CommandSpec {
    this.calls.push({
      model: input.model,
      workspace: input.workspace,
      prompt: input.prompt,
      agentId: input.agentId,
      newAgentId: input.newAgentId,
      promptFile: input.promptFile,
      options: { ...input.options },
    });
    const responseInput = (input.prompt.split(/\r\n|\n|\r/)[0] ?? '').replace(/^user: /, '');
    const payload = JSON.stringify({
      text: `status: complete\necho:${responseInput}`,
      sessionId: 'native-session-1',
      call: this.calls.length - 1,
    });
    return {
      argv: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', payload],
    };
  }

  public runCommand(input: BuildCommandInput): CommandSpec {
    return this.buildCommand(input);
  }

  public parseResponse(stdout: string): [string, string | null] {
    const data = JSON.parse(stdout) as { text: string; sessionId?: string };
    return [writeHandoffFromReply(this.parsedPrompt(), data.text), data.sessionId ?? null];
  }

  /** Index of the call whose process produced the output being parsed; concurrent stages interleave. */
  protected parsingCall: number | null = null;

  protected parsedPrompt(): string {
    return (this.parsingCall === null ? this.calls.at(-1) : this.calls[this.parsingCall])?.prompt ?? '';
  }

  public parseRun(stdout: string, lastMessageFile: string): CliRunOutput {
    void lastMessageFile;
    try {
      const {call} = (JSON.parse(stdout) as { call?: unknown });
      this.parsingCall = typeof call === 'number' ? call : null;
    } catch {
      this.parsingCall = null;
    }
    const [text, sessionId] = this.parseResponse(stdout);
    return { text, sessionId, source: 'model' };
  }

  public modelsCommand(): CommandSpec {
    return { argv: [this.command, 'models'] };
  }

  public parseModels(stdout: string): CliModelCatalog {
    const ids = stdout.split(/\r\n|\n|\r/).map((line) => line.trim()).filter((line) => line !== '');
    return { ids, defaultId: null, optionValues: [], valuesFor: () => null };
  }

  public createEventParser(): (line: string) => Record<string, unknown> | null {
    return () => null;
  }

  public eventLabel(line: string): string | null {
    void line;
    return null;
  }

  public extractFailure(stdout: string, exitCode: number): ReturnType<CliClient['extractFailure']> {
    void stdout;
    if (exitCode === 0) return null;
    return { origin: 'exit-only', message: `exited ${exitCode}`, exitCode };
  }

  public optionValuesCommand(option: string, model: string): CommandSpec | null {
    void option;
    void model;
    return null;
  }

  public parseOptionValues(option: string, stdout: string, model: string): readonly string[] {
    void option;
    void stdout;
    void model;
    return [];
  }
}

export class BlockedClient extends FakeClient {
  public override parseResponse(): [string, string | null] {
    return [writeHandoffFromReply(this.parsedPrompt(), 'status: blocked\nblocker: missing approved design'), 'native-session-1'];
  }
}

export class MissingOutcomeClient extends FakeClient {
  public override parseResponse(): [string, string | null] {
    return ['implementation report without a status header', 'native-session-1'];
  }
}

export class ScriptedClient extends FakeClient {
  private responses: string[];
  private artifacts: (string | null | { body: string; only: string[] })[];

  constructor(responses: string[], artifacts?: (string | null | { body: string; only: string[] })[] | null) {
    super();
    this.responses = [...responses];
    this.artifacts = artifacts ? [...artifacts] : [];
  }

  public override parseResponse(): [string, string | null] {
    if (this.artifacts.length > 0) {
      const next = this.artifacts.shift() ?? null;
      const prompt = this.calls.at(-1)?.prompt;
      if (next !== null && prompt !== undefined) {
        if (typeof next === 'string') writePromptArtifact(prompt, next);
        else writePromptArtifact(prompt, next.body, next.only);
      }
    }
    const response = this.responses.shift();
    if (response === undefined) throw new Error('scripted client has no response left');
    return [writeHandoffFromReply(this.parsedPrompt(), response), 'native-session-1'];
  }
}

function writePromptArtifact(prompt: string, body: string, only?: readonly string[]): void {
  // The latest Execution block wins: replayed history can hold earlier ones.
  const directory = [...prompt.matchAll(/^- Artifacts: `(.+)`$/gm)].at(-1)?.[1];
  const names = promptArtifactNames(prompt).filter((name) => only === undefined || only.includes(name));
  if (!directory || names.length === 0) return;
  mkdirSync(directory, { recursive: true });
  for (const name of names) writeFileSync(path.join(directory, name), body, 'utf8');
}

/** File names the latest prompt asks for: the single-artifact line or the multi-file list. */
function promptArtifactNames(prompt: string): string[] {
  const single = [...prompt.matchAll(/^Write the artifact as `(.+?)`/gm)].at(-1)?.[1];
  if (single) return [single];
  const at = prompt.lastIndexOf('Write these artifacts in the artifacts directory:');
  if (at < 0) return [];
  return [...prompt.slice(at).split('\n').slice(1).join('\n').matchAll(/^- `(.+?)`/gm)].map((match) => match[1]!);
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
  const workspace = tempDir('migent-plan-');
  const workflows = path.join(workspace, '.migent', 'workflows');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workflows, 'plan.yaml'), PLAN_REVIEW_WORKFLOW, 'utf8');
  writeSessionConfig(workspace);
  return [workspace, createWorkflowSession(workspace, 'plan', { task: 'Write a plan' })];
}

export function repoWorkflowText(workflowId: string): string {
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'workflows');
  return readFileSync(path.join(fixtures, `${workflowId}.yaml`), 'utf8');
}

/**
 * Protocol 3 shim: a scripted reply that opens with a status header is also written as the handoff
 * file the prompt names. `status: question` with a JSON body, or a `<<FILE>>` section, supplies the
 * questions. Replies without a status header write nothing.
 */
export function writeHandoffFromReply(prompt: string, response: string): string {
  if (!/^- Handoff file: `/m.test(prompt)) return writeQuestionRequestFromReply(prompt, response);
  const target = [...prompt.matchAll(/^- Handoff file: `(.+)`$/gm)].at(-1)?.[1];
  const marker = '\n<<FILE>>';
  const split = response.indexOf(marker);
  const report = split >= 0 ? response.slice(0, split) : response;
  const raw = split >= 0 ? response.slice(split + marker.length) : null;
  if (!target) return report;
  const headers = new Map<string, string>();
  for (const line of report.split(/\r\n|\n|\r/)) {
    const at = line.indexOf(':');
    if (line.trim() === '' || at <= 0) break;
    headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  const status = headers.get('status');
  if (status === undefined && raw === null) return report;
  const questionHead = 'status: question\n\n';
  let content: string | null = null;
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      content = parsed !== null && typeof parsed === 'object' && !('status' in parsed) && status === 'question'
        ? JSON.stringify({ ...parsed, status: 'question' }) : raw;
    } catch {
      content = raw;
    }
  } else if (status === 'question') {
    const body = report.startsWith(questionHead) ? report.slice(questionHead.length) : '';
    if (!body.startsWith('{')) return report;
    content = JSON.stringify({ ...(JSON.parse(body) as Record<string, unknown>), status: 'question' });
    writeFileSync(target, content, 'utf8');
    return questionHead + 'The questions are in the handoff file.';
  } else if (status === 'blocked') {
    content = JSON.stringify({ schema_version: 1, status, blocker: headers.get('blocker') ?? '' });
  } else if (status === 'complete') {
    const decision = headers.get('decision');
    content = JSON.stringify({ schema_version: 1, status, ...(decision ? { decision } : {}) });
  }
  if (content !== null) writeFileSync(target, content, 'utf8');
  return report;
}

/** Protocol 2 shim: `status: question` plus a JSON body, or a `<<FILE>>` section, becomes the question request file. */
export function writeQuestionRequestFromReply(prompt: string, response: string): string {
  const target = [...prompt.matchAll(/^- Question file: `(.+)`$/gm)].at(-1)?.[1];
  const marker = '\n<<FILE>>';
  const split = response.indexOf(marker);
  if (split >= 0) {
    if (target) writeFileSync(target, response.slice(split + marker.length), 'utf8');
    return response.slice(0, split);
  }
  const head = 'status: question\n\n';
  if (!response.startsWith(head) || !response.slice(head.length).startsWith('{')) return response;
  if (target) writeFileSync(target, response.slice(head.length), 'utf8');
  return head + 'The questions are in the request file.';
}
