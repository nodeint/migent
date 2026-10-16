import { Command, type OptionValues } from "commander";
import { ConfigurationError, DEFAULT_MAX_DISPATCHES } from "@nodeint/migent-kernel";
import { dispatchAgent } from "./commands/agent.js";
import { runConfigModel, runConfigRole, runConfigShow } from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
import { executeWorkflow } from "./commands/execute.js";
import { runInit } from "./commands/init.js";
import { runSessions } from "./commands/sessions.js";
import { parsePort, runServiceStart, runServiceStatus, runServiceStop } from "./commands/service.js";
import { installSkill, updateSkill } from "./commands/skill.js";
import { watchSession } from "./commands/watch.js";
import { runRegister, runRemove, runWorkspaceList } from "./commands/workspace-registry.js";
import { printError } from "./display.js";
import { LOOP_EXITS, STAGE_EXITS } from "./exits.js";
import { runMigrate } from "./migrate.js";
import { optionalText, text } from "./text.js";
import { PACKAGE_VERSION } from "./version.js";
import { findWorkspace, invocationCwdPath } from "./workspace.js";

const PRIOR_HELP =
  "Completed session with the workflow id and decision named in requires. Checked before outputs are injected.";

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

  const start = program
    .command("start")
    .description("Create a session and continue until it stops.")
    .argument("<workflow>", "Workflow id, or a path to a workflow file.")
    .requiredOption("--task <task>", "Task recorded on the new session.");
  addDispatchOptions(start, "Dispatch the next eligible stage once.");
  start
    .addHelpText("after", `${exitText(LOOP_EXITS)}With --once:\n${exitText(STAGE_EXITS)}`)
    .action((workflow: string, options: OptionValues) =>
      settle(status, () => {
        if (rejectOnce(options)) return 2;
        if (options.once === true) {
          return executeWorkflow(findWorkspace(invocationCwdPath()), {
            action: "stage",
            workflowId: workflow,
            task: String(options.task),
            priorSessionId: optionalText(options.prior),
            maxAttempts: null,
            maxDispatches: null,
          });
        }
        const ceiling = dispatchCeiling(options);
        if (typeof ceiling === "string") return 2;
        return executeWorkflow(findWorkspace(invocationCwdPath()), {
          action: "start",
          workflowId: workflow,
          task: String(options.task),
          priorSessionId: optionalText(options.prior),
          maxAttempts: attemptsOf(options),
          maxDispatches: ceiling,
        });
      }),
    );

  const continueCommand = program
    .command("continue")
    .description("Resume a session until it stops. Resets revision counts. --once dispatches one stage and does not reset them.")
    .argument("<session>", "Session to resume.");
  addDispatchOptions(
    continueCommand,
    "Dispatch the next eligible stage once and do not reset revision counts. Without --once, continue resets them.",
  );
  continueCommand
    .addHelpText(
      "after",
      `${exitText(LOOP_EXITS)}With --once:\n${exitText(STAGE_EXITS)}Examples:\n  migent continue <session> --once\n`,
    )
    .action((session: string, options: OptionValues) =>
      settle(status, () => {
        if (rejectOnce(options)) return 2;
        if (options.once === true) {
          return executeWorkflow(findWorkspace(invocationCwdPath()), {
            action: "stage",
            sessionId: session,
            priorSessionId: optionalText(options.prior),
            maxAttempts: null,
            maxDispatches: null,
          });
        }
        const ceiling = dispatchCeiling(options);
        if (typeof ceiling === "string") return 2;
        return executeWorkflow(findWorkspace(invocationCwdPath()), {
          action: "continue",
          sessionId: session,
          priorSessionId: optionalText(options.prior),
          maxAttempts: attemptsOf(options),
          maxDispatches: ceiling,
        });
      }),
    );

  program
    .command("stage", { hidden: true })
    .description("Advance one stage. Dispatch the next eligible stage once.")
    .argument("[session]", "Session to advance. Omit when passing --workflow.")
    .option("--workflow <workflow>", "Workflow id or path. Creates a session and dispatches its next stage once.")
    .option("--task <task>", "Task recorded on the new session. Required with --workflow.")
    .option("--prior <session>", PRIOR_HELP)
    .addHelpText("after", exitText(STAGE_EXITS))
    .action((session: string | undefined, options: OptionValues) =>
      settle(status, () => {
        const sessionId = text(session);
        const workflow = optionalText(options.workflow);
        const task = optionalText(options.task);
        const replacement =
          sessionId !== null
            ? "continue SESSION --once"
            : "start WORKFLOW --task TASK --once";
        deprecate("stage", replacement);
        if (sessionId !== null && (workflow !== null || task !== null)) {
          printError("Pass SESSION, or --workflow and --task, not both.");
          return 2;
        }
        if (sessionId === null && (workflow === null || task === null)) {
          printError("Pass SESSION, or both --workflow and --task.");
          return 2;
        }
        return executeWorkflow(findWorkspace(invocationCwdPath()), {
          action: "stage",
          workflowId: workflow,
          task,
          sessionId,
          priorSessionId: optionalText(options.prior),
          maxAttempts: null,
          maxDispatches: null,
        });
      }),
    );

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

  program
    .command("sessions")
    .description("List sessions, print one snapshot, or follow its events.")
    .argument("[session]", "Session to inspect. Omit to list.")
    .option("--json", "List: a JSON array. Snapshot: one object. Follow: a snapshot object, then JSON lines. With --cursor, only JSON lines.")
    .option("--follow", "Print the snapshot, then follow events until a signal. With --cursor, skip the snapshot.")
    .option("--execution <execution>", "Limit followed events and --until to this execution.")
    .option("--cursor <offset>", "Byte offset in events.jsonl for tools that resume a follow. Requires --follow. 0 replays the whole log.")
    .option("--until", "Exit when --execution reaches completed, failed, or cancelled. Requires --follow and --execution.")
    .option("--exit-when-done", "With --follow, exit when the session is completed (0), blocked (1), or cancelled (130).")
    .addHelpText(
      "after",
      `${exitText([
        "Exit 0 after a list or a snapshot, including a blocked session.",
        "Exit 0 when --exit-when-done and the session is completed.",
        "Exit 1 when --exit-when-done and the session is blocked.",
        "Exit 130 when --exit-when-done and the session is cancelled, or the follow is cancelled.",
        "Exit 2 on a configuration error.",
      ])}Examples:\n  migent sessions\n  migent sessions <session>\n  migent sessions <session> --follow\n`,
    )
    .action((session: string | undefined, options: OptionValues) =>
      settle(status, () =>
        runSessions(findWorkspace(invocationCwdPath()), session, {
          asJson: options.json === true,
          follow: options.follow === true,
          execution: optionalText(options.execution),
          until: options.until === true,
          cursor: options.cursor === undefined ? undefined : String(options.cursor),
          exitWhenDone: options.exitWhenDone === true,
        }),
      ),
    );

  program
    .command("watch", { hidden: true })
    .description("Follow a session.")
    .argument("<session>", "Session to follow.")
    .option("--execution <execution>", "Limit followed events and --until to this execution.")
    .option("--json", "With --once, print one JSON snapshot. While following, print JSON lines.")
    .option("--cursor <offset>", "Replay events.jsonl from this byte offset. 0 replays the whole log.")
    .option("--once", "Print the snapshot and events cursor, then exit.")
    .option("--until", "Exit when --execution reaches completed, failed, or cancelled.")
    .action((session: string, options: OptionValues) =>
      settle(status, () => {
        deprecate("watch", options.once === true ? "sessions SESSION" : "sessions SESSION --follow");
        const cursor = options.cursor === undefined ? null : Number(options.cursor);
        if (options.cursor !== undefined && (!Number.isInteger(cursor) || (cursor ?? 0) < 0)) {
          throw new ConfigurationError("--cursor must be >= 0.");
        }
        return watchSession(findWorkspace(invocationCwdPath()), session, {
          once: options.once === true,
          executionId: optionalText(options.execution),
          untilTerminal: options.until === true,
          jsonLines: options.json === true,
          cursor,
        });
      }),
    );

  const agent = program
    .command("agent")
    .description("Run one role outside a workflow.")
    .option("--role <role>", "Key under roles in .migent/config.yaml.")
    .option("--session <session>", "Session to continue. Omit to create one.")
    .option("--task <task>", "Label for the new session. Cannot be used with --session.")
    .option("--provider <provider>", "Provider for this role. Pass with --model, or omit both.")
    .option("--model <model>", "Native model id for this role. Pass with --provider, or omit both.")
    .option("--option <pair>", "KEY=VALUE overriding one provider option for this turn.", collect, [])
    .option("--prompt <prompt>", "Prompt text.")
    .option("--file <file>", "Read the prompt from this file.")
    .option("--stdin", "Read the prompt from stdin.")
    .option("--json", "Print the result as one JSON object.")
    .usage("[options]")
    .argument("[legacy]")
    .argument("[legacy-session]")
    .addHelpText(
      "after",
      exitText([
        "Exit 0 when the outcome is complete.",
        "Exit 1 when the outcome is not complete.",
        "Exit 2 on a configuration error.",
        "Exit 130 when cancelled.",
      ]),
    )
    .action((legacy: string | undefined, legacySession: string | undefined, options: OptionValues) => {
      if (legacy === "start" || legacy === "continue") {
        return settle(status, () => {
          if (legacy === "start") {
            deprecate("agent start", "agent");
            return runAgent(options, null);
          }
          const session = text(legacySession);
          deprecate("agent continue", "agent --session SESSION");
          if (session === null) {
            printError("Pass a session.");
            return 2;
          }
          return runAgent(options, session);
        });
      }
      if (legacy !== undefined) {
        agent.error(`error: unknown command '${legacy}'`, { code: "commander.unknownCommand" });
      }
      if (!agentInvoked(options)) {
        agent.outputHelp();
        status.handled = true;
        status.code = 2;
        return;
      }
      return settle(status, () => runAgent(options, optionalText(options.session)));
    });

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

function addDispatchOptions(command: Command, onceDescription: string): void {
  command
    .option("--once", onceDescription)
    .option("--prior <session>", PRIOR_HELP)
    .option("--attempts <count>", "Failed executions allowed for one stage. Default: 3.")
    .option(
      "--max-dispatches <count>",
      `Stage dispatches allowed in this command. Default: ${DEFAULT_MAX_DISPATCHES}. Pass --unlimited-dispatches to remove the ceiling.`,
    )
    .option("--unlimited-dispatches", "Remove the dispatch ceiling for this command.");
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

function agentInvoked(options: OptionValues): boolean {
  return (
    options.role !== undefined ||
    options.session !== undefined ||
    options.task !== undefined ||
    options.provider !== undefined ||
    options.model !== undefined ||
    stringList(options.option).length > 0 ||
    options.prompt !== undefined ||
    options.file !== undefined ||
    options.stdin === true ||
    options.json === true
  );
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
  if (options.once !== true) return false;
  if (options.attempts !== undefined) {
    printError("--once cannot be combined with --attempts.");
    return true;
  }
  if (options.maxDispatches !== undefined) {
    printError("--once cannot be combined with --max-dispatches.");
    return true;
  }
  if (options.unlimitedDispatches === true) {
    printError("--once cannot be combined with --unlimited-dispatches.");
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

function attemptsOf(options: OptionValues): number {
  const raw = optionalText(options.attempts);
  if (raw === null) return 3;
  return integerFlag(raw, "--attempts");
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

function deprecate(oldName: string, replacement: string): void {
  process.stderr.write(`'${oldName}' is deprecated; use '${replacement}'.\n`);
}
