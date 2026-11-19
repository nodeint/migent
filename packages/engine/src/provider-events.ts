import { eventKindTraits } from '@nodeint/migent-contracts';
import { logProgress, utcNow } from '@nodeint/migent-kernel';
import type { ExecutionContext, SessionStore } from '@nodeint/migent-session';

function reportsOnStderr(event: string, itemProgress: boolean): boolean {
  if (eventKindTraits(event).stderr) return true;
  return itemProgress && event === 'provider.item_completed';
}

export class ProviderEvent {
  public readonly event: string;
  public readonly client: string;
  public readonly sessionId: string;
  public readonly executionId: string;
  public readonly stageId: string;
  public readonly timestamp: string;
  public readonly summary: string | null;
  public readonly details: Record<string, unknown>;

  constructor(input: {
    event: string;
    client: string;
    sessionId: string;
    executionId: string;
    stageId: string;
    timestamp?: string;
    summary?: string | null;
    details?: Record<string, unknown>;
  }) {
    this.event = input.event;
    this.client = input.client;
    this.sessionId = input.sessionId;
    this.executionId = input.executionId;
    this.stageId = input.stageId;
    this.timestamp = input.timestamp ?? utcNow();
    this.summary = input.summary ?? null;
    this.details = input.details ?? {};
  }

  public toJson(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      event: this.event,
      client: this.client,
      session_id: this.sessionId,
      execution_id: this.executionId,
      stage_id: this.stageId,
      timestamp: this.timestamp,
    };
    if (this.summary) payload.summary = this.summary;
    if (Object.keys(this.details).length > 0) payload.details = this.details;
    return payload;
  }
}

export class ProviderEventReporter {
  public readonly store: SessionStore;
  public readonly context: ExecutionContext;
  public readonly client: string;
  public readonly model: string;
  public readonly itemProgress: boolean;

  constructor(
    execution: { store: SessionStore; context: ExecutionContext },
    provider: { client: string; model: string; itemProgress?: boolean },
  ) {
    this.store = execution.store;
    this.context = execution.context;
    this.client = provider.client;
    this.model = provider.model;
    this.itemProgress = provider.itemProgress ?? false;
  }

  public emit(event: string, summary?: string | null, details?: Record<string, unknown> | null): void {
    const providerEvent = new ProviderEvent({
      event,
      client: this.client,
      sessionId: this.context.sessionId,
      executionId: this.context.executionId,
      stageId: this.store.stageId(this.context),
      summary: summary ?? null,
      details: details ?? {},
    });
    this.store.recordProviderEvent(this.context, providerEvent.toJson());
    if (!reportsOnStderr(event, this.itemProgress)) return;
    const message = summary || event.replace(/^provider\./, '').replaceAll('_', ' ');
    logProgress(message);
  }
}
