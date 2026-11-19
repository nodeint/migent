/** The `session` mapping of a stage, or null when `resume_from` is not set. */
export function sessionMapping(stage: { resumeFrom: string | null }): Record<string, string> | null {
  return stage.resumeFrom === null ? null : { resume_from: stage.resumeFrom };
}
