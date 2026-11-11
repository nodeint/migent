import { printError } from '../display.js';
import { createDiscoveryContext } from '../get/discovery.js';
import { OUTPUT_FORMATS, type OutputFormat,renderList, renderOne } from '../get/render.js';
import { clientResolver, findResource, RESOURCES, resourceTypes } from '../get/resources.js';
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
export async function runGet(cwd: string, type: string, name: string | null, options: GetOptions): Promise<number> {
  if (type === 'provider' || type === 'providers') {
    printError('get providers has been removed; use `migent get clients`.');
    return 2;
  }
  const resource = findResource(type);
  if (resource === undefined) {
    printError(`Unknown resource type: ${type}. Valid types: ${resourceTypes()}.`);
    return 2;
  }
  if (options.json === true && options.output !== undefined && options.output !== 'json') {
    printError(`--json conflicts with -o ${options.output}.`);
    return 2;
  }
  const format: string = options.output ?? (options.json === true ? 'json' : 'human');
  if (format !== 'human' && !OUTPUT_FORMATS.includes(format)) {
    printError(`Invalid output format: ${format}. Use json, yaml, or name.`);
    return 2;
  }
  if (resource.kind === 'config' && (format === 'name' || name !== null)) {
    printError(name !== null ? 'config takes no name.' : '-o name is not valid for config.');
    return 2;
  }
  const session = options.session ?? null;
  if (session !== null && resource.kind !== 'workflow') {
    printError('--session is only valid for workflows.');
    return 2;
  }
  const client = options.client ?? null;
  const native = options.native === true;
  if (native && resource.kind !== 'option') {
    printError('--native is only valid for options.');
    return 2;
  }
  if (resource.scope === 'project') {
    if (client !== null) {
      printError('--client is only valid for models, options, and efforts.');
      return 2;
    }
  } else if (client !== null && !resource.acceptsClient) {
    printError(`--client is not valid for ${resource.kind}s.`);
    return 2;
  }

  const output = format as OutputFormat;
  if (resource.scope === 'project') {
    const workspace = findWorkspace(cwd);
    const resolve = clientResolver();
    if (resource.list !== undefined && name === null && session === null) {
      process.stdout.write(renderList(resource.list(workspace, resolve), output, resource.columns, resource.listContract));
      return 0;
    }
    process.stdout.write(renderOne(resource.get(workspace, name, resolve, session), output, resource.contract));
    return 0;
  }

  const context = createDiscoveryContext();
  const query = { name, client, native };
  const columns = resource.columnsFor?.(query) ?? resource.columns;
  const contracts = resource.contractFor?.(query) ?? { one: resource.contract, item: resource.listContract };
  if (resource.list !== undefined && name === null) {
    process.stdout.write(renderList(await resource.list(context, query), output, columns, contracts.item));
    return 0;
  }
  process.stdout.write(renderOne(await resource.get(context, query), output, contracts.one));
  return 0;
}

export function getHelpTypes(): string {
  return RESOURCES.map((resource) => `  ${resource.names.slice(0, 2).join(', ').padEnd(18)}${resource.summary}`).join('\n');
}
