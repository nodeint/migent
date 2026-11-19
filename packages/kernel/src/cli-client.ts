import type { CliClient, ClientOption, NativeOptionSupport } from '@nodeint/migent-contracts';

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
  InterruptOutcome,
  NativeOptionSupport,
  NewSession,
  ProviderClassification,
  QuotaClassification,
  RawFailure,
  ResponseSource,
  TurnUsage,
  UsageCapture,
} from '@nodeint/migent-contracts';

/** The narrow client surface config resolution and doctor need. */
export interface ClientInfo {
  readonly id: string;
  readonly command: string;
  readonly effortOption?: string;
  readonly nativeOptions?: NativeOptionSupport;
  options(): readonly ClientOption[];
  validateOptions(options: Readonly<Record<string, string>>): void;
}

/**
 * The one selection entry point. The kernel only defines the interface; the CLI
 * composition root builds it from the adapters' `createClient`/`clientIds`.
 * `get` throws a `ConfigurationError` that names the supported IDs.
 */
export interface ClientRegistry {
  ids(): string[];
  get(id: string): CliClient;
  /**
   * Optional: finds the clients whose model list contains `model`, so an agent can omit
   * `client.type`. The composition root implements it (it may run list commands); the kernel only
   * applies the decision rule. A registry without it keeps `client.type` required.
   */
  clientsForModel?(model: string): ModelClientLookup;
}

/** Which clients list a model, and which could not be searched. */
export interface ModelClientLookup {
  /** Client ids whose model list contains the model. */
  matches: readonly string[];
  /** Clients whose model list was read. */
  searched: readonly string[];
  /** Clients whose executable is not on PATH. */
  skipped: readonly string[];
  /** Clients whose list command failed, with the reason. */
  failed: readonly { client: string; reason: string }[];
}
