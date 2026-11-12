/** Base for every `$id`. Equals the raw URL of the generated files in `packages/contracts/schemas` on `main`. */
export const SCHEMA_BASE = 'https://raw.githubusercontent.com/nodeint/migent/main/packages/contracts/schemas';

export const id = (path: string): string => `${SCHEMA_BASE}/${path}.json`;
