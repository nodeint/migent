import { loadQuestionFile } from "./questions.js";
import { parseStageOutcome, StageOutcome, type AskTarget } from "./stage-outcome.js";

export interface OutcomeContext {
  required: boolean;
  decisionValues: readonly string[];
  /** The stage's ask target. Never omitted, so a resume cannot skip question authorization. */
  ask: AskTarget | null;
  /** Absolute path of the question request file for this execution. */
  questionFile: string;
}

/**
 * Turn a response into a stage outcome. For `status: question` the questions come only from
 * the question request file; it throws QuestionFileError when that file cannot be used.
 */
export function resolveStageOutcome(response: string, context: OutcomeContext): StageOutcome | null {
  const outcome = parseStageOutcome(response, context.required, context.decisionValues, context.ask);
  if (outcome?.status !== "question") return outcome;
  const questions = loadQuestionFile(context.questionFile);
  return new StageOutcome("question", null, null, questions[0]!.question, questions);
}
