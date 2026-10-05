import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const homeOs = {
  homedir(): string {
    return homedir();
  },
};

export function migentHomePath(): string {
  const override = process.env.MIGENT_HOME;
  if (override) return override;
  return path.join(homeOs.homedir(), ".migent");
}

export function registryHomePath(): string {
  return path.join(migentHomePath(), "registry");
}

export function ensureRegistryHome(directory?: string): string {
  const target = directory ?? registryHomePath();
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  return target;
}
