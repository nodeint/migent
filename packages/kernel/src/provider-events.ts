import { isRecord } from "./record.js";
import { logProgress, utcNow } from "./runtime.js";
import type { ExecutionContext, SessionStore } from "./session-store.js";
import { STATUS_PROVIDER_EVENTS } from "./event-kinds.js";

const CONTROL_PLANE_WARNING_MARKERS = ["failed to refresh available models"];

const STDERR_EVENTS = new Set([
  "provider.turn_failed",
  "provider.quota",
  "provider.error",
  "provider.warning",
  "provider.cancelled",
  "verify.failed",
]);

function reportsOnStderr(event: string, itemProgress: boolean): boolean {
  if (STDERR_EVENTS.has(event)) return true;
  return itemProgress && event === "provider.item_completed";
}

export function providerErrorMessage(payload: Record<string, unknown>): string | null {
  const message = payload.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  const error = payload.error;
  if (isRecord(error)) {
    const nested = error.message;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  if (typeof error === "string" && error.trim()) return error.trim();
  return null;
}

export function classifyProviderError(message: string | null): { event: string; summary: string } {
  let summary = typeof message === "string" && message.trim() ? message.trim() : "";
  if (!summary) summary = "provider emitted an error";
  const lowered = summary.toLowerCase();
  let event = CONTROL_PLANE_WARNING_MARKERS.some((marker) => lowered.includes(marker))
    ? "provider.warning"
    : "provider.error";
  if (!STATUS_PROVIDER_EVENTS.has(event)) event = "provider.error";
  return { event, summary };
}

export class ProviderEvent {
  readonly event: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly stageId: string;
  readonly timestamp: string;
  readonly summary: string | null;
  readonly details: Record<string, unknown>;

  constructor(input: {
    event: string;
    provider: string;
    sessionId: string;
    executionId: string;
    stageId: string;
    timestamp?: string;
    summary?: string | null;
    details?: Record<string, unknown>;
  }) {
    this.event = input.event;
    this.provider = input.provider;
    this.sessionId = input.sessionId;
    this.executionId = input.executionId;
    this.stageId = input.stageId;
    this.timestamp = input.timestamp ?? utcNow();
    this.summary = input.summary ?? null;
    this.details = input.details ?? {};
  }

  toJson(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      event: this.event,
      provider: this.provider,
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
  constructor(
    readonly store: SessionStore,
    readonly context: ExecutionContext,
    readonly provider: string,
    readonly model: string,
    readonly itemProgress = false,
  ) {}

  emit(event: string, summary?: string | null, details?: Record<string, unknown> | null): void {
    const providerEvent = new ProviderEvent({
      event,
      provider: this.provider,
      sessionId: this.context.sessionId,
      executionId: this.context.executionId,
      stageId: this.store.stageId(this.context),
      summary: summary ?? null,
      details: details ?? {},
    });
    this.store.recordProviderEvent(this.context, providerEvent.toJson());
    if (!reportsOnStderr(event, this.itemProgress)) return;
    const message = summary || event.replace(/^provider\./, "").replaceAll("_", " ");
    logProgress(message);
  }
}
