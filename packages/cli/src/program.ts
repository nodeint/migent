import { readFileSync } from "node:fs";
import { Command, type OptionValues } from "commander";
import { ConfigurationError, DEFAULT_MAX_DISPATCHES, requireAgentSession } from "@nodeint/migent-kernel";
import { continueAgent, dispatchAgent } from "./commands/agent.js";
import { runConfigModel, runConfigRole, runConfigShow } from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
import { executeWorkflow } from "./commands/execute.js";
import { prepareWorkflowSession } from "./commands/prepare.js";
import { repairWorkflowSession } from "./commands/repair.js";
import { runInit } from "./commands/init.js";
import { runSessionMetrics, runSessions } from "./commands/sessions.js";
import { parsePort, runServiceStart, runServiceStatus, runServiceStop } from "./commands/service.js";
import { installSkill, updateSkill } from "./commands/skill.js";
import { runRegister, runRemove, runWorkspaceList } from "./commands/workspace-registry.js";
import { printError } from "./display.js";
import { LOOP_EXITS, STAGE_EXITS } from "./exits.js";
import { runMigrate } from "./migrate.js";
import { optionalText, rawText, text } from "./text.js";
import { PACKAGE_VERSION } from "./version.js";
import { findWorkspace, invocationCwdPath } from "./workspace.js";

const PRIOR_HELP =
  "Completed session with the workflow id and decision named in requires. Checked before outputs are injected.";
const PROGRESS_HELP =
  "Print each tool call when it finishes. The default prints one line when a stage starts and one when it finishes.";
const VERBOSE_HELP =
  "Accepted for compatibility. Stage lines already include the attempt and the time. The response stays in the execution directory.";

export interface CliStatus {
  code: number;
  handled: boolean;
}

export function createProgram(status: CliStatus): Command {
  const program = new Command();
  program
    .name("migent")
    .description("Run named workflows and standalone roles from .migent/.")
    .version(PACKAGE_VERSION, "-V, --version", "Print the Migent version.")
    .exitOverride();

  registerSessionCommand(program, status);

  const init = program
    .command("init")
    .description("Create a minimal config, one workflow, and a sessions gitignore.")
    .option("--provider <provider>", "Provider for the default model. Pass with --model.")
    .option("--model <model>", "Model id for the default model. Pass with --provider.")
    .option("--option <pair>", "KEY=VALUE stored under models.*.options.", collect, [])
    .option("--preset <preset>", "Workflow to create: implement or plan. Default: implement.", "implement")
    .option("--skill", "Install the Migent skill at .agents/skills/migent.")
    .option("--no-input", "Do not prompt. Same as MIGENT_NO_INPUT=1.");
  init.action((options: OptionValues) =>
    settle(status, () => {
      const provider = optionalText(options.provider);
      const model = optionalText(options.model);
      const interactive = !inputDisabled(options) && provider === null && Boolean(process.stdin.isTTY);
      return runInit(invocationCwdPath(), {
        provider,
        model,
        options: stringList(options.option),
        preset: typeof options.preset === "string" ? options.preset : "implement",
        presetExplicit: init.getOptionValueSource("preset") === "cli",
        skill: options.skill === true,
        interactive,
      });
    }),
  );

  const config = program
    .command("config")
    .description("Print .migent/config.yaml, or update models and roles.");
  config.action(() => settle(status, () => runConfigShow(findWorkspace(invocationCwdPath()))));
  config
    .command("show")
    .description("Print .migent/config.yaml.")
    .action(() => settle(status, () => runConfigShow(findWorkspace(invocationCwdPath()))));
  config
    .command("model")
    .description("List models, or create and update one model name.")
    .argument("[name]", "Name to show or update.")
    .option("--provider <provider>", "Provider for this name. Pass with --model.")
    .option("--model <model>", "Model id for this name. Pass with --provider.")
    .option("--option <pair>", "KEY=VALUE stored under this model's options.", collect, [])
    .option("--clear-option <key>", "Remove one key from this model's options.", collect, [])
    .option("--json", "Print one JSON object.")
    .option("--no-input", "Do not prompt. Same as MIGENT_NO_INPUT=1. With no changes, list models.")
    .action((name: string | undefined, options: OptionValues) =>
      settle(status, () => {
        const provider = optionalText(options.provider);
        const model = optionalText(options.model);
        const optionValues = stringList(options.option);
        const clearOptions = stringList(options.clearOption);
        const mutating = provider !== null || model !== null || optionValues.length > 0 || clearOptions.length > 0;
        const interactive = !inputDisabled(options) && Boolean(process.stdin.isTTY) && options.json !== true && !mutating;
        return runConfigModel(findWorkspace(invocationCwdPath()), {
          key: text(name),
          provider,
          model,
          options: optionValues,
          clearOptions,
          asJson: options.json === true,
          interactive,
        });
      }),
    );
  config
    .command("role")
    .description("List roles, or point roles at a model.")
    .argument("[role...]", "Role to show or update.")
    .option("--model-name <name>", "models: name to point the roles at. This is not a provider model id.")
    .option("--provider <provider>", "Provider for this role only. Pass with --model.")
    .option("--model <model>", "Provider model id for this role only. Pass with --provider.")
    .option("--option <pair>", "KEY=VALUE stored under this role's options.", collect, [])
    .option("--clear-option <key>", "Remove one key from this role's options.", collect, [])
    .option("--json", "Print one JSON object.")
    .option("--no-input", "Do not prompt. Same as MIGENT_NO_INPUT=1. With no changes, list roles.")
    .action((roles: string[], options: OptionValues) =>
      settle(status, () => {
        const unique = roles
          .map((role) => text(role))
          .filter((role): role is string => role !== null)
          .filter((role, index, all) => all.indexOf(role) === index);
        const provider = optionalText(options.provider);
        const model = optionalText(options.model);
        const modelName = optionalText(options.modelName);
        const optionValues = stringList(options.option);
        const clearOptions = stringList(options.clearOption);
        const mutating = modelName !== null || provider !== null || model !== null || optionValues.length > 0 || clearOptions.length > 0;
        const interactive = !inputDisabled(options) && Boolean(process.stdin.isTTY) && options.json !== true && !mutating;
        return runConfigRole(findWorkspace(invocationCwdPath()), {
          roles: unique,
          modelName,
          provider,
          model,
          options: optionValues,
          clearOptions,
          asJson: options.json === true,
          interactive,
        });
      }),
    );

  program
    .command("doctor")
    .description("Check config, workflows, and provider CLIs.")
    .option("--json", "Print the checks as one JSON object.")
    .addHelpText("after", exitText(["Exit 0 when every check passes.", "Exit 1 when a check fails."]))
    .action((options: OptionValues) =>
      settle(status, () => runDoctor(findWorkspace(invocationCwdPath()), { asJson: options.json === true })),
    );

  program
    .command("migrate")
    .description("Upgrade config and workflows to the current schema version.")
    .option("-y, --yes", "Upgrade without asking. Use this when no terminal is available.")
    .action((options: OptionValues) =>
      settle(status, () => runMigrate(findWorkspace(invocationCwdPath()), { assumeYes: options.yes === true })),
    );

  const skill = program.command("skill").description("Install or update the Migent skill in this project.");
  skill
    .command("install")
    .description("Install the Migent skill without replacing an existing directory.")
    .action(() => settle(status, () => installSkill(findWorkspace(invocationCwdPath()))));
  skill
    .command("update")
    .description("Update a managed Migent skill to the bundled template.")
    .option("--force", "Replace a locally modified managed skill with the bundled template.")
    .action((options: OptionValues) =>
      settle(status, () => updateSkill(findWorkspace(invocationCwdPath()), { force: options.force === true })),
    );
  showHelpWhenBare(status, skill);

  const service = program.command("service").description("Run the local workspace registry service.");
  service
    .command("start")
    .description("Start the registry service, or adopt one that is already running.")
    .option("--port <port>", "Bind 127.0.0.1 on this port. The default is 47321.")
    .option("--foreground", "Serve in this process instead of detaching.")
    .action((options: OptionValues) =>
      settle(status, () => {
        const port = options.port === undefined ? null : parsePort(String(options.port));
        return runServiceStart(port, options.foreground === true);
      }),
    );
  service
    .command("stop")
    .description("Stop the registry service when its process identity matches. Stop is idempotent and exits 0 when the service is already absent.")
    .action(() => settle(status, () => runServiceStop()));
  service
    .command("status")
    .description("Report whether the registry service is running. Status is a query and exits 1 when the service is stopped.")
    .option("--json", "Print one JSON object.")
    .addHelpText("after", exitText(["Exit 0 when the service is running.", "Exit 1 when the service is stopped."]))
    .action((options: OptionValues) => settle(status, () => runServiceStatus(options.json === true)));
  showHelpWhenBare(status, service);

  const workspace = program.command("workspace").description("Register this machine's Migent workspaces.");
  workspace
    .command("register")
    .description("Register the workspace that contains .migent/config.yaml.")
    .option("--path <path>", "Workspace root or a directory inside it.")
    .option("--name <name>", "Display name. Defaults to the directory name.")
    .action((options: OptionValues) =>
      settle(status, () => runRegister(optionalText(options.path), optionalText(options.name))),
    );
  workspace
    .command("list")
    .description("List registered workspaces.")
    .option("--json", "Print one JSON object.")
    .action((options: OptionValues) => settle(status, () => runWorkspaceList(options.json === true)));
  workspace
    .command("remove")
    .description("Remove one registered workspace by id.")
    .argument("<id>", "Workspace id to remove.")
    .action((id: string) => settle(status, () => runRemove(id)));
  showHelpWhenBare(status, workspace);

  program.allowExcessArguments();
  program.action(() => {
    const unknown = program.args[0];
    if (unknown) {
      program.error(`error: unknown command '${unknown}'`, { code: "commander.unknownCommand" });
    }
    program.outputHelp();
    status.handled = true;
    status.code = 2;
  });
  return program;
}

const ROLE_EXITS = [
  "Exit 0 when the outcome is complete, or the role session is already completed.",
  "Exit 1 when the outcome is not complete.",
  "Exit 2 on a configuration error.",
  "Exit 6 when a cancelled role session reopened more than one execution and one exhausted verify.",
  "Exit 130 when cancelled. session continue resumes that execution.",
];

const RUN_SPLIT = "Pass --workflow for a workflow run, or --role for an agent run.";

function registerSessionCommand(program: Command, status: CliStatus): void {
  const session = program.command("session").description("Create, run, resume, and inspect sessions.");
  const run = session
    .command("run")
    .description("Run a workflow, or one role when --workflow is omitted.")
    .option("--workflow <workflow>", "Workflow id, or a path to a workflow file. Omit to run one role.")
    .option("--task <task>", "Workflow: one-line task stored in task.md. Role: label for a new session.")
    .option("--session <session>", "Workflow: prepared session to start, with --workflow. Role: session to continue.");
  addDispatchOptions(run, "Dispatch the next eligible stage once. Requires --workflow.");
  run
    .option("--role <role>", "Role to run. Omit --workflow.")
    .option("--provider <provider>", "Provider for this role. Pass with --model, or omit both.")
    .option("--model <model>", "Native model id for this role. Pass with --provider, or omit both.")
    .option("--option <pair>", "KEY=VALUE overriding one provider option for this turn.", collect, [])
    .option("--prompt <prompt>", "Prompt text for a role run.")
    .option("--file <file>", "Read the role prompt from this file.")
    .option("--stdin", "Read the role prompt from stdin.")
    .option("--json", "Print the role result as one JSON object.")
    .addHelpText(
      "after",
      `With --workflow:\n${exitText(LOOP_EXITS)}With --workflow and --once:\n${exitText(STAGE_EXITS)}Without --workflow:\n${exitText(ROLE_EXITS)}Examples:\n  migent session run --workflow plan --task "<one line>"\n  migent session run --session <session> --workflow plan\n  migent session run --role reviewer --prompt "<prompt>"\n`,
    )
    .action((options: OptionValues) => settle(status, () => runSessionCommand(options)));

  session
    .command("prepare")
    .description("Create a prepared session and exit. Write task.md, then session run --session <id> --workflow <workflow>.")
    .argument("<title>", "Session title shown in the list, such as \"some task title\". The session id is a UUID.")
    .requiredOption("--workflow <workflow>", "Workflow id, or a path to a workflow file.")
    .option("--prior <session>", PRIOR_HELP)
    .addHelpText(
      "after",
      `${exitText(["Exit 0 when the session is prepared.", "Exit 2 on a configuration error."])}Examples:\n  migent session prepare "some task title" --workflow plan\n`,
    )
    .action((id: string, options: OptionValues) =>
      settle(status, () =>
        prepareWorkflowSession(findWorkspace(invocationCwdPath()), id, String(options.workflow), optionalText(options.prior)),
      ),
    );

  const continueCommand = session
    .command("continue")
    .description("Resume a stopped workflow or role session. A workflow session runs until it stops and resets revision counts. --once dispatches one workflow stage and does not reset them.")
    .argument("<session>", "Session to resume.");
  addDispatchOptions(
    continueCommand,
    "Dispatch the next eligible stage once and do not reset revision counts. Without --once, continue resets them.",
  );
  continueCommand
    .option("--reply <text>", "Reply for the blocked stage. The new execution prompt body is this text.")
    .option("--reply-file <file>", "Read the blocked stage's reply from this file.")
    .addHelpText(
      "after",
      `Workflow session:\n${exitText(LOOP_EXITS)}With --once:\n${exitText(STAGE_EXITS)}Role session:\n${exitText(ROLE_EXITS)}Examples:\n  migent session continue <session>\n  migent session continue <session> --once\n  migent session continue <session> --reply "<reply>"\n  migent session continue <session> --stage plan --reply-file answer.md\n`,
    )
    .action((id: string, options: OptionValues) => settle(status, () => continueSession(id, options)));

  session
    .command("repair")
    .description("Rebuild status.json from the session directory.")
    .argument("<session>", "Session to repair.")
    .option("--accept-task", "Store the hash of the current task.md when status.json does not parse.")
    .addHelpText(
      "after",
      `${exitText([
        "Exit 0 after status.json is rebuilt.",
        "Exit 2 when the session cannot be repaired, or another process holds the session lock.",
      ])}Examples:\n  migent session repair <session>\n  migent session repair <session> --accept-task\n`,
    )
    .action((id: string, options: OptionValues) =>
      settle(status, () =>
        repairWorkflowSession(findWorkspace(invocationCwdPath()), id, options.acceptTask === true),
      ),
    );

  session
    .command("list")
    .description("List sessions, newest first.")
    .option("--json", "Print a JSON array without the task. With --latest, print one object, or null.")
    .option("--workflow <id>", "List sessions for this workflow id.")
    .option("--status <status>", "List sessions with this status: active, prepared, completed, blocked, cancelled, or corrupt.")
    .option("--limit <n>", "List the newest n sessions. At least 1. Cannot be combined with --latest.")
    .option("--latest", "Print the newest matching session. Cannot be combined with --limit.")
    .addHelpText(
      "after",
      `${exitText(["Exit 0 after a list, including an empty list.", "Exit 2 on a configuration error."])}Examples:\n  migent session list\n  migent session list --latest --json\n  migent session list --workflow <id> --status completed --json\n`,
    )
    .action((options: OptionValues) =>
      settle(status, () =>
        runSessions(findWorkspace(invocationCwdPath()), undefined, {
          asJson: options.json === true,
          follow: false,
          execution: null,
          until: false,
          cursor: undefined,
          exitWhenDone: false,
          workflow: typeof options.workflow === "string" ? options.workflow : null,
          status: typeof options.status === "string" ? options.status : null,
          limit: options.limit === undefined ? null : String(options.limit),
          latest: options.latest === true,
        }),
      ),
    );

  session
    .command("show")
    .description("Print one session snapshot.")
    .argument("<session>", "Session to inspect.")
    .option("--json", "Print one JSON object without the task.")
    .addHelpText(
      "after",
      `${exitText(["Exit 0 after a snapshot, including a blocked session.", "Exit 2 on a configuration error."])}Examples:\n  migent session show <session>\n  migent session show <session> --json\n`,
    )
    .action((id: string, options: OptionValues) =>
      settle(status, () =>
        runSessions(findWorkspace(invocationCwdPath()), id, {
          asJson: options.json === true,
          follow: false,
          execution: null,
          until: false,
          cursor: undefined,
          exitWhenDone: false,
          workflow: null,
          status: null,
          limit: null,
          latest: false,
        }),
      ),
    );

  session
    .command("metrics")
    .description("Print usage, time, and revision counts recorded for a completed workflow session.")
    .argument("[session]", "Workflow session to read. Omit to list sessions that have metrics.")
    .option("--json", "Print one JSON object, or one object per line for a list.")
    .option("--workflow <id>", "With a list, keep sessions for this workflow.")
    .option("--status <status>", "With a list, keep sessions in this status.")
    .option("--limit <n>", "With a list, keep the newest n sessions.")
    .addHelpText(
      "after",
      `${exitText([
        "Exit 0 after one session object, or one object per line. An empty list prints nothing.",
        "Exit 2 when --json is missing, the session has no metrics.json, that file is corrupt, or a list flag is invalid.",
      ])}Examples:\n  migent session metrics <session> --json\n  migent session metrics --json --workflow <id> --status completed --limit 10\n`,
    )
    .action((id: string | undefined, options: OptionValues) =>
      settle(status, () =>
        runSessionMetrics(findWorkspace(invocationCwdPath()), id, {
          asJson: options.json === true,
          workflow: typeof options.workflow === "string" ? options.workflow : null,
          status: typeof options.status === "string" ? options.status : null,
          limit: options.limit === undefined ? null : String(options.limit),
        }),
      ),
    );

  session
    .command("follow")
    .description("Follow a session's events until a signal.")
    .argument("<session>", "Session to follow.")
    .option("--json", "Print a snapshot object, then JSON lines. With --cursor, only JSON lines.")
    .option("--execution <execution>", "Limit followed events and --until to this execution.")
    .option(
      "--cursor <offset>",
      "Byte offset in events.jsonl. 0 replays the whole log and every execution stream. Any other offset replays events from that byte, and stream lines whose timestamp is at or after the first event there. Skips the snapshot.",
    )
    .option("--until", "Exit when --execution reaches completed, failed, or cancelled. Requires --execution.")
    .option("--exit-when-done", "Exit when the session is completed (0), blocked (1), or cancelled (130).")
    .addHelpText(
      "after",
      `${exitText([
        "Exit 0 when --exit-when-done and the session is completed.",
        "Exit 1 when --exit-when-done and the session is blocked.",
        "Exit 130 when --exit-when-done and the session is cancelled, or the follow is cancelled.",
        "Exit 2 on a configuration error.",
      ])}Examples:\n  migent session follow <session>\n  migent session follow <session> --exit-when-done\n`,
    )
    .action((id: string, options: OptionValues) =>
      settle(status, () =>
        runSessions(findWorkspace(invocationCwdPath()), id, {
          asJson: options.json === true,
          follow: true,
          execution: optionalText(options.execution),
          until: options.until === true,
          cursor: options.cursor === undefined ? undefined : String(options.cursor),
          exitWhenDone: options.exitWhenDone === true,
          workflow: null,
          status: null,
          limit: null,
          latest: false,
        }),
      ),
    );
  showHelpWhenBare(status, session);
}

function runSessionCommand(options: OptionValues): number | Promise<number> {
  if (options.stage !== undefined && optionalText(options.stage) === null) {
    printError("--stage is empty.");
    return 2;
  }
  const workflowProvided = options.workflow !== undefined;
  const workflowId = optionalText(options.workflow);
  if (workflowProvided && workflowId === null) {
    printError("--workflow is empty.");
    return 2;
  }
  const roleMode = roleFlagsPresent(options);
  const workflowMode = workflowFlagsPresent(options);
  if ((workflowId !== null && roleMode) || (workflowId === null && workflowMode)) {
    printError(RUN_SPLIT);
    return 2;
  }
  if (workflowId !== null) {
    const sessionId = optionalText(options.session);
    const task = rawText(options.task);
    const prepared = sessionId !== null;
    if (prepared && task !== null) {
      printError("Pass --workflow and --task, or --session and --workflow, not both.");
      return 2;
    }
    if (!prepared && task === null) {
      printError("Pass --task.");
      return 2;
    }
    return runWorkflowCommand({
      workflowId,
      task,
      sessionId,
      prepared,
      once: options.once === true,
      options,
    });
  }
  if (!roleMode) {
    printError(RUN_SPLIT);
    return 2;
  }
  return runAgent(options, optionalText(options.session));
}

function roleFlagsPresent(options: OptionValues): boolean {
  return (
    options.role !== undefined ||
    options.provider !== undefined ||
    options.model !== undefined ||
    stringList(options.option).length > 0 ||
    options.prompt !== undefined ||
    options.file !== undefined ||
    options.stdin === true ||
    options.json === true
  );
}

function workflowFlagsPresent(options: OptionValues): boolean {
  return (
    options.once === true ||
    options.stage !== undefined ||
    options.prior !== undefined ||
    options.maxDispatches !== undefined ||
    options.unlimitedDispatches === true ||
    options.progress === true ||
    options.verbose === true ||
    options.refreshWorkflow === true
  );
}

function runWorkflowCommand(args: {
  workflowId: string | null;
  task: string | null;
  sessionId: string | null;
  prepared: boolean;
  once: boolean;
  options: OptionValues;
}): number | Promise<number> {
  if (rejectOnce(args.options)) return 2;
  const workflowId = args.workflowId;
  const task = args.prepared ? null : args.task;
  const sessionId = args.prepared ? args.sessionId : null;
  const stageId = optionalText(args.options.stage);
  if (!args.once && stageId === null) {
    const ceiling = dispatchCeiling(args.options);
    if (typeof ceiling === "string") return 2;
    return executeWorkflow(findWorkspace(invocationCwdPath()), {
      action: "start",
      workflowId,
      task,
      sessionId,
      startPrepared: args.prepared,
      priorSessionId: optionalText(args.options.prior),
      maxDispatches: ceiling,
      refreshWorkflow: args.options.refreshWorkflow === true,
      ...outputFlags(args.options),
    });
  }
  return executeWorkflow(findWorkspace(invocationCwdPath()), {
    action: "stage",
    workflowId,
    task,
    sessionId,
    stageId,
    startPrepared: args.prepared,
    priorSessionId: optionalText(args.options.prior),
    maxDispatches: null,
    refreshWorkflow: args.options.refreshWorkflow === true,
    ...outputFlags(args.options),
  });
}

function continueSession(session: string, options: OptionValues): number | Promise<number> {
  if (options.stage !== undefined && optionalText(options.stage) === null) {
    printError("--stage is empty.");
    return 2;
  }
  const workspace = findWorkspace(invocationCwdPath());
  if (isAgentSession(workspace, session)) return continueRoleSession(workspace, session, options);
  if (rejectOnce(options)) return 2;
  const reply = readReply(options);
  if (reply === "invalid") return 2;
  const stageId = optionalText(options.stage);
  if (options.once === true || stageId !== null) {
    return executeWorkflow(findWorkspace(invocationCwdPath()), {
      action: "stage",
      sessionId: session,
      stageId,
      priorSessionId: optionalText(options.prior),
      maxDispatches: null,
      continueFailed: true,
      refreshWorkflow: options.refreshWorkflow === true,
      reply,
      ...outputFlags(options),
    });
  }
  const ceiling = dispatchCeiling(options);
  if (typeof ceiling === "string") return 2;
  return executeWorkflow(findWorkspace(invocationCwdPath()), {
    action: "continue",
    sessionId: session,
    priorSessionId: optionalText(options.prior),
    maxDispatches: ceiling,
    continueFailed: true,
    refreshWorkflow: options.refreshWorkflow === true,
    reply,
    ...outputFlags(options),
  });
}

function isAgentSession(workspace: string, sessionId: string): boolean {
  try {
    requireAgentSession(workspace, sessionId);
    return true;
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    if (error.message === `Session not found: ${sessionId}.`) return false;
    if (error.message === `Session ${sessionId} was not created by agent.`) return false;
    if (error.message.startsWith("Session status file is corrupt:")) return false;
    throw error;
  }
}

function continueRoleSession(workspace: string, sessionId: string, options: OptionValues): number | Promise<number> {
  const flags: string[] = [];
  if (options.once === true) flags.push("--once");
  if (options.stage !== undefined) flags.push("--stage");
  if (options.prior !== undefined) flags.push("--prior");
  if (options.maxDispatches !== undefined) flags.push("--max-dispatches");
  if (options.unlimitedDispatches === true) flags.push("--unlimited-dispatches");
  if (options.progress === true) flags.push("--progress");
  if (options.verbose === true) flags.push("--verbose");
  if (options.refreshWorkflow === true) flags.push("--refresh-workflow");
  if (flags.length > 0) {
    printError(`Session ${sessionId} is a role session. Omit ${flags.join(", ")}.`);
    return 2;
  }
  const reply = readReply(options);
  if (reply === "invalid") return 2;
  return continueAgent(workspace, { sessionId, reply });
}

function readReply(options: OptionValues): string | null | "invalid" {
  const hasReply = options.reply !== undefined;
  const hasFile = options.replyFile !== undefined;
  if (!hasReply && !hasFile) return null;
  if (hasReply && hasFile) {
    printError("Pass only one of --reply or --reply-file.");
    return "invalid";
  }
  if (hasFile) {
    const file = optionalText(options.replyFile);
    if (file === null) {
      printError("--reply-file is empty.");
      return "invalid";
    }
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      printError(`Unable to read reply file: ${file} (${reason})`);
      return "invalid";
    }
    if (text.trim() === "") {
      printError("--reply is empty.");
      return "invalid";
    }
    return text;
  }
  const reply = rawText(options.reply);
  if (reply === null || reply.trim() === "") {
    printError("--reply is empty.");
    return "invalid";
  }
  return reply;
}

function addDispatchOptions(command: Command, onceDescription: string): void {
  command
    .option("--once", onceDescription)
    .option("--stage <stage>", "Dispatch this ready stage once. It does not have to be the first ready stage.")
    .option("--prior <session>", PRIOR_HELP)
    .option(
      "--max-dispatches <count>",
      `Stage dispatches allowed in this command. Default: ${DEFAULT_MAX_DISPATCHES}. Pass --unlimited-dispatches to remove the ceiling.`,
    )
    .option("--unlimited-dispatches", "Remove the dispatch ceiling for this command.")
    .option("--progress", PROGRESS_HELP)
    .option("--verbose", VERBOSE_HELP)
    .option(
      "--refresh-workflow",
      "Use the current workflow, models, and role instructions for this session. Requires an existing session that has a frozen workflow.",
    );
}

function outputFlags(options: OptionValues): { itemProgress: boolean } {
  return { itemProgress: options.progress === true };
}

function showHelpWhenBare(status: CliStatus, command: Command): void {
  command.action(() => {
    command.outputHelp();
    status.handled = true;
    status.code = 2;
  });
}

function settle(status: CliStatus, action: () => number | Promise<number>): Promise<void> {
  return Promise.resolve(action()).then((code) => {
    status.handled = true;
    status.code = code;
  });
}

function exitText(lines: readonly string[]): string {
  return `\n${lines.join("\n")}\n`;
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

async function runAgent(options: OptionValues, sessionId: string | null): Promise<number> {
  const role = optionalText(options.role);
  if (role === null) {
    printError("Pass --role.");
    return 2;
  }
  const provider = optionalText(options.provider);
  const model = optionalText(options.model);
  if ((provider === null) !== (model === null)) {
    printError("Pass both --provider and --model, or omit both.");
    return 2;
  }
  const prompt = optionalText(options.prompt);
  const promptFile = optionalText(options.file);
  const promptStdin = options.stdin === true;
  const selected = Number(prompt !== null) + Number(promptFile !== null) + Number(promptStdin);
  if (selected !== 1) {
    printError("Pass one of --prompt, --file, or --stdin.");
    return 2;
  }
  return dispatchAgent(findWorkspace(invocationCwdPath()), {
    role,
    task: optionalText(options.task),
    sessionId,
    provider,
    model,
    options: stringList(options.option),
    prompt,
    promptFile,
    promptStdin,
    asJson: options.json === true,
  });
}

function rejectOnce(options: OptionValues): boolean {
  if (options.once !== true && options.stage === undefined) return false;
  const flag = options.once === true ? "--once" : "--stage";
  if (options.maxDispatches !== undefined) {
    printError(`${flag} cannot be combined with --max-dispatches.`);
    return true;
  }
  if (options.unlimitedDispatches === true) {
    printError(`${flag} cannot be combined with --unlimited-dispatches.`);
    return true;
  }
  return false;
}

function dispatchCeiling(options: OptionValues): number | null | "error" {
  const maxDispatches = optionalText(options.maxDispatches);
  const unlimited = options.unlimitedDispatches === true;
  if (unlimited && maxDispatches !== null) {
    printError("--max-dispatches cannot be combined with --unlimited-dispatches.");
    return "error";
  }
  if (unlimited) return null;
  if (maxDispatches === null) return DEFAULT_MAX_DISPATCHES;
  return integerFlag(maxDispatches, "--max-dispatches");
}

function integerFlag(raw: string, flag: string): number {
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) {
    throw new ConfigurationError(`${flag} must be at least 1.`);
  }
  return Number(raw);
}

function inputDisabled(options: OptionValues): boolean {
  return options.noInput === true || process.env.MIGENT_NO_INPUT === "1";
}
