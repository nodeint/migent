import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { AuthoringEnvelope } from '@nodeint/migent-contracts';
import {
  type ConfigLoad,
  type Diagnostic,
  validateConfigDraft,
  validateWorkflowDraft,
} from '@nodeint/migent-doctor';
import { buildDraftSourceMap, configPath, ConfigurationError, type DraftFormat, type DraftSourceMap,loadYamlMapping, localConfigPath, mergeConfigLayers, parseDraftText, renderAuthoringYaml, sha256Hex, writeFileConditional, yamlHasComments } from '@nodeint/migent-kernel';
import { locateSessionDirectory, resolveSessionDraft, type SessionDraft,SessionLock } from '@nodeint/migent-session';
import { workflowsDirectory } from '@nodeint/migent-workflow';

import { clientRegistry } from '../client.js';
import { writeJson } from '../emit.js';
import { EXIT_BLOCKED, EXIT_CONFIG, EXIT_STAGE_FAILED } from '../exits.js';
import { findWorkspace, invocationCwdPath } from '../workspace.js';

export type AuthoringKind = 'config' | 'workflow';
export type AuthoringMode = 'validate' | 'render' | 'save';

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

/** Authoring exits: invalid draft, invocation or I/O error, and conflict. They share the catalog codes. */
const EXIT_INVALID = EXIT_BLOCKED;
const EXIT_IO = EXIT_CONFIG;
const EXIT_CONFLICT = EXIT_STAGE_FAILED;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface PublicDiagnostic {
  source?: 'project' | 'local' | 'effective' | 'workflow';
  file?: string;
  draft?: boolean;
  path?: (string | number)[];
  severity: 'error' | 'warning';
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
  scope: 'project' | 'local' | null;
  /** Workflow basename of the draft, when known. */
  file: string | null;
  /** The draft text, for resolving diagnostic ranges. */
  text: string | null;
  /** Built once per run from `text`. */
  source: DraftSourceMap | null;
}

interface SourceFields {
  source?: PublicDiagnostic['source'];
  file?: string;
  draft?: boolean;
}

function sourceFieldsOf(item: Diagnostic, context: Context): SourceFields {
  if (item.source === undefined) return {};
  if ('workflow' in item.source) {
    return {
      source: 'workflow',
      // An empty name is the draft itself, before a file name can be derived.
      file: item.source.workflow === '' ? undefined : item.source.workflow,
      draft: context.file !== null && item.source.workflow === context.file,
    };
  }
  const source = item.source.layer === 'merged' ? 'effective' : item.source.layer;
  return { source, draft: context.scope !== null && (source === 'effective' || source === context.scope) };
}

function positionFieldsOf(position: Diagnostic['position']): Partial<PublicDiagnostic> {
  if (position === undefined) return {};
  return {
    line: position.line,
    column: position.column,
    ...(position.end === undefined ? {} : { end_line: position.end.line, end_column: position.end.column }),
  };
}

function publicDiagnostic(item: Diagnostic, context: Context): PublicDiagnostic {
  const { source, file, draft } = sourceFieldsOf(item, context);
  const position = item.position ?? (draft === true ? draftRangeOf(item, context) : undefined);
  return {
    ...(source === undefined ? {} : { source }),
    ...(file === undefined ? {} : { file }),
    ...(draft === undefined ? {} : { draft }),
    ...(item.path === undefined ? {} : { path: [...item.path] }),
    severity: item.severity,
    code: item.code,
    message: item.message,
    ...positionFieldsOf(position),
  };
}

/** Range of a draft node. Key-level codes point at the key; every other code points at the value. */
function draftRangeOf(item: Diagnostic, context: Context): Diagnostic['position'] {
  if (item.path === undefined || context.text === null) return undefined;
  context.source ??= buildDraftSourceMap(context.text);
  const range = item.code === 'unknown-key' && !item.code.includes('legacy')
    ? context.source.keyRangeOf(item.path)
    : context.source.rangeOf(item.path);
  return range === null
    ? undefined
    : { line: range.start.line, column: range.start.column, end: range.end };
}

function plain(code: string, message: string, severity: 'error' | 'warning' = 'error'): Diagnostic {
  return { severity, code, message };
}

/** `config.validate` etc. when argv is an authoring command asking for JSON; otherwise null. */
export function authoringCommandOf(argv: readonly string[]): string | null {
  const [group] = argv;
  if (group !== 'config' && group !== 'workflow') return null;
  // `config` itself takes --json, so it may sit between the group and the mode.
  let at = 1;
  while (at < argv.length && argv[at].startsWith('-') && argv[at] !== '--help' && argv[at] !== '-h') at += 1;
  const mode = argv[at];
  if (mode !== 'validate' && mode !== 'render' && mode !== 'save') return null;
  return argv.includes('--json') ? `${group}.${mode}` : null;
}

/** A usage error in the versioned envelope. */
export function printInvocationEnvelope(command: string, message: string): void {
  const diagnostics = [{ severity: 'error' as const, code: 'invalid-invocation', message }];
  writeJson(AuthoringEnvelope, { schema_version: 1, command, valid: false, diagnostics });
}

class Finish extends Error {
  constructor(
    public readonly exit: number,
    public readonly items: Diagnostic[],
    public readonly extra: Record<string, unknown> = {},
  ) {
    super('finish');
  }
}

export function runAuthoring(options: AuthoringOptions): number {
  const command = `${options.kind}.${options.mode}`;
  const context: Context = { scope: null, file: null, text: null, source: null };
  const emit = (exit: number, items: Diagnostic[], extra: Record<string, unknown> = {}): number => {
    const diagnostics = items.map((item) => publicDiagnostic(item, context));
    const valid = !items.some((item) => item.severity === 'error');
    if (options.asJson === true) {
      const envelope = { schema_version: 1 as const, command, valid, diagnostics, ...extra };
      writeJson(AuthoringEnvelope, envelope);
    } else {
      printHumanDiagnostics(diagnostics);
      if (exit === 0) printHumanSuccess(options.mode, extra);
    }
    return exit;
  };
  try {
    return execute(options, context, emit);
  } catch (error) {
    if (error instanceof Finish) return emit(error.exit, error.items, error.extra);
    if (error instanceof ConfigurationError) {
      return emit(EXIT_IO, [{ ...plain(error.code ?? 'invalid-invocation', error.message) }]);
    }
    throw error;
  }
}

function printHumanDiagnostics(diagnostics: readonly PublicDiagnostic[]): void {
  for (const item of diagnostics) {
    const where = item.path === undefined ? '' : ` ${item.path.join('.')}`;
    const column = item.column === undefined ? '' : `, column ${item.column}`;
    const line = item.line === undefined ? '' : ` (line ${item.line}${column})`;
    process.stderr.write(`${item.severity}${where}${line}: ${item.message} [${item.code}]\n`);
  }
}

function printHumanSuccess(mode: AuthoringOptions['mode'], extra: Record<string, unknown>): void {
  if (typeof extra.rendered === 'string') process.stdout.write(extra.rendered);
  else if (mode === 'save' && typeof extra.file === 'string') process.stdout.write(`Saved ${extra.file}.\n`);
  else process.stdout.write('Valid.\n');
}

/** The session lock a save holds. The command releases it in a `finally`, whatever step failed. */
class HeldLock {
  private current: SessionLock | null = null;

  /** Take the lock of `directory`; false when another process holds it. */
  public tryAcquire(directory: string): boolean {
    this.current = SessionLock.tryAcquire(directory);
    return this.current !== null;
  }

  public release(): void {
    this.current?.release();
  }
}

function execute(
  options: AuthoringOptions,
  context: Context,
  emit: (exit: number, items: Diagnostic[], extra?: Record<string, unknown>) => number,
): number {
  // A session save holds the session lock from before it reads mutable session state until the write ends.
  const held = new HeldLock();
  try {
    return executeDraft(options, context, { emit, held });
  } finally {
    held.release();
  }
}

type Emit = (exit: number, items: Diagnostic[], extra?: Record<string, unknown>) => number;

/** A validated draft and where it would be written. */
interface Target {
  draft: Record<string, unknown>;
  diagnostics: Diagnostic[];
  destination: string;
  label: string;
}

function executeDraft(
  options: AuthoringOptions,
  context: Context,
  output: { emit: Emit; held: HeldLock },
): number {
  const { emit, held } = output;
  const { mode } = options;
  const scope = checkInvocation(options);
  if (options.kind === 'config') context.scope = scope;
  const format = resolveFormat(options, invocation);
  const text = (context.text = readDraft(options));

  const workspace = locateWorkspace(scope, options.kind);
  const session = openSessionDraft(workspace, options, held);
  const draft = parseDraft(text, format, { options, context, scope, session });
  const target = options.kind === 'config'
    ? configTarget(workspace, scope, draft)
    : workflowTarget(workspace, { options, context, session }, draft);
  const { diagnostics } = target;

  const invalid = diagnostics.some((item) => item.severity === 'error');
  if (mode === 'validate' || invalid) return emit(invalid ? EXIT_INVALID : 0, diagnostics);

  return renderOrSave(options, target, { emit });
}

function renderOrSave(options: AuthoringOptions, target: Target, output: { emit: Emit }): number {
  const { emit } = output;
  const { diagnostics, draft } = target;
  const preserve = options.preserveComments === true;
  const base = preserve ? resolveBase(options, target) : { text: null };
  const { conflict } = base;
  if (conflict !== undefined) return emit(EXIT_CONFLICT, [...diagnostics, conflict.item], conflict.extra);
  const rendered = renderAuthoringYaml(draft, base.text ?? undefined);
  const preservation = preservationWarnings(target.label, rendered, preserve && base.text !== null);
  if (options.mode === 'render') return emit(0, [...diagnostics, ...preservation], { rendered: rendered.text });
  return saveDraft(options, target, { emit, rendered, preservation });
}

function preservationWarnings(
  label: string,
  rendered: ReturnType<typeof renderAuthoringYaml>,
  hadBase: boolean,
): Diagnostic[] {
  if (!hadBase || rendered.preserved) return [];
  const reason = rendered.reason ?? 'the file could not be kept in place';
  return [plain('comments-not-preserved', `${label}: comments were not preserved (${reason}).`, 'warning')];
}

function invocation(message: string): Finish {
  return new Finish(EXIT_IO, [plain('invalid-invocation', message)]);
}

/** Rejects flag combinations that do not apply; returns the config scope. */
function checkInvocation(options: AuthoringOptions): 'project' | 'local' {
  const scope = checkScope(options);
  checkBaseHash(options);
  checkWorkflowTarget(options);
  return scope;
}

function checkScope(options: AuthoringOptions): 'project' | 'local' {
  if (options.kind !== 'config') {
    if (options.scope !== undefined) throw invocation('--scope applies only to config.');
    return 'project';
  }
  const given = options.scope ?? 'project';
  if (given !== 'project' && given !== 'local') throw invocation('--scope must be project or local.');
  return given;
}

function checkBaseHash(options: AuthoringOptions): void {
  const { mode } = options;
  if (options.baseHash !== undefined && !/^[0-9a-f]{64}$/.test(options.baseHash)) {
    throw invocation('--base-hash must be a lowercase SHA-256 hex digest.');
  }
  if (options.baseHash !== undefined && mode !== 'save') throw invocation('--base-hash applies only to save.');
  if (options.preserveComments === true && mode === 'validate') {
    throw invocation('--preserve-comments applies only to render and save.');
  }
}

function checkWorkflowTarget(options: AuthoringOptions): void {
  const { kind } = options;
  if (options.target !== undefined && kind !== 'workflow') throw invocation('--target applies only to workflow.');
  if (options.session !== undefined && kind !== 'workflow') throw invocation('--session applies only to workflow.');
  if (options.session !== undefined && options.target !== undefined) throw invocation('--session and --target are mutually exclusive.');
  if (options.target !== undefined && !(FILE_NAME.test(options.target) && options.target.endsWith('.yaml'))) {
    throw invocation('--target must be a plain *.yaml file name.');
  }
}

function readDraft(options: AuthoringOptions): string {
  try {
    return options.draft === '-'
      ? (options.readStdin ?? (() => readFileSync(0, 'utf8')))()
      : readFileSync(path.resolve(invocationCwdPath(), options.draft), 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Finish(EXIT_IO, [plain('draft-unreadable', `Unable to read draft: ${reason}`)]);
  }
}

function openSessionDraft(workspace: string, options: AuthoringOptions, held: HeldLock): SessionDraft | null {
  if (options.session === undefined) return null;
  if (options.mode === 'save') {
    const directory = locateSessionDirectory(workspace, options.session);
    if (!held.tryAcquire(directory)) {
      throw new Finish(EXIT_CONFLICT, [plain('session-locked', `Session ${options.session} is locked by a running process; try again when it stops.`)]);
    }
  }
  // Under the lock for a save, so the status it checks cannot change before the write.
  return resolveSessionDraft(workspace, options.session, { forSave: options.mode === 'save' });
}

function parseDraft(
  text: string,
  format: DraftFormat,
  state: { options: AuthoringOptions; context: Context; scope: 'project' | 'local'; session: SessionDraft | null },
): Record<string, unknown> {
  const { options, context, scope, session } = state;
  const { kind } = options;
  const draftSource = kind === 'config' ? { layer: scope } as const : { workflow: session?.relativePath ?? options.target ?? '' };
  try {
    return parseDraftText(text, format);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    if (kind === 'workflow') context.file = session?.relativePath ?? options.target ?? '';
    throw new Finish(EXIT_INVALID, [{
      severity: 'error',
      code: error.code ?? 'syntax',
      message: error.message,
      source: draftSource,
      ...(error.position === undefined ? {} : { position: error.position }),
    }]);
  }
}

function configTarget(workspace: string, scope: 'project' | 'local', draft: Record<string, unknown>): Target {
  const destination = scope === 'project' ? configPath(workspace) : localConfigPath(workspace);
  const label = scope === 'project' ? 'config.yaml' : 'config.local.yaml';
  const other = scope === 'project' ? 'local' : 'project';
  const otherPath = scope === 'project' ? localConfigPath(workspace) : configPath(workspace);
  // A companion layer that does not load is one finding; the draft is still validated without it.
  const companionProblems: Diagnostic[] = [];
  let companion: Record<string, unknown> | null = null;
  if (existsSync(otherPath)) {
    try {
      companion = loadYamlMapping(otherPath, other);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      companionProblems.push({
        severity: 'error',
        code: error.code ?? 'config-invalid',
        message: error.message,
        source: { layer: other },
        ...(error.position === undefined ? {} : { position: error.position }),
      });
    }
  } else if (scope === 'local') {
    companionProblems.push({
      severity: 'error',
      code: 'config-missing',
      message: 'Missing .migent/config.yaml; the local config is validated against it.',
      source: { layer: 'project' },
    });
  }
  const diagnostics = [...companionProblems, ...validateConfigDraft({ scope, draft, companion }, clientRegistry())];
  return { draft, diagnostics, destination, label };
}

function workflowTarget(
  workspace: string,
  state: { options: AuthoringOptions; context: Context; session: SessionDraft | null },
  draft: Record<string, unknown>,
): Target {
  const { options, context, session } = state;
  const clients = clientRegistry();
  const config = loadConfigLayers(workspace);
  if (session !== null) {
    context.file = session.relativePath;
    const siblings = readSiblings(workflowsDirectory(workspace), '');
    const diagnostics = validateWorkflowDraft(
      { draft, file: session.relativePath, siblings, config, session: { expectedId: session.workflowId } },
      clients,
    );
    return { draft, diagnostics, destination: session.draftPath, label: session.relativePath };
  }
  const {id} = draft;
  const derived = typeof id === 'string' && FILE_NAME.test(id) ? `${id}.yaml` : null;
  const file = options.target ?? derived;
  context.file = file ?? '';
  if (file === null && options.mode === 'save') {
    throw new Finish(EXIT_INVALID, [{ severity: 'error', code: 'invalid-value', message: 'Cannot derive a file name from id; pass --target.', path: ['id'], source: { workflow: '' } }]);
  }
  const name = file ?? '';
  const siblings = readSiblings(workflowsDirectory(workspace), name);
  const diagnostics = validateWorkflowDraft({ draft, file: name, siblings, config }, clients);
  return { draft, diagnostics, destination: path.join(workflowsDirectory(workspace), name), label: `workflows/${name}` };
}

function staleBase(label: string, currentHash: string | null): { item: Diagnostic; extra: Record<string, unknown> } {
  const item = plain('stale-base', currentHash === null
    ? `${label} does not exist, so the base hash cannot match.`
    : `${label} changed since the base hash was taken.`);
  return { item, extra: { file: label, ...(currentHash === null ? {} : { current_hash: currentHash }) } };
}

/** The base is the target's current bytes. `save` only has a base when it is replacing a file. */
function resolveBase(
  options: AuthoringOptions,
  target: Target,
): { text: string | null; conflict?: { item: Diagnostic; extra: Record<string, unknown> } } {
  if (options.mode === 'render') return { text: readExisting(target.destination) };
  if (options.baseHash === undefined) return { text: null };
  const current = readExisting(target.destination);
  const currentHash = current === null ? null : sha256Hex(current);
  if (currentHash !== options.baseHash) return { text: null, conflict: staleBase(target.label, currentHash) };
  return { text: current };
}

function saveDraft(
  options: AuthoringOptions,
  target: Target,
  output: { emit: Emit; rendered: ReturnType<typeof renderAuthoringYaml>; preservation: Diagnostic[] },
): number {
  const { emit, rendered, preservation } = output;
  const { diagnostics, destination, label } = target;
  const preserve = options.preserveComments === true;
  let result;
  try {
    result = writeFileConditional(destination, rendered.text, { baseHash: options.baseHash ?? null });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return emit(EXIT_IO, [...diagnostics, plain('write-failed', `Unable to write ${label}: ${reason}`)]);
  }
  switch (result.status) {
    case 'stale-base': {
      const stale = staleBase(label, result.currentHash);
      return emit(EXIT_CONFLICT, [...diagnostics, stale.item], stale.extra);
    }
    case 'already-exists':
      return emit(EXIT_CONFLICT, [...diagnostics, plain('already-exists', `${label} already exists; pass --base-hash to replace it.`)], { file: label });
    case 'create-unsupported':
      return emit(EXIT_IO, [...diagnostics, plain('create-unsupported', `Cannot create ${label} safely (${result.reason}). Create the file another way, then save with --base-hash.`)], { file: label });
    case 'written': {
      const dropped = result.previous !== null && yamlHasComments(result.previous) && !(preserve && rendered.preserved);
      const warnings = dropped
        ? [plain('comments-dropped', `${label} had comments; the saved file does not keep them.`, 'warning')]
        : [];
      return emit(0, [...diagnostics, ...preservation, ...warnings], { file: label, hash: result.hash, written: true });
    }
  }
}

/** The target's current text, or null when it does not exist. */
function readExisting(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function resolveFormat(options: AuthoringOptions, invocation: (message: string) => Finish): DraftFormat {
  if (options.format !== undefined) {
    if (options.format !== 'yaml' && options.format !== 'json') throw invocation('--format must be yaml or json.');
    return options.format;
  }
  if (options.draft === '-') throw invocation('--format is required when the draft comes from stdin.');
  const extension = path.extname(options.draft).toLowerCase();
  if (extension === '.json') return 'json';
  if (extension === '.yaml' || extension === '.yml') return 'yaml';
  throw invocation('Cannot tell the draft format from its extension; pass --format.');
}

function locateWorkspace(scope: 'project' | 'local', kind: AuthoringKind): string {
  try {
    return findWorkspace(invocationCwdPath());
  } catch (error) {
    // A first project config has no workspace marker yet.
    if (kind === 'config' && scope === 'project') return invocationCwdPath();
    throw new Finish(EXIT_IO, [plain('workspace-not-found', error instanceof Error ? error.message : String(error))]);
  }
}

function loadConfigLayers(workspace: string): ConfigLoad | ConfigurationError {
  try {
    const project = loadYamlMapping(configPath(workspace), 'project');
    const local = existsSync(localConfigPath(workspace)) ? loadYamlMapping(localConfigPath(workspace), 'local') : null;
    return { ...mergeConfigLayers(project, local), layers: { project, local } };
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return error;
  }
}

function readSiblings(directory: string, exclude: string) {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.yaml') && !name.startsWith('.') && name !== exclude).sort();
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
