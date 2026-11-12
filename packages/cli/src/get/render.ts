import { listOf, type Static, type TSchema } from '@nodeint/migent-contracts';
import { stringify } from 'yaml';

import { serializeJson } from '../emit.js';

export type OutputFormat = 'human' | 'json' | 'yaml' | 'name';
export const OUTPUT_FORMATS: readonly string[] = ['json', 'yaml', 'name'];

export interface Column {
  header: string;
  cell: (view: Record<string, unknown>) => string;
}

function yamlText(value: unknown): string {
  return stringify(value, { lineWidth: 0 });
}

function table(views: readonly Record<string, unknown>[], columns: readonly Column[]): string {
  const rows = [columns.map((column) => column.header), ...views.map((view) => tableCells(view, columns))];
  const widths = columns.map((_, index) => columnWidth(rows, index));
  return rows.map((row) => tableLine(row, widths)).join('\n').concat('\n');
}

function tableCells(view: Record<string, unknown>, columns: readonly Column[]): string[] {
  return columns.map((column) => column.cell(view));
}

function columnWidth(rows: readonly string[][], index: number): number {
  let width = 0;
  for (const row of rows) width = Math.max(width, row[index].length);
  return width;
}

/** Pads every cell but the last to its column width. */
function tableLine(row: readonly string[], widths: readonly number[]): string {
  const last = row.length - 1;
  const cells = row.map((cell, index) => (index === last ? cell : cell.padEnd(widths[index])));
  return cells.join('  ').trimEnd();
}

function names(views: readonly Record<string, unknown>[]): string {
  return views.map((view) => String(view.name)).join('\n').concat(views.length > 0 ? '\n' : '');
}

/** Renders a list of views in the requested format. */
export function renderList<S extends TSchema>(
  items: readonly Static<S>[],
  format: OutputFormat,
  shape: { columns: readonly Column[]; itemContract: S },
): string {
  const { columns, itemContract } = shape;
  if (format === 'json') return `${serializeJson(listOf(itemContract), [...items], true)}\n`;
  const views = items as readonly Record<string, unknown>[];
  if (format === 'yaml') return views.length === 0 ? '[]\n' : yamlText(views);
  if (format === 'name') return names(views);
  return views.length === 0 ? '' : table(views, columns);
}

/** Renders one view. The human format is the YAML view. */
export function renderOne<S extends TSchema>(item: Static<S>, format: OutputFormat, contract: S): string {
  if (format === 'json') return `${serializeJson(contract, item, true)}\n`;
  const view = item as Record<string, unknown>;
  if (format === 'name') return `${String(view.name)}\n`;
  return yamlText(view);
}

export function cell(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (Array.isArray(value)) return value.length === 0 ? '-' : value.map(String).join(',');
  if (typeof value === 'object' && (value as { inline?: unknown }).inline === true) return '(inline)';
  return String(value);
}
