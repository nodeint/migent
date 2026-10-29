import { KERNEL_PLACEHOLDER, type Provider } from "./types.js";
import { AgyProvider } from "./providers/agy-provider.js";
import { ByteplusProvider } from "./providers/byteplus-provider.js";
import { ClaudeProvider } from "./providers/claude-provider.js";
import { CodexProvider } from "./providers/codex-provider.js";
import { GrokProvider } from "./providers/grok-provider.js";
import { OpencodeProvider } from "./providers/opencode-provider.js";

export const ADAPTERS_PLACEHOLDER = `providers:${KERNEL_PLACEHOLDER}`;

// Re-export all types from types.ts để adapters hoàn toàn độc lập
export {
  KERNEL_PLACEHOLDER,
  STATUS_PROVIDER_EVENTS,
  isRecord,
  classifyProviderError,
  providerErrorMessage,
} from "./types.js";

export type {
  CommandSpec,
  ProviderInfo,
  ProviderResolver,
  ProviderOption,
  NewSession,
  BuildCommandInput,
  UsageCapture,
  TurnUsage,
  QuotaClassification,
  ProviderClassification,
  FailureClassification,
  Provider,
  RawFailure,
  CliModelCatalog,
  CliUsage,
  CliRunOutput,
  CliClient,
} from "./types.js";

export { ModelCatalog } from "./catalog.js";
export { clientIds, createClient } from "./providers/provider-base.js";
export { AgyClient } from "./clients/agy-client.js";
export { AgyProvider } from "./providers/agy-provider.js";
export { ByteplusProvider } from "./providers/byteplus-provider.js";
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
    byteplus: new ByteplusProvider(),
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
