import type { CliClient } from "../types.js";
import { AgyClient } from "./agy-client.js";
import { ClaudeCodeClient } from "./claude-code-client.js";
import { CodexClient } from "./codex-client.js";
import { GrokClient } from "./grok-client.js";
import { OpencodeClient } from "./opencode-client.js";

/**
 * The known CLI clients. Each call builds a new instance, so per-run parser
 * state is never shared between concurrent stages.
 */
const clientFactories: Record<string, () => CliClient> = {
  agy: () => new AgyClient(),
  "claude-code": () => new ClaudeCodeClient(),
  codex: () => new CodexClient(),
  grok: () => new GrokClient(),
  opencode: () => new OpencodeClient(),
};

export function clientIds(): string[] {
  return Object.keys(clientFactories).sort();
}

export function createClient(clientId: string): CliClient {
  const factory = Object.hasOwn(clientFactories, clientId) ? clientFactories[clientId] : undefined;
  if (factory === undefined) {
    throw new Error(`Unknown CLI client: ${clientId}. Supported: ${clientIds().join(", ")}`);
  }
  return factory();
}
