export {
  appendLineSynced,
  isAtomicTempName,
  sealTornTail,
  writeFileAtomic,
  writeJsonAtomic,
} from './atomic-file.js';
export { unknownRoleKeyEntries } from './authoring-diagnostics.js';
export type {
  BuildCommandInput,
  CliClient,
  ClientInfo,
  ClientOption,
  ClientRegistry,
  CliModelCatalog,
  CliRunOutput,
  CliUsage,
  FailureClassification,
  FailureOrigin,
  InterruptOutcome,
  ModelClientLookup,
  NewSession,
  ProviderClassification,
  QuotaClassification,
  RawFailure,
  ResponseSource,
  TurnUsage,
  UsageCapture,
} from './cli-client.js';
export { classifyFailure, createNewSession, normalizeUsage, sessionOptions } from './client-policy.js';
export type {
  CommandResult,
  CommandSpec,
  ExecutionFailure,
  RunOptions,
  StartFailure,
  StartResult,
} from './command-executor.js';
export {
  CancellationRequested,
  CommandExecutor,
  DEFAULT_TIMEOUT_SEC,
  PROGRESS_INTERVAL_SEC,
  raiseCancellation,
  resetCancellation,
  stopProcessGroup,
  TERMINATION_GRACE_SEC,
} from './command-executor.js';
export { describeStartFailure } from './command-executor.js';
export type {
  AgentDefinitionEntry,
  ConfigLayer,
  ConfigOwner,
  EffectiveClientFailure,
  Field,
  MergedConfig,
  ModelOverride,
  ResolveContext,
  ResolveSpecOptions,
  ResolveTargetOptions,
  RoleCascadeOptions,
  StageTarget,
  StageTargetRef,
} from './config.js';
export {
  configPath,
  documentVersion,
  field,
  hasLocalConfig,
  listAgentDefinitions,
  loadAgentDefinition,
  loadAgentTarget,
  loadMergedConfig,
  loadRoleDescription,
  loadRoleResponsibilities,
  loadWorkspaceConfig,
  loadYamlMapping,
  LOCAL_CONFIG_FILE,
  localConfigPath,
  mergeConfig,
  mergeConfigLayers,
  readConfigLayer,
  rejectLegacyConfigKeys,
  resolveEffectiveClient,
  resolveRoleCascade,
  resolveRoleTarget,
  resolveStageSpec,
  resolveStageTarget,
  stringifyConfig,
  validateRoleKeys,
} from './config.js';
export type {
  AgentView,
  ConfigChange,
  ConfigView,
  RoleView,
  StageRef,
  StageShield,
} from './config-edit.js';
export {
  assignRoles,
  describeChange,
  inspectConfig,
  matchingAgentName,
  placeRoleAgent,
  upsertAgent,
} from './config-edit.js';
export { patchConfigText, upgradeConfigText } from './config-text.js';
export { CORRECTION_FAILURE_REASONS } from './correction-policy.js';
export { debugEnabled, inheritedEnv, migentHomeOverride, noInputRequested, platformHome, skillsChildEnv } from './env.js';
export type { ConfigurationErrorDetails, SourcePosition } from './errors.js';
export { ConfigurationError, OutputsMissing } from './errors.js';
export { STATUS_PROVIDER_EVENTS } from './event-kinds.js';
export { HandoffFileError, loadHandoffFile } from './handoff.js';
export {
  clientOfCommand,
  LEGACY_COMMAND_CLIENT,
  LEGACY_PROVIDER_CLIENT,
  legacyClientOf,
} from './legacy-provider.js';
export type { MigrateConfigOptions, MigrateWorkflowOptions, MigrationFn, MigrationLayer, MigrationResult } from './migration.js';
export { migrateConfig, migrateWorkflow } from './migration.js';
export { assertConfigClientEquivalence } from './migration-config.js';
export { resolveStageOutcome } from './outcome-resolver.js';
export type { ExecutionSnapshot, PublishedOutput } from './outputs.js';
export {
  atomicCopy,
  isArtifactSchema,
  isCompletionDecision,
  missingCompletionOutputNames,
  missingWorkflowOutputNames,
  nonemptyArtifact,
  publishOutputFiles,
  resolveArtifactSources,
  runnableViolation,
  selectSourceExecution,
  sessionStatusAfterExecution,
  type SessionStatusInput,
  shouldPublishOutputs,
} from './outputs.js';
export type {
  EndpointState,
  ProcessInspector,
  ProcessStartInfo,
  ReapDecision,
} from './process-ownership.js';
export {
  classifyOrphanedExecution,
  collectProcessStartInfo,
  ENDPOINT_ALIVE,
  ENDPOINT_GONE,
  ENDPOINT_UNKNOWN,
  ERROR_ALREADY_EXITED,
  ownerMetadataPayload,
  PID_GONE,
  PID_PRESENT,
  PID_UNVERIFIED,
  probeEndpointSync,
  probePid,
  processMetadataPayload,
  raiseReapDecision,
  REAP_ALREADY_EXITED,
  REAP_NOOP,
  REAP_STILL_RUNNING,
  REAP_UNVERIFIED,
  SystemProcessInspector,
  wrapperArgv,
} from './process-ownership.js';
export { killProcessTree, wrapperEndpoint } from './process-wrapper.js';
export { buildStagePrompt, buildStageReplyPrompt, buildStageResumePrompt, prependRoleInstructions } from './prompt.js';
export {
  assertArgumentsPassable,
  spawnProvider,
  spawnProviderSync,
  UnpassableArgument,
} from './provider-spawn.js';
export type { Question, QuestionAnswer } from './questions.js';
export { answerQuestions, formatQuestionAnswers, loadQuestionFile, QuestionFileError, storedQuestions } from './questions.js';
export { log, utcNow } from './runtime.js';
export {
  addArtifactContext,
  addStageOutcomeContract,
  CONVERSATION_FILENAME,
  EXECUTION_SCHEMA_VERSION,
  EXECUTIONS_DIRNAME,
  flattenHistory,
  formatClock,
  formatDuration,
  isUnicodeAlnum,
  LEGACY_CONVERSATION_FILENAME,
  logProgress,
  MIGENT_DIRNAME,
  safeComponent,
  SESSIONS_DIRNAME,
} from './runtime.js';
export type { BlockResume, NextStageResult, RunPool, SchedulableState, ScheduleState } from './selection.js';
export {
  NextStage,
  nextStage,
  NextStageError,
  readyStages,
  runnableNow,
  stageDispatchError,
  Stop,
} from './selection.js';
export {
  failedStageCount,
  latestCompleteByStage,
  type RevisionQuery,
  revisionResumeExecution,
  revisionStop,
  stageAgentExecution,
  stagePromptAlreadyDelivered,
  VERIFY_FAILED,
  verifyExhaustedExecution,
  verifyFailedExecution,
} from './selection-history.js';
export type { AskTarget } from './stage-outcome.js';
export { outcomeStatuses, parseStageOutcome, StageOutcome } from './stage-outcome.js';
export type { VerifyCommandResult,VerifyRunResult } from './verify-runner.js';
export { formatVerifyReport,VerifyRunner } from './verify-runner.js';
export { whichSync } from './which.js';
export { patchWorkflowText } from './workflow-text.js';
export { ConfigEditError, yamlScalar } from './yaml-patch.js';
export type { TurnKind } from '@nodeint/migent-prompts';

export const KERNEL_PLACEHOLDER = 'kernel';

export type { AuthoringRender, DraftFormat, SchemaVersionStatus } from './authoring.js';
export {
  checkDocumentSchemaVersion,
  parseDraftText,
  renderAuthoringYaml,
  sha256Hex,
  yamlHasComments,
} from './authoring.js';
export type { ProcessFacts, StopReason } from './command-executor.js';
export { cancellationSignal } from './command-executor.js';
export type { ConditionalWrite } from './conditional-write.js';
export { writeFileConditional } from './conditional-write.js';
export { buildStructuralIndex, containerIssues, isAgentPlaceholder, type StructuralIndex } from './config-structure.js';
export type { CorrectionFiles, CorrectionLedger, GateFailure } from './correction-policy.js';
export { classifyGateError, CORRECTION_POLICY, decideCorrection, readCorrectionLedger, ruleForTurn } from './correction-policy.js';
export type { DraftRange, DraftSourceMap } from './draft-source.js';
export { buildDraftSourceMap } from './draft-source.js';
export { withFileLockSync } from './file-lock.js';
export type { OutcomeContext } from './outcome-resolver.js';
export { buildVerifyRepairPrompt } from './prompt.js';
export type { InterruptPolicy, InterruptReport } from './provider-interrupt.js';
export { DEFAULT_INTERRUPT_POLICY, interruptSession, isSettled } from './provider-interrupt.js';
export { missingOutputNames, missingOutputProducers, readyOutsideStoppedBranches, schedulableStageIds, version2IdleReason } from './selection.js';
export { version2GraphQuiet } from './selection.js';
export { currentCompleteByStage, VERIFY_EXHAUSTED } from './selection-history.js';
export { ResponseContractError } from './stage-outcome.js';
export type { Gates } from './turn-diagnostics.js';
export { buildTurnDiagnostics, observeTurn, StreamSummarizer, truncateText } from './turn-diagnostics.js';
export { renderProviderDiagnostics } from './turn-diagnostics.js';
