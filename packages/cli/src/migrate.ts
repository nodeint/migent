import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { confirm as clackConfirm, isCancel } from "@clack/prompts";
import { documentVersion, checkDocumentSchemaVersion, loadYamlMapping, loadWorkspaceConfig, localConfigPath, mergeConfigLayers, assertConfigClientEquivalence, migrateConfig, migrateWorkflow, patchConfigText, patchWorkflowText, stringifyConfig, WORKFLOW_FREEZE_FILE, SessionLock, SessionLockHeldError, sha256Hex, yamlHasComments, ConfigEditError, ConfigurationError } from "@nodeint/migent-kernel";
import { SCHEMA_VERSION, parseWorkflowMapping, workflowsDirectory, parseYamlDocument } from "@nodeint/migent-workflow";
import { printError, printNotice } from "./display.js";
import { clientRegistry } from "./client.js";
import { isDirectory, isFile } from "./fs-utils.js";

function versionList(entries: ReadonlyArray<[string, number]>): string {
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries.map(([label, version]) => `  ${label.padEnd(width)}  v${version}`).join("\n");
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
  const newer: Array<[string, number]> = [];
  const older: Array<[string, number]> = [];
  const files = schemaFiles(workspace).filter(([label]) => options.configOnly !== true || !label.includes("/workflows/"));
  for (const [label, filePath] of files) {
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
    clientIds?: readonly string[] | null;
  } = {},
): Promise<number> {
  const clientIds = options.clientIds ?? clientRegistry().ids();
  const rewrites = pendingRewrites(workspace, clientIds);
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
  const locks: SessionLock[] = [];
  try {
    // Session files change only under the session lock, and only if they still match the plan.
    for (const directory of [...new Set(rewrites.flatMap((item) => (item.session ? [item.session.directory] : [])))]) {
      const lock = SessionLock.acquire(directory);
      locks.push(lock);
    }
    for (const rewrite of rewrites) {
      if (rewrite.session === undefined) continue;
      let current: string | null = null;
      try {
        if (lstatSync(rewrite.path).isFile()) current = readFileSync(rewrite.path, "utf8");
      } catch {
        // Treated as changed below.
      }
      if (current !== rewrite.session.original) {
        throw new ConfigurationError(`${path.relative(workspace, rewrite.path)} changed during migration. Nothing was written; run \`migent migrate\` again.`);
      }
    }
    for (const rewrite of rewrites) writeFileSync(rewrite.path, rewrite.text, "utf8");
  } catch (error) {
    if (!(error instanceof SessionLockHeldError || error instanceof ConfigurationError)) throw error;
    printError(`${error.message} Nothing was written.`);
    return 2;
  } finally {
    for (const lock of locks) lock.release();
  }
  process.stdout.write(`Upgraded schema to version ${SCHEMA_VERSION}.\n`);
  return 0;
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

function pendingRewrites(workspace: string, clientIds: readonly string[]): Rewrite[] {
  const configPath = path.join(workspace, ".migent", "config.yaml");
  if (!isFile(configPath)) return [];
  const originalContext = loadWorkspaceConfig(workspace);
  const projectOriginal = readConfigOriginal(configPath);
  if (projectOriginal === null) return [];
  const localPath = localConfigPath(workspace);
  const localOriginal = isFile(localPath) ? readConfigOriginal(localPath) : null;
  // Older layers must reach v5 before the client lift inspects their merged shape.
  const projectV5 = structuredClone(projectOriginal);
  const localV5 = localOriginal === null ? null : structuredClone(localOriginal);
  for (const layer of [projectV5, localV5]) {
    if (layer !== null && documentVersion(layer) < 5) migrateConfig(layer, 5, originalContext);
  }
  const context = mergeConfigLayers(projectV5, localV5).config;
  const [config, configRewrite] = configRewriteOf(configPath, projectOriginal, context, clientIds, {
    layer: "project",
    project: projectV5,
    local: localV5,
  });
  if (config === null) return [];
  const rewrites: Rewrite[] = [];
  if (configRewrite !== null) rewrites.push(configRewrite);
  let effective = config;
  if (localOriginal !== null) {
    const [local, rewrite] = configRewriteOf(localPath, localOriginal, context, clientIds, {
      layer: "local",
      project: projectV5,
      local: localV5,
    });
    if (rewrite !== null) rewrites.push(rewrite);
    if (local !== null) effective = mergeConfigLayers(config, local).config;
  }
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
    const result = checkDocumentSchemaVersion(loadYamlMapping(filePath));
    return result.status === "invalid" ? null : result.version;
  } catch {
    return null;
  }
}

function configRewriteOf(
  filePath: string,
  originalDocument: Record<string, unknown>,
  context: Record<string, unknown>,
  clientIds: readonly string[],
  layers: { layer: "project" | "local"; project: Record<string, unknown>; local: Record<string, unknown> | null },
): [Record<string, unknown> | null, Rewrite | null] {
  const original = readFileSync(filePath, "utf8");
  const updated = structuredClone(originalDocument);
  let notes: string[];
  try {
    notes = migrateConfig(updated, SCHEMA_VERSION, context, {
      ...layers,
      merged: context,
      clientIds,
    });
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
    note.startsWith("schema_version") ? `Migrated .migent/${path.basename(filePath)} ${note}` : note,
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
      changed = migrateWorkflow(updated, config, SCHEMA_VERSION, clientIds);
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      continue;
    }
    if (changed.length === 0) continue;
    let rewritten: string;
    try {
      rewritten = patchWorkflowText(original, updated);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      // The line patcher cannot edit this layout (flow-style stages, a key on the dash line, empty
      // entries): write the migrated document as canonical YAML. Comments are reported below.
      rewritten = stringifyConfig(updated);
      parseWorkflowMapping(updated, "migrated workflow");
    }
    if (rewritten === original) continue;
    const relative = `.migent/workflows/${name}`;
    const notes = changed.map((note) =>
      note.startsWith("schema_version") ? `Migrated ${relative} ${note}` : `${relative}: ${note}`,
    );
    if (yamlHasComments(original) && !yamlHasComments(rewritten)) {
      notes.push(`${relative}: comments could not be preserved by this migration`);
    }
    rewrites.push({ path: filePath, text: rewritten, notes });
  }
  return rewrites;
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
    return realRoot === path.join(realpathSync(workspace), ".migent", "sessions") ? realRoot : null;
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

function sessionRewrites(
  workspace: string,
  config: Record<string, unknown>,
  clientIds: readonly string[],
): Rewrite[] {
  const root = path.join(workspace, ".migent", "sessions");
  const realRoot = realSessionsRoot(workspace, root);
  if (realRoot === null || !isRealDirectory(root)) return [];
  const rewrites: Rewrite[] = [];
  for (const id of readdirSync(root).sort()) {
    const directory = path.join(root, id);
    // A symlinked session directory or file could point outside the workspace; leave it alone.
    if (!isRealDirectory(directory) || !isDirectChild(realRoot, directory)) continue;
    const draftPath = path.join(directory, "workflow.yaml");
    const label = `.migent/sessions/${id}`;
    let draftText: string | null = null;
    let newDraftText: string | null = null;
    if (isRegularFile(draftPath)) {
      draftText = readFileSync(draftPath, "utf8");
      const result = migratedText(draftText, config, clientIds, `${label}/workflow.yaml`);
      if (result !== null) {
        newDraftText = result.text;
        rewrites.push({ path: draftPath, text: result.text, notes: result.notes, session: { directory, original: draftText } });
      }
    }
    const frozenPath = path.join(directory, WORKFLOW_FREEZE_FILE);
    if (!isRegularFile(frozenPath)) continue;
    const frozenText = readFileSync(frozenPath, "utf8");
    let document: Record<string, unknown>;
    try {
      const parsed = parseYamlDocument(frozenText);
      if (!isRecord(parsed)) continue;
      document = parsed;
    } catch {
      continue;
    }
    const body = document.workflow;
    if (!isRecord(body)) continue;
    let notes: string[];
    try {
      notes = migrateWorkflow(body, config, SCHEMA_VERSION, clientIds);
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      continue;
    }
    if (notes.length === 0) continue;
    // The pin records the draft's hash; keep it matching when the draft is rewritten alongside.
    if (draftText !== null && newDraftText !== null && document.source_sha256 === sha256Hex(draftText)) {
      document.source_sha256 = sha256Hex(newDraftText);
    }
    rewrites.push({
      path: frozenPath,
      text: stringifyConfig(document),
      session: { directory, original: frozenText },
      notes: notes.map((note) =>
        note.startsWith("schema_version") ? `Migrated ${label}/${WORKFLOW_FREEZE_FILE} ${note}` : `${label}/${WORKFLOW_FREEZE_FILE}: ${note}`,
      ),
    });
  }
  return rewrites;
}

function migratedText(
  original: string,
  config: Record<string, unknown>,
  clientIds: readonly string[],
  relative: string,
): { text: string; notes: string[] } | null {
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(original);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const updated = structuredClone(parsed);
  let changed: string[];
  try {
    changed = migrateWorkflow(updated, config, SCHEMA_VERSION, clientIds);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return null;
  }
  if (changed.length === 0) return null;
  let text: string;
  try {
    text = patchWorkflowText(original, updated);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    text = stringifyConfig(updated);
    parseWorkflowMapping(updated, "migrated workflow");
  }
  if (text === original) return null;
  const notes = changed.map((note) =>
    note.startsWith("schema_version") ? `Migrated ${relative} ${note}` : `${relative}: ${note}`,
  );
  if (yamlHasComments(original) && !yamlHasComments(text)) {
    notes.push(`${relative}: comments could not be preserved by this migration`);
  }
  return { text, notes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
