export const EXIT_OK = 0;
export const EXIT_BLOCKED = 1;
export const EXIT_CONFIG = 2;
export const EXIT_ATTEMPTS = 3;
export const EXIT_REVISIONS = 4;
export const EXIT_DISPATCHES = 5;
export const EXIT_VERIFY = 6;
export const EXIT_CANCELLED = 130;

export const LOOP_EXITS = [
  `Exit ${EXIT_OK} when the session is completed.`,
  `Exit ${EXIT_BLOCKED} when the session is blocked. session continue runs that stage again.`,
  `Exit ${EXIT_CONFIG} on a configuration error.`,
  `Exit ${EXIT_ATTEMPTS} when --attempts is spent. The session stays active.`,
  `Exit ${EXIT_REVISIONS} when a route would exceed max_revisions. The session stays active.`,
  `Exit ${EXIT_DISPATCHES} when --max-dispatches is spent. The session stays active.`,
  `Exit ${EXIT_VERIFY} when verify fails max_verify times. The session stays active.`,
  `Exit ${EXIT_CANCELLED} when cancelled. session continue resumes that execution.`,
];

export const STAGE_EXITS = [
  `Exit ${EXIT_OK} when the stage outcome is complete, or the session is already completed.`,
  `Exit ${EXIT_BLOCKED} when the stage is not complete, or the session is blocked.`,
  `Exit ${EXIT_CONFIG} on a configuration error.`,
  `Exit ${EXIT_REVISIONS} when a route would exceed max_revisions. The session stays active.`,
  `Exit ${EXIT_VERIFY} when verify fails max_verify times. The session stays active.`,
  `Exit ${EXIT_CANCELLED} when cancelled. session continue resumes that execution.`,
];
