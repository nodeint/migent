import { KERNEL_PLACEHOLDER, type AgentAdapter } from "@migent/kernel";
import { CodexAdapter } from "./codex-adapter.js";
import { GrokAdapter } from "./grok-adapter.js";

export const ADAPTERS_PLACEHOLDER = `adapters:${KERNEL_PLACEHOLDER}`;

export { ModelCatalog } from "./catalog.js";
export { CodexAdapter } from "./codex-adapter.js";
export { GrokAdapter } from "./grok-adapter.js";

export function defaultAdapters(): Record<string, AgentAdapter> {
  return { codex: new CodexAdapter(), grok: new GrokAdapter() };
}

export function providerCommands(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(defaultAdapters()).map(([name, adapter]) => [name, adapter.command]),
  );
}
