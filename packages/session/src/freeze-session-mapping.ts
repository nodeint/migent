/** The `session` mapping of a stage, or null when neither `resume_from` nor `on_expired` is set. */
interface SessionFields {
  resumeFrom: string | null;
  onExpired: string | null;
}

export function sessionMapping(stage: SessionFields): Record<string, string> | null {
  if (stage.resumeFrom === null && stage.onExpired === null) return null;
  const session: Record<string, string> = {};
  if (stage.resumeFrom !== null) session.resume_from = stage.resumeFrom;
  if (stage.onExpired !== null) session.on_expired = stage.onExpired;
  return session;
}
