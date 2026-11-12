import { HANDOFF_FILE_PROTOCOL } from '@nodeint/migent-prompts';

import { loadHandoffFile } from './handoff.js';
import { loadQuestionFile } from './questions.js';
import { type AskTarget,parseStageOutcome, StageOutcome } from './stage-outcome.js';

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
  if (context.protocol >= HANDOFF_FILE_PROTOCOL) {
    if (!context.required) return null;
    const handoff = loadHandoffFile(context.handoffFile, { decisionValues: context.decisionValues, ask: context.ask });
    if (handoff.status === 'question') {
      return new StageOutcome('question', { question: handoff.questions[0].question, questions: handoff.questions });
    }
    return new StageOutcome(handoff.status, { blocker: handoff.blocker, decision: handoff.decision });
  }
  const outcome = parseStageOutcome(
    response,
    context.required,
    { decisionValues: context.decisionValues, ask: context.ask },
  );
  if (outcome?.status !== 'question') return outcome;
  const questions = loadQuestionFile(context.questionFile);
  return new StageOutcome('question', { question: questions[0].question, questions });
}
