import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { clientIds, createClient } from '@nodeint/migent-adapters';
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

const optionKey = /^[A-Za-z][A-Za-z0-9_.-]*$/;

const grokOptions = new Set([
  'reasoning-effort',
  'max_turns',
  'tools',
  'disallowed_tools',
  'permission_mode',
  'rules',
  'allow',
  'deny',
  'sandbox',
]);

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

/** A client for doctor checks: only the metadata the doctor reads carries behavior. */
class TestClient implements CliClient {
  public readonly optionsList: readonly ClientOption[] = [];

  constructor(
    public readonly id: string,
    public readonly command: string,
    private readonly validate: (options: Readonly<Record<string, string>>) => void,
    public readonly effortOption?: string,
  ) {}

  public options(): readonly ClientOption[] {
    return this.optionsList;
  }

  public validateOptions(options: Readonly<Record<string, string>>): void {
    this.validate(options);
  }

  public runCommand(_input: BuildCommandInput): CommandSpec {
    throw new Error('doctor tests never run a client turn.');
  }

  public modelsCommand(): CommandSpec {
    throw new Error('doctor tests never list models.');
  }

  public versionCommand(): CommandSpec {
    throw new Error('doctor tests never read a version.');
  }

  public parseRun(_stdout: string, _lastMessageFile: string): CliRunOutput {
    throw new Error('doctor tests never parse a turn.');
  }

  public parseModels(_stdout: string): CliModelCatalog {
    return { ids: [], defaultId: null, optionValues: [], valuesFor: () => null };
  }

  public parseVersion(_stdout: string): string | null {
    return null;
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

/** A client with no option rules, for tests that only need distinct ids and commands. */
export function testClient(id: string, command: string): CliClient {
  return new TestClient(id, command, () => {});
}

export function clientRegistryOf(clients: Record<string, CliClient>): ClientRegistry {
  return {
    ids: () => Object.keys(clients),
    get: (id: string): CliClient => {
      const client = clients[id];
      if (client === undefined) throw new Error(`Unknown CLI client: ${id}`);
      return client;
    },
  };
}

export function defaultClients(): ClientRegistry {
  return clientRegistryOf({
    codex: new TestClient('codex', 'codex', (options) => {
      for (const [key, value] of Object.entries(options)) {
        if (!optionKey.test(key)) throw new Error(`${key} is not a codex option.`);
        if (value.trim() === '') throw new Error(`${key} is empty.`);
      }
    }, 'model_reasoning_effort'),
    grok: new TestClient('grok', 'grok', (options) => {
      for (const [key, value] of Object.entries(options)) {
        if (!grokOptions.has(key)) throw new Error(`${key} is not a grok option.`);
        if (value.trim() === '') throw new Error(`${key} is empty.`);
      }
    }, 'reasoning-effort'),
  });
}

/** The production registry, for tests that exercise real client parsers. */
export function adaptersClients(): ClientRegistry {
  return {
    ids: () => clientIds(),
    get: (id: string): CliClient => createClient(id),
  };
}

export function whichFound(found: ReadonlySet<string>): (command: string) => string | null {
  return (command) => (found.has(command) ? `/bin/${command}` : null);
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
    agent: gpt-terra
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
