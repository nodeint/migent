import type { EffectiveProviderFailure, ProviderInfo } from "@nodeint/migent-kernel";

/** The message for a provider-binding failure of the target declared at `field`. */
/** Where a provider failure sits relative to the agent definition: client settings live under `client`. */
export function failurePath(failure: EffectiveProviderFailure): string[] {
  if (failure.part === "options") return ["client", "options"];
  if (failure.part === "client") return ["client", "type"];
  return ["provider"];
}

/** `flat` names the resolved target a freeze pins (`client`, `options`), not an agent definition. */
export function failureText(field: string, failure: EffectiveProviderFailure, flat = false): string {
  const where = flat ? failure.part : failurePath(failure).join(".");
  return failure.part === "options"
    ? `${field}.${where}: ${failure.message}`
    : `${field}.${where} ${failure.message}`;
}

/**
 * The provider bound to the target's CLI client; the base provider when no client is named or it
 * cannot switch. Lenient on purpose: the strict check reports an unusable client once, elsewhere.
 */
export function withTargetClient(provider: ProviderInfo | undefined, client: string | undefined): ProviderInfo | undefined {
  if (provider === undefined || client === undefined || provider.withClient === undefined) return provider;
  try {
    return provider.withClient(client);
  } catch {
    return provider;
  }
}
