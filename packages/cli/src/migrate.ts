import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { confirm as clackConfirm, isCancel } from "@clack/prompts";
import {
  SCHEMA_VERSION,
  documentVersion,
  loadYamlMapping,
  migrateConfig,
  migrateWorkflow,
  patchConfigText,
  patchWorkflowText,
  workflowsDirectory,
  type MigrationAdapter,
  ConfigurationError,
} from "@nodeint/migent-kernel";
import { printError, printNotice } from "./display.js";
import { isDirectory, isFile } from "./fs-utils.js";
import { adapterMap } from "./provider.js";

function versionList(entries: ReadonlyArray<[string, number]>): string {
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries.map(([label, version]) => `  ${label.padEnd(width)}  v${version}`).join("\n");
}

interface Rewrite {
  path: string;
  text: string;
  notes: string[];
}

export function requireCurrentSchema(workspace: string): void {
  const newer: Array<[string, number]> = [];
  const older: Array<[string, number]> = [];
  for (const [label, filePath] of schemaFiles(workspace)) {
    const version = storedVersion(filePath);
    if (version === null || version === SCHEMA_VERSION) continue;
    (version > SCHEMA_VERSION ? newer : older).push([label, version]);
  }
  if (older.length > 0) {
    throw new ConfigurationError(
      `Schema is outdated (this Migent uses v${SCHEMA_VERSION}).\n${versionList(older)}\n\n` +
        "Run `migent migrate` to update.",
    );
  }
  if (newer.length > 0) {
    throw new ConfigurationError(
      `Schema is newer than this Migent supports (v${SCHEMA_VERSION}).\n${versionList(newer)}`,
    );
  }
}

export async function runMigrate(
  workspace: string,
  options: {
    assumeYes?: boolean;
    confirm?: ((message: string) => boolean | Promise<boolean>) | null;
    adapters?: Record<string, MigrationAdapter> | null;
  } = {},
): Promise<number> {
  const adapters = options.adapters ?? migrationAdapters();
  const rewrites = pendingRewrites(workspace, adapters);
  if (rewrites.length === 0) {
    process.stdout.write("Schema is current.\n");
    return 0;
  }
  for (const rewrite of rewrites) {
    for (const note of rewrite.notes) printNotice(note);
  }
  if (!options.assumeYes && !(await accepted(options.confirm ?? null))) {
    return options.confirm == null && !process.stdin.isTTY ? 2 : 0;
  }
  for (const rewrite of rewrites) writeFileSync(rewrite.path, rewrite.text, "utf8");
  process.stdout.write(`Upgraded schema to version ${SCHEMA_VERSION}.\n`);
  return 0;
}

export function migrationAdapters(
  adapters: Record<string, unknown> = adapterMap(),
): Record<string, MigrationAdapter> {
  const mapped: Record<string, MigrationAdapter> = {};
  for (const [name, adapter] of Object.entries(adapters)) {
    const candidate = adapter as Partial<MigrationAdapter>;
    mapped[name] = {
      modelMigrations: candidate.modelMigrations ?? {},
      roleMigrations: candidate.roleMigrations ?? {},
      stageMigrations: candidate.stageMigrations ?? {},
    };
  }
  return mapped;
}

async function accepted(confirm: ((message: string) => boolean | Promise<boolean>) | null): Promise<boolean> {
  const question = `Upgrade schema to version ${SCHEMA_VERSION}?`;
  if (confirm !== null) {
    if (await confirm(question)) return true;
    process.stdout.write("Left unchanged.\n");
    return false;
  }
  if (!process.stdin.isTTY) {
    printError("Pass --yes to upgrade without confirmation.");
    return false;
  }
  const result = await clackConfirm({ message: question, initialValue: false });
  if (isCancel(result) || result !== true) {
    process.stdout.write("Left unchanged.\n");
    return false;
  }
  return true;
}

function pendingRewrites(workspace: string, adapters: Record<string, MigrationAdapter>): Rewrite[] {
  const configPath = path.join(workspace, ".migent", "config.yaml");
  if (!isFile(configPath)) return [];
  const [config, configRewrite] = configRewriteOf(configPath, adapters);
  if (config === null) return [];
  const rewrites: Rewrite[] = [];
  if (configRewrite !== null) rewrites.push(configRewrite);
  rewrites.push(...workflowRewrites(workspace, config, adapters));
  return rewrites;
}

function schemaFiles(workspace: string): Array<[string, string]> {
  const files: Array<[string, string]> = [[".migent/config.yaml", path.join(workspace, ".migent", "config.yaml")]];
  const directory = workflowsDirectory(workspace);
  if (isDirectory(directory)) {
    for (const name of readdirSync(directory).filter((item) => item.endsWith(".yaml")).sort()) {
      const filePath = path.join(directory, name);
      if (isFile(filePath)) files.push([`.migent/workflows/${name}`, filePath]);
    }
  }
  return files;
}

function storedVersion(filePath: string): number | null {
  if (!isFile(filePath)) return null;
  try {
    return documentVersion(loadYamlMapping(filePath));
  } catch {
    return null;
  }
}

function configRewriteOf(
  filePath: string,
  adapters: Record<string, MigrationAdapter>,
): [Record<string, unknown> | null, Rewrite | null] {
  const original = readFileSync(filePath, "utf8");
  let parsed: Record<string, unknown>;
  try {
    parsed = loadYamlMapping(filePath);
  } catch {
    return [null, null];
  }
  const updated = structuredClone(parsed);
  let notes: string[];
  try {
    notes = migrateConfig(updated, adapters);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return [null, null];
  }
  if (notes.length === 0) return [updated, null];
  const rewritten = patchConfigText(original, updated);
  if (rewritten === original) return [updated, null];
  const labeled = notes.map((note) =>
    note.startsWith("schema_version") ? `Migrated .migent/config.yaml ${note}` : note,
  );
  return [updated, { path: filePath, text: rewritten, notes: labeled }];
}

function workflowRewrites(
  workspace: string,
  config: Record<string, unknown>,
  adapters: Record<string, MigrationAdapter>,
): Rewrite[] {
  const directory = workflowsDirectory(workspace);
  if (!isDirectory(directory)) return [];
  const rewrites: Rewrite[] = [];
  for (const name of readdirSync(directory).filter((item) => item.endsWith(".yaml")).sort()) {
    const filePath = path.join(directory, name);
    if (!isFile(filePath)) continue;
    const original = readFileSync(filePath, "utf8");
    let parsed: Record<string, unknown>;
    try {
      parsed = loadYamlMapping(filePath);
    } catch {
      continue;
    }
    const updated = structuredClone(parsed);
    let changed: string[];
    try {
      changed = migrateWorkflow(updated, config, adapters);
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      continue;
    }
    if (changed.length === 0) continue;
    const rewritten = patchWorkflowText(original, updated);
    if (rewritten === original) continue;
    const relative = `.migent/workflows/${name}`;
    const notes = changed.map((note) =>
      note.startsWith("schema_version") ? `Migrated ${relative} ${note}` : `${relative}: ${note}`,
    );
    rewrites.push({ path: filePath, text: rewritten, notes });
  }
  return rewrites;
}


