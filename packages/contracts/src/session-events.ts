import Type, { type Static, type TOptional, type TProperties, type TSchema } from 'typebox';

import { id, nullable } from './common.js';
import { EXECUTION_STATUSES, type ExecutionStatus, STAGE_OUTCOME_STATUSES, type StageOutcomeStatus } from './data/statuses.js';
import { LIFECYCLE_EVENT_VERSION } from './data/versions.js';
import { LegacyLifecycleEvent, LifecycleEventV2, ResumeDecidedData, ResumeExpiredData } from './known-shapes.js';
import { SESSION_STATUS_CATALOG, type SessionStatusName } from './session-status.js';

/**
 * One record schema per `events.jsonl` event name, under `session/event/<name>`. Every event is
 * class `known`: its fields are an opt-in description. Objects are open.
 */

const str = () => Type.String();
const opt = Type.Optional;
const obj = () => Type.Record(Type.String(), Type.Unknown());
const nullableStr = () => nullable(str());

const ENVELOPE_VERSIONS = Type.Union([Type.Literal(LIFECYCLE_EVENT_VERSION), Type.Literal(1)]);

/** Envelope fields every record shares. `v` and `seq` are optional so older lines validate. */
const envelope = <N extends string>(name: N) => ({
  v: opt(ENVELOPE_VERSIONS),
  seq: opt(Type.Number()),
  event: Type.Literal(name),
  timestamp: str(),
  execution_id: opt(str()),
  stage_id: opt(str()),
  summary: opt(str()),
});

const eventId = (name: string) => id(`session/event/${name}`);
const eventTitle = (name: string) => `Event \`${name}\``;

/** Outcome keys copied to the top level of some lifecycle events. */
const outcomeTop = {
  status: opt(str()),
  decision: opt(str()),
  blocker: opt(str()),
  question: opt(Type.Unknown()),
  questions: opt(Type.Unknown()),
};

interface LifecycleOptions<T extends TProperties> {
  top?: T;
  description?: string;
}

function lifecycle<N extends string, D extends TProperties, T extends TProperties = Record<never, never>>(
  name: N,
  data: D,
  options: LifecycleOptions<T> = {},
) {
  return Type.Object(
    { ...envelope(name), ...((options.top ?? {}) as T), data: Type.Object(data) },
    {
      $id: eventId(name),
      title: eventTitle(name),
      ...(options.description ? { description: options.description } : {}),
    },
  );
}

// ---- lifecycle events -------------------------------------------------------------------------

const outcomeData = { outcome: opt(nullable(obj())) };
const sessionStatusData = {
  from: opt(nullableStr()),
  reason: opt(str()),
  manual: opt(Type.Boolean()),
  reply: opt(str()),
  origin: opt(str()),
  answers: opt(Type.Array(obj())),
  ...outcomeData,
};

const executionStatusData = {
  outcome: nullable(obj()),
  failure_reason: nullableStr(),
  error: nullableStr(),
  session_status: str(),
};

/** Fixed-name lifecycle events, keyed by event name with their concrete schema types. */
export const FIXED_LIFECYCLE_EVENTS = {
  'session.created': lifecycle('session.created', {
    workflow_id: opt(str()), workflow_path: opt(str()), hash: opt(str()), title: opt(str()), task: opt(str()),
    prior_session_id: opt(str()), handoff: opt(obj()), role: opt(str()), prepared: opt(Type.Boolean()),
  }),
  'session.activated': lifecycle('session.activated', { from: opt(nullableStr()) }),
  'execution.started': lifecycle('execution.started', {
    execution_order: Type.Number(),
    stage_attempt: Type.Number(),
    client: nullableStr(),
    model: nullableStr(),
    resumes_execution_id: nullableStr(),
  }),
  'task.frozen': lifecycle('task.frozen', { sha256: str() }),
  'baseline.captured': lifecycle('baseline.captured', { commit: nullableStr(), error: nullableStr() }),
  'outputs.published': lifecycle('outputs.published', { outputs: Type.Array(obj()) }),
  'handoff.bound': lifecycle('handoff.bound', { handoff: obj(), hash: opt(str()) }),
  'workflow.refreshed': lifecycle('workflow.refreshed', { hash: str(), previous_hash: str(), source_sha256: opt(str()) }),
  'revisions.reset': lifecycle('revisions.reset', { baselines: Type.Unknown() }),
};

const sessionStatusEvent = <S extends SessionStatusName>(status: S) =>
  lifecycle(`session.${status}` as const, sessionStatusData, { top: outcomeTop });
const executionStatusEvent = <S extends ExecutionStatus>(status: S) =>
  lifecycle(`execution.${status}` as const, executionStatusData);
const stageOutcomeEvent = <S extends StageOutcomeStatus>(status: S) =>
  lifecycle(`stage.${status}` as const, outcomeData, { top: outcomeTop });

/** Templated status events, keyed `session.<status>`, `execution.<status>` and `stage.<status>`. */
export type StatusLifecycleEvents = {
  [S in SessionStatusName as `session.${S}`]: ReturnType<typeof sessionStatusEvent<S>>;
} & {
  [S in ExecutionStatus as `execution.${S}`]: ReturnType<typeof executionStatusEvent<S>>;
} & {
  [S in StageOutcomeStatus as `stage.${S}`]: ReturnType<typeof stageOutcomeEvent<S>>;
};

const statusEntries = {
  session: SESSION_STATUS_CATALOG.map((entry) => entry.name).map((name) => [`session.${name}`, sessionStatusEvent(name)] as const),
  execution: EXECUTION_STATUSES.map((status) => [`execution.${status}`, executionStatusEvent(status)] as const),
  stage: STAGE_OUTCOME_STATUSES.map((status) => [`stage.${status}`, stageOutcomeEvent(status)] as const),
};

export const STATUS_LIFECYCLE_EVENTS = Object.fromEntries(
  Object.values(statusEntries).flat(),
) as unknown as StatusLifecycleEvents;

const resumeEvent = <N extends string, D extends TSchema>(name: N, data: D) =>
  Type.Object({ ...envelope(name), data }, { $id: eventId(name), title: eventTitle(name) });

export const RESUME_EVENTS = {
  'resume.expired': resumeEvent('resume.expired', ResumeExpiredData),
  'resume.decided': resumeEvent('resume.decided', ResumeDecidedData),
};

// ---- client events ----------------------------------------------------------------------------

const optionalProperties = <D extends TProperties>(details: D) =>
  Object.fromEntries(
    Object.entries(details).map(([key, value]) => [key, Type.Optional(value as TSchema)]),
  ) as { [K in keyof D]: TOptional<D[K]> };

function clientEvent<N extends string, D extends TProperties>(
  name: N,
  details: D,
  extra: { description?: string } = {},
) {
  const current = Type.Object({
    ...envelope(name),
    client: str(),
    session_id: str(),
    details: opt(Type.Object(details)),
    data: opt(obj()),
  });
  const historical = Type.Object({
    ...envelope(name),
    client: opt(str()),
    session_id: opt(str()),
    provider: opt(str()),
    details: opt(Type.Object(optionalProperties(details))),
    data: opt(obj()),
  });
  const schema = Type.Union([current, historical], { $id: eventId(name), title: eventTitle(name), ...extra });
  return { name, schema, current, historical };
}

/** Both forms of one client event, as written today and as written before `client` / `session_id` existed. */
export type ClientEventForms = ReturnType<typeof clientEvent>;

const tuple = <T extends unknown[]>(...items: T): T => items;

const opaque = {};
const CLIENT_EVENT_LIST = tuple(
  clientEvent('provider.stage_started', { cli_version: nullableStr(), git_head: opt(nullableStr()), git_dirty: opt(nullable(Type.Boolean())), options: opt(obj()) }),
  clientEvent('provider.turn_completed', opaque),
  clientEvent('provider.turn_failed', opaque),
  clientEvent('provider.quota', { retry_at: opt(str()), client: opt(str()), window: opt(str()) }),
  clientEvent('provider.cancelled', opaque),
  clientEvent('provider.error', opaque),
  clientEvent('provider.warning', opaque),
  clientEvent('provider.heartbeat', { elapsed_seconds: opt(Type.Number()) }),
  clientEvent('provider.interrupt', { agent_id: str(), reason: opt(str()), phase: opt(str()), outcome: opt(str()), attempts: opt(Type.Number()) }),
  clientEvent('provider.exit_anomaly', {
    turn: Type.Number(),
    client: str(),
    exit_code: nullable(Type.Number()),
    signal: nullableStr(),
    origin: str(),
    accepted: Type.Boolean(),
    reason: nullableStr(),
  }),
  clientEvent('provider.item_started', opaque, { description: 'Item content is adapter-specific and opaque.' }),
  clientEvent('provider.item_completed', opaque, { description: 'Item content is adapter-specific and opaque.' }),
  clientEvent('verify.started', { turn: Type.Number(), commands: Type.Array(Type.Unknown()) }),
  clientEvent('verify.heartbeat', { turn: Type.Number(), command: str(), elapsed_seconds: Type.Number() }),
  clientEvent('verify.failed', {
    turn: Type.Number(),
    red: Type.Number(),
    max_verify: Type.Number(),
    command: nullableStr(),
    status: nullableStr(),
    exit_code: nullable(Type.Number()),
    report: str(),
  }),
  clientEvent('verify.passed', { turn: Type.Number(), report: opt(str()) }),
  // Correction events are written through the same reporter.
  clientEvent('response.contract_invalid', { turn: Type.Number(), error_kind: str() }),
  clientEvent('stage.output_missing', { turn: Type.Number(), error_kind: str() }),
  clientEvent('question.file_invalid', { turn: Type.Number(), error_kind: str(), file: opt(str()) }),
  clientEvent('handoff.file_invalid', { turn: Type.Number(), error_kind: str(), file: opt(str()) }),
);

type ClientEventList = typeof CLIENT_EVENT_LIST;

/** Client and correction events keyed by name, each with its `schema` (union), `current` and `historical` form. */
export type ClientEvents = { [E in ClientEventList[number] as E['name']]: E };

export const SESSION_CLIENT_EVENT_FORMS = Object.fromEntries(
  CLIENT_EVENT_LIST.map((entry) => [entry.name, entry]),
) as unknown as ClientEvents;

/** Where the templated families slot into the fixed lifecycle events, in documentation order. */
const BEFORE_SESSION_STATUS = 2;
const BEFORE_EXECUTION_STATUS = 3;

const fixedEntries = Object.entries(FIXED_LIFECYCLE_EVENTS);

export const SESSION_EVENT_SCHEMAS: readonly { readonly event: string; readonly schema: TSchema }[] = [
  ...fixedEntries.slice(0, BEFORE_SESSION_STATUS),
  ...statusEntries.session,
  ...fixedEntries.slice(BEFORE_SESSION_STATUS, BEFORE_EXECUTION_STATUS),
  ...statusEntries.execution,
  ...statusEntries.stage,
  ...fixedEntries.slice(BEFORE_EXECUTION_STATUS),
  ...Object.entries(RESUME_EVENTS),
  ...CLIENT_EVENT_LIST.map((entry): [string, TSchema] => [entry.name, entry.schema]),
].map(([event, schema]) => ({ event: event as string, schema: schema as TSchema }));

/** Every event name, with its record schema. */
export type SessionEventSchemas = typeof FIXED_LIFECYCLE_EVENTS & StatusLifecycleEvents & typeof RESUME_EVENTS & {
  [N in keyof ClientEvents]: ClientEvents[N]['schema'];
};
export type SessionEventName = keyof SessionEventSchemas;
/** The record type of one event, e.g. `SessionEventRecord<'task.frozen'>`. */
export type SessionEventRecord<N extends SessionEventName> = Static<SessionEventSchemas[N]>;
/** The current (written today) form of a client or correction event. */
export type ClientEventCurrent<N extends keyof ClientEvents> = Static<ClientEvents[N]['current']>;
/** The historical (older lines) form of a client or correction event. */
export type ClientEventHistorical<N extends keyof ClientEvents> = Static<ClientEvents[N]['historical']>;

/** Envelope of every `events.jsonl` line: the v2 record, or an older line (no `v`, or `v: 1`). */
export const SessionEvent = Type.Union([LifecycleEventV2, LegacyLifecycleEvent], {
  $id: id('session/event'),
  title: 'Session event envelope (`events.jsonl`)',
  description: 'Every line of `events.jsonl`. The per-event records are `session/event/<name>`.',
});

export type SessionEvent = Static<typeof SessionEvent>;
