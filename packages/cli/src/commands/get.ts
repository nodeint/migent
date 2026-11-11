import { printError } from '../display.js';
import { EXIT_CONFIG } from '../exits.js';
import { createDiscoveryContext } from '../get/discovery.js';
import { OUTPUT_FORMATS, type OutputFormat,renderList, renderOne } from '../get/render.js';
import type { MachineQuery, MachineResource, ProjectResource, Resource } from '../get/resource-types.js';
import { clientResolver, findResource, LIST_NAME_WIDTH, LISTED_NAMES, RESOURCES, resourceTypes } from '../get/resources.js';
import { findWorkspace } from '../workspace.js';

export interface GetOptions {
  output?: string | undefined;
  json?: boolean;
  session?: string | undefined;
  client?: string | undefined;
  native?: boolean;
}

/**
 * Read-only lookup. Project types read the workspace; machine types read the
 * host and may run discovery. Exit 0 on success, 2 on a usage or configuration error.
 */
export async function runGet(
  cwd: string,
  target: { type: string; name: string | null },
  options: GetOptions,
): Promise<number> {
  const { type, name } = target;
  const resolved = resolveRequest(type, name, options);
  if (typeof resolved === 'string') {
    printError(resolved);
    return EXIT_CONFIG;
  }
  const { resource, output } = resolved;
  const session = options.session ?? null;
  if (resource.scope === 'project') {
    process.stdout.write(renderProject(resource, findWorkspace(cwd), { name, session, output }));
    return 0;
  }
  const query = { name, client: options.client ?? null, native: options.native === true };
  process.stdout.write(await renderMachine(resource, query, output));
  return 0;
}

/** The resource and output format of a valid request, or the usage error to print. */
function resolveRequest(
  type: string,
  name: string | null,
  options: GetOptions,
): { resource: Resource; output: OutputFormat } | string {
  if (type === 'provider' || type === 'providers') return 'get providers has been removed; use `migent get clients`.';
  const resource = findResource(type);
  if (resource === undefined) return `Unknown resource type: ${type}. Valid types: ${resourceTypes()}.`;
  const format = formatOf(options);
  if (format.error !== undefined) return format.error;
  const error = resourceOptionError(resource, name, { ...options, output: format.value });
  return error ?? { resource, output: format.value as OutputFormat };
}

function formatOf(options: GetOptions): { value: string; error?: string } {
  if (options.json === true && options.output !== undefined && options.output !== 'json') {
    return { value: options.output, error: `--json conflicts with -o ${options.output}.` };
  }
  const value: string = options.output ?? (options.json === true ? 'json' : 'human');
  if (value !== 'human' && !OUTPUT_FORMATS.includes(value)) {
    return { value, error: `Invalid output format: ${value}. Use json, yaml, or name.` };
  }
  return { value };
}

function resourceOptionError(resource: Resource, name: string | null, options: GetOptions): string | null {
  if (resource.kind === 'config' && (options.output === 'name' || name !== null)) {
    return name !== null ? 'config takes no name.' : '-o name is not valid for config.';
  }
  if (options.session !== undefined && resource.kind !== 'workflow') return '--session is only valid for workflows.';
  if (options.native === true && resource.kind !== 'option') return '--native is only valid for options.';
  return clientOptionError(resource, options.client ?? null);
}

function clientOptionError(resource: Resource, client: string | null): string | null {
  if (client === null) return null;
  if (resource.scope === 'project') return '--client is only valid for models, options, and efforts.';
  return resource.acceptsClient ? null : `--client is not valid for ${resource.kind}s.`;
}

function renderProject(
  resource: ProjectResource,
  workspace: string,
  request: { name: string | null; session: string | null; output: OutputFormat },
): string {
  const { name, session, output } = request;
  const resolve = clientResolver();
  if (resource.list !== undefined && name === null && session === null) {
    return renderList(
      resource.list(workspace, resolve),
      output,
      { columns: resource.columns, itemContract: resource.listContract },
    );
  }
  return renderOne(resource.get(workspace, { name, session }, resolve), output, resource.contract);
}

async function renderMachine(resource: MachineResource, query: MachineQuery, output: OutputFormat): Promise<string> {
  const context = createDiscoveryContext();
  const columns = resource.columnsFor?.(query) ?? resource.columns;
  const contracts = resource.contractFor?.(query) ?? { one: resource.contract, item: resource.listContract };
  if (resource.list !== undefined && query.name === null) {
    return renderList(await resource.list(context, query), output, { columns, itemContract: contracts.item });
  }
  return renderOne(await resource.get(context, query), output, contracts.one);
}

export function getHelpTypes(): string {
  return RESOURCES.map((resource) => `  ${resource.names.slice(0, LISTED_NAMES).join(', ').padEnd(LIST_NAME_WIDTH)}${resource.summary}`).join('\n');
}
