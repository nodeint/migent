import { readFileSync } from "node:fs";
import { Command, Option, type OptionValues } from "commander";
import { ConfigurationError, DEFAULT_MAX_DISPATCHES, requireAgentSession } from "@nodeint/migent-kernel";
import { continueAgent, dispatchAgent } from "./commands/agent.js";
import { runAuthoring, type AuthoringKind, type AuthoringMode } from "./commands/authoring.js";
import { removedConfigCommand, runConfigShow } from "./commands/config.js";
import { getHelpTypes, runGet } from "./commands/get.js";
import { runDoctor } from "./commands/doctor.js";
import { executeWorkflow } from "./commands/execute.js";
import { cancelSession } from "./commands/cancel.js";
import { prepareWorkflowSession } from "./commands/prepare.js";
import { repairWorkflowSession } from "./commands/repair.js";
import { runUpdate } from "./commands/update.js";
import { runInit } from "./commands/init.js";
import { runSessionMetrics, runSessions } from "./commands/sessions.js";
import { parsePort, runServiceStart, runServiceStatus, runServiceStop } from "./commands/service.js";
import { installSkill, printSkillPath, updateSkill, type SkillOptions } from "./commands/skill.js";
import { runRegister, runRemove, runWorkspaceList } from "./commands/workspace-registry.js";
import { printError } from "./display.js";
import { LOOP_EXITS, STAGE_EXITS } from "./exits.js";
import { runMigrate } from "./migrate.js";
import { optionalText, rawText, text } from "./text.js";
import { PACKAGE_VERSION } from "./version.js";
import { findWorkspace, invocationCwdPath } from "./workspace.js";

const PRIOR_HELP =
  "Completed session whose outputs provide context. A matching downstream suggestion supplies the task and named artifacts.";
const PROGRESS_HELP =
  "Print each tool call when it finishes. The default prints one line when a stage starts and one when it finishes.";
const VERBOSE_HELP =
  "Accepted for compatibility. Stage lines already include the attempt and the time. The response stays in the execution directory.";
const PROVIDER_LIST_REMOVED =
  "provider list has been removed. Use `migent get providers`, `migent get clients`, `migent get models`, `migent get options`, or `migent get efforts`.";

export interface CliStatus {
  code: number;
  handled: boolean;
}

export function createProgram(status: CliStatus, options: { quietErrors?: boolean } = {}): Command {
  const program = new Command();
  // Authoring commands with --json report usage errors as an envelope, so Commander stays silent.
  if (options.quietErrors === true) program.configureOutput({ writeErr: () => undefined });
  program
    .name("migent")
    .description("Run named workflows and standalone roles from .migent/.")
    .version(PACKAGE_VERSION, "-V, --version", "Print the Migent version.")
    .exitOverride();

  registerSessionCommand(program, status);

  const init = program
    .command("init")
    .description("Set up planner, reviewer, and developer models with implement and plan workflows.")
    .option("--planner-provider <provider>", "Planner provider. Pass with --planner-model.")
    .option("--planner-model <model>", "Planner model ID. Pass with --planner-provider.")
    .option("--planner-effort <effort>", "Planner model effort.")
    .option("--planner-option <pair>", "Planner model option, KEY=VALUE.", collect, [])
    .option("--reviewer-provider <provider>", "Reviewer provider. Pass with --reviewer-model.")
    .option("--reviewer-model <model>", "Reviewer model ID. Pass with --reviewer-provider.")
    .option("--reviewer-effort <effort>", "Reviewer model effort.")
    .option("--reviewer-option <pair>", "Reviewer model option, KEY=VALUE.", collect, [])
    .option("--developer-provider <provider>", "Developer provider. Pass with --developer-model.")
    .option("--developer-model <model>", "Developer model ID. Pass with --developer-provider.")
    .option("--developer-effort <effort>", "Developer model effort.")
    .option("--developer-option <pair>", "Developer model option, KEY=VALUE.", collect, [])
    .option("--provider <provider>", "Alias for --developer-provider.")
    .option("--model <model>", "Alias for --developer-model.")
    .option("--effort <effort>", "Alias for --developer-effort.")
    .option("--option <pair>", "Alias for --developer-option, KEY=VALUE.", collect, [])
    .addOption(new Option("--skill").hideHelp())
    .option("--no-input", "Do not prompt. Same as MIGENT_NO_INPUT=1.");
  init.action((options: OptionValues) =>
    settle(status, () => {
      if (options.skill === true) {
        printError("init --skill has been removed. Run `migent init`, then `migent skill install --project`.");
        return 2;
      }
      for (const [name, legacy] of [["developerProvider", "provider"], ["developerModel", "model"], ["developerEffort", "effort"]] as const) {
        if (options[name] !== undefined && options[legacy] !== undefined) {
          printError(`Use only one of --${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} and --${legacy}.`);
          return 2;
        }
      }
      const provider = optionalText(options.developerProvider ?? options.provider);
      const model = optionalText(options.developerModel ?? options.model);
      const interactive = !inputDisabled(options) && Boolean(process.stdin.isTTY);
      return runInit(invocationCwdPath(), {
        provider,
        model,
        effort: optionalText(options.developerEffort ?? options.effort),
        options: [...stringList(options.developerOption), ...stringList(options.option)],
        plannerProvider: optionalText(options.plannerProvider),
        plannerModel: optionalText(options.plannerModel),
        plannerEffort: optionalText(options.plannerEffort),
        plannerOptions: stringList(options.plannerOption),
        reviewerProvider: optionalText(options.reviewerProvider),
        reviewerModel: optionalText(options.reviewerModel),
        reviewerEffort: optionalText(options.reviewerEffort),
        reviewerOptions: stringList(options.reviewerOption),
        interactive,
      });
    }),
  );

  const config = program
    .command("config")
    .description("Print the effective config: .migent/config.yaml with .migent/config.local.yaml merged over it.")
    .option("--json", "Print one JSON object with the merged config and the local file's agent names.");
  config.action((options: OptionValues) =>
    settle(status, () => runConfigShow(findWorkspace(invocationCwdPath()), { asJson: options.json === true })),
  );
  const authoring = (parent: Command, kind: AuthoringKind, mode: AuthoringMode, summary: string): void => {
    const sub = parent
      .command(`${mode} <draft>`)
      .description(summary)
      .option("--format <format>", "Draft format: yaml or json. Required for stdin (`-`).")
      .option("--json", "Print one JSON envelope with the diagnostics.");
    if (kind === "config") sub.option("--scope <scope>", "Layer the draft replaces: project or local.", "project");
    if (kind === "workflow") sub.option("--target <file>", "Workflow file name under .migent/workflows/ (default <id>.yaml).");
    if (mode !== "validate") sub.option("--preserve-comments", "Keep the target's comments, key order and line endings.");
    if (mode === "save") sub.option("--base-hash <sha256>", "SHA-256 of the file being replaced. Without it, save only creates a new file.");
    sub.action((draft: string, _local: OptionValues, self: Command) => {
      // `config --json` is also declared on the parent, which consumes the flag first.
      const options = self.optsWithGlobals();
      return settle(status, () =>
        runAuthoring({
          kind,
          mode,
          draft,
          ...(typeof options.scope === "string" ? { scope: options.scope } : {}),
          ...(typeof options.format === "string" ? { format: options.format } : {}),
          ...(typeof options.target === "string" ? { target: options.target } : {}),
          ...(typeof options.baseHash === "string" ? { baseHash: options.baseHash } : {}),
          preserveComments: options.preserveComments === true,
          asJson: options.json === true,
        }),
      );
    });
  };
  for (const mode of ["validate", "render", "save"] as const) {
    authoring(config, "config", mode, `${mode === "validate" ? "Validate" : mode === "render" ? "Print canonical YAML for" : "Validate and save"} a config draft (a file, or - for stdin).`);
  }
  const workflow = program.command("workflow").description("Validate, render, or save workflow drafts.");
  for (const mode of ["validate", "render", "save"] as const) {
    authoring(workflow, "workflow", mode, `${mode === "validate" ? "Validate" : mode === "render" ? "Print canonical YAML for" : "Validate and save"} a workflow draft (a file, or - for stdin).`);
  }
  for (const removed of ["show", "model", "role"]) {
    config
      .command(removed, { hidden: true })
      .allowUnknownOption()
      .allowExcessArguments()
      .helpOption(false)
      .action(() =>
        settle(status, () => {
          printError(removedConfigCommand(removed));
          return 2;
        }),
      );
  }

  program
    .command("get [type] [name]")
    .description("Look up workflows, roles, agents, the effective config, and this machine's providers, clients, models, options, and efforts (read-only).")
    .option("-o, --output <format>", "Output format: json, yaml, or name. Default is a table or YAML.")
    .option("--json", "Same as -o json.")
    .option("--session <id>", "For workflows: the workflow this session runs (draft, frozen, or live).")
    .option("--client <id>", "For models, options, and efforts: limit to one CLI client.")
    .option("--native", "For options: list the CLI's native headless options discovered from its help.")
    .addHelpText(
      "after",
      `
Types:
${getHelpTypes()}
Models, options, and efforts are keyed by CLI client. Without --client, a name both clients
use is ambiguous and exits 2; pass --client to choose one.
${exitText(["Exit 0 on success, including an empty list.", "Exit 2 on a usage or configuration error, or when the name is not found."])}Examples:
  migent get workflows
  migent get workflow plan --json
  migent get workflow --session <id> -o yaml
  migent get roles -o name
  migent get agent <name>
  migent get clients
  migent get models --client claude-code -o json
  migent get options --native --client codex
  migent get effort high --client agy
`,
    )
    .action((type: string | undefined, name: string | undefined, options: OptionValues, command: Command) => {
      if (type === undefined) {
        command.outputHelp();
        status.handled = true;
        status.code = 2;
        return;
      }
      return settle(status, () =>
        runGet(invocationCwdPath(), type, name ?? null, {
          output: optionalText(options.output) ?? undefined,
          json: options.json === true,
          session: optionalText(options.session) ?? undefined,
          client: optionalText(options.client) ?? undefined,
          native: options.native === true,
        }),
      );
    });

  program
    .command("doctor")
    .description("Check config, workflows, and provider CLIs, or one session's workflow.")
    .option("--json", "Print the checks as one JSON object.")
    .option("--session <id>", "Check only the workflow this session runs: its draft, frozen copy, or live source. Read-only.")
    .addHelpText(
      "after",
      `
Examples:
  migent doctor
  migent doctor --session <id>    Validate an edited prepared workflow before \`session run\`.
  migent doctor --session <id> --json
${exitText([
        "Exit 0 when every check passes.",
        "Exit 1 when a check fails, including an unknown session, a role session, or a broken workflow.",
        "Exit 2 for an invalid session id or an outdated schema.",
      ])}`,
    )
    .action((options: OptionValues) =>
      settle(status, () =>
        runDoctor(findWorkspace(invocationCwdPath()), {
          asJson: options.json === true,
          ...(typeof options.session === "string" ? { session: options.session } : {}),
        })),
    );

  program
    .command("update")
    .description("Update Migent to the latest published version.")
    .option("--check", "Only report whether an update is available.")
    .option("--dry-run", "Same as --check.")
    .option("--json", "Print the result as one JSON object.")
    .addHelpText("after", exitText(["Exit 0 when up to date, when only checking, or after a successful update.", "Exit 1 when the registry or the upgrade command fails."]))
    .action((options: OptionValues) =>
      settle(status, () =>
        runUpdate({ check: options.check === true || options.dryRun === true, asJson: options.json === true }),
      ),
    );

  // Removed in favour of per-type `get` commands. Hidden so it no longer appears in help.
  const provider = program.command("provider", { hidden: true });
  provider
    .command("list", { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false)
    .action(() => settle(status, () => {
      printError(PROVIDER_LIST_REMOVED);
      return 2;
    }));
  provider.action(() => settle(status, () => {
    printError(PROVIDER_LIST_REMOVED);
    return 2;
  }));

  program
    .command("migrate")
    .description("Upgrade config and workflows to the current schema version.")
    .option("-y, --yes", "Upgrade without asking. Use this when no terminal is available.")
    .action((options: OptionValues) =>
      settle(status, () => runMigrate(findWorkspace(invocationCwdPath()), { assumeYes: options.yes === true })),
    );

  const skill = program
    .command("skill")
    .description("Install or update the Migent skill with `npx skills` (needs Node 22.20 or newer).");
  const scoped = (command: Command): Command =>
    command
      .option("--project", "Use the current project.")
      .option("--global", "Use the home directory, for all projects.")
      .option("--client <ids>", "Comma-separated clients: claude-code, codex, opencode, agy, grok.")
      .option("-y, --yes", "Do not ask.")
      .option("--no-input", "Do not prompt. Same as MIGENT_NO_INPUT=1.");
  const skillOptions = (options: OptionValues): SkillOptions | null => {
    if (options.project === true && options.global === true) {
      printError("Pass only one of --project and --global.");
      return null;
    }
    let workspace = invocationCwdPath();
    try {
      workspace = findWorkspace(workspace);
    } catch {
      // No .migent yet: the skill installs into the current directory.
    }
    return {
      workspace,
      scope: options.global === true ? "global" : options.project === true ? "project" : null,
      clients: optionalText(options.client)?.split(",") ?? [],
      yes: options.yes === true,
      interactive: !inputDisabled(options) && Boolean(process.stdin.isTTY),
    };
  };
  scoped(skill.command("install").description("Install the Migent skill into the clients' skill directories.")).action(
    (options: OptionValues) => settle(status, () => {
      const resolved = skillOptions(options);
      return resolved === null ? 2 : installSkill(resolved);
    }),
  );
  scoped(skill.command("update").description("Reinstall installed Migent skill copies that differ from the bundled skill.")).action(
    (options: OptionValues) => settle(status, () => {
      const resolved = skillOptions(options);
      return resolved === null ? 2 : updateSkill(resolved);
    }),
  );
  skill
    .command("path")
    .description("Print the directory of the skill bundled with this CLI.")
    .action(() => settle(status, () => printSkillPath()));
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

const PREFLIGHT_EXIT = "Exit 2 when the preflight check finds a problem. Nothing is created or frozen. Pass --skip-preflight to bypass it.";

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
    .description("Run a workflow (create with --workflow, or start a prepared session with --session), or one role with --role.")
    .option("--workflow <workflow>", "Workflow id, or a path to a workflow file. Required to create a workflow session. Omit to run one role, or to start a prepared session with --session.")
    .option("--task <task>", "Workflow: one-line task stored in task.md. Role: label for a new session.")
    .option("--session <session>", "Workflow: prepared session to start; --workflow is optional. Role: session to continue.");
  addDispatchOptions(run, "Dispatch the next eligible stage once. Workflow mode only.");
  run
    .option("--skip-preflight", "Workflow mode: start without the doctor checks that run over the whole workflow first. Use when a check is wrong or the run is urgent.")
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
      `Before a workflow run starts (--workflow, or --session on a prepared session), the doctor checks run over every stage. ${PREFLIGHT_EXIT}\nWorkflow run:\n${exitText(LOOP_EXITS)}Workflow run with --once:\n${exitText(STAGE_EXITS)}Role run:\n${exitText(ROLE_EXITS)}Examples:\n  migent session run --workflow plan --task "<one line>"\n  migent session run --session <prepared-session>\n  migent session run --role reviewer --prompt "<prompt>"\n`,
    )
    .action((options: OptionValues) => settle(status, () => runSessionCommand(options)));

  session
    .command("prepare")
    .description("Create a prepared session with task.md and an editable workflow.yaml, then exit. Fill them in, then session run --session <id>.")
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
    .option("--reply <text>", "Reply for a blocked or cancelled stage, or a pending question. The new execution prompt body is this text.")
    .option("--reply-file <file>", "Read the stage's reply from this file.")
    .addHelpText(
      "after",
      `Workflow session:\n${exitText(LOOP_EXITS)}With --once:\n${exitText(STAGE_EXITS)}Role session:\n${exitText(ROLE_EXITS)}Examples:\n  migent session continue <session>\n  migent session continue <session> --once\n  migent session continue <session> --reply "<reply>"\n  migent session continue <session> --stage plan --reply-file answer.md\n`,
    )
    .action((id: string, options: OptionValues) => settle(status, () => continueSession(id, options)));

  session
    .command("cancel")
    .description("Ask the process running a session to stop. Works on Windows, where signals cannot reach it.")
    .argument("<session>", "Session to cancel.")
    .option("--wait <seconds>", "Seconds to wait for the process to stop.", "15")
    .option("--json", "Print {session_id, cancelled, status}.")
    .addHelpText(
      "after",
      `${exitText([
        "Exit 0 when the session stopped.",
        "Exit 1 when the cancel was requested but the process is still running after --wait.",
        "Exit 2 when the session does not exist, is not running, or runs on another machine.",
      ])}Examples:\n  migent session cancel <session>\n  migent session cancel <session> --wait 60 --json\n`,
    )
    .action((id: string, options: OptionValues) =>
      settle(status, () => {
        const wait = Number(options.wait);
        if (!Number.isFinite(wait) || wait < 0) {
          printError("--wait must be a number of seconds, 0 or more.");
          return 2;
        }
        return cancelSession(findWorkspace(invocationCwdPath()), id, { waitSeconds: wait, asJson: options.json === true });
      }),
    );

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
    .option("--status <status>", "List sessions with this status: active, prepared, completed, blocked, question, cancelled, or corrupt.")
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
    .option("--exit-when-done", "Exit when the session is completed (0), blocked (1), waiting for a reply (9), or cancelled (130).")
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
  const sessionId = optionalText(options.session);
  const roleMode = roleFlagsPresent(options);
  const workflowMode = workflowFlagsPresent(options);
  if ((workflowId !== null && roleMode) || (workflowId === null && workflowMode && (roleMode || sessionId === null))) {
    printError(RUN_SPLIT);
    return 2;
  }
  // A session without role flags is a prepared workflow session; it records its own workflow.
  if (workflowId !== null || (sessionId !== null && !roleMode)) {
    const task = rawText(options.task);
    const prepared = sessionId !== null;
    if (prepared && task !== null) {
      printError("Pass --workflow and --task, or --session, not both.");
      return 2;
    }
    if (!prepared && task === null && options.prior === undefined) {
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
    options.refreshWorkflow === true ||
    options.skipPreflight === true
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
      skipPreflight: args.options.skipPreflight === true,
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
    skipPreflight: args.options.skipPreflight === true,
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
  // With --reply and no --once, --stage only picks the stage that receives the reply; the workflow keeps running.
  if (options.once === true || (stageId !== null && reply === null)) {
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
    replyStageId: stageId,
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
      "Use the current workflow, agents, and role responsibilities for this session. Requires an existing session that has a frozen workflow. A prepared-session start reads its recorded workflow source instead and does not need this flag.",
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
