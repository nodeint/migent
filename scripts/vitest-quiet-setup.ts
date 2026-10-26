// Tests exercise code that writes progress straight to process.stdout/stderr,
// which vitest's `silent` option does not intercept. Drop it so only failures show.
const noop = (): boolean => true;
process.stdout.write = noop as typeof process.stdout.write;
process.stderr.write = noop as typeof process.stderr.write;
