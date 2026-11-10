import { loadHandoffFile } from "./handoff.js";
import { loadQuestionFile } from "./questions.js";
import { parseStageOutcome, StageOutcome, type AskTarget } from "./stage-outcome.js";

export interface OutcomeContext {
  required: boolean;
  decisionValues: readonly string[];
  /** The stage's ask target. Never omitted, so a resume cannot skip question authorization. */
  ask: AskTarget | null;
  /** Response protocol the execution runs under. 3 reads the handoff file; 2 reads headers. */
  protocol: number;
  /** Absolute path of the question request file for this execution (protocol 2). */
  questionFile: string;
  /** Absolute path of the handoff file for this execution (protocol 3). */
  handoffFile: string;
}

/**
 * Turn a response into a stage outcome. Protocol 3 reads only the handoff file and throws
 * HandoffFileError when it cannot be used. Protocol 2 reads response headers, and for
 * `status: question` the question request file; it throws QuestionFileError when that file is unusable.
 */
export function resolveStageOutcome(response: string, context: OutcomeContext): StageOutcome | null {
  if (context.protocol >= 3) {
    if (!context.required) return null;
    const handoff = loadHandoffFile(context.handoffFile, { decisionValues: context.decisionValues, ask: context.ask });
    if (handoff.status === "question") {
      return new StageOutcome("question", null, null, handoff.questions[0]!.question, handoff.questions);
    }
    return new StageOutcome(handoff.status, handoff.blocker, handoff.decision);
  }
  const outcome = parseStageOutcome(response, context.required, context.decisionValues, context.ask);
  if (outcome?.status !== "question") return outcome;
  const questions = loadQuestionFile(context.questionFile);
  return new StageOutcome("question", null, null, questions[0]!.question, questions);
}
