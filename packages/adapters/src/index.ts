import { KERNEL_PLACEHOLDER, type Provider } from "@nodeint/migent-kernel";
import { AgyProvider } from "./providers/agy-provider.js";
import { ClaudeProvider } from "./providers/claude-provider.js";
import { CodexProvider } from "./providers/codex-provider.js";
import { GrokProvider } from "./providers/grok-provider.js";
import { OpencodeProvider } from "./providers/opencode-provider.js";

export const ADAPTERS_PLACEHOLDER = `providers:${KERNEL_PLACEHOLDER}`;

export { ModelCatalog } from "./catalog.js";
export { AgyClient } from "./clients/agy-client.js";
export { AgyProvider } from "./providers/agy-provider.js";
export { ClaudeCodeClient } from "./clients/claude-code-client.js";
export { ClaudeProvider } from "./providers/claude-provider.js";
export { CodexClient } from "./clients/codex-client.js";
export { CodexProvider } from "./providers/codex-provider.js";
export { GrokClient } from "./clients/grok-client.js";
export { GrokProvider } from "./providers/grok-provider.js";
export { OpencodeClient } from "./clients/opencode-client.js";
export { OpencodeProvider } from "./providers/opencode-provider.js";

export function defaultProviders(): Record<string, Provider> {
  return {
    agy: new AgyProvider(),
    claude: new ClaudeProvider(),
    codex: new CodexProvider(),
    grok: new GrokProvider(),
    opencode: new OpencodeProvider(),
  };
}

export function providerCommands(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(defaultProviders()).map(([name, provider]) => [name, provider.command]),
  );
}
