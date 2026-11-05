import { z } from "zod";
import type { ConfigOwner, ProviderInfo } from "@nodeint/migent-kernel";

export interface Check {
  name: string;
  ok: boolean;
  items: string[];
  problems: string[];
  warnings: string[];
}

const checkSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  items: z.array(z.string()),
  problems: z.array(z.string()),
  warnings: z.array(z.string()),
});

export interface ModelEffortCheck {
  problem?: string;
  warning?: string;
}

export interface DiagnoseOptions {
  providers: Readonly<Record<string, ProviderInfo>>;
  which?: (command: string) => string | null;
  modelEffortChecks?: Readonly<Record<string, ModelEffortCheck>>;
}

/**
 * One finding, with enough structure to be de-duplicated and attributed without reading its text.
 * `message` is the text users see today; the rest is internal until the public schema is fixed.
 */
export interface Diagnostic {
  severity: "error" | "warning";
  /** Stable rule id. Kernel rules keep the code they were thrown with. */
  code: string;
  message: string;
  /** Field path in the effective config, when the finding belongs to one. */
  path?: readonly (string | number)[];
  /** The underlying reason, for findings whose message adds a label (e.g. provider option errors). */
  detail?: string;
  /** Which layer supplies the offending node, derived from the merge. */
  source?: { layer: ConfigOwner } | { workflow: string };
  position?: { line: number; column: number };
}

/** Identity of a finding independent of its wording: the rule and where it applies. */
export function diagnosticKey(diagnostic: Pick<Diagnostic, "code" | "path" | "message">): string {
  return `${diagnostic.code}|${diagnostic.path === undefined ? "" : JSON.stringify(diagnostic.path)}|${diagnostic.message}`;
}

/**
 * What two findings must share to be the same root cause: the rule and the path when there is one,
 * otherwise the text.
 */
export function identityKey(diagnostic: Pick<Diagnostic, "code" | "path" | "message">): string {
  return diagnostic.path === undefined
    ? `text|${diagnostic.message}`
    : `${diagnostic.code}|${JSON.stringify(diagnostic.path)}`;
}

/** Collects findings in order and drops exact repeats. */
export class DiagnosticList {
  readonly items: Diagnostic[] = [];
  private readonly seen = new Set<string>();

  add(diagnostic: Diagnostic): void {
    const key = `${diagnostic.severity}|${diagnosticKey(diagnostic)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push(diagnostic);
  }

  get errors(): Diagnostic[] {
    return this.items.filter((item) => item.severity === "error");
  }

  get warnings(): Diagnostic[] {
    return this.items.filter((item) => item.severity === "warning");
  }
}

export function passed(name: string, items: readonly string[], warnings: readonly string[] = []): Check {
  return checkSchema.parse({ name, ok: true, items: [...items], problems: [], warnings: [...warnings] });
}

export function failed(
  name: string,
  problems: readonly string[],
  items: readonly string[] = [],
  warnings: readonly string[] = [],
): Check {
  return checkSchema.parse({
    name,
    ok: false,
    items: [...items],
    problems: [...problems],
    warnings: [...warnings],
  });
}

export function makeCheck(name: string, items: string[], problems: string[], warnings: string[]): Check {
  return { name, ok: problems.length === 0, items, problems, warnings };
}

/** Appends `message` unless the list already has it. */
export function addUnique(list: string[], message: string): void {
  if (!list.includes(message)) list.push(message);
}
