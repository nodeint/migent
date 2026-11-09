import { UpdateCheck, type Static } from "@nodeint/migent-contracts";
import { writeJson } from "../emit.js";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { printError } from "../display.js";
import { PACKAGE_VERSION } from "../version.js";

const PACKAGE_NAME = "@nodeint/migent";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2f")}/latest`;

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface UpdateOptions {
  check?: boolean;
  asJson?: boolean;
  /** Installed version. Defaults to the running package version. */
  current?: string;
  /** Path of the running script, used to detect the package manager. */
  installPath?: string;
}

export type FetchLatest = () => Promise<string>;
export type UpdateRunner = (argv: string[]) => number;

/** Test seams for `migent update`. Production leaves both null. */
export const updateHooks: { fetchLatest: FetchLatest | null; run: UpdateRunner | null } = {
  fetchLatest: null,
  run: null,
};

async function fetchLatestVersion(): Promise<string> {
  const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`registry answered ${response.status}`);
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== "string") throw new Error("registry response has no version");
  return body.version;
}

/** Negative when `a` is older than `b`. Pre-release suffixes sort before the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): [number[], string] => {
    const [core = "", pre = ""] = value.replace(/^v/, "").split("-", 2);
    return [core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre];
  };
  const [left, leftPre] = parse(a);
  const [right, rightPre] = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (leftPre === rightPre) return 0;
  if (leftPre === "") return 1;
  if (rightPre === "") return -1;
  return leftPre < rightPre ? -1 : 1;
}

/** Package manager that owns the install containing `installPath`, or null when unknown. */
export function detectPackageManager(installPath: string): PackageManager | null {
  const normalized = installPath.replace(/\\/g, "/").toLowerCase();
  if (!normalized.includes("/node_modules/")) return null;
  if (normalized.includes("/.bun/")) return "bun";
  if (normalized.includes("/pnpm/") || normalized.includes("/.pnpm/")) return "pnpm";
  if (normalized.includes("/yarn/")) return "yarn";
  return "npm";
}

export function upgradeCommand(manager: PackageManager): string[] {
  const spec = `${PACKAGE_NAME}@latest`;
  switch (manager) {
    case "npm": return ["npm", "install", "-g", spec];
    case "pnpm": return ["pnpm", "add", "-g", spec];
    case "yarn": return ["yarn", "global", "add", spec];
    case "bun": return ["bun", "add", "-g", spec];
  }
}

function defaultRun(argv: string[]): number {
  const [command = "", ...args] = argv;
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  return result.status ?? 1;
}

function runningScriptPath(): string {
  try {
    return realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return fileURLToPath(import.meta.url);
  }
}

export async function runUpdate(options: UpdateOptions = {}): Promise<number> {
  const current = options.current ?? PACKAGE_VERSION;
  let latest: string;
  try {
    latest = await (updateHooks.fetchLatest ?? fetchLatestVersion)();
  } catch (error) {
    printError(`Could not check the latest version: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const outdated = compareVersions(current, latest) < 0;
  const manager = detectPackageManager(options.installPath ?? runningScriptPath());
  const command = manager === null ? upgradeCommand("npm") : upgradeCommand(manager);
  const commandText = command.join(" ");
  const base = { current, latest, update_available: outdated };

  if (!outdated) {
    report(options, { ...base, updated: false }, `Migent ${current} is up to date.`);
    return 0;
  }
  if (options.check === true) {
    report(
      options,
      { ...base, updated: false, command: commandText },
      `Migent ${current} is installed; ${latest} is available. Run \`migent update\` to upgrade.`,
    );
    return 0;
  }
  if (manager === null) {
    report(
      options,
      { ...base, updated: false, command: commandText },
      `Migent ${current} is installed; ${latest} is available.\n` +
        `Could not tell how it was installed. Upgrade it with your package manager, for example:\n  ${commandText}`,
    );
    return 0;
  }
  if (options.asJson !== true) process.stdout.write(`Updating Migent ${current} -> ${latest}\n  ${commandText}\n`);
  const code = (updateHooks.run ?? defaultRun)(command);
  if (code !== 0) {
    printError(`\`${commandText}\` failed with exit ${code}.`);
    return code;
  }
  report(
    options,
    { ...base, updated: true, command: commandText, next: ["migent migrate", "migent skill update"] },
    `Updated Migent to ${latest}.\nNext: run \`migent migrate\` if the schema changed, and \`migent skill update\` to refresh the installed skill.`,
  );
  return 0;
}

function report(options: UpdateOptions, data: Static<typeof UpdateCheck>, message: string): void {
  if (options.asJson === true) writeJson(UpdateCheck, data);
  else process.stdout.write(`${message}\n`);
}
