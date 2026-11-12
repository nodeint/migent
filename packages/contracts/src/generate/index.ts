import { generateMarkdownFiles } from './markdown.js';
import { generateSchemaFiles } from './schemas.js';

export { collectIdentities, schemaPath } from './schemas.js';

/** Every generated file, keyed by repo-relative path. */
export function generateAll(): Record<string, string> {
  return { ...generateSchemaFiles(), ...generateMarkdownFiles() };
}
