import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigurationError } from '@nodeint/migent-kernel';
import { isMap, parseDocument } from 'yaml';

import { isDirectory } from './fs-utils.js';

export const PRESETS = ['implement', 'plan'] as const;
const ROLES = ['planner', 'reviewer', 'developer'] as const;

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

/** Pure render: loads assets, applies the selected models, and returns every file to write. */
export function renderProject(
  models: { planner: ModelChoice; reviewer: ModelChoice; developer: ModelChoice },
  directory: string = projectTemplateDirectory(),
): RenderedFile[] {
  const config = renderConfig(readAsset(directory, 'config.yaml'), models);
  const localConfig = readAsset(directory, 'config.local.yaml');
  return [
    { path: '.migent/config.yaml', content: config },
    { path: '.migent/config.local.yaml', content: localConfig },
    ...PRESETS.map((preset) => ({
      path: `.migent/workflows/${preset}.yaml`,
      content: readAsset(directory, `workflows/${preset}.yaml`),
    })),
    { path: '.migent/.gitignore', content: readAsset(directory, '.gitignore.txt') },
  ];
}

function renderConfig(source: string, models: Record<(typeof ROLES)[number], ModelChoice>): string {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    throw new ConfigurationError(`Project template config.yaml is invalid: ${doc.errors[0]?.message}`);
  }
  for (const role of ROLES) {
    if (!isMap(doc.getIn(['roles', role]))) {
      throw new ConfigurationError(`Project template config.yaml is missing or invalid: roles.${role}.`);
    }
    if (doc.getIn(['roles', role, 'agent']) !== `{{${role}.agent}}`) {
      throw new ConfigurationError(`Project template config.yaml is missing or invalid: roles.${role}.agent.`);
    }
    const choice = models[role];
    const node: Record<string, unknown> = {
      model: choice.model,
      client: { type: choice.client, ...(Object.keys(choice.options).length > 0 ? { options: choice.options } : {}) },
    };
    if (choice.effort !== undefined) node.effort = choice.effort;
    doc.setIn(['roles', role, 'agent'], doc.createNode(node));
  }
  return doc.toString({ defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN', lineWidth: 0 });
}
