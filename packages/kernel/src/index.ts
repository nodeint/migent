export type {
  BuildCommandInput,
  CliClient,
  CliModelCatalog,
  CliRunOutput,
  CliUsage,
  ClientInfo,
  ClientOption,
  ClientRegistry,
  ModelClientLookup,
  FailureClassification,
  FailureOrigin,
  InterruptOutcome,
  NewSession,
  ProviderClassification,
  QuotaClassification,
  RawFailure,
  ResponseSource,
  TurnUsage,
  UsageCapture,
} from "./cli-client.js";
export {
  LOCAL_CONFIG_FILE,
  configPath,
  documentVersion,
  hasLocalConfig,
  loadAgentTarget,
  loadAgentDefinition,
  loadRoleResponsibilities,
  loadRoleDescription,
  loadMergedConfig,
  loadWorkspaceConfig,
  loadYamlMapping,
  listAgentDefinitions,
  field,
  readConfigLayer,
  mergeConfigLayers,
  resolveEffectiveClient,
  localConfigPath,
  mergeConfig,
  resolveRoleTarget,
  resolveRoleCascade,
  resolveStageSpec,
  resolveStageTarget,
  stringifyConfig,
  validateRoleKeys,
  rejectLegacyConfigKeys,
} from "./config.js";
export type {
  ConfigLayer,
  Field,
  ConfigOwner,
  EffectiveClientFailure,
  MergedConfig,
  AgentDefinitionEntry,
  ModelOverride,
  StageTarget,
} from "./config.js";
export {
  ConfigEditError,
  assignRoles,
  describeChange,
  inspectConfig,
  matchingAgentName,
  patchConfigText,
  placeRoleAgent,
  upsertAgent,
  upgradeConfigText,
  yamlScalar,
} from "./config-edit.js";
export { migrateConfig, migrateWorkflow, patchWorkflowText } from "./migration.js";
export { assertConfigClientEquivalence } from "./migration-config.js";
export { classifyFailure, createNewSession, normalizeUsage, sessionOptions } from "./client-policy.js";
export {
  LEGACY_COMMAND_CLIENT,
  LEGACY_PROVIDER_CLIENT,
  clientOfCommand,
  legacyClientOf,
} from "./legacy-provider.js";

export type { MigrationLayer, MigrationFn } from "./migration.js";
export type {
  ConfigChange,
  ConfigView,
  AgentView,
  RoleView,
  StageRef,
  StageShield,
} from "./config-edit.js";
export { whichSync } from "./which.js";

export { ConfigurationError, OutputsMissing } from "./errors.js";
export type { ConfigurationErrorDetails, SourcePosition } from "./errors.js";
export { unknownRoleKeyEntries } from "./authoring-diagnostics.js";

export {
  appendLineSynced,
  isAtomicTempName,
  sealTornTail,
  writeFileAtomic,
  writeJsonAtomic,
} from "./atomic-file.js";
export {
  atomicCopy,
  isArtifactSchema,
  resolveArtifactSources,
  isCompletionDecision,
  missingCompletionOutputNames,
  missingWorkflowOutputNames,
  nonemptyArtifact,
  publishOutputFiles,
  runnableViolation,
  selectSourceExecution,
  sessionStatusAfterExecution,
  shouldPublishOutputs,
} from "./outputs.js";
export type { ExecutionSnapshot, PublishedOutput } from "./outputs.js";
export { buildStagePrompt, buildStageReplyPrompt, buildStageResumePrompt, prependRoleInstructions } from "./prompt.js";
export type { TurnKind } from "@nodeint/migent-prompts";
export {
  failedStageCount,
  latestCompleteByStage,
  nextStage,
  readyStages,
  runnableNow,
  revisionResumeExecution,
  revisionStop,
  stageAgentExecution,
  stagePromptAlreadyDelivered,
  stageDispatchError,
  VERIFY_FAILED,
  verifyExhaustedExecution,
  verifyFailedExecution,
  NextStage,
  NextStageError,
  Stop,
} from "./selection.js";
export type { NextStageResult } from "./selection.js";
export { outcomeStatuses, parseStageOutcome, StageOutcome } from "./stage-outcome.js";
export type { AskTarget } from "./stage-outcome.js";
export { resolveStageOutcome } from "./outcome-resolver.js";
export { HandoffFileError, loadHandoffFile } from "./handoff.js";
export { QuestionFileError, answerQuestions, formatQuestionAnswers, loadQuestionFile, storedQuestions } from "./questions.js";
export type { Question, QuestionAnswer } from "./questions.js";
export { log, utcNow } from "./runtime.js";
export { debugEnabled, inheritedEnv, migentHomeOverride, noInputRequested, platformHome, skillsChildEnv } from "./env.js";
export {
  MIGENT_DIRNAME,
  EXECUTIONS_DIRNAME,
  SESSIONS_DIRNAME,
  CONVERSATION_FILENAME,
  LEGACY_CONVERSATION_FILENAME,
  EXECUTION_SCHEMA_VERSION,
  addArtifactContext,
  addStageOutcomeContract,
  flattenHistory,
  isUnicodeAlnum,
  formatClock,
  formatDuration,
  logProgress,
  safeComponent,
} from "./runtime.js";
export { STATUS_PROVIDER_EVENTS } from "./event-kinds.js";

export { CORRECTION_FAILURE_REASONS } from "./correction-policy.js";
export { VerifyRunner, formatVerifyReport } from "./verify-runner.js";
export type { VerifyRunResult, VerifyCommandResult } from "./verify-runner.js";

export { killProcessTree, wrapperEndpoint } from "./process-wrapper.js";
export {
  UnpassableArgument,
  assertArgumentsPassable,
  spawnProvider,
  spawnProviderSync,
} from "./provider-spawn.js";
export {
  CancellationRequested,
  CommandExecutor,
  DEFAULT_TIMEOUT_SEC,
  PROGRESS_INTERVAL_SEC,
  TERMINATION_GRACE_SEC,
  raiseCancellation,
  resetCancellation,
  stopProcessGroup,
} from "./command-executor.js";
export type {
  CommandResult,
  CommandSpec,
  ExecutionFailure,
  RunOptions,
  StartFailure,
  StartResult,
} from "./command-executor.js";
export { describeStartFailure } from "./command-executor.js";

export {
  ENDPOINT_ALIVE,
  ENDPOINT_GONE,
  ENDPOINT_UNKNOWN,
  ERROR_ALREADY_EXITED,
  PID_GONE,
  PID_PRESENT,
  PID_UNVERIFIED,
  REAP_ALREADY_EXITED,
  REAP_NOOP,
  REAP_STILL_RUNNING,
  REAP_UNVERIFIED,
  SystemProcessInspector,
  ownerMetadataPayload,
  classifyOrphanedExecution,
  collectProcessStartInfo,
  probeEndpointSync,
  probePid,
  processMetadataPayload,
  raiseReapDecision,
  wrapperArgv,
} from "./process-ownership.js";
export type {
  EndpointState,
  ProcessInspector,
  ProcessStartInfo,
  ReapDecision,
} from "./process-ownership.js";

export const KERNEL_PLACEHOLDER = "kernel";

export {
  checkDocumentSchemaVersion,
  parseDraftText,
  renderAuthoringYaml,
  sha256Hex,
  yamlHasComments,
} from "./authoring.js";
export type { AuthoringRender, DraftFormat, SchemaVersionStatus } from "./authoring.js";
export { buildDraftSourceMap } from "./draft-source.js";
export type { DraftRange, DraftSourceMap } from "./draft-source.js";
export { writeFileConditional } from "./conditional-write.js";
export type { ConditionalWrite } from "./conditional-write.js";
export { containerIssues, isAgentPlaceholder, buildStructuralIndex, type StructuralIndex } from "./config-structure.js";

export { CORRECTION_POLICY, classifyGateError, decideCorrection, readCorrectionLedger, ruleForTurn } from "./correction-policy.js";
export type { CorrectionFiles, CorrectionLedger, GateFailure } from "./correction-policy.js";
export { DEFAULT_INTERRUPT_POLICY, interruptSession, isSettled } from "./provider-interrupt.js";
export type { InterruptPolicy, InterruptReport } from "./provider-interrupt.js";
export { StreamSummarizer, buildTurnDiagnostics, observeTurn, truncateText } from "./turn-diagnostics.js";
export type { Gates } from "./turn-diagnostics.js";
export type { OutcomeContext } from "./outcome-resolver.js";
export { cancellationSignal } from "./command-executor.js";
export type { ProcessFacts, StopReason } from "./command-executor.js";

export { VERIFY_EXHAUSTED, currentCompleteByStage, missingOutputNames, readyOutsideStoppedBranches, missingOutputProducers, schedulableStageIds, version2IdleReason } from "./selection.js";

export { buildVerifyRepairPrompt } from "./prompt.js";

export { ResponseContractError } from "./stage-outcome.js";
export { version2GraphQuiet } from "./selection.js";

export { renderProviderDiagnostics } from "./turn-diagnostics.js";
export { withFileLockSync } from "./file-lock.js";
