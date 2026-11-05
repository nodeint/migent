import { printError } from "../display.js";
import { OUTPUT_FORMATS, renderList, renderOne, type OutputFormat } from "../get/render.js";
import { RESOURCES, findResource, providerResolver, resourceTypes } from "../get/resources.js";

export interface GetOptions {
  output?: string | undefined;
  json?: boolean;
  session?: string | undefined;
}

/** Read-only lookup of what the project defines. Exit 0 on success, 2 on a usage or configuration error. */
export function runGet(workspace: string, type: string, name: string | null, options: GetOptions): number {
  const resource = findResource(type);
  if (resource === undefined) {
    printError(`Unknown resource type: ${type}. Valid types: ${resourceTypes()}.`);
    return 2;
  }
  if (options.json === true && options.output !== undefined && options.output !== "json") {
    printError(`--json conflicts with -o ${options.output}.`);
    return 2;
  }
  const format: string = options.output ?? (options.json === true ? "json" : "human");
  if (format !== "human" && !OUTPUT_FORMATS.includes(format)) {
    printError(`Invalid output format: ${format}. Use json, yaml, or name.`);
    return 2;
  }
  if (resource.kind === "config" && (format === "name" || name !== null)) {
    printError(name !== null ? "config takes no name." : "-o name is not valid for config.");
    return 2;
  }
  const session = options.session ?? null;
  if (session !== null && resource.kind !== "workflow") {
    printError("--session is only valid for workflows.");
    return 2;
  }
  const resolve = providerResolver();
  const output = format as OutputFormat;
  if (resource.list !== undefined && name === null && session === null) {
    process.stdout.write(renderList(resource.list(workspace, resolve), output, resource.columns));
    return 0;
  }
  process.stdout.write(renderOne(resource.get(workspace, name, resolve, session), output));
  return 0;
}

export function getHelpTypes(): string {
  return RESOURCES.map((resource) => `  ${resource.names.slice(0, 2).join(", ").padEnd(18)}${resource.summary}`).join("\n");
}
