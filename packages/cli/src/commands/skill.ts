import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { confirm as clackConfirm, isCancel, select as clackSelect } from '@clack/prompts';
import { loadWorkspaceConfig, skillsChildEnv, whichSync } from '@nodeint/migent-kernel';

import { printError } from '../display.js';
import { PromptCancelled } from '../errors.js';
import { EXIT_CONFIG } from '../exits.js';
import { isDirectory, isFile } from '../fs-utils.js';
import { cliHooks } from '../hooks.js';
import { scanInstalledSkills } from '../skill-scan.js';
import { findTarget, SKILL_TARGETS, type SkillScope, type SkillTarget } from '../skill-targets.js';

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 20;

const MIN_NODE = [MIN_NODE_MAJOR, MIN_NODE_MINOR] as const;

/** Runs `npx` with the given arguments in `cwd` on inherited stdio and returns its exit code. */
export type SkillRunner = (argv: string[], cwd: string) => number | Promise<number>;

export interface SkillOptions {
  /** Workspace root. Required for project scope. */
  workspace?: string | null;
  scope?: SkillScope | null;
  clients?: readonly string[];
  yes?: boolean;
  interactive?: boolean;
  home?: string;
  run?: SkillRunner | null;
  which?: ((command: string) => string | null) | null;
  nodeVersion?: string;
  confirm?: ((message: string) => boolean | Promise<boolean>) | null;
  selectScope?: (() => SkillScope | Promise<SkillScope>) | null;
}

/** `dist/templates/migent` once built, `skills/migent` at the repo root when running from source. */
export function skillSourceDirectory(): string {
  const built = fileURLToPath(new URL('../templates/migent/', import.meta.url));
  const source = fileURLToPath(new URL('../../../../skills/migent/', import.meta.url));
  // A trailing backslash would escape the closing quote when passed through cmd.exe.
  return path.resolve(isDirectory(built) ? built : source);
}

export function printSkillPath(): number {
  process.stdout.write(`${skillSourceDirectory()}\n`);
  return 0;
}

export async function installSkill(options: SkillOptions = {}): Promise<number> {
  const scope = await resolveScope(options);
  if (scope === null) return EXIT_CONFIG;
  const workspace = options.workspace ?? null;
  if (scope === 'project' && workspace === null) {
    printError('Project scope needs a Migent workspace; run `migent init` or pass --global.');
    return 1;
  }
  const requested = options.clients ?? [];
  const targets = pickTargets(
    requested.length > 0 || scope === 'global' || workspace === null ? requested : clientsFromConfig(workspace),
  );
  if (targets === null) return EXIT_CONFIG;
  if (!preflight(options)) return 1;
  return runSkills(scope, targets, options);
}

type InstalledSkill = ReturnType<typeof scanInstalledSkills>[number];

export async function updateSkill(options: SkillOptions = {}): Promise<number> {
  const requested = options.clients ?? [];
  const wanted = requested.length === 0 ? null : pickTargets(requested);
  if (requested.length > 0 && wanted === null) return EXIT_CONFIG;
  const installed = installedSkills(options, wanted);
  if (installed.length === 0) {
    printError('Migent skill is not installed; run `migent skill install`.');
    return 1;
  }
  const stale = installed.filter((entry) => entry.state === 'different');
  if (stale.length === 0) {
    process.stdout.write('Already up to date.\n');
    return 0;
  }
  if (!preflight(options)) return 1;
  const confirmed = await confirmUpdate(options, stale);
  if (confirmed !== true) return confirmed;
  return updateStale(stale, options);
}

function installedSkills(options: SkillOptions, wanted: readonly SkillTarget[] | null): InstalledSkill[] {
  const workspace = options.workspace ?? null;
  const home = options.home ?? homedir();
  const wantsClient = (client: string): boolean => wanted?.some((target) => target.client === client) === true;
  return scanInstalledSkills({ workspace: workspace ?? path.join(home, '\0none'), home }, skillSourceDirectory())
    .filter((entry) => entry.scope === 'global' || workspace !== null)
    .filter((entry) => (options.scope === null || options.scope === undefined) || entry.scope === options.scope)
    .filter((entry) => wanted === null || entry.clients.some(wantsClient));
}

/** True to proceed; otherwise the exit code to return. */
async function confirmUpdate(options: SkillOptions, stale: readonly InstalledSkill[]): Promise<true | number> {
  if (options.yes === true) return true;
  const list = stale.map((entry) => `  ${entry.directory}`).join('\n');
  const answer = await ask(options, `Overwrite these copies with the bundled skill? Local edits are lost.\n${list}`);
  if (answer === null) {
    printError('Pass --yes to update without confirmation.');
    return EXIT_CONFIG;
  }
  return answer ? true : 0;
}

async function updateStale(stale: readonly InstalledSkill[], options: SkillOptions): Promise<number> {
  for (const scope of ['project', 'global'] as const) {
    const group = stale.filter((entry) => entry.scope === scope);
    if (group.length === 0) continue;
    const clients = new Set(group.flatMap((entry) => entry.clients));
    const targets = SKILL_TARGETS.filter((target) => clients.has(target.client));
    const code = await runSkills(scope, targets, { ...options, yes: true });
    if (code !== 0) return code;
  }
  return 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Migent client ids used by the agents in `.migent/config.yaml`. */
export function clientsFromConfig(workspace: string): string[] {
  const configPath = path.join(workspace, '.migent', 'config.yaml');
  if (!isFile(configPath)) return [];
  let config: Record<string, unknown>;
  try {
    config = loadWorkspaceConfig(workspace);
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const model of agentDefinitions(config)) {
    const id = clientTypeOf(model);
    if (id !== null && findTarget(id) !== undefined) found.add(id);
  }
  return [...found];
}

/** Agent definitions from `agents` and the inline `agent` of each role. */
function agentDefinitions(config: Record<string, unknown>): unknown[] {
  const definitions: unknown[] = isObject(config.agents) ? Object.values(config.agents) : [];
  const roles = isObject(config.roles) ? Object.values(config.roles) : [];
  for (const role of roles) {
    if (isObject(role) && 'agent' in role) definitions.push(role.agent);
  }
  return definitions;
}

function clientTypeOf(model: unknown): string | null {
  if (!isObject(model)) return null;
  const { client } = model;
  const clientType = isObject(client) ? client.type : undefined;
  return typeof clientType === 'string' ? clientType : null;
}

/** Directory the client reads project skills from, for prompt text. */
export function projectSkillPath(client: string | null): string {
  const target = (client === null ? undefined : findTarget(client)) ?? findTarget('codex');
  return `${target?.project ?? '.agents/skills'}/migent`;
}

export function buildSkillsArgv(scope: SkillScope, targets: readonly SkillTarget[], yes: boolean): string[] {
  const argv = ['-y', 'skills', 'add', skillSourceDirectory(), '-s', 'migent', '--copy'];
  if (scope === 'global') argv.push('-g');
  if (targets.length > 0) argv.push('-a', ...new Set(targets.map((target) => target.skillsAgent)));
  if (yes) argv.push('-y');
  return argv;
}

async function runSkills(scope: SkillScope, targets: readonly SkillTarget[], options: SkillOptions): Promise<number> {
  const argv = buildSkillsArgv(scope, targets, options.yes === true || options.interactive === false);
  const run = options.run ?? cliHooks.skillRunner ?? defaultRunner;
  const code = await run(argv, scope === 'project' ? (options.workspace ?? process.cwd()) : (options.workspace ?? options.home ?? homedir()));
  if (code !== 0) printError(`npx skills exited with code ${code}.`);
  return code === 0 ? 0 : 1;
}

/** `shell: true` joins argv unquoted, so cmd.exe splits an argument that holds a space. */
export function quoteShellArg(arg: string): string {
  return /[\s&|<>()^%!"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

function defaultRunner(argv: string[], cwd: string): number {
  const windows = process.platform === 'win32';
  const result = spawnSync('npx', windows ? argv.map(quoteShellArg) : argv, {
    cwd,
    stdio: 'inherit',
    shell: windows,
    env: skillsChildEnv(),
  });
  return result.status ?? 1;
}

function preflight(options: SkillOptions): boolean {
  const node = options.nodeVersion ?? process.versions.node;
  const [major = 0, minor = 0] = node.split('.').map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    printError(`\`npx skills\` needs Node ${MIN_NODE.join('.')} or newer; this is Node ${node}.`);
    return false;
  }
  const which = options.which ?? cliHooks.which ?? whichSync;
  if (which('npx') === null) {
    printError('`npx` was not found on PATH; install Node.js with npm.');
    return false;
  }
  return true;
}

function pickTargets(clients: readonly string[]): SkillTarget[] | null {
  const targets: SkillTarget[] = [];
  for (const client of clients.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean)) {
    const target = findTarget(client);
    if (target === undefined) {
      printError(`Unknown client: ${client}. Supported: ${SKILL_TARGETS.map((item) => item.client).join(', ')}.`);
      return null;
    }
    targets.push(target);
  }
  return targets;
}

async function resolveScope(options: SkillOptions): Promise<SkillScope | null> {
  if ((options.scope !== null && options.scope !== undefined)) return options.scope;
  if (options.interactive !== true) {
    printError('Pass --project or --global.');
    return null;
  }
  if ((options.selectScope !== null && options.selectScope !== undefined)) return options.selectScope();
  const result = await clackSelect<SkillScope>({
    message: 'Install the Migent skill for',
    options: [
      { value: 'project', label: 'Project (this repo)' },
      { value: 'global', label: 'Global (all projects)' },
    ],
    initialValue: 'project',
  });
  if (isCancel(result)) throw new PromptCancelled();
  return result;
}

async function ask(options: SkillOptions, message: string): Promise<boolean | null> {
  if ((options.confirm !== null && options.confirm !== undefined)) return options.confirm(message);
  if (!process.stdin.isTTY) return null;
  const result = await clackConfirm({ message, initialValue: false });
  if (isCancel(result)) throw new PromptCancelled();
  return result;
}
