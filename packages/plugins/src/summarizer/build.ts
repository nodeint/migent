import type {
  PluginExecutionRow, PluginSessionArtifact, PluginSessionArtifacts, PluginSessionSnapshot,
} from '@nodeint/migent-contracts';

const MAX_LINES = 20;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const rowsOf = (snapshot: PluginSessionSnapshot): PluginExecutionRow[] =>
  snapshot.executions as unknown as PluginExecutionRow[];

function executionLine(row: PluginExecutionRow): string {
  const parts = [
    `${row.stageId} attempt ${row.attempt ?? '?'} (${row.id})`,
    `status ${row.status ?? 'unknown'}`,
    `outcome ${row.outcomeStatus ?? 'none'}`,
  ];
  if (row.blocker) parts.push(`blocker: ${row.blocker}`);
  if (row.error) parts.push(`error: ${row.error}`);
  if (row.failureReason) parts.push(`failure: ${row.failureReason}`);
  return `- ${parts.join('; ')}`;
}

const optionLabel = (option: Record<string, unknown>): string => String(option.label ?? option.id ?? '');

function optionLabels(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.filter(isRecord).map(optionLabel).filter(Boolean);
}

/** Every pending question from `status.questions`: stopped stages can each hold one, not only the latest run. */
function questionLines(snapshot: PluginSessionSnapshot): string[] {
  const { questions } = snapshot.status;
  if (!Array.isArray(questions)) return [];
  return questions.filter(isRecord).map((question) => {
    const options = optionLabels(question.options);
    const where = `stage ${String(question.stage_id ?? '?')}, execution ${String(question.execution_id ?? '?')}`;
    const suffix = options.length > 0 ? ` Options: ${options.join(' | ')}.` : '';
    return `- (${where}) ${String(question.question ?? '')}${suffix}`;
  });
}

/** The latest execution of each stage whose outcome is `blocked`; the outcome decides, not the status. */
function blockedRows(snapshot: PluginSessionSnapshot): PluginExecutionRow[] {
  const latest = new Map<string, { row: PluginExecutionRow; position: number }>();
  for (const [index, row] of rowsOf(snapshot).entries()) {
    const position = row.order ?? index;
    const current = latest.get(row.stageId);
    if (current === undefined || position >= current.position) latest.set(row.stageId, { row, position });
  }
  return [...latest.values()].filter(({ row }) => row.outcomeStatus === 'blocked').map(({ row }) => row);
}

function artifactBlock(entry: PluginSessionArtifact): string {
  const label = `${entry.stage_id ?? '?'}/${entry.execution_id}/${entry.path}`;
  if (entry.skipped !== null) return `### ${label}\n(not included: ${entry.skipped})`;
  const note = entry.truncated ? ' (shortened: the file is longer than shown)' : '';
  return `### ${label}${note}\n${entry.content ?? ''}`;
}

function eventLine(event: PluginSessionSnapshot['events'][number]): string {
  const stage = event.stageId === null ? '' : ` [${event.stageId}]`;
  const summary = event.summary ? `: ${event.summary}` : '';
  return `- ${event.timestamp} ${event.event}${stage}${summary}`;
}

function eventLines(snapshot: PluginSessionSnapshot): string[] {
  return snapshot.events.filter((event) => !event.event.startsWith('provider.')).map(eventLine);
}

const section = (title: string, lines: readonly string[]): string[] =>
  lines.length === 0 ? [] : [`## ${title}`, ...lines, ''];

/** Pure: the whole prompt of one summary. Names the shortened and skipped artifacts so the agent can report them. */
export function buildPrompt(
  sessionId: string,
  snapshot: PluginSessionSnapshot,
  artifacts: PluginSessionArtifacts,
): string {
  const { status } = snapshot;
  const incomplete = artifacts.entries.filter((entry) => entry.truncated || entry.skipped !== null)
    .map((entry) => `- ${entry.stage_id ?? '?'}/${entry.path}: ${entry.skipped ?? 'shortened'}`);
  const blocked = blockedRows(snapshot).map(executionLine);
  return [
    'You write a short status summary of one Migent session for a person who returns to it later.',
    'Write Markdown with exactly three sections, "## Done", "## Current state" and "## Needs attention",',
    `in at most about ${MAX_LINES} lines in total.`,
    'Do not write a title line. Use only the facts below. Name any pending question under "Needs attention".',
    'Say which artifacts are shortened or not included when they matter.',
    '',
    `Session: ${sessionId}`,
    `Workflow: ${String(status.workflow_id ?? 'none')}`,
    `Status: ${String(status.status ?? 'unknown')}`,
    '',
    ...section('Executions', rowsOf(snapshot).map(executionLine)),
    ...section('Pending questions', questionLines(snapshot)),
    ...section('Blocked outcomes', blocked),
    ...section('Lifecycle events', eventLines(snapshot)),
    ...section('Shortened or skipped artifacts', incomplete),
    ...section('Artifacts', artifacts.entries.map(artifactBlock)),
  ].join('\n');
}
