// The single owner of `process.env` in production source (enforced by test/env-guard.test.ts).
// `process-wrapper.ts` runs from source via `node process-wrapper.ts` and imports this module, so
// it may import only Node built-ins plus type-only imports (erased on type stripping).
// Every non-platform variable read here must be in the contracts catalog (test/env.test.ts scans this file).

/** `MIGENT_DEBUG=1|true`. */
export function debugEnabled(): boolean {
  const value = process.env.MIGENT_DEBUG;
  return value === '1' || value === 'true';
}

/** `MIGENT_NO_INPUT=1`. */
export function noInputRequested(): boolean {
  return process.env.MIGENT_NO_INPUT === '1';
}

/** Non-empty `MIGENT_HOME`, verbatim; otherwise undefined. */
export function migentHomeOverride(): string | undefined {
  return process.env.MIGENT_HOME || undefined;
}

/** Inherited environment plus `DISABLE_TELEMETRY=1` unless already set (empty string kept). */
export function skillsChildEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DISABLE_TELEMETRY: process.env.DISABLE_TELEMETRY ?? '1' };
}

/** The full inherited environment, for detached children. */
export function inheritedEnv(): NodeJS.ProcessEnv {
  return process.env;
}

/** Platform `HOME` (not a Migent contract), for `~` expansion. */
export function platformHome(): string | undefined {
  return process.env.HOME;
}

/** Platform `ComSpec` (not a Migent contract): the Windows command interpreter. */
export function platformComSpec(): string | undefined {
  return process.env.ComSpec || undefined;
}
