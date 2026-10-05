import type { CommandSpec } from "./command-executor.js";

/** Methods doctor and config resolution call. Migrations are out of scope. */
export interface ProviderAdapter {
  readonly command: string;
  validateOptions(options: Readonly<Record<string, string>>): void;
}

export interface ProviderOption {
  name: string;
  prompt?: boolean;
  allowDefault?: boolean;
  overridable?: boolean;
}

export interface NewSession {
  agentId?: string | null;
  agentIdSource?: string | null;
}

export interface BuildCommandInput {
  model: string;
  workspace: string;
  prompt: string;
  agentId: string | null;
  newAgentId: string | null;
  promptFile: string;
  lastMessageFile: string;
  options: Readonly<Record<string, string>>;
}

/** Provider CLI surface used by the workflow runner. Not the adapters package. */
export interface AgentAdapter extends ProviderAdapter {
  providerOptions?(): readonly ProviderOption[];
  profileOptions?(options: Readonly<Record<string, string>>): Record<string, string>;
  createNewSession?(): NewSession;
  buildCommand(input: BuildCommandInput): CommandSpec;
  parseResponse(stdout: string, lastMessageFile: string): [string, string | null];
  parseProgressEvent?(line: string): Record<string, unknown> | null;
}

const grokOptionNames = new Set([
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

export class CodexAdapter implements AgentAdapter {
  readonly command = "codex";

  validateOptions(options: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(options)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key)) throw new Error(`${key} is not a codex option.`);
      if (value.trim() === "") throw new Error(`${key} is empty.`);
    }
  }

  providerOptions(): ProviderOption[] {
    return [{ name: "model_reasoning_effort", prompt: true, allowDefault: true, overridable: true }];
  }

  buildCommand(): CommandSpec {
    throw new Error("codex adapter is not available in the kernel.");
  }

  parseResponse(): [string, string | null] {
    throw new Error("codex adapter is not available in the kernel.");
  }
}

export class GrokAdapter implements AgentAdapter {
  readonly command = "grok";

  validateOptions(options: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(options)) {
      if (!grokOptionNames.has(key)) throw new Error(`${key} is not a grok option.`);
      if (value.trim() === "") throw new Error(`${key} is empty.`);
    }
  }

  providerOptions(): ProviderOption[] {
    return [
      { name: "reasoning-effort", prompt: true, allowDefault: true, overridable: true },
      { name: "max_turns" },
      { name: "tools" },
      { name: "disallowed_tools" },
      { name: "permission_mode" },
      { name: "rules" },
      { name: "allow" },
      { name: "deny" },
      { name: "sandbox" },
    ];
  }

  buildCommand(): CommandSpec {
    throw new Error("grok adapter is not available in the kernel.");
  }

  parseResponse(): [string, string | null] {
    throw new Error("grok adapter is not available in the kernel.");
  }
}

export function defaultAdapters(): Record<string, AgentAdapter> {
  return { codex: new CodexAdapter(), grok: new GrokAdapter() };
}
