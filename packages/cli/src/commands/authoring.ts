import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  validateConfigDraft,
  validateWorkflowDraft,
  type ConfigLoad,
  type Diagnostic,
} from "@nodeint/migent-doctor";
import {
  ConfigurationError,
  buildDraftSourceMap,
  configPath,
  locateSessionDirectory,
  mergeConfigLayers,
  resolveSessionDraft,
  SessionLock,
  type SessionDraft,
  loadYamlMapping,
  localConfigPath,
  parseDraftText,
  renderAuthoringYaml,
  sha256Hex,
  workflowsDirectory,
  writeFileConditional,
  yamlHasComments,
  type DraftFormat,
  type DraftSourceMap,
} from "@nodeint/migent-kernel";
import { clientRegistry } from "../client.js";
import { findWorkspace, invocationCwdPath } from "../workspace.js";

export type AuthoringKind = "config" | "workflow";
export type AuthoringMode = "validate" | "render" | "save";

export interface AuthoringOptions {
  kind: AuthoringKind;
  mode: AuthoringMode;
  /** Draft file path, or `-` for stdin. */
  draft: string;
  scope?: string;
  format?: string;
  target?: string;
  /** Id of an existing session whose editable workflow draft is the destination. */
  session?: string;
  baseHash?: string;
  asJson?: boolean;
  /** Keep the target's comments, key order and line endings on render/save. */
  preserveComments?: boolean;
  /** Test seam for stdin. */
  readStdin?: () => string;
}

const EXIT_INVALID = 1;
const EXIT_IO = 2;
const EXIT_CONFLICT = 3;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface PublicDiagnostic {
  source?: "project" | "local" | "effective" | "workflow";
  file?: string;
  draft?: boolean;
  path?: (string | number)[];
  severity: "error" | "warning";
  code: string;
  message: string;
  line?: number;
  column?: number;
  /** Exclusive end of the range, one-based, when known. */
  end_line?: number;
  end_column?: number;
}

interface Context {
  /** Config scope of the draft, or null for a workflow. */
  scope: "project" | "local" | null;
  /** Workflow basename of the draft, when known. */
  file: string | null;
  /** The draft text, for resolving diagnostic ranges. */
  text: string | null;
  /** Built once per run from `text`. */
  source: DraftSourceMap | null;
}

function publicDiagnostic(item: Diagnostic, context: Context): PublicDiagnostic {
  let source: PublicDiagnostic["source"];
  let file: string | undefined;
  let draft: boolean | undefined;
  if (item.source !== undefined) {
    if ("workflow" in item.source) {
      source = "workflow";
      // An empty name is the draft itself, before a file name can be derived.
      file = item.source.workflow === "" ? undefined : item.source.workflow;
      draft = context.file !== null && item.source.workflow === context.file;
    } else {
      source = item.source.layer === "merged" ? "effective" : item.source.layer;
      draft = context.scope !== null && (source === "effective" || source === context.scope);
    }
  }
  const position = item.position ?? (draft === true ? draftRangeOf(item, context) : undefined);
  return {
    ...(source === undefined ? {} : { source }),
    ...(file === undefined ? {} : { file }),
    ...(draft === undefined ? {} : { draft }),
    ...(item.path === undefined ? {} : { path: [...item.path] }),
    severity: item.severity,
    code: item.code,
    message: item.message,
    ...(position === undefined ? {} : { line: position.line, column: position.column }),
    ...(position?.end === undefined
      ? {}
      : { end_line: position.end.line, end_column: position.end.column }),
  };
}

/** Range of a draft node. Key-level codes point at the key; every other code points at the value. */
function draftRangeOf(item: Diagnostic, context: Context): Diagnostic["position"] {
  if (item.path === undefined || context.text === null) return undefined;
  context.source ??= buildDraftSourceMap(context.text);
  const range = item.code === "unknown-key" && !item.code.includes("legacy")
    ? context.source.keyRangeOf(item.path)
    : context.source.rangeOf(item.path);
  return range === null
    ? undefined
    : { line: range.start.line, column: range.start.column, end: range.end };
}

function plain(code: string, message: string, severity: "error" | "warning" = "error"): Diagnostic {
  return { severity, code, message };
}

/** `config.validate` etc. when argv is an authoring command asking for JSON; otherwise null. */
export function authoringCommandOf(argv: readonly string[]): string | null {
  const group = argv[0];
  if (group !== "config" && group !== "workflow") return null;
  // `config` itself takes --json, so it may sit between the group and the mode.
  let at = 1;
  while (at < argv.length && argv[at]!.startsWith("-") && argv[at] !== "--help" && argv[at] !== "-h") at += 1;
  const mode = argv[at];
  if (mode !== "validate" && mode !== "render" && mode !== "save") return null;
  return argv.includes("--json") ? `${group}.${mode}` : null;
}

/** A usage error in the versioned envelope. */
export function printInvocationEnvelope(command: string, message: string): void {
  const diagnostics = [{ severity: "error", code: "invalid-invocation", message }];
  process.stdout.write(`${JSON.stringify({ schema_version: 1, command, valid: false, diagnostics })}\n`);
}

class Finish extends Error {
  constructor(readonly exit: number, readonly items: Diagnostic[], readonly extra: Record<string, unknown> = {}) {
    super("finish");
  }
}

export function runAuthoring(options: AuthoringOptions): number {
  const command = `${options.kind}.${options.mode}`;
  const context: Context = { scope: null, file: null, text: null, source: null };
  const emit = (exit: number, items: Diagnostic[], extra: Record<string, unknown> = {}): number => {
    const diagnostics = items.map((item) => publicDiagnostic(item, context));
    const valid = !items.some((item) => item.severity === "error");
    if (options.asJson === true) {
      const envelope = { schema_version: 1, command, valid, diagnostics, ...extra };
      process.stdout.write(`${JSON.stringify(envelope)}\n`);
    } else {
      for (const item of diagnostics) {
        const where = item.path === undefined ? "" : ` ${item.path.join(".")}`;
        const line = item.line === undefined ? "" : ` (line ${item.line}${item.column === undefined ? "" : `, column ${item.column}`})`;
        process.stderr.write(`${item.severity}${where}${line}: ${item.message} [${item.code}]\n`);
      }
      if (exit === 0) {
        if (typeof extra.rendered === "string") process.stdout.write(extra.rendered);
        else if (options.mode === "save" && typeof extra.file === "string") process.stdout.write(`Saved ${extra.file}.\n`);
        else process.stdout.write("Valid.\n");
      }
    }
    return exit;
  };
  try {
    return execute(options, context, emit);
  } catch (error) {
    if (error instanceof Finish) return emit(error.exit, error.items, error.extra);
    if (error instanceof ConfigurationError) {
      return emit(EXIT_IO, [{ ...plain(error.code ?? "invalid-invocation", error.message) }]);
    }
    throw error;
  }
}

function execute(
  options: AuthoringOptions,
  context: Context,
  emit: (exit: number, items: Diagnostic[], extra?: Record<string, unknown>) => number,
): number {
  // A session save holds the session lock from before it reads mutable session state until the write ends.
  const held: { lock: SessionLock | null } = { lock: null };
  try {
    return executeDraft(options, context, emit, held);
  } finally {
    held.lock?.release();
  }
}

function executeDraft(
  options: AuthoringOptions,
  context: Context,
  emit: (exit: number, items: Diagnostic[], extra?: Record<string, unknown>) => number,
  held: { lock: SessionLock | null },
): number {
  const { kind, mode } = options;
  const invocation = (message: string): Finish => new Finish(EXIT_IO, [plain("invalid-invocation", message)]);

  let scope: "project" | "local" = "project";
  if (kind === "config") {
    const given = options.scope ?? "project";
    if (given !== "project" && given !== "local") throw invocation("--scope must be project or local.");
    scope = given;
    context.scope = scope;
  } else if (options.scope !== undefined) {
    throw invocation("--scope applies only to config.");
  }
  if (options.baseHash !== undefined && !/^[0-9a-f]{64}$/.test(options.baseHash)) {
    throw invocation("--base-hash must be a lowercase SHA-256 hex digest.");
  }
  if (options.baseHash !== undefined && mode !== "save") throw invocation("--base-hash applies only to save.");
  if (options.preserveComments === true && mode === "validate") {
    throw invocation("--preserve-comments applies only to render and save.");
  }
  if (options.target !== undefined && kind !== "workflow") throw invocation("--target applies only to workflow.");
  if (options.session !== undefined && kind !== "workflow") throw invocation("--session applies only to workflow.");
  if (options.session !== undefined && options.target !== undefined) throw invocation("--session and --target are mutually exclusive.");
  if (options.target !== undefined && !(FILE_NAME.test(options.target) && options.target.endsWith(".yaml"))) {
    throw invocation("--target must be a plain *.yaml file name.");
  }

  const format = resolveFormat(options, invocation);
  let text: string;
  try {
    text = options.draft === "-"
      ? (options.readStdin ?? (() => readFileSync(0, "utf8")))()
      : readFileSync(path.resolve(invocationCwdPath(), options.draft), "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Finish(EXIT_IO, [plain("draft-unreadable", `Unable to read draft: ${reason}`)]);
  }
  context.text = text;

  const workspace = locateWorkspace(scope, kind);
  let session: SessionDraft | null = null;
  if (options.session !== undefined) {
    if (mode === "save") {
      const directory = locateSessionDirectory(workspace, options.session);
      held.lock = SessionLock.tryAcquire(directory);
      if (held.lock === null) {
        throw new Finish(EXIT_CONFLICT, [plain("session-locked", `Session ${options.session} is locked by a running process; try again when it stops.`)]);
      }
    }
    // Under the lock for a save, so the status it checks cannot change before the write.
    session = resolveSessionDraft(workspace, options.session, { forSave: mode === "save" });
  }
  const clients = clientRegistry();
  const draftSource = kind === "config" ? { layer: scope } as const : { workflow: session?.relativePath ?? options.target ?? "" };
  let draft: Record<string, unknown>;
  try {
    draft = parseDraftText(text, format);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    if (kind === "workflow") context.file = session?.relativePath ?? options.target ?? "";
    throw new Finish(EXIT_INVALID, [{
      severity: "error",
      code: error.code ?? "syntax",
      message: error.message,
      source: draftSource,
      ...(error.position === undefined ? {} : { position: error.position }),
    }]);
  }

  let diagnostics: Diagnostic[];
  let destination: string;
  let label: string;
  if (kind === "config") {
    destination = scope === "project" ? configPath(workspace) : localConfigPath(workspace);
    label = scope === "project" ? "config.yaml" : "config.local.yaml";
    const other = scope === "project" ? "local" : "project";
    const otherPath = scope === "project" ? localConfigPath(workspace) : configPath(workspace);
    // A companion layer that does not load is one finding; the draft is still validated without it.
    const companionProblems: Diagnostic[] = [];
    let companion: Record<string, unknown> | null = null;
    if (existsSync(otherPath)) {
      try {
        companion = loadYamlMapping(otherPath, other);
      } catch (error) {
        if (!(error instanceof ConfigurationError)) throw error;
        companionProblems.push({
          severity: "error",
          code: error.code ?? "config-invalid",
          message: error.message,
          source: { layer: other },
          ...(error.position === undefined ? {} : { position: error.position }),
        });
      }
    } else if (scope === "local") {
      companionProblems.push({
        severity: "error",
        code: "config-missing",
        message: "Missing .migent/config.yaml; the local config is validated against it.",
        source: { layer: "project" },
      });
    }
    diagnostics = [...companionProblems, ...validateConfigDraft({ scope, draft, companion }, clients)];
  } else {
    const config = loadConfigLayers(workspace);
    if (session !== null) {
      context.file = session.relativePath;
      destination = session.draftPath;
      label = session.relativePath;
      const siblings = readSiblings(workflowsDirectory(workspace), "");
      diagnostics = validateWorkflowDraft({ draft, file: session.relativePath, siblings, config, session: { expectedId: session.workflowId } }, clients);
    } else {
      const id = draft.id;
      const derived = typeof id === "string" && FILE_NAME.test(id) ? `${id}.yaml` : null;
      const file = options.target ?? derived;
      context.file = file ?? "";
      if (file === null && mode === "save") {
        throw new Finish(EXIT_INVALID, [{ severity: "error", code: "invalid-value", message: "Cannot derive a file name from id; pass --target.", path: ["id"], source: { workflow: "" } }]);
      }
      const name = file ?? "";
      destination = path.join(workflowsDirectory(workspace), name);
      label = `workflows/${name}`;
      const siblings = readSiblings(workflowsDirectory(workspace), name);
      diagnostics = validateWorkflowDraft({ draft, file: name, siblings, config }, clients);
    }
  }

  const invalid = diagnostics.some((item) => item.severity === "error");
  if (mode === "validate" || invalid) return emit(invalid ? EXIT_INVALID : 0, diagnostics);

  // The base is the target's current bytes. `save` only has a base when it is replacing a file.
  const preserve = options.preserveComments === true;
  let base: string | null = null;
  if (preserve) {
    if (mode === "render") {
      base = readExisting(destination);
    } else if (options.baseHash !== undefined) {
      const current = readExisting(destination);
      const currentHash = current === null ? null : sha256Hex(current);
      if (currentHash !== options.baseHash) {
        return emit(EXIT_CONFLICT, [...diagnostics, plain("stale-base", currentHash === null
          ? `${label} does not exist, so the base hash cannot match.`
          : `${label} changed since the base hash was taken.`)], { file: label, ...(currentHash === null ? {} : { current_hash: currentHash }) });
      }
      base = current;
    }
  }
  const rendered = renderAuthoringYaml(draft, base ?? undefined);
  const preservation = preserve && base !== null && !rendered.preserved
    ? [plain("comments-not-preserved", `${label}: comments were not preserved (${rendered.reason ?? "the file could not be kept in place"}).`, "warning")]
    : [];
  if (mode === "render") return emit(0, [...diagnostics, ...preservation], { rendered: rendered.text });

  let result;
  try {
    result = writeFileConditional(destination, rendered.text, options.baseHash ?? null);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return emit(EXIT_IO, [...diagnostics, plain("write-failed", `Unable to write ${label}: ${reason}`)]);
  }
  switch (result.status) {
    case "stale-base":
      return emit(EXIT_CONFLICT, [...diagnostics, plain("stale-base", result.currentHash === null
        ? `${label} does not exist, so the base hash cannot match.`
        : `${label} changed since the base hash was taken.`)], { file: label, ...(result.currentHash === null ? {} : { current_hash: result.currentHash }) });
    case "already-exists":
      return emit(EXIT_CONFLICT, [...diagnostics, plain("already-exists", `${label} already exists; pass --base-hash to replace it.`)], { file: label });
    case "create-unsupported":
      return emit(EXIT_IO, [...diagnostics, plain("create-unsupported", `Cannot create ${label} safely (${result.reason}). Create the file another way, then save with --base-hash.`)], { file: label });
    case "written": {
      const dropped = result.previous !== null && yamlHasComments(result.previous) && !(preserve && rendered.preserved);
      const warnings = dropped
        ? [plain("comments-dropped", `${label} had comments; the saved file does not keep them.`, "warning")]
        : [];
      return emit(0, [...diagnostics, ...preservation, ...warnings], { file: label, hash: result.hash, written: true });
    }
  }
}

/** The target's current text, or null when it does not exist. */
function readExisting(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function resolveFormat(options: AuthoringOptions, invocation: (message: string) => Finish): DraftFormat {
  if (options.format !== undefined) {
    if (options.format !== "yaml" && options.format !== "json") throw invocation("--format must be yaml or json.");
    return options.format;
  }
  if (options.draft === "-") throw invocation("--format is required when the draft comes from stdin.");
  const extension = path.extname(options.draft).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".yaml" || extension === ".yml") return "yaml";
  throw invocation("Cannot tell the draft format from its extension; pass --format.");
}

function locateWorkspace(scope: "project" | "local", kind: AuthoringKind): string {
  try {
    return findWorkspace(invocationCwdPath());
  } catch (error) {
    // A first project config has no workspace marker yet.
    if (kind === "config" && scope === "project") return invocationCwdPath();
    throw new Finish(EXIT_IO, [plain("workspace-not-found", error instanceof Error ? error.message : String(error))]);
  }
}

function loadConfigLayers(workspace: string): ConfigLoad | ConfigurationError {
  try {
    const project = loadYamlMapping(configPath(workspace), "project");
    const local = existsSync(localConfigPath(workspace)) ? loadYamlMapping(localConfigPath(workspace), "local") : null;
    return { ...mergeConfigLayers(project, local), layers: { project, local } };
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return error;
  }
}

function readSiblings(directory: string, exclude: string) {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".yaml") && !name.startsWith(".") && name !== exclude).sort();
  } catch {
    return [];
  }
  return names.map((file) => {
    try {
      const document = loadYamlMapping(path.join(directory, file));
      return { file, document };
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      return { file, error };
    }
  });
}
