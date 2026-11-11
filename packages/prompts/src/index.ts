import { renderPrompt } from './renderer.js';

export { renderPrompt };

export type AskTarget = string;

/**
 * `full` (or `true`) sends the whole response contract; use it when the conversation has not seen it
 * under the current protocol. `reminder` targets the same agent and only restates the status line.
 */
export type ContractMode = boolean | 'full' | 'reminder';

/** What the turn's message is. It picks the instruction under `## Do`; absent means a free-form request. */
export type TurnKind = 'start' | 'continue' | 'reply' | 'answers' | 'repair' | 'correction'
  | 'response_correction' | 'output_correction' | 'handoff_correction';

const TURN_DIRECTIVES: Record<TurnKind, string> = {
  start: 'carry out the stage.',
  continue: 'continue the stage with the context above.',
  reply: 'Continue the stage with the human reply above.',
  answers: 'Continue the stage using these answers.',
  repair: 'Fix the verify failure above, then report again.',
  correction: 'Rewrite the whole question file as one valid JSON document, then respond again.',
  response_correction: 'Send the response again in the required format. Do not redo the work.',
  output_correction: 'Write the missing files, then report again.',
  handoff_correction: 'Rewrite the whole handoff file as one valid JSON document, then respond again.',
};

/** Protocol 3: the stage result is the handoff file. Protocol 2: response headers plus a question file. */
export const HANDOFF_FILE_PROTOCOL = 3;
/** Oldest response protocol still understood. */
export const LEGACY_RESPONSE_PROTOCOL = 2;
export const CURRENT_RESPONSE_PROTOCOL = HANDOFF_FILE_PROTOCOL;

function directive(turn: TurnKind | null, hasTask: boolean, handoff: boolean): string {
  if (handoff && turn === 'output_correction') return 'Write the missing files, then rewrite the handoff file.';
  if (handoff && turn === 'repair') return 'Fix the verify failure above, then rewrite the handoff file.';
  if (turn === 'start' || turn === 'continue') {
    const text = TURN_DIRECTIVES[turn];
    return hasTask ? `Read the task, then ${text}` : text[0].toUpperCase() + text.slice(1);
  }
  return turn === null ? 'Carry out the request above.' : TURN_DIRECTIVES[turn];
}

export interface ProviderPromptOptions {
  contract?: ContractMode;
  turn?: TurnKind | null;
  decisionValues?: readonly string[];
  decisionInstructions?: Readonly<Record<string, string>>;
  ask?: AskTarget | null;
  /** Response protocol the conversation runs under. Defaults to the current protocol (3). */
  protocol?: number;
  /** Absolute path of the handoff file. Required to describe protocol 3. */
  handoffFile?: string | null;
  /** Absolute path of the question request file. Required to describe the question protocol when `ask` is set. */
  questionFile?: string | null;
  artifactDirectory?: string;
  artifactName?: string | null;
  /** Every file the stage writes; `decision` is set for files only a given decision requires. */
  artifactFiles?: readonly { file: string; description: string | null; required: boolean; decision: string | null }[];
  /** Artifact directory of the execution this turn continues, when it differs from `artifactDirectory`. */
  previousArtifactDirectory?: string | null;
  previousVerifyReport?: string | null;
  /** Session task file and directory, listed first under Execution. */
  taskFile?: string | null;
  sessionDirectory?: string | null;
}

type EnvelopeMode = 'full' | 'reminder' | null;
type EnvelopeDecision = { name: string; instruction: string | null };
type ArtifactFile = NonNullable<ProviderPromptOptions['artifactFiles']>[number];

function contractMode(options: ProviderPromptOptions): EnvelopeMode {
  return options.contract === true ? 'full' : options.contract || null;
}

function envelopeDecisions(options: ProviderPromptOptions, mode: EnvelopeMode): EnvelopeDecision[] {
  if (mode === null) return [];
  const instructions = options.decisionInstructions ?? {};
  return (options.decisionValues ?? []).filter(Boolean).map((value) => {
    const name = value.toLowerCase();
    return { name, instruction: instructions[name] ?? null };
  });
}

function artifactFileLine(item: ArtifactFile): string {
  const when = item.decision === null ? '' : ` (with \`decision: ${item.decision}\`)`;
  const kind = item.required ? '' : ' [optional]';
  const note = item.description === null ? '' : `: ${item.description}`;
  return `- \`${item.file}\`${when}${kind}${note}`;
}

function artifactLines(files: readonly ArtifactFile[], artifactName: string | null): string[] {
  const multi = files.length > 1 || files.some((item) => item.decision !== null || item.description !== null);
  if (multi) return ['Write these artifacts in the artifacts directory:', ...files.map(artifactFileLine)];
  return artifactName ? [`Write the artifact as \`${artifactName}\` in the artifacts directory.`] : [];
}

function reminderLine(handoff: boolean, statusLabel: string, decisions: readonly EnvelopeDecision[]): string {
  const decisionLabel = decisions.map(({ name }) => name).join('|');
  const decision = decisions.length > 0 ? `, with \`decision: ${decisionLabel}\` when complete` : '';
  return handoff
    ? `Same response contract and stage instructions as before: write the handoff file with \`status\` ${statusLabel}${decision}.`
    : `Same response contract and stage instructions as before: start with \`status: ${statusLabel}\`${decision}.`;
}

interface DoTextInput {
  options: ProviderPromptOptions;
  mode: EnvelopeMode;
  handoff: boolean;
  statusLabel: string;
  decisions: readonly EnvelopeDecision[];
  artifactName: string | null;
  taskFile: string | null;
}

// The single place that tells the agent what to do this turn.
function doText(input: DoTextInput): string {
  const { options, mode, handoff, statusLabel, decisions, artifactName, taskFile } = input;
  const doLines: string[] = [];
  if (mode !== null) doLines.push(directive(options.turn ?? null, taskFile !== null, handoff));
  doLines.push(...artifactLines(options.artifactFiles ?? [], artifactName));
  if (mode === 'reminder') doLines.push(reminderLine(handoff, statusLabel, decisions));
  return doLines.join('\n');
}

/** Per-execution file locations, defaulted for the template. */
function envelopePaths(options: ProviderPromptOptions) {
  return {
    handoffFile: options.handoffFile ?? '',
    questionFile: options.questionFile ?? '',
    artifactDirectory: options.artifactDirectory ?? '',
    sessionDirectory: options.sessionDirectory ?? '',
  };
}

function envelope(options: ProviderPromptOptions) {
  const mode = contractMode(options);
  const decisions = envelopeDecisions(options, mode);
  const handoff = (options.protocol ?? CURRENT_RESPONSE_PROTOCOL) >= HANDOFF_FILE_PROTOCOL;
  const canAsk = mode !== null && (options.ask !== null && options.ask !== undefined);
  const artifactName = options.artifactName ?? null;
  const previousArtifactDirectory = artifactName ? options.previousArtifactDirectory ?? null : null;
  const previousVerifyReport = options.previousVerifyReport ?? null;
  const taskFile = options.taskFile ?? null;
  const statusLabel = canAsk ? 'complete | question | blocked' : 'complete | blocked';
  const handoffContract = handoff && mode !== null;
  return {
    full: mode === 'full',
    reminder: mode === 'reminder',
    contract: mode !== null,
    canAsk,
    statusLabel,
    handoff,
    handoffContract,
    ...envelopePaths(options),
    decisions,
    decisionLabel: decisions.map(({ name }) => name).join('|'),
    artifactName,
    previousArtifactDirectory,
    previousVerifyReport,
    taskFile,
    hasExecution: taskFile !== null || canAsk || handoffContract || artifactName !== null
      || previousVerifyReport !== null,
    doText: doText({ options, mode, handoff, statusLabel, decisions, artifactName, taskFile }),
  };
}

/** Layout: stable contract first, then the message, then per-execution paths, then the closing ask. */
export function renderProviderPrompt(prompt: string, options: ProviderPromptOptions = {}): string {
  return renderPrompt('provider-turn', { prompt, ...envelope(options) });
}

export function addArtifactContext(prompt: string, artifactDirectory: string, artifactName?: string | null): string {
  return renderProviderPrompt(prompt, { artifactDirectory, artifactName });
}

export type StageOutcomeContractOptions = Pick<ProviderPromptOptions, 'decisionValues' | 'decisionInstructions' | 'ask'>;

export function addStageOutcomeContract(prompt: string, options: StageOutcomeContractOptions = {}): string {
  const { decisionValues = [], decisionInstructions = {}, ask = null } = options;
  return renderProviderPrompt(prompt, { contract: true, decisionValues, decisionInstructions, ask });
}

export function flattenHistory(history: readonly { role: string; content: string }[]): string {
  return renderPrompt('history', { history });
}

/** Context the kernel gathers for a stage message. Fields mirror the template variables. */
export interface StageContext {
  taskFile: string;
  sessionDirectory: string;
  stage: { id: string; role: string; instructions: readonly string[]; verify: readonly string[] };
  roleInstructions: readonly string[];
  constraints: readonly string[];
  upstream: readonly { stageId: string; path: string; verify: boolean; description: string | null; updated: boolean }[];
  routed: unknown;
  blocked: unknown;
  failed?: unknown;
  prior: unknown;
}

/** Role and stage instructions render as separate lists; a stage line already in the role list is dropped. */
export function renderStageStart(context: StageContext): string {
  const roleInstructions = [...new Set(context.roleInstructions)];
  const stageInstructions = [...new Set(context.stage.instructions)].filter((line) => !roleInstructions.includes(line));
  return renderPrompt('stage-start', { ...context, roleInstructions, stageInstructions });
}

export function renderStageContinue(context: object): string {
  return renderPrompt('stage-continue', context);
}

export interface StageReplyOptions {
  /** The reply is formatted answers to the agent's pending questions. */
  answers?: boolean;
  /** The human stopped the agent's previous turn before it finished. */
  interrupted?: boolean;
}

/** Reply to a stage that already holds the conversation. The runner adds the execution paths and closing ask. */
export function buildStageReplyPrompt(reply: string, options: StageReplyOptions = {}): string {
  return renderPrompt('stage-reply', { reply, answers: options.answers ?? false, interrupted: options.interrupted ?? false });
}

export function prependRoleInstructions(instructions: readonly string[], prompt: string): string {
  return renderPrompt('role-run', { instructions, prompt });
}

export interface VerifyRepairContext {
  report: string;
  red: number;
  maxVerify: number;
  artifactPath: string | null;
  taskFile: string | null;
  sessionDirectory: string | null;
}

export function renderVerifyRepair(context: VerifyRepairContext): string {
  return renderPrompt('verify-repair', context);
}

export interface AnsweredQuestion {
  id: string;
  question: string;
  selection: 'single' | 'multiple';
  options: readonly { id: string; label: string }[];
}
export interface QuestionAnswerInput {
  question_id: string;
  selected: readonly string[];
  text?: string;
}

/**
 * Structured answers for the agent. Every answer echoes its question, so it reads correctly after
 * context compaction. `Selected:` is always present (`none` when empty); `Free text:` only when given.
 */
export function formatQuestionAnswers(
  questions: readonly AnsweredQuestion[],
  answers: readonly QuestionAnswerInput[],
): string {
  return answers.map((answer) => {
    const question = questions.find((row) => row.id === answer.question_id);
    if (question === undefined) throw new Error(`Answer references unknown question: ${answer.question_id}`);
    const selected = answer.selected.map((id) => {
      const option = question.options.find((candidate) => candidate.id === id);
      if (option === undefined) throw new Error(`Answer references unknown option ${id} of question ${answer.question_id}`);
      return `${id}. ${option.label}`;
    });
    const lines = [
      `${answer.question_id}. ${question.question} (${question.selection})`,
      `   - Selected: ${selected.length > 0 ? selected.join('; ') : 'none'}`,
    ];
    if (answer.text) lines.push(`   - Free text: ${JSON.stringify(answer.text)}`);
    return lines.join('\n');
  }).join('\n\n');
}

export interface QuestionCorrectionContext {
  questionFile: string;
  errorKind: string;
  errorDetail: string;
}

/** The single correction message sent when a question request file fails validation. */
export function renderQuestionCorrection(context: QuestionCorrectionContext): string {
  return renderPrompt('question-correction', context);
}

export interface GateCorrectionContext {
  errorKind: string;
  errorDetail: string;
  /** Set under protocol 3: the agent must rewrite this handoff file after fixing the problem. */
  handoffFile?: string | null;
}

export interface HandoffCorrectionContext {
  handoffFile: string;
  errorKind: string;
  errorDetail: string;
}

/** The single correction message sent when a handoff file fails validation. */
export function renderHandoffCorrection(context: HandoffCorrectionContext): string {
  return renderPrompt('handoff-correction', context);
}

/** The correction message sent when the response violates the response contract. */
export function renderResponseCorrection(context: GateCorrectionContext): string {
  return renderPrompt('response-correction', context);
}

/** The correction message sent when required artifacts or completion outputs are missing. */
export function renderOutputCorrection(context: GateCorrectionContext): string {
  return renderPrompt('output-correction', { ...context, handoff: (context.handoffFile !== null && context.handoffFile !== undefined), handoffFile: context.handoffFile ?? '' });
}

/**
 * Appended to a prompt saved under an older response protocol. It carries the current
 * contract and states that it replaces the earlier response instructions.
 */
export function renderProtocolUpdate(options: ProviderPromptOptions): string {
  return renderPrompt('protocol-update', envelope({ ...options, protocol: 2, contract: 'full' }));
}
