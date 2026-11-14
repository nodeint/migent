/**
 * Process exit codes of user-facing commands. Pure data describing current behavior. The CLI builds
 * its `--help` exit text from it, and the kernel's stop-reason map is tested against it.
 */

/** Command families that share one exit vocabulary. */
export const EXIT_FAMILIES = ['run', 'run_once', 'role_run', 'resume', 'preflight', 'authoring', 'doctor', 'get', 'complete'] as const;
export type ExitFamily = (typeof EXIT_FAMILIES)[number];

export const EXIT_FAMILY_TITLES: Record<ExitFamily, string> = {
  run: 'Workflow run (`session run`, `session continue`)',
  run_once: 'Workflow run with `--once` or `--stage`',
  role_run: 'Role run (`session run --role`)',
  resume: 'Resume after the prompt cache expired (`session resume`)',
  preflight: 'Preflight before a workflow run',
  authoring: 'Authoring (`config|workflow validate|render|save`)',
  doctor: '`doctor`',
  get: '`get`',
  complete: '`session complete`',
};

/**
 * One exit code and what it means for each command family.
 * Equal to `Static<typeof ExitCodeEntry>` (checked in `exits.ts`).
 */
export interface ExitCodeEntry {
  /** The process exit code. */
  code: number;
  /** Stable name. The stop reason where one exists. */
  name: string;
  /** Per command family: the text that follows `Exit <code> `. */
  descriptions: Record<string, string>;
}

export const EXIT_CATALOG = [
  {
    code: 0,
    name: 'completed',
    descriptions: {
      run: 'when the session is completed.',
      run_once: 'when the stage outcome is complete, or the session is already completed.',
      role_run: 'when the outcome is complete, or the role session is already completed.',
      authoring: 'ok (warnings allowed).',
      doctor: 'when every check passes.',
      get: 'on success, including an empty list.',
      complete: 'on success and when already completed.',
    },
  },
  {
    code: 1,
    name: 'blocked',
    descriptions: {
      run: 'when the session is blocked. session continue runs that stage again.',
      run_once: 'when the stage is not complete, or the session is blocked.',
      role_run: 'when the outcome is not complete.',
      authoring: 'for an invalid draft.',
      doctor: 'when a check fails.',
    },
  },
  {
    code: 2,
    name: 'config',
    descriptions: {
      run: 'on a configuration error.',
      run_once: 'on a configuration error.',
      role_run: 'on a configuration error.',
      preflight: 'when the preflight check finds a problem. Nothing is created or frozen. Pass --skip-preflight to bypass it.',
      authoring: 'for an invocation or I/O error.',
      doctor: 'for an invalid session id or an unreadable session.',
      get: 'on a usage or configuration error, or when the name is not found.',
      complete: 'on a usage error or an invalid session.',
    },
  },
  {
    code: 3,
    name: 'stage_failed',
    descriptions: {
      run: 'when a stage fails. The session stays active.',
      run_once: 'when a non-continue --once or --stage finds a failed stage with no resume marker.',
      authoring: 'for a conflict (`stale-base`, `already-exists`, `session-locked`).',
    },
  },
  {
    code: 4,
    name: 'revisions_exhausted',
    descriptions: {
      run: 'when a route would exceed max_revisions. The session stays active.',
      run_once: 'when a route would exceed max_revisions. The session stays active.',
    },
  },
  {
    code: 5,
    name: 'dispatch_limit',
    descriptions: { run: 'when --max-dispatches is spent. The session stays active.' },
  },
  {
    code: 6,
    name: 'verify_exhausted',
    descriptions: {
      run: 'when verify fails max_verify times. The session stays active.',
      run_once: 'when verify fails max_verify times. The session stays active.',
      role_run: 'when a cancelled role session reopened more than one execution and one exhausted verify.',
    },
  },
  {
    code: 7,
    name: 'verify_failed',
    descriptions: {
      run: 'when a stage with no role fails verify. The session stays active.',
      run_once: 'when a stage with no role fails verify. The session stays active.',
    },
  },
  {
    code: 8,
    name: 'quota',
    descriptions: {
      run: 'when --once or --stage hits a client quota. The session stays active.',
      run_once: 'when --once or --stage hits a client quota.',
    },
  },
  {
    code: 9,
    name: 'question',
    descriptions: {
      run: 'when waiting for a reply to a question.',
      run_once: 'when waiting for a reply to a question.',
    },
  },
  {
    code: 10,
    name: 'resume_expired',
    descriptions: {
      run: 'when a resume waits for a decision after the prompt cache expired. session resume decides it.',
      run_once: 'when a resume waits for a decision after the prompt cache expired.',
      role_run: 'when a resume waits for a decision after the prompt cache expired.',
      resume: 'when another resume still waits for a decision.',
    },
  },
  {
    code: 130,
    name: 'cancelled',
    descriptions: {
      run: 'when cancelled. session continue resumes that execution.',
      run_once: 'when cancelled. session continue resumes that execution.',
      role_run: 'when cancelled. session continue resumes that execution.',
    },
  },
] as const satisfies readonly ExitCodeEntry[];

export type ExitName = (typeof EXIT_CATALOG)[number]['name'];

/** Numeric code for a catalog name. */
export function exitCode(name: ExitName): number {
  const entry = EXIT_CATALOG.find((item) => item.name === name);
  if (!entry) throw new Error(`Unknown exit name: ${name}`);
  return entry.code;
}

/** The `Exit <code> <text>` help lines for one family, in code order, with `order` placing codes first. */
export function exitLines(family: ExitFamily, order?: readonly ExitName[]): string[] {
  const entries = EXIT_CATALOG.filter((entry) => family in entry.descriptions);
  const rank = (name: string) => (order ? order.indexOf(name as ExitName) : -1);
  const sorted = order ? [...entries].sort((a, b) => rank(a.name) - rank(b.name)) : entries;
  return sorted.map((entry) => `Exit ${entry.code} ${(entry.descriptions as Record<string, string>)[family]}`);
}
