import Type, { type Static, type TSchema } from "typebox";

/** Base for every `$id`. Final host is decided before schemas are published (epic #97, PR 6). */
export const SCHEMA_BASE = "https://migent.dev/schemas";

export const id = (path: string): string => `${SCHEMA_BASE}/${path}.json`;

/** Any JSON object. The only guarantee for persisted passthrough output. */
export const AnyJsonObject = Type.Record(Type.String(), Type.Unknown(), {
  $id: id("common/json-object"),
  title: "JSON object",
  description: "Any JSON object. No property is declared.",
});
export type AnyJsonObject = Static<typeof AnyJsonObject>;

export const SessionStatus = Type.Union(
  ["active", "prepared", "completed", "blocked", "question", "cancelled", "corrupt"].map((value) => Type.Literal(value)),
  { $id: id("common/session-status"), title: "Session status" },
);
export type SessionStatus = Static<typeof SessionStatus>;

export const Severity = Type.Union([Type.Literal("error"), Type.Literal("warning")], {
  $id: id("common/severity"),
  title: "Diagnostic severity",
});

export const Diagnostic = Type.Object(
  {
    severity: Severity,
    code: Type.String({ description: "Stable machine-readable code." }),
    message: Type.String(),
    source: Type.Optional(Type.String({ description: "project, local, effective, or workflow." })),
    file: Type.Optional(Type.String()),
    draft: Type.Optional(Type.Boolean()),
    path: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number()]))),
    line: Type.Optional(Type.Number()),
    column: Type.Optional(Type.Number()),
    end_line: Type.Optional(Type.Number()),
    end_column: Type.Optional(Type.Number()),
  },
  { $id: id("common/diagnostic"), title: "Diagnostic", description: "One authoring diagnostic." },
);
export type Diagnostic = Static<typeof Diagnostic>;

export const NextSuggestion = Type.Object(
  {
    workflow: Type.String(),
    task: Type.String(),
    artifacts: Type.Record(Type.String(), Type.Object({ output: Type.String(), path: Type.String() })),
    argv: Type.Array(Type.String()),
    command: Type.String({ description: "The argv rendered as a shell command line." }),
  },
  { $id: id("common/next-suggestion"), title: "Next workflow suggestion" },
);
export type NextSuggestion = Static<typeof NextSuggestion>;

export const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** The list form of an item contract. Derived, never declared separately: `…/x.json` becomes `…/x-list.json`. */
export const listOf = <T extends TSchema>(item: T) => {
  const rawId = (item as { $id?: unknown }).$id;
  const itemId = typeof rawId === "string" ? rawId : null;
  return Type.Array(item, itemId === null ? {} : { $id: itemId.replace(/\.json$/, "-list.json"), title: `List of ${itemId}` });
};
