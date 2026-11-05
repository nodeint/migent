import type { EffectiveProviderFailure, ProviderInfo } from "@nodeint/migent-kernel";

/** The message for a provider-binding failure of the target declared at `field`. */
export function failureText(field: string, failure: EffectiveProviderFailure): string {
  return failure.part === "options"
    ? `${field}.options: ${failure.message}`
    : `${field}.${failure.part} ${failure.message}`;
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
