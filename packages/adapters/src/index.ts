import { KERNEL_PLACEHOLDER } from "./types.js";

export const ADAPTERS_PLACEHOLDER = `clients:${KERNEL_PLACEHOLDER}`;

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
  ClientOption,
  NewSession,
  BuildCommandInput,
  UsageCapture,
  TurnUsage,
  QuotaClassification,
  ProviderClassification,
  FailureClassification,
  FailureOrigin,
  ResponseSource,
  RawFailure,
  CliModelCatalog,
  CliUsage,
  CliRunOutput,
  CliClient,
} from "./types.js";

export { ModelCatalog } from "./catalog.js";
export { clientIds, createClient } from "./clients/registry.js";
export { AgyClient } from "./clients/agy-client.js";
export { ClaudeCodeClient } from "./clients/claude-code-client.js";
export { CodexClient } from "./clients/codex-client.js";
export { GrokClient } from "./clients/grok-client.js";
export { OpencodeClient } from "./clients/opencode-client.js";

export { parseHelpOptions } from "./utils/parse-help-options.js";
export type { HelpOptionsFormat } from "./utils/parse-help-options.js";
export type { HeadlessOption } from "./types.js";
