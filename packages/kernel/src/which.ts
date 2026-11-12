import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const whichModule = require('which') as {
  sync(command: string, options?: { nothrow?: boolean }): string | null;
};

/** The resolved path of `command` on PATH, or null when it is not there. */
export function whichSync(command: string): string | null {
  const found = whichModule.sync(command, { nothrow: true });
  return (found === null || found === undefined) || found === '' ? null : found;
}
