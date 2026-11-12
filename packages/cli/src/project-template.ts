import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigurationError } from '@nodeint/migent-kernel';
import { type Document, isMap, isScalar, parse,parseDocument } from 'yaml';

import { isDirectory } from './fs-utils.js';

export const PRESETS = ['implement', 'plan'] as const;
/** The only `model` value of a template `agents` entry; it marks the slot while the template stays a valid layer. */
const AGENT_SENTINEL = '{{agent}}';

export interface ModelChoice {
  client: string;
  model: string;
  effort?: string;
  options: Record<string, string>;
}

export interface RenderedFile {
  /** Path relative to the workspace root. */
  path: string;
  content: string;
}

/**
 * Compiled modules (`.js`) read only `templates/project` beside them; source modules (`.ts`) read the
 * root `templates/`. A compiled layout never falls back to repository files.
 */
export function projectTemplateDirectory(moduleUrl: string = import.meta.url): string {
  if (moduleUrl.endsWith('.ts')) {
    return path.resolve(fileURLToPath(new URL('../../../templates/', moduleUrl)));
  }
  const built = path.resolve(fileURLToPath(new URL('./templates/project/', moduleUrl)));
  if (!isDirectory(built)) {
    throw new ConfigurationError(`Packaged project templates are missing: ${built}. Reinstall or rebuild the CLI.`);
  }
  return built;
}

function readAsset(directory: string, relative: string): string {
  try {
    return readFileSync(path.join(directory, relative), 'utf8');
  } catch {
    throw new ConfigurationError(`Project template asset is missing or unreadable: ${relative} (in ${directory}).`);
  }
}

/** An agent slot of the template and the roles that use it. */
export interface AgentSlot {
  name: string;
  roles: string[];
}

/** The ordered agent slots of the template; throws a `ConfigurationError` when the template is inconsistent. */
export function discoverAgentSlots(directory: string = projectTemplateDirectory()): AgentSlot[] {
  return checkTemplate(directory).slots;
}

/** Pure render: loads assets, fills every agent slot with its model, and returns every file to write. */
export function renderProject(
  models: Readonly<Record<string, ModelChoice>>,
  directory: string = projectTemplateDirectory(),
): RenderedFile[] {
  const { doc, slots } = checkTemplate(directory);
  const names = slots.map((slot) => slot.name);
  const given = Object.keys(models);
  if (names.length !== given.length || names.some((name) => !Object.hasOwn(models, name))) {
    throw new ConfigurationError(`Models must cover exactly the template agents: ${names.join(', ')}.`);
  }
  for (const name of names) {
    const choice = models[name];
    if (!choice) continue;
    const node: Record<string, unknown> = {
      model: choice.model,
      client: { type: choice.client, ...(Object.keys(choice.options).length > 0 ? { options: choice.options } : {}) },
    };
    if (choice.effort !== undefined) node.effort = choice.effort;
    doc.setIn(['agents', name], doc.createNode(node));
  }
  const config = doc.toString({ defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN', lineWidth: 0 });
  return [
    { path: '.migent/config.yaml', content: config },
    { path: '.migent/config.local.yaml', content: readAsset(directory, 'config.local.yaml') },
    ...PRESETS.map((preset) => ({
      path: `.migent/workflows/${preset}.yaml`,
      content: readAsset(directory, `workflows/${preset}.yaml`),
    })),
    { path: '.migent/.gitignore', content: readAsset(directory, '.gitignore.txt') },
  ];
}

/** Parses the template config and checks agents, roles, and preset workflow references agree. */
function checkTemplate(directory: string): { doc: Document; slots: AgentSlot[] } {
  const doc = parseDocument(readAsset(directory, 'config.yaml'));
  if (doc.errors.length > 0) {
    throw new ConfigurationError(`Project template config.yaml is invalid: ${doc.errors[0]?.message}`);
  }
  const slots = readSlots(doc);
  const roles = readRoles(doc, slots);
  for (const slot of slots) {
    if (slot.roles.length === 0) {
      throw new ConfigurationError(`Project template config.yaml is missing or invalid: agents.${slot.name} is used by no role.`);
    }
  }
  checkPresets(directory, new Set(roles), new Set(slots.map((slot) => slot.name)));
  return { doc, slots };
}

function slotNamed(slots: readonly AgentSlot[], name: unknown): AgentSlot | undefined {
  return slots.find((slot) => slot.name === name);
}

function keyName(key: unknown): string {
  return String(isScalar(key) ? key.value : key);
}

function readSlots(doc: Document): AgentSlot[] {
  const agents = doc.get('agents');
  if (!isMap(agents) || agents.items.length === 0) {
    throw new ConfigurationError('Project template config.yaml is missing or invalid: agents.');
  }
  return agents.items.map((pair) => {
    const name = keyName(pair.key);
    if (!isMap(pair.value) || pair.value.items.length !== 1 || pair.value.get('model') !== AGENT_SENTINEL) {
      throw new ConfigurationError(`Project template config.yaml is missing or invalid: agents.${name}.`);
    }
    return { name, roles: [] };
  });
}

/** Records each role on the slot it names and returns the role names. */
function readRoles(doc: Document, slots: readonly AgentSlot[]): string[] {
  const roles = doc.get('roles');
  if (!isMap(roles) || roles.items.length === 0) {
    throw new ConfigurationError('Project template config.yaml is missing or invalid: roles.');
  }
  return roles.items.map((pair) => {
    const role = keyName(pair.key);
    const agent = isMap(pair.value) ? pair.value.get('agent') : undefined;
    const slot = slotNamed(slots, agent);
    if (!slot) throw new ConfigurationError(`Project template config.yaml is missing or invalid: roles.${role}.agent.`);
    slot.roles.push(role);
    return role;
  });
}

function checkPresets(directory: string, roles: ReadonlySet<string>, agents: ReadonlySet<string>): void {
  for (const preset of PRESETS) {
    const file = `workflows/${preset}.yaml`;
    const stages = (parse(readAsset(directory, file)) as { stages?: unknown } | null)?.stages;
    if (!Array.isArray(stages)) continue;
    for (const [index, stage] of stages.entries()) {
      const { role, agent } = (stage ?? {}) as { role?: unknown; agent?: unknown };
      if (typeof role === 'string' && !roles.has(role)) {
        throw new ConfigurationError(`Project template ${file} is invalid: stages[${index}].role names undefined role ${role}.`);
      }
      if (typeof agent === 'string' && !agents.has(agent)) {
        throw new ConfigurationError(`Project template ${file} is invalid: stages[${index}].agent names undefined agent ${agent}.`);
      }
    }
  }
}
