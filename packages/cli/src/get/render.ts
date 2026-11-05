import { stringify } from "yaml";

export type OutputFormat = "human" | "json" | "yaml" | "name";
export const OUTPUT_FORMATS: readonly string[] = ["json", "yaml", "name"];

export interface Column {
  header: string;
  cell: (view: Record<string, unknown>) => string;
}

function yamlText(value: unknown): string {
  return stringify(value, { lineWidth: 0 });
}

function table(views: readonly Record<string, unknown>[], columns: readonly Column[]): string {
  const rows = [columns.map((column) => column.header), ...views.map((view) => columns.map((column) => column.cell(view)))];
  const widths = columns.map((_, index) => Math.max(...rows.map((row) => row[index]!.length)));
  return rows
    .map((row) => row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]!))).join("  ").trimEnd())
    .join("\n")
    .concat("\n");
}

function names(views: readonly Record<string, unknown>[]): string {
  return views.map((view) => String(view.name)).join("\n").concat(views.length > 0 ? "\n" : "");
}

/** Renders a list of views in the requested format. */
export function renderList(views: readonly Record<string, unknown>[], format: OutputFormat, columns: readonly Column[]): string {
  if (format === "json") return `${JSON.stringify(views, null, 2)}\n`;
  if (format === "yaml") return views.length === 0 ? "[]\n" : yamlText(views);
  if (format === "name") return names(views);
  return views.length === 0 ? "" : table(views, columns);
}

/** Renders one view. The human format is the YAML view. */
export function renderOne(view: Record<string, unknown>, format: OutputFormat): string {
  if (format === "json") return `${JSON.stringify(view, null, 2)}\n`;
  if (format === "name") return `${String(view.name)}\n`;
  return yamlText(view);
}

export function cell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) return value.length === 0 ? "-" : value.map(String).join(",");
  return String(value);
}
