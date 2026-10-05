import { existsSync, readFileSync } from "node:fs";

export function readExistingText(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf8");
}
