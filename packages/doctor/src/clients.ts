import type { EffectiveClientFailure } from "@nodeint/migent-kernel";

/** Where a client-binding failure sits relative to the agent definition. */
export function failurePath(failure: EffectiveClientFailure): string[] {
  if (failure.part === "options") return ["client", "options"];
  return ["client", "type"];
}

/** `flat` names the resolved target a freeze pins (`client`, `options`), not an agent definition. */
export function failureText(field: string, failure: EffectiveClientFailure, flat = false): string {
  const where = flat ? failure.part : failurePath(failure).join(".");
  return failure.part === "options"
    ? `${field}.${where}: ${failure.message}`
    : `${field}.${where} ${failure.message}`;
}
