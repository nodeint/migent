import path from 'node:path';

import {
  buildTurnDiagnostics, type ExecutionFailure, type FailureClassification, type Gates, observeTurn, type ProcessFacts,
  type ResponseSource, type StreamSummarizer,
} from '@nodeint/migent-kernel';
import type { AgentSessionRecord, ExecutionContext, SessionStore } from '@nodeint/migent-session';

import type { ProviderEventReporter } from '../provider-events.js';
import type { ChangeApplier } from '../runtime/operation.js';
import type { Change } from './changes.js';
import { toStageOutcome } from './outcome-data.js';
import { revive } from './plain.js';
import type { TurnVerdict } from './types.js';

/** What the applier writes to. The record and the store are touched here and nowhere else in the execution layer. */
export type ApplierTarget = {
  readonly record: AgentSessionRecord;
  readonly store: SessionStore;
  readonly context: ExecutionContext;
  readonly eventReporter: ProviderEventReporter;
};

/**
 * The one place that commits an execution's writes. It runs each change in list order and never awaits, so a
 * cooperative interruption cannot split a commit (D12).
 */
export class ExecutionApplier implements ChangeApplier<Change> {
  constructor(private readonly target: ApplierTarget) {}

  public apply(changes: readonly Change[]): void {
    for (const change of changes) this.commit(change);
  }

  private commit(change: Change): void {
    switch (change.kind) {
      case 'recordProviderTurn':
      case 'setStatus':
      case 'appendHistory':
        this.commitRecord(change);
        return;
      case 'saveRecord':
      case 'saveProgress':
      case 'saveExecution':
        this.commitExecution(change);
        return;
      case 'saveResponse':
      case 'saveTurnResponse':
      case 'saveTurnOutcome':
      case 'saveTurnVerify':
      case 'publishVerifyReport':
        this.commitTurnFile(change);
        return;
      case 'writeTurnDiagnostics':
        this.writeDiagnostics(change.verdict);
        return;
      case 'emit':
        this.target.eventReporter.emit(
          change.event, change.summary, change.details === null ? null : { ...change.details },
        );
        return;
      default:
        change satisfies never;
    }
  }

  // The writes that change the in-memory conversation record.
  private commitRecord(change: Extract<Change, { kind: 'recordProviderTurn' | 'setStatus' | 'appendHistory' }>): void {
    const { record } = this.target;
    switch (change.kind) {
      case 'recordProviderTurn':
        record.agentId = change.agentId;
        record.model = change.model;
        record.options = { ...change.options };
        record.workspace = change.workspace;
        return;
      case 'setStatus':
        record.status = change.status;
        return;
      case 'appendHistory':
        record.history.push({ role: change.role, content: change.content });
        return;
      default:
        change satisfies never;
    }
  }

  // The writes of the conversation record and of execution.json.
  private commitExecution(change: Extract<Change, { kind: 'saveRecord' | 'saveProgress' | 'saveExecution' }>): void {
    const { record, store, context } = this.target;
    switch (change.kind) {
      case 'saveRecord':
        store.save(record, context);
        return;
      case 'saveProgress':
        store.saveExecutionProgress(context, record, { ...change.fields });
        return;
      case 'saveExecution':
        store.saveExecution(context, record, {
          status: change.status,
          ...(change.error === undefined ? {} : { error: change.error }),
          ...(change.outcome === undefined ? {} : {
            outcome: change.outcome === null ? null : toStageOutcome(change.outcome),
          }),
          ...(change.extra === undefined ? {} : { extra: change.extra === null ? null : { ...change.extra } }),
        });
        return;
      default:
        change satisfies never;
    }
  }

  // The response and per-turn files, and the published verify report.
  private commitTurnFile(
    change: Extract<Change, { kind: 'saveResponse' | 'saveTurnResponse' | 'saveTurnOutcome' | 'saveTurnVerify' | 'publishVerifyReport' }>,
  ): void {
    const { store, context } = this.target;
    switch (change.kind) {
      case 'saveResponse':
        store.saveResponse(context, change.text);
        return;
      case 'saveTurnResponse':
        store.saveTurnResponse(context, change.turn, change.text);
        return;
      case 'saveTurnOutcome':
        store.saveTurnOutcome(context, change.turn, toStageOutcome(change.outcome));
        return;
      case 'saveTurnVerify':
        store.saveTurnVerify(context, change.turn, change.report);
        return;
      case 'publishVerifyReport':
        store.publishVerifyReport(context, change.turn);
        return;
      default:
        change satisfies never;
    }
  }

  // The only writer of diagnostics.json: once this turn's gates have run, before any verify or follow-up turn.
  private writeDiagnostics(verdict: TurnVerdict): void {
    const { record, store, context } = this.target;
    const failure = revive<ExecutionFailure | null>(verdict.failure);
    const facts = revive<ProcessFacts | null>(verdict.facts);
    store.saveDiagnostics(context, buildTurnDiagnostics({
      turn: verdict.turn,
      agentId: record.agentId || null,
      ...(failure ? { failure } : {}),
      ...(facts ? { facts } : {}),
      classification: revive<FailureClassification | null>(verdict.classification),
      stream: revive<ReturnType<StreamSummarizer['finish']>>(verdict.stream),
      resultState: {
        observed: observeTurn({
          source: verdict.parsedSource === null ? undefined : revive<ResponseSource>(verdict.parsedSource),
          responseText: verdict.responseText,
          artifactPath: verdict.artifactName ? path.join(context.artifactDirectory, verdict.artifactName) : null,
          responseWritten: verdict.modelResponded,
          conversationTurns: record.history.filter((item) => item.role === 'assistant').length,
        }),
        gates: revive<Gates>(verdict.gates),
        turn_verdict: verdict.accepted ? 'accepted' : 'failed',
        reason: verdict.reason,
      },
    }));
  }
}
