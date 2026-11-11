import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { confirm as clackConfirm, isCancel } from '@clack/prompts';
import { assertConfigClientEquivalence, checkDocumentSchemaVersion, CONFIG_CLIENTS_LIFT_FROM, ConfigEditError, ConfigurationError, documentVersion, loadWorkspaceConfig, loadYamlMapping, localConfigPath, mergeConfigLayers, migrateConfig, migrateWorkflow, patchConfigText, patchWorkflowText, sha256Hex, stringifyConfig, yamlHasComments } from '@nodeint/migent-kernel';
import { SessionLock, SessionLockHeldError,WORKFLOW_FREEZE_FILE } from '@nodeint/migent-session';
import { parseWorkflowMapping, parseYamlDocument,SCHEMA_VERSION, workflowsDirectory } from '@nodeint/migent-workflow';

import { clientRegistry } from './client.js';
import { printError, printNotice } from './display.js';
import { EXIT_CONFIG } from './exits.js';
import { isDirectory, isFile } from './fs-utils.js';

function versionList(entries: readonly [string, number][]): string {
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries.map(([label, version]) => `  ${label.padEnd(width)}  v${version}`).join('\n');
}

interface Rewrite {
  path: string;
  text: string;
  notes: string[];
  /** Session files only: the session directory to lock and the text the plan was made from. */
  session?: { directory: string; original: string };
}

/** `configOnly` skips `.migent/workflows/`, for a check that never reads the project catalog. */
export function requireCurrentSchema(workspace: string, options: { configOnly?: boolean } = {}): void {
  const newer: [string, number][] = [];
  const older: [string, number][] = [];
  const files = schemaFiles(workspace).filter(([label]) => options.configOnly !== true || !label.includes('/workflows/'));
  for (const [label, filePath] of files) {
    const version = storedVersion(filePath);
    if (version === null || version === SCHEMA_VERSION) continue;
    (version > SCHEMA_VERSION ? newer : older).push([label, version]);
  }
  if (older.length > 0) {
    throw new ConfigurationError(
      `Schema is outdated (this Migent uses v${SCHEMA_VERSION}).\n${versionList(older)}\n\n` +
        'Run `migent migrate` to update.',
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
    clientIds?: readonly string[] | null;
  } = {},
): Promise<number> {
  const clientIds = options.clientIds ?? clientRegistry().ids();
  const rewrites = pendingRewrites(workspace, clientIds);
  if (rewrites.length === 0) {
    process.stdout.write('Schema is current.\n');
    return 0;
  }
  for (const rewrite of rewrites) {
    for (const note of rewrite.notes) printNotice(note);
  }
  if (!options.assumeYes && !(await accepted(options.confirm ?? null))) {
    return (options.confirm === null || options.confirm === undefined) && !process.stdin.isTTY ? EXIT_CONFIG : 0;
  }
  if (!applyRewrites(workspace, rewrites)) return EXIT_CONFIG;
  process.stdout.write(`Upgraded schema to version ${SCHEMA_VERSION}.\n`);
  return 0;
}

/** Writes every rewrite under the session locks; false after reporting why nothing was written. */
function applyRewrites(workspace: string, rewrites: readonly Rewrite[]): boolean {
  const locks: SessionLock[] = [];
  try {
    // Session files change only under the session lock, and only if they still match the plan.
    for (const directory of [...new Set(rewrites.flatMap((item) => (item.session ? [item.session.directory] : [])))]) {
      locks.push(SessionLock.acquire(directory));
    }
    for (const rewrite of rewrites) assertSessionFileUnchanged(workspace, rewrite);
    for (const rewrite of rewrites) writeFileSync(rewrite.path, rewrite.text, 'utf8');
    return true;
  } catch (error) {
    if (!(error instanceof SessionLockHeldError || error instanceof ConfigurationError)) throw error;
    printError(`${error.message} Nothing was written.`);
    return false;
  } finally {
    for (const lock of locks) lock.release();
  }
}

function assertSessionFileUnchanged(workspace: string, rewrite: Rewrite): void {
  if (rewrite.session === undefined) return;
  let current: string | null = null;
  try {
    if (lstatSync(rewrite.path).isFile()) current = readFileSync(rewrite.path, 'utf8');
  } catch {
    // Treated as changed below.
  }
  if (current !== rewrite.session.original) {
    throw new ConfigurationError(`${path.relative(workspace, rewrite.path)} changed during migration. Nothing was written; run \`migent migrate\` again.`);
  }
}

async function accepted(confirm: ((message: string) => boolean | Promise<boolean>) | null): Promise<boolean> {
  const question = `Upgrade schema to version ${SCHEMA_VERSION}?`;
  if (confirm !== null) {
    if (await confirm(question)) return true;
    process.stdout.write('Left unchanged.\n');
    return false;
  }
  if (!process.stdin.isTTY) {
    printError('Pass --yes to upgrade without confirmation.');
    return false;
  }
  const result = await clackConfirm({ message: question, initialValue: false });
  if (isCancel(result) || result !== true) {
    process.stdout.write('Left unchanged.\n');
    return false;
  }
  return true;
}

function pendingRewrites(workspace: string, clientIds: readonly string[]): Rewrite[] {
  const configPath = path.join(workspace, '.migent', 'config.yaml');
  if (!isFile(configPath)) return [];
  const originalContext = loadWorkspaceConfig(workspace);
  const projectOriginal = readConfigOriginal(configPath);
  if (projectOriginal === null) return [];
  const localPath = localConfigPath(workspace);
  const localOriginal = isFile(localPath) ? readConfigOriginal(localPath) : null;
  // Older layers must reach v5 before the client lift inspects their merged shape.
  const toV5 = (layer: Record<string, unknown>): Record<string, unknown> =>
    documentVersion(layer) < CONFIG_CLIENTS_LIFT_FROM
      ? migrateConfig(layer, { current: CONFIG_CLIENTS_LIFT_FROM, context: originalContext }).document
      : layer;
  const projectV5 = toV5(projectOriginal);
  const localV5 = localOriginal === null ? null : toV5(localOriginal);
  const context = mergeConfigLayers(projectV5, localV5).config;
  const [config, configRewrite] = configRewriteOf(configPath, projectOriginal, {
    context,
    clientIds,
    layers: { layer: 'project', project: projectV5, local: localV5 },
  });
  if (config === null) return [];
  const [local, localRewrite] = localOriginal === null
    ? [null, null]
    : configRewriteOf(localPath, localOriginal, {
      context,
      clientIds,
      layers: { layer: 'local', project: projectV5, local: localV5 },
    });
  const rewrites = [configRewrite, localRewrite].filter((item): item is Rewrite => item !== null);
  const effective = local === null ? config : mergeConfigLayers(config, local).config;
  // Both views must keep the client every location had in the original v5 documents.
  assertConfigClientEquivalence({
    originalProject: projectV5,
    originalMerged: context,
    updatedProject: config,
    updatedMerged: effective,
  });
  rewrites.push(...workflowRewrites(workspace, effective, clientIds));
  rewrites.push(...sessionRewrites(workspace, effective, clientIds));
  return rewrites;
}

function readConfigOriginal(filePath: string): Record<string, unknown> | null {
  try {
    return loadYamlMapping(filePath);
  } catch {
    return null;
  }
}

function schemaFiles(workspace: string): [string, string][] {
  const files: [string, string][] = [['.migent/config.yaml', path.join(workspace, '.migent', 'config.yaml')]];
  files.push(['.migent/config.local.yaml', localConfigPath(workspace)]);
  const directory = workflowsDirectory(workspace);
  if (isDirectory(directory)) {
    for (const name of readdirSync(directory).filter((item) => item.endsWith('.yaml')).sort()) {
      const filePath = path.join(directory, name);
      if (isFile(filePath)) files.push([`.migent/workflows/${name}`, filePath]);
    }
  }
  return files;
}

function storedVersion(filePath: string): number | null {
  if (!isFile(filePath)) return null;
  try {
    const result = checkDocumentSchemaVersion(loadYamlMapping(filePath));
    return result.status === 'invalid' ? null : result.version;
  } catch {
    return null;
  }
}

function configRewriteOf(
  filePath: string,
  originalDocument: Record<string, unknown>,
  migration: {
    context: Record<string, unknown>;
    clientIds: readonly string[];
    layers: { layer: 'project' | 'local'; project: Record<string, unknown>; local: Record<string, unknown> | null };
  },
): [Record<string, unknown> | null, Rewrite | null] {
  const { context, clientIds, layers } = migration;
  const original = readFileSync(filePath, 'utf8');
  let updated: Record<string, unknown>;
  let notes: string[];
  try {
    ({ document: updated, notes } = migrateConfig(originalDocument, {
      ...layers,
      context,
      merged: context,
      clientIds,
    }));
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return [null, null];
  }
  if (notes.length === 0) return [updated, null];
  let rewritten: string;
  try {
    rewritten = patchConfigText(original, updated);
  } catch (error) {
    if (!(error instanceof ConfigEditError)) throw error;
    // A layout the line patcher cannot edit (flow-style mappings): write the canonical rendering.
    rewritten = stringifyConfig(updated);
  }
  if (rewritten === original) return [updated, null];
  const labeled = notes.map((note) =>
    note.startsWith('schema_version') ? `Migrated .migent/${path.basename(filePath)} ${note}` : note,
  );
  // The text patcher keeps comments; when it cannot (flow-style mappings), say so instead of dropping them silently.
  if (yamlHasComments(original) && !yamlHasComments(rewritten)) {
    labeled.push(`.migent/${path.basename(filePath)}: comments could not be preserved by this migration`);
  }
  return [updated, { path: filePath, text: rewritten, notes: labeled }];
}

function workflowRewrites(
  workspace: string,
  config: Record<string, unknown>,
  clientIds: readonly string[],
): Rewrite[] {
  const directory = workflowsDirectory(workspace);
  if (!isDirectory(directory)) return [];
  const rewrites: Rewrite[] = [];
  for (const name of readdirSync(directory).filter((item) => item.endsWith('.yaml')).sort()) {
    const filePath = path.join(directory, name);
    if (!isFile(filePath)) continue;
    const original = readFileSync(filePath, 'utf8');
    let parsed: Record<string, unknown>;
    try {
      parsed = loadYamlMapping(filePath);
    } catch {
      continue;
    }
    const result = rewrittenWorkflow({ original, relative: `.migent/workflows/${name}` }, parsed, { config, clientIds });
    if (result !== null) rewrites.push({ path: filePath, ...result });
  }
  return rewrites;
}

/** The migrated workflow, or null when migration fails on a non-configuration error. */
function tryMigrateWorkflow(
  document: Record<string, unknown>,
  source: { config: Record<string, unknown>; clientIds: readonly string[] },
): { document: Record<string, unknown>; notes: string[] } | null {
  try {
    return migrateWorkflow(document, source.config, { clientIds: source.clientIds });
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return null;
  }
}

/** Migrated workflow text and its notes, or null when nothing changes. */
function rewrittenWorkflow(
  file: { original: string; relative: string },
  parsed: Record<string, unknown>,
  source: { config: Record<string, unknown>; clientIds: readonly string[] },
): { text: string; notes: string[] } | null {
  const { original, relative } = file;
  const migrated = tryMigrateWorkflow(parsed, source);
  if (migrated === null || migrated.notes.length === 0) return null;
  const { document: updated, notes: changed } = migrated;
  let text: string;
  try {
    text = patchWorkflowText(original, updated);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    // The line patcher cannot edit this layout (flow-style stages, a key on the dash line, empty
    // entries): write the migrated document as canonical YAML. Comments are reported below.
    text = stringifyConfig(updated);
    parseWorkflowMapping(updated, 'migrated workflow');
  }
  if (text === original) return null;
  const notes = labelWorkflowNotes(changed, relative);
  if (yamlHasComments(original) && !yamlHasComments(text)) {
    notes.push(`${relative}: comments could not be preserved by this migration`);
  }
  return { text, notes };
}

function labelWorkflowNotes(notes: readonly string[], relative: string): string[] {
  return notes.map((note) =>
    note.startsWith('schema_version') ? `Migrated ${relative} ${note}` : `${relative}: ${note}`,
  );
}



/** Session `workflow.yaml` drafts and `workflow.frozen.yaml` pins follow the same migration as project workflows. */
function isRealDirectory(target: string): boolean {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(target: string): boolean {
  try {
    return lstatSync(target).isFile();
  } catch {
    return false;
  }
}

/** The sessions root must really be `<workspace>/.migent/sessions`; a symlinked parent fails this. */
function realSessionsRoot(workspace: string, root: string): string | null {
  try {
    const realRoot = realpathSync(root);
    return realRoot === path.join(realpathSync(workspace), '.migent', 'sessions') ? realRoot : null;
  } catch {
    return null;
  }
}

function isDirectChild(realRoot: string, target: string): boolean {
  try {
    return path.dirname(realpathSync(target)) === realRoot;
  } catch {
    return false;
  }
}

type MigrationSource = { config: Record<string, unknown>; clientIds: readonly string[] };

function sessionRewrites(
  workspace: string,
  config: Record<string, unknown>,
  clientIds: readonly string[],
): Rewrite[] {
  const root = path.join(workspace, '.migent', 'sessions');
  const realRoot = realSessionsRoot(workspace, root);
  if (realRoot === null || !isRealDirectory(root)) return [];
  const rewrites: Rewrite[] = [];
  for (const id of readdirSync(root).sort()) {
    const directory = path.join(root, id);
    // A symlinked session directory or file could point outside the workspace; leave it alone.
    if (!isRealDirectory(directory) || !isDirectChild(realRoot, directory)) continue;
    rewrites.push(...sessionDirectoryRewrites(directory, `.migent/sessions/${id}`, { config, clientIds }));
  }
  return rewrites;
}

function sessionDirectoryRewrites(directory: string, label: string, source: MigrationSource): Rewrite[] {
  const rewrites: Rewrite[] = [];
  const draftPath = path.join(directory, 'workflow.yaml');
  let draft: { original: string; updated: string | null } | null = null;
  if (isRegularFile(draftPath)) {
    const draftText = readFileSync(draftPath, 'utf8');
    const result = migratedText(draftText, `${label}/workflow.yaml`, source);
    draft = { original: draftText, updated: result?.text ?? null };
    if (result !== null) {
      rewrites.push({
        path: draftPath,
        text: result.text,
        notes: result.notes,
        session: { directory, original: draftText },
      });
    }
  }
  const frozen = frozenRewrite(directory, label, { source, draft });
  if (frozen !== null) rewrites.push(frozen);
  return rewrites;
}

function readFrozenDocument(frozenText: string): Record<string, unknown> | null {
  try {
    const parsed = parseYamlDocument(frozenText);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function frozenRewrite(
  directory: string,
  label: string,
  state: { source: MigrationSource; draft: { original: string; updated: string | null } | null },
): Rewrite | null {
  const frozenPath = path.join(directory, WORKFLOW_FREEZE_FILE);
  if (!isRegularFile(frozenPath)) return null;
  const frozenText = readFileSync(frozenPath, 'utf8');
  const parsed = readFrozenDocument(frozenText);
  if (parsed === null || !isRecord(parsed.workflow)) return null;
  const migrated = tryMigrateWorkflow(parsed.workflow, state.source);
  if (migrated === null || migrated.notes.length === 0) return null;
  const document: Record<string, unknown> = { ...parsed, workflow: migrated.document };
  // The pin records the draft's hash; keep it matching when the draft is rewritten alongside.
  const { draft } = state;
  if (draft !== null && draft.updated !== null && document.source_sha256 === sha256Hex(draft.original)) {
    document.source_sha256 = sha256Hex(draft.updated);
  }
  return {
    path: frozenPath,
    text: stringifyConfig(document),
    session: { directory, original: frozenText },
    notes: labelWorkflowNotes(migrated.notes, `${label}/${WORKFLOW_FREEZE_FILE}`),
  };
}

function migratedText(
  original: string,
  relative: string,
  source: MigrationSource,
): { text: string; notes: string[] } | null {
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(original);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return rewrittenWorkflow({ original, relative }, parsed, source);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
