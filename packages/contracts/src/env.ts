import Type, { type Static } from "typebox";
import { id } from "./common.js";

/**
 * Environment variables Migent honors. Pure data describing current behavior: no value is ever
 * validated and no value causes an error. The runtime reader is `packages/kernel/src/env.ts`.
 */

const processes = Type.Array(Type.String(), { description: "Processes that honor the variable." });
const base = { name: Type.String(), description: Type.String(), processes };

/** Exact, case-sensitive values turn the setting on. Unset, empty, and any other value leave it off. */
export const FlagEnvVar = Type.Object(
  { ...base, kind: Type.Literal("flag"), enabling_values: Type.Array(Type.String()) },
  { title: "Flag variable" },
);

/** Any non-empty value is used verbatim (not trimmed). Unset or empty applies `default`. */
export const PathEnvVar = Type.Object(
  { ...base, kind: Type.Literal("path"), default: Type.String() },
  { title: "Path override variable" },
);

/** Not interpreted. The caller's value (empty included) reaches `child`; only when absent is `default_value` set. */
export const ChildDefaultEnvVar = Type.Object(
  { ...base, kind: Type.Literal("child_default"), default_value: Type.String(), child: Type.String() },
  { title: "Child default variable" },
);

export const EnvVar = Type.Union([FlagEnvVar, PathEnvVar, ChildDefaultEnvVar], {
  $id: id("env/env-var"),
  title: "Environment variable",
});
export type EnvVar = Static<typeof EnvVar>;

export const ENV_CATALOG = [
  {
    name: "MIGENT_DEBUG",
    kind: "flag",
    enabling_values: ["1", "true"],
    description: "Writes the process-wrapper start/stop trace to stderr and debug.log. The wrapper reads its inherited value once at startup.",
    processes: ["cli", "service", "process-wrapper"],
  },
  {
    name: "MIGENT_NO_INPUT",
    kind: "flag",
    enabling_values: ["1"],
    description: "Same effect as --no-input: never prompt.",
    processes: ["cli"],
  },
  {
    name: "MIGENT_HOME",
    kind: "path",
    default: "<os home>/.migent",
    description: "Overrides the directory that holds Migent's user-level state, including the registry.",
    processes: ["cli", "service"],
  },
  {
    name: "DISABLE_TELEMETRY",
    kind: "child_default",
    default_value: "1",
    child: "npx skills",
    description: "Migent does not interpret it. When `migent skill` spawns `npx skills`, the caller's value passes through; if absent, it is set to the default.",
    processes: ["cli"],
  },
] as const satisfies readonly EnvVar[];

export type EnvVarName = (typeof ENV_CATALOG)[number]["name"];
