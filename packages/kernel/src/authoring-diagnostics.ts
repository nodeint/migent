import { ROLE_KEYS } from "./config-structure.js";
import { isRecord } from "@nodeint/migent-workflow";
import { unknownKeyEntries } from "@nodeint/migent-workflow";
import type { UnknownKey } from "@nodeint/migent-workflow";

/** Role-key feedback for config documents. Workflow-key feedback lives in `@nodeint/migent-workflow`. */
const ROLE_V4_RENAMED: Readonly<Record<string, string>> = {
  default_model: "was renamed to {location}.agent in schema_version 5. Run `migent migrate`.",
  instructions: "was renamed to {location}.responsibilities in schema_version 5. Run `migent migrate`.",
  options: "is no longer supported. Move options into the role's agent under client.options.",
};

/** Unknown keys under each role of a config document, with their paths. */
export function unknownRoleKeyEntries(config: Record<string, unknown>): UnknownKey[] {
  if (!isRecord(config.roles)) return [];
  return Object.entries(config.roles).flatMap(([name, role]) =>
    isRecord(role)
      ? unknownKeyEntries(role, ROLE_KEYS, `roles.${name}`, ["roles", name], ROLE_V4_RENAMED)
      : []);
}

/** Unknown keys under each role of a config document. */
export function unknownRoleKeys(config: Record<string, unknown>): string[] {
  return unknownRoleKeyEntries(config).map((entry) => entry.message);
}
