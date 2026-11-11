import { KERNEL_PLACEHOLDER } from './types.js';

export const ADAPTERS_PLACEHOLDER = `clients:${KERNEL_PLACEHOLDER}`;

// Re-export all types from types.ts để adapters hoàn toàn độc lập
export { ModelCatalog } from './catalog.js';
export { AgyClient } from './clients/agy-client.js';
export { ClaudeCodeClient } from './clients/claude-code-client.js';
export { CodexClient } from './clients/codex-client.js';
export { GrokClient } from './clients/grok-client.js';
export { OpencodeClient } from './clients/opencode-client.js';
export { clientIds, createClient } from './clients/registry.js';
export type {
  BuildCommandInput,
  CliClient,
  ClientOption,
  CliModelCatalog,
  CliRunOutput,
  CliUsage,
  CommandSpec,
  FailureClassification,
  FailureOrigin,
  NewSession,
  ProviderClassification,
  QuotaClassification,
  RawFailure,
  ResponseSource,
  TurnUsage,
  UsageCapture,
} from './types.js';
export type { HeadlessOption } from './types.js';
export {
  classifyProviderError,
  isRecord,
  KERNEL_PLACEHOLDER,
  providerErrorMessage,
  STATUS_PROVIDER_EVENTS,
} from './types.js';
export type { HelpOptionsFormat } from './utils/parse-help-options.js';
export { parseHelpOptions } from './utils/parse-help-options.js';
