import { renderPrompt } from "./renderer.js";

export { renderPrompt };

export type AskTarget = string;

export interface ProviderPromptOptions {
  contract?: boolean;
  decisionValues?: readonly string[];
  decisionInstructions?: Readonly<Record<string, string>>;
  ask?: AskTarget | null;
  /** Absolute path of the question request file. Required to describe the question protocol when `ask` is set. */
  questionFile?: string | null;
  artifactDirectory?: string;
  artifactName?: string | null;
  previousVerifyReport?: string | null;
}

export function renderProviderPrompt(prompt: string, options: ProviderPromptOptions = {}): string {
  const instructions = options.decisionInstructions ?? {};
  const decisions = (options.decisionValues ?? []).filter(Boolean).map((value) => {
    const name = value.toLowerCase();
    return { name, instruction: instructions[name] ?? "undefined" };
  });
  return renderPrompt("provider-turn", {
    prompt,
    contract: options.contract ?? false,
    canAsk: options.ask != null,
    questionFile: options.questionFile ?? "",
    decisions,
    decisionLabel: decisions.map(({ name }) => name).join("|"),
    hasDecisionInstructions: Object.keys(instructions).length > 0,
    artifactDirectory: options.artifactDirectory ?? "",
    artifactName: options.artifactName ?? null,
    previousVerifyReport: options.previousVerifyReport ?? null,
  });
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
  prior: unknown;
}

export function renderStageStart(context: StageContext): string {
  return renderPrompt("stage-start", context);
}

export function renderStageContinue(context: object): string {
  return renderPrompt("stage-continue", context);
}

/** Reply to a stage that already holds the conversation. The runner appends the response contract. */
export function buildStageReplyPrompt(reply: string, question?: string, interruptedExecutionId?: string): string {
  return renderPrompt("stage-reply", { reply, question: question ?? null, interruptedExecutionId: interruptedExecutionId ?? null });
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
  options: readonly { id: string; label: string }[];
}
export interface QuestionAnswerInput {
  question_id: string;
  selected: readonly string[];
  text?: string;
}

/**
 * Readable Q/A text for the agent: selected option labels and any free text; empty fields are omitted.
 * A lone question is not repeated because the reply prompt already names it; several are numbered with their text.
 */
export function formatQuestionAnswers(questions: readonly AnsweredQuestion[], answers: readonly QuestionAnswerInput[]): string {
  return answers.map((answer) => {
    const question = questions.find((row) => row.id === answer.question_id)!;
    const lines = questions.length === 1 ? [] : [`${answer.question_id}. ${question.question}`];
    if (answer.selected.length > 0) {
      const labels = answer.selected.map((id) => question.options.find((option) => option.id === id)!.label);
      lines.push(`Selected: ${labels.join("; ")}`);
    }
    if (answer.text) lines.push(`Answer: ${answer.text}`);
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
  return renderProviderPrompt(renderPrompt("protocol-update", {}), { ...options, contract: true });
}
