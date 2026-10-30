import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { confirm as clackConfirm, isCancel } from "@clack/prompts";
import {
  SCHEMA_VERSION,
  documentVersion,
  loadYamlMapping,
  loadWorkspaceConfig,
  localConfigPath,
  mergeConfig,
  migrateConfig,
  migrateWorkflow,
  patchConfigText,
  patchWorkflowText,
  workflowsDirectory,
  type MigrationProvider,
  ConfigurationError,
} from "@nodeint/migent-kernel";
import { printError, printNotice } from "./display.js";
import { isDirectory, isFile } from "./fs-utils.js";
import { providerMap } from "./provider.js";

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
    providers?: Record<string, MigrationProvider> | null;
  } = {},
): Promise<number> {
  const providers = options.providers ?? migrationProviders();
  const rewrites = pendingRewrites(workspace, providers);
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

export function migrationProviders(
  providers: Record<string, unknown> = providerMap(),
): Record<string, MigrationProvider> {
  const mapped: Record<string, MigrationProvider> = {};
  for (const [name, provider] of Object.entries(providers)) {
    const candidate = provider as Partial<MigrationProvider>;
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

function pendingRewrites(workspace: string, providers: Record<string, MigrationProvider>): Rewrite[] {
  const configPath = path.join(workspace, ".migent", "config.yaml");
  if (!isFile(configPath)) return [];
  const context = loadWorkspaceConfig(workspace);
  const [config, configRewrite] = configRewriteOf(configPath, providers, context);
  if (config === null) return [];
  const rewrites: Rewrite[] = [];
  if (configRewrite !== null) rewrites.push(configRewrite);
  let effective = config;
  const localPath = localConfigPath(workspace);
  if (isFile(localPath)) {
    const [local, rewrite] = configRewriteOf(localPath, providers, context);
    if (rewrite !== null) rewrites.push(rewrite);
    if (local !== null) {
      effective = mergeConfig(config, local);
      if (isRecord(local.roles) && isRecord(effective.roles)) {
        for (const [name, role] of Object.entries(local.roles)) {
          const target = effective.roles[name];
          if (isRecord(role) && isRecord(target) && Object.hasOwn(role, "default_model")) {
            target.default_model = role.default_model;
          }
        }
      }
    }
  }
  rewrites.push(...workflowRewrites(workspace, effective, providers));
  return rewrites;
}

function schemaFiles(workspace: string): Array<[string, string]> {
  const files: Array<[string, string]> = [[".migent/config.yaml", path.join(workspace, ".migent", "config.yaml")]];
  files.push([".migent/config.local.yaml", localConfigPath(workspace)]);
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
  providers: Record<string, MigrationProvider>,
  context: Record<string, unknown>,
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
    notes = migrateConfig(updated, providers, SCHEMA_VERSION, context);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return [null, null];
  }
  if (notes.length === 0) return [updated, null];
  const rewritten = patchConfigText(original, updated);
  if (rewritten === original) return [updated, null];
  const labeled = notes.map((note) =>
    note.startsWith("schema_version") ? `Migrated .migent/${path.basename(filePath)} ${note}` : note,
  );
  return [updated, { path: filePath, text: rewritten, notes: labeled }];
}

function workflowRewrites(
  workspace: string,
  config: Record<string, unknown>,
  providers: Record<string, MigrationProvider>,
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
      changed = migrateWorkflow(updated, config, providers);
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



function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
