import { createRequire } from "node:module";
import { Command, type OptionValues } from "commander";
import { ConfigurationError, DEFAULT_MAX_DISPATCHES } from "@nodeint/migent-kernel";
import { dispatchAgent } from "./commands/agent.js";
import { runConfigModel, runConfigRole, runConfigShow } from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
import { executeWorkflow } from "./commands/execute.js";
import { runInit } from "./commands/init.js";
import { listSessions } from "./commands/sessions.js";
import { parsePort, runServiceStart, runServiceStatus, runServiceStop } from "./commands/service.js";
import { installSkill, updateSkill } from "./commands/skill.js";
import { watchSession } from "./commands/watch.js";
import { runRegister, runRemove, runWorkspaceList } from "./commands/workspace-registry.js";
import { printError } from "./display.js";
import { runMigrate } from "./migrate.js";
import { findWorkspace, invocationCwdPath } from "./workspace.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const START_EXITS = [
  "Exit 0 when the session is completed.",
  "Exit 1 when the session is blocked.",
  "Exit 2 on a configuration error.",
  "Exit 3 when --attempts is spent. The session stays active.",
  "Exit 4 when a route would exceed max_revisions. The session stays active.",
  "Exit 5 when --max-dispatches is spent. The session stays active.",
  "Exit 130 when cancelled.",
];

const CONTINUE_EXITS = [
  "Exit 0 when the session is completed.",
  "Exit 1 when the session is blocked.",
  "Exit 2 on a configuration error.",
  "Exit 3 when --attempts is spent. The session stays active.",
  "Exit 4 when a route would exceed max_revisions. The session stays active.",
  "Exit 5 when --max-dispatches is spent. The session stays active.",
  "Exit 130 when cancelled.",
];

const STAGE_EXITS = [
  "Exit 0 when the stage outcome is complete, or the session is already completed.",
  "Exit 1 when the stage is not complete, or the session is blocked.",
  "Exit 2 on a configuration error.",
  "Exit 4 when a route would exceed max_revisions. The session stays active.",
  "Exit 130 when cancelled.",
];

export interface CliStatus {
  code: number;
  handled: boolean;
}

export function createProgram(status: CliStatus): Command {
  const program = new Command();
  program
    .name("migent")
    .description("Run named workflows and standalone roles from .migent/.")
    .version(version, "-V, --version", "Print the Migent version.")
    .exitOverride();

  const start = program
    .command("start")
    .description("Create a session and continue until it stops.")
    .argument("<workflow>", "Workflow id, or a path to a workflow file.")
    .requiredOption("--task <task>", "Task recorded on the new session.");
  addDispatchOptions(start);
  start.addHelpText("after", exitText(START_EXITS)).action((workflow: string, options: OptionValues) =>
    settle(status, () => {
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
    .description("Resume a session until it stops.")
    .argument("<session>", "Session to resume.");
  addDispatchOptions(continueCommand);
  continueCommand.addHelpText("after", exitText(CONTINUE_EXITS)).action((session: string, options: OptionValues) =>
    settle(status, () => {
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
    .command("stage")
    .description("Advance one stage. Dispatch the next eligible stage once.")
    .argument("[session]", "Session to advance. Omit when passing --workflow.")
    .option("--workflow <workflow>", "Workflow id or path. Creates a session and dispatches its next stage once.")
    .option("--task <task>", "Task recorded on the new session. Required with --workflow.")
    .option("--prior <session>", "Completed session whose workflow and decision match requires.")
    .addHelpText("after", exitText(STAGE_EXITS))
    .action((session: string | undefined, options: OptionValues) =>
      settle(status, () => {
        const sessionId = text(session);
        const workflow = optionalText(options.workflow);
        const task = optionalText(options.task);
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

  program
    .command("init")
    .description("Create a minimal config, one workflow, and a sessions gitignore.")
    .option("--provider <provider>", "Provider for the default model. Pass with --model.")
    .option("--model <model>", "Model id for the default model. Pass with --provider.")
    .option("--option <pair>", "KEY=VALUE stored under models.*.options.", collect, [])
    .option("--preset <preset>", "Workflow to create: implement or plan. Default: implement.", "implement")
    .action((options: OptionValues) =>
      settle(status, () => {
        const provider = optionalText(options.provider);
        const model = optionalText(options.model);
        const interactive = provider === null && Boolean(process.stdin.isTTY);
        return runInit(invocationCwdPath(), {
          provider,
          model,
          options: stringList(options.option),
          preset: typeof options.preset === "string" ? options.preset : "implement",
          interactive,
        });
      }),
    );

  const config = program.command("config").description("Update models and roles in .migent/config.yaml.");
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
    .action((name: string | undefined, options: OptionValues) =>
      settle(status, () => {
        const provider = optionalText(options.provider);
        const model = optionalText(options.model);
        const optionValues = stringList(options.option);
        const clearOptions = stringList(options.clearOption);
        const mutating = provider !== null || model !== null || optionValues.length > 0 || clearOptions.length > 0;
        const interactive = Boolean(process.stdin.isTTY) && options.json !== true && !mutating;
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
    .option("--model-name <name>", "Point the roles at this model.")
    .option("--provider <provider>", "Provider for this role only. Pass with --model.")
    .option("--model <model>", "Model id for this role only. Pass with --provider.")
    .option("--option <pair>", "KEY=VALUE stored under this role's options.", collect, [])
    .option("--clear-option <key>", "Remove one key from this role's options.", collect, [])
    .option("--json", "Print one JSON object.")
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
        const interactive = Boolean(process.stdin.isTTY) && options.json !== true && !mutating;
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
  showHelpWhenBare(status, config);

  program
    .command("doctor")
    .description("Check config, workflows, and provider CLIs.")
    .option("--json", "Print the checks as one JSON object.")
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
    .description("List sessions and their latest status.")
    .option("--json", "Print the same rows as a JSON array.")
    .action((options: OptionValues) =>
      settle(status, () => listSessions(findWorkspace(invocationCwdPath()), { asJson: options.json === true })),
    );

  program
    .command("watch")
    .description("Follow a session.")
    .argument("<session>", "Session to follow.")
    .option("--execution <execution>", "Limit followed events and --until to this execution.")
    .option("--json", "With --once, print one JSON snapshot. While following, print JSON lines.")
    .option("--cursor <offset>", "Replay events.jsonl from this byte offset. 0 replays the whole log.")
    .option("--once", "Print the snapshot and events cursor, then exit.")
    .option("--until", "Exit when --execution reaches completed, failed, or cancelled.")
    .action((session: string, options: OptionValues) =>
      settle(status, () => {
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

  const agent = program.command("agent").description("Run one role outside a workflow.");
  const agentStart = agent.command("start").description("Create a session and dispatch one turn.");
  addAgentOptions(agentStart);
  agentStart.action((options: OptionValues) => settle(status, () => runAgent(options, null)));
  const agentContinue = agent
    .command("continue")
    .description("Append a turn to a session.")
    .argument("<session>", "Session to continue.");
  addAgentOptions(agentContinue);
  agentContinue.action((session: string, options: OptionValues) => settle(status, () => runAgent(options, session)));
  showHelpWhenBare(status, agent);

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
    .description("Stop the registry service when its process identity matches.")
    .action(() => settle(status, () => runServiceStop()));
  service
    .command("status")
    .description("Report whether the registry service is running.")
    .option("--json", "Print one JSON object.")
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

function addDispatchOptions(command: Command): void {
  command
    .option("--prior <session>", "Completed session whose workflow and decision match requires.")
    .option("--attempts <count>", "Failed executions allowed for one stage. Default: 3.")
    .option(
      "--max-dispatches <count>",
      `Stage dispatches allowed in this command. Default: ${DEFAULT_MAX_DISPATCHES}. Pass --unlimited-dispatches to remove the ceiling.`,
    )
    .option("--unlimited-dispatches", "Remove the dispatch ceiling for this command.");
}

function addAgentOptions(command: Command): void {
  command
    .requiredOption("--role <role>", "Key under roles in .migent/config.yaml.")
    .option("--task <task>", "Label stored on the new session. Defaults to the role key.")
    .option("--provider <provider>", "Provider for this role. Pass with --model, or omit both.")
    .option("--model <model>", "Native model id for this role. Pass with --provider, or omit both.")
    .option("--option <pair>", "KEY=VALUE overriding one provider option for this turn.", collect, [])
    .option("--prompt <prompt>", "Prompt text.")
    .option("--file <file>", "Read the prompt from this file.")
    .option("--stdin", "Read the prompt from stdin.")
    .option("--json", "Print the result as one JSON object.");
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
    role: String(options.role),
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

function optionalText(value: unknown): string | null {
  return text(typeof value === "string" ? value : null);
}

function text(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const stripped = value.trim();
  return stripped === "" ? null : stripped;
}
