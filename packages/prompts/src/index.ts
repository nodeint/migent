import { renderPrompt } from "./renderer.js";

export { renderPrompt };

export type AskTarget = string;

/**
 * `full` (or `true`) sends the whole response contract; use it when the conversation has not seen it
 * under the current protocol. `reminder` targets the same agent and only restates the status line.
 */
export type ContractMode = boolean | "full" | "reminder";

/** What the turn's message is. It picks the instruction under `## Do`; absent means a free-form request. */
export type TurnKind = "start" | "continue" | "reply" | "answers" | "repair" | "correction";

const TURN_DIRECTIVES: Record<TurnKind, string> = {
  start: "carry out the stage.",
  continue: "continue the stage with the context above.",
  reply: "Continue the stage with the human reply above.",
  answers: "Continue the stage using these answers.",
  repair: "Fix the verify failure above, then report again.",
  correction: "Rewrite the whole question file as one valid JSON document, then respond again.",
};

function directive(turn: TurnKind | null, hasTask: boolean): string {
  if (turn === "start" || turn === "continue") {
    const text = TURN_DIRECTIVES[turn];
    return hasTask ? `Read the task, then ${text}` : text[0]!.toUpperCase() + text.slice(1);
  }
  return turn === null ? "Carry out the request above." : TURN_DIRECTIVES[turn];
}

export interface ProviderPromptOptions {
  contract?: ContractMode;
  turn?: TurnKind | null;
  decisionValues?: readonly string[];
  decisionInstructions?: Readonly<Record<string, string>>;
  ask?: AskTarget | null;
  /** Absolute path of the question request file. Required to describe the question protocol when `ask` is set. */
  questionFile?: string | null;
  artifactDirectory?: string;
  artifactName?: string | null;
  /** Artifact directory of the execution this turn continues, when it differs from `artifactDirectory`. */
  previousArtifactDirectory?: string | null;
  previousVerifyReport?: string | null;
  /** Session task file and directory, listed first under Execution. */
  taskFile?: string | null;
  sessionDirectory?: string | null;
}

function envelope(options: ProviderPromptOptions) {
  const mode = options.contract === true ? "full" : options.contract || null;
  const instructions = options.decisionInstructions ?? {};
  const decisions = mode === null ? [] : (options.decisionValues ?? []).filter(Boolean).map((value) => {
    const name = value.toLowerCase();
    return { name, instruction: instructions[name] ?? null };
  });
  const canAsk = mode !== null && options.ask != null;
  const artifactName = options.artifactName ?? null;
  const previousArtifactDirectory = artifactName ? options.previousArtifactDirectory ?? null : null;
  const previousVerifyReport = options.previousVerifyReport ?? null;
  const taskFile = options.taskFile ?? null;
  const decisionLabel = decisions.map(({ name }) => name).join("|");
  const statusLabel = canAsk ? "complete | question | blocked" : "complete | blocked";
  // The single place that tells the agent what to do this turn.
  const doLines: string[] = [];
  if (mode !== null) doLines.push(directive(options.turn ?? null, taskFile !== null));
  if (artifactName) doLines.push(`Write the artifact as \`${artifactName}\` in the artifacts directory.`);
  if (mode === "reminder") {
    const decision = decisions.length > 0 ? `, with \`decision: ${decisionLabel}\` when complete` : "";
    doLines.push(`Same response contract and stage instructions as before: start with \`status: ${statusLabel}\`${decision}.`);
  }
  return {
    full: mode === "full",
    reminder: mode === "reminder",
    contract: mode !== null,
    canAsk,
    statusLabel,
    questionFile: options.questionFile ?? "",
    decisions,
    decisionLabel,
    artifactDirectory: options.artifactDirectory ?? "",
    artifactName,
    previousArtifactDirectory,
    previousVerifyReport,
    taskFile,
    sessionDirectory: options.sessionDirectory ?? "",
    hasExecution: taskFile !== null || canAsk || artifactName !== null || previousVerifyReport !== null,
    doText: doLines.join("\n"),
  };
}

/** Layout: stable contract first, then the message, then per-execution paths, then the closing ask. */
export function renderProviderPrompt(prompt: string, options: ProviderPromptOptions = {}): string {
  return renderPrompt("provider-turn", { prompt, ...envelope(options) });
}

export function addArtifactContext(prompt: string, artifactDirectory: string, artifactName?: string | null): string {
  return renderProviderPrompt(prompt, { artifactDirectory, artifactName });
}

export function addStageOutcomeContract(
  prompt: string,
  decisionValues: readonly string[] = [],
  decisionInstructions: Readonly<Record<string, string>> = {},
  ask: AskTarget | null = null,
): string {
  return renderProviderPrompt(prompt, { contract: true, decisionValues, decisionInstructions, ask });
}

export function flattenHistory(history: readonly { role: string; content: string }[]): string {
  return renderPrompt("history", { history });
}

/** Context the kernel gathers for a stage message. Fields mirror the template variables. */
export interface StageContext {
  taskFile: string;
  sessionDirectory: string;
  stage: { id: string; role: string; instructions: readonly string[]; verify: readonly string[] };
  roleInstructions: readonly string[];
  constraints: readonly string[];
  upstream: readonly { stageId: string; path: string; verify: boolean; updated: boolean }[];
  routed: unknown;
  blocked: unknown;
  failed?: unknown;
  prior: unknown;
}

/** Role and stage instructions render as separate lists; a stage line already in the role list is dropped. */
export function renderStageStart(context: StageContext): string {
  const roleInstructions = [...new Set(context.roleInstructions)];
  const stageInstructions = [...new Set(context.stage.instructions)].filter((line) => !roleInstructions.includes(line));
  return renderPrompt("stage-start", { ...context, roleInstructions, stageInstructions });
}

export function renderStageContinue(context: object): string {
  return renderPrompt("stage-continue", context);
}

export interface StageReplyOptions {
  /** The reply is formatted answers to the agent's pending questions. */
  answers?: boolean;
  /** The human stopped the agent's previous turn before it finished. */
  interrupted?: boolean;
}

/** Reply to a stage that already holds the conversation. The runner adds the execution paths and closing ask. */
export function buildStageReplyPrompt(reply: string, options: StageReplyOptions = {}): string {
  return renderPrompt("stage-reply", { reply, answers: options.answers ?? false, interrupted: options.interrupted ?? false });
}

export function prependRoleInstructions(instructions: readonly string[], prompt: string): string {
  return renderPrompt("role-run", { instructions, prompt });
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
  return renderPrompt("verify-repair", context);
}

export interface AnsweredQuestion {
  id: string;
  question: string;
  selection: "single" | "multiple";
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
export function formatQuestionAnswers(questions: readonly AnsweredQuestion[], answers: readonly QuestionAnswerInput[]): string {
  return answers.map((answer) => {
    const question = questions.find((row) => row.id === answer.question_id)!;
    const selected = answer.selected.map((id) => `${id}. ${question.options.find((option) => option.id === id)!.label}`);
    const lines = [
      `${answer.question_id}. ${question.question} (${question.selection})`,
      `   - Selected: ${selected.length > 0 ? selected.join("; ") : "none"}`,
    ];
    if (answer.text) lines.push(`   - Free text: ${JSON.stringify(answer.text)}`);
    return lines.join("\n");
  }).join("\n\n");
}

export interface QuestionCorrectionContext {
  questionFile: string;
  errorKind: string;
  errorDetail: string;
}

/** The single correction message sent when a question request file fails validation. */
export function renderQuestionCorrection(context: QuestionCorrectionContext): string {
  return renderPrompt("question-correction", context);
}

/**
 * Appended to a prompt saved under an older response protocol. It carries the current
 * contract and states that it replaces the earlier response instructions.
 */
export function renderProtocolUpdate(options: ProviderPromptOptions): string {
  return renderPrompt("protocol-update", envelope({ ...options, contract: "full" }));
}
