import Type, { type Static } from "typebox";
import { id, nullable } from "./common.js";

/**
 * Opt-in descriptions of persisted files written by Migent. They are never the guarantee of a
 * command: `session metrics` and `session follow` re-emit these files byte for byte.
 */

const num = () => Type.Number();
const str = () => Type.String();

// ---- lifecycle events -------------------------------------------------------------------------

export const LifecycleEventV2 = Type.Object(
  { v: Type.Literal(2), seq: num(), event: str(), timestamp: str(), data: Type.Record(str(), Type.Unknown()) },
  { $id: id("known/lifecycle-event-v2"), title: "Lifecycle event (v2)" },
);
export type LifecycleEventV2 = Static<typeof LifecycleEventV2>;

export const LegacyLifecycleEvent = Type.Object(
  { v: Type.Optional(Type.Literal(1)), event: str() },
  { $id: id("known/lifecycle-event-legacy"), title: "Lifecycle event (unversioned or v1)" },
);

export const ProviderStreamRecord = Type.Record(str(), Type.Unknown(), {
  $id: id("known/provider-stream-record"),
  title: "Provider stream record",
  description: "Opaque; documentation only.",
});

// ---- sealed metrics ---------------------------------------------------------------------------

const UsageNumbers = Type.Object({
  input_tokens: nullable(num()),
  output_tokens: nullable(num()),
  reasoning_tokens: nullable(num()),
  cache_read_tokens: nullable(num()),
  cache_write_tokens: nullable(num()),
  cost_usd: nullable(num()),
});
const UsageMissing = Type.Object({
  input_tokens: num(),
  output_tokens: num(),
  reasoning_tokens: num(),
  cache_read_tokens: num(),
  cache_write_tokens: num(),
  cost_usd: num(),
});

const CurrentTotals = Type.Object({
  executions: num(),
  skipped: num(),
  wall_seconds: nullable(num()),
  active_seconds: num(),
  verify_seconds: num(),
  turns: num(),
  uncaptured_turns: num(),
  provider_exit_anomalies: num(),
  provider_exit_anomalies_accepted: num(),
  usage: UsageNumbers,
  usage_missing: UsageMissing,
  cost_partial: Type.Boolean(),
  failed_executions: num(),
  blocked: num(),
  cancelled: num(),
  verify_red: num(),
  revisions: nullable(num()),
  revisions_reset: num(),
});

const CurrentStage = Type.Object({
  executions: num(),
  skipped: num(),
  revisions: nullable(num()),
  failed: num(),
  blocked: num(),
});

const CurrentExecution = Type.Object({
  execution_id: str(),
  execution_order: nullable(num()),
  stage_id: str(),
  stage_attempt: nullable(num()),
  role: nullable(str()),
  client: nullable(str()),
  model: nullable(str()),
  cli_version: nullable(str()),
  argv: nullable(Type.Array(str())),
  agent_id: nullable(str()),
  resumes_execution_id: nullable(str()),
  routed_from: nullable(str()),
  git_head: nullable(str()),
  git_dirty: nullable(Type.Boolean()),
  status: nullable(str()),
  outcome_status: nullable(str()),
  decision: nullable(str()),
  blocker: nullable(str()),
  error: nullable(str()),
  failure_reason: nullable(str()),
  created_at: nullable(str()),
  completed_at: nullable(str()),
  wall_seconds: nullable(num()),
  verify_seconds: num(),
  turns: num(),
  uncaptured_turns: num(),
  provider_exit_anomalies: num(),
  provider_exit_anomalies_accepted: num(),
  usage: UsageNumbers,
  usage_missing: UsageMissing,
  verify: nullable(Type.Object({ runs: num(), red: num(), first_pass: Type.Boolean(), failed_commands: Type.Array(str()) })),
  skip: nullable(Type.Record(str(), Type.Unknown())),
});

/** What the current producer writes (`sessionMetrics` in the kernel) for a sealed session. */
export const SealedMetricsCurrent = Type.Object(
  {
    session_id: str(),
    workflow_id: nullable(str()),
    workflow_hash: nullable(str()),
    status: nullable(str()),
    latest_decision: nullable(str()),
    task_sha256: nullable(str()),
    prior_session_id: nullable(str()),
    created_at: nullable(str()),
    updated_at: nullable(str()),
    totals: CurrentTotals,
    stages: Type.Record(str(), CurrentStage),
    executions: Type.Array(CurrentExecution),
  },
  { $id: id("known/metrics-current"), title: "Sealed metrics, current producer" },
);

/**
 * Fields any released Migent may have written. Every field is optional: absence means "not
 * recorded" (docs/session-metrics.md). Types apply where a field is present.
 */
export const SealedMetricsHistorical = Type.Object(
  {
    session_id: Type.Optional(str()),
    workflow_id: Type.Optional(nullable(str())),
    workflow_hash: Type.Optional(nullable(str())),
    status: Type.Optional(nullable(str())),
    latest_decision: Type.Optional(nullable(str())),
    task_sha256: Type.Optional(nullable(str())),
    prior_session_id: Type.Optional(nullable(str())),
    created_at: Type.Optional(nullable(str())),
    updated_at: Type.Optional(nullable(str())),
    totals: Type.Optional(
      Type.Partial(CurrentTotals, {}),
    ),
    stages: Type.Optional(Type.Record(str(), Type.Partial(CurrentStage))),
    executions: Type.Optional(Type.Array(Type.Partial(CurrentExecution))),
  },
  { $id: id("known/metrics-historical"), title: "Sealed metrics, known historical fields", description: "All optional; absence means not recorded." },
);
