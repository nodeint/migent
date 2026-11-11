import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  BuildCommandInput,
  CliClient,
  ClientOption,
  ClientRegistry,
  CliModelCatalog,
  CliRunOutput,
  CliUsage,
  CommandSpec,
  RawFailure,
  UsageCapture,
} from '@nodeint/migent-kernel';
import { raiseCancellation } from '@nodeint/migent-kernel';

export interface ClientCall {
  model: string;
  workspace: string;
  prompt: string;
  agent_id: string | null;
  new_agent_id: string | null;
  prompt_file: string;
  options: Record<string, string>;
}

/** The registry the runner and metrics use: any id a test names resolves to its own client. */
export function registryOf(clients: Record<string, CliClient>): ClientRegistry {
  return {
    ids: () => Object.keys(clients),
    get: (id: string): CliClient => {
      const client = clients[id];
      if (client === undefined) throw new Error(`Unknown CLI client: ${id}`);
      return client;
    },
  };
}

const BLANK_USAGE: CliUsage = {
  values: {
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
  },
  cumulative: [],
};

export class FakeClient implements CliClient {
  public readonly id = 'fake';
  public readonly command = 'fake';
  public readonly calls: ClientCall[] = [];

  public options(): readonly ClientOption[] {
    return [{ name: 'effort', overridable: true }];
  }

  public validateOptions(_options: Readonly<Record<string, string>>): void {}

  public runCommand(input: BuildCommandInput): CommandSpec {
    return this.buildCommand(input);
  }

  /** Records the call and returns the command a subclass wants to run. */
  protected buildCommand(input: BuildCommandInput): CommandSpec {
    this.calls.push({
      model: input.model,
      workspace: input.workspace,
      prompt: input.prompt,
      agent_id: input.agentId,
      new_agent_id: input.newAgentId,
      prompt_file: input.promptFile,
      options: { ...input.options },
    });
    return { argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(JSON.stringify({ call: this.calls.length - 1 }))})`] };
  }

  public parseRun(stdout: string, lastMessageFile: string): CliRunOutput {
    const [text, sessionId] = this.parseResponse(stdout, lastMessageFile);
    return { text, sessionId, source: text === '' ? 'none' : 'model' };
  }

  /** The prompt of the call whose process printed `stdout`; concurrent stages interleave their calls. */
  protected promptFor(stdout: string): string {
    try {
      const {call} = (JSON.parse(stdout) as { call?: unknown });
      if (typeof call === 'number' && this.calls[call] !== undefined) return this.calls[call].prompt;
    } catch { /* fall back to the latest call */ }
    return this.calls.at(-1)?.prompt ?? '';
  }

  protected parseResponse(stdout: string, _lastMessageFile: string): [string, string | null] {
    const data = JSON.parse(stdout) as { text?: string; sessionId?: string | null };
    return [writeHandoffFromReply(this.promptFor(stdout), data.text ?? ''), data.sessionId ?? null];
  }

  public modelsCommand(): CommandSpec {
    return { argv: [process.execPath, '-e', "process.stdout.write('{}')"] };
  }

  public parseModels(_stdout: string): CliModelCatalog {
    return { ids: [], defaultId: null, optionValues: [], valuesFor: () => null };
  }

  public versionCommand(): CommandSpec {
    return { argv: [process.execPath, '-e', "process.stdout.write('fake/1.0.0')"] };
  }

  public parseVersion(stdout: string): string | null {
    return stdout.trim() === '' ? null : stdout.trim();
  }

  public createEventParser(): (line: string) => Record<string, unknown> | null {
    return () => null;
  }

  public extractFailure(_stdout: string, _exitCode: number): RawFailure | null {
    return null;
  }

  public captureUsage(_stdout: string): UsageCapture | null {
    return null;
  }

  public readUsage(_capture: UsageCapture): CliUsage {
    return BLANK_USAGE;
  }

  public optionValuesCommand(_option: string, _model: string): CommandSpec | null {
    return null;
  }

  public parseOptionValues(_option: string, _stdout: string, _model: string): readonly string[] {
    return [];
  }
}

export class ScriptedClient extends FakeClient {
  private responses: string[];
  private artifacts: (string | null)[];

  constructor(responses: readonly string[], artifacts?: readonly (string | null)[]) {
    super();
    this.responses = [...responses];
    this.artifacts = artifacts === undefined ? [] : [...artifacts];
  }

  protected override parseResponse(stdout: string, _lastMessageFile: string): [string, string | null] {
    if (this.artifacts.length > 0) {
      const body = this.artifacts.shift() ?? null;
      const prompt = this.calls.at(-1)?.prompt;
      if (body !== null && prompt) writePromptArtifact(prompt, body);
    }
    const response = this.responses.shift();
    if (response === undefined) throw new Error('ScriptedClient has no response left.');
    return [writeHandoffFromReply(this.promptFor(stdout), response), 'native-session-1'];
  }
}

function writePromptArtifact(prompt: string, body: string): void {
  // The latest Execution block wins: replayed history can hold earlier ones.
  const directory = [...prompt.matchAll(/^- Artifacts: `(.+)`$/gm)].at(-1)?.[1];
  const names = promptArtifactNames(prompt);
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
  return [...prompt.slice(at).split('\n').slice(1).join('\n').matchAll(/^- `(.+?)`/gm)].map((match) => match[1]);
}

export const FAKE_FLOW_CONFIG = `\
schema_version: 7
agents:
  fake-model:
    client:
      type: fake
      options:
        effort: medium
    model: m1
roles:
  planner:
    agent: fake-model
  reviewer:
    agent: fake-model
  developer:
    agent: fake-model
`;

const FIXTURES = fileURLToPath(new URL('./fixtures/workflows/', import.meta.url));

export function repoWorkflowText(workflowId: string): string {
  return readFileSync(path.join(FIXTURES, `${workflowId}.yaml`), 'utf8');
}

export function writeFakeWorkflowWorkspace(documents: Record<string, string>): string {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-cli-'));
  const workflows = path.join(workspace, '.migent', 'workflows');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), FAKE_FLOW_CONFIG, 'utf8');
  for (const [workflowId, document] of Object.entries(documents)) {
    writeFileSync(path.join(workflows, `${workflowId}.yaml`), document, 'utf8');
  }
  return workspace;
}

export function removeWorkspace(workspace: string): void {
  rmSync(workspace, { recursive: true, force: true });
}

export async function capture(
  fn: () => Promise<unknown> | unknown,
): Promise<{ stdout: string; stderr: string; value: unknown }> {
  let stdout = '';
  let stderr = '';
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
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

/** A scripted client whose first turn raises a cancellation, so the session stays resumable. */
export class CancelOnCommand extends ScriptedClient {
  public override buildCommand(input: BuildCommandInput): CommandSpec {
    super.buildCommand(input);
    raiseCancellation(osConstants.signals.SIGINT);
    return { argv: [process.execPath, '-e', 'process.exit(0)'] };
  }
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
