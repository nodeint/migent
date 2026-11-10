import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@nodeint/migent-workflow";

export function nonempty(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function textField(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function readJsonObject(filePath: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!isRecord(value)) throw new Error(`Expected a JSON object: ${filePath}`);
  return value;
}

export function latestExecutionPerStage<
  T extends { context: { executionId: string }; metadata: Record<string, unknown>; order: number },
>(rows: readonly T[]): T[] {
  const byStage = new Map<string, T>();
  for (const row of rows) {
    const stageId = typeof row.metadata.stage_id === "string" ? row.metadata.stage_id : "";
    const current = byStage.get(stageId);
    if (
      current === undefined ||
      compareSortKey([row.order, row.context.executionId], [current.order, current.context.executionId]) > 0
    ) {
      byStage.set(stageId, row);
    }
  }
  return [...byStage.values()];
}

export function verifyReportPath(directory: string, verify: unknown): string | null {
  if (!isRecord(verify) || typeof verify.last_report !== "string" || verify.last_report === "") {
    return null;
  }
  return path.join(directory, verify.last_report);
}

export function isDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

export function asInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return 0;
}

export function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function compareSortKey(left: [number, string], right: [number, string]): number {
  if (left[0] !== right[0]) return left[0] - right[0];
  if (left[1] < right[1]) return -1;
  if (left[1] > right[1]) return 1;
  return 0;
}
