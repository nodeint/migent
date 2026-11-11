import { readFileSync } from 'node:fs';

import { DEFAULT_MAX_DISPATCHES } from '@nodeint/migent-engine';
import { noInputRequested } from '@nodeint/migent-kernel';
import { Command, Option, type OptionValues } from 'commander';

import { CLIENT_MAPPING, continueRoleSession, isAgentSession, runAgent } from './commands/agent.js';
import { type AuthoringKind, type AuthoringMode,runAuthoring } from './commands/authoring.js';
import { removedConfigCommand, runConfigShow } from './commands/config.js';
import { runDoctor } from './commands/doctor.js';
import { dispatchCeiling, executeWorkflow, rejectOnce, runWorkflowCommand } from './commands/execute.js';
import { getHelpTypes, runGet } from './commands/get.js';
import { runInit } from './commands/init.js';
import { prepareWorkflowSession } from './commands/prepare.js';
import { parsePort, runServiceStart, runServiceStatus, runServiceStop } from './commands/service.js';
import { registerSessionLifecycleCommands, registerSessionQueryCommands } from './commands/sessions.js';
import { installSkill, printSkillPath, type SkillOptions,updateSkill } from './commands/skill.js';
import { runUpdate } from './commands/update.js';
import { runRegister, runRemove, runWorkspaceList } from './commands/workspace-registry.js';
import { printError } from './display.js';
import { exitText, LOOP_EXITS, PREFLIGHT_EXIT, ROLE_EXITS, STAGE_EXITS } from './exits.js';
import { runMigrate } from './migrate.js';
import { collect, optionalText, rawText, stringList } from './text.js';
import { PACKAGE_VERSION } from './version.js';
import { findWorkspace, invocationCwdPath } from './workspace.js';

const PRIOR_HELP =
  'Completed session whose outputs provide context. A matching downstream suggestion supplies the task and named artifacts.';
const PROGRESS_HELP =
  'Print each tool call when it finishes. The default prints one line when a stage starts and one when it finishes.';
const VERBOSE_HELP =
  'Accepted for compatibility. Stage lines already include the attempt and the time. The response stays in the execution directory.';
const PROVIDER_LIST_REMOVED =
  'provider list has been removed. Use `migent get clients`, `migent get models`, `migent get options`, or `migent get efforts`.';

export interface CliStatus {
  code: number;
  handled: boolean;
}

export function createProgram(status: CliStatus, options: { quietErrors?: boolean } = {}): Command {
  const program = new Command();
  // Authoring commands with --json report usage errors as an envelope, so Commander stays silent.
  if (options.quietErrors === true) program.configureOutput({ writeErr: () => undefined });
  program
    .name('migent')
    .description('Run named workflows and standalone roles from .migent/.')
    .version(PACKAGE_VERSION, '-V, --version', 'Print the Migent version.')
    .exitOverride();

  registerSessionCommand(program, status);
  registerProjectCommands(program, status);
  registerSkillCommands(program, status);
  registerServiceCommands(program, status);
  registerWorkspaceCommands(program, status);

  program.allowExcessArguments();
  program.action(() => {
    const [unknown] = program.args;
    if (unknown) {
      program.error(`error: unknown command '${unknown}'`, { code: 'commander.unknownCommand' });
    }
    program.outputHelp();
    status.handled = true;
    status.code = 2;
  });
  return program;
}

/** init and config, then config drafts, workflow drafts, and the lookup commands. */
function registerProjectCommands(program: Command, status: CliStatus): void {
  registerInitCommand(program, status);

  const config = program
    .command('config')
    .description('Print the effective config: .migent/config.yaml with .migent/config.local.yaml merged over it.')
    .option('--json', "Print one JSON object with the merged config and the local file's agent names.");
  config.action((options: OptionValues) =>
    settle(status, () => runConfigShow(findWorkspace(invocationCwdPath()), { asJson: options.json === true })),
  );
  registerAuthoringCommands(program, status, config);

  program
    .command('get [type] [name]')
    .description("Look up workflows, roles, agents, the effective config, and this machine's clients, models, options, and efforts (read-only).")
    .option('-o, --output <format>', 'Output format: json, yaml, or name. Default is a table or YAML.')
    .option('--json', 'Same as -o json.')
    .option('--session <id>', 'For workflows: the workflow this session runs (draft, frozen, or live).')
    .option('--client <id>', 'For models, options, and efforts: limit to one CLI client.')
    .option('--native', "For options: list the CLI's native headless options discovered from its help.")
    .addHelpText(
      'after',
      `
Types:
${getHelpTypes()}
Models, options, and efforts are keyed by CLI client. Without --client, a name both clients
use is ambiguous and exits 2; pass --client to choose one.
${exitText(['Exit 0 on success, including an empty list.', 'Exit 2 on a usage or configuration error, or when the name is not found.'])}Examples:
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
    .command('doctor')
    .description("Check config, workflows, and client CLIs, or one session's workflow.")
    .option('--json', 'Print the checks as one JSON object.')
    .option('--session <id>', 'Check only the workflow this session runs: its draft, frozen copy, or live source. Read-only.')
    .addHelpText(
      'after',
      `
Examples:
  migent doctor
  migent doctor --session <id>    Validate an edited prepared workflow before \`session run\`.
  migent doctor --session <id> --json
${exitText([
        'Exit 0 when every check passes.',
        'Exit 1 when a check fails, including an unknown session, a role session, or a broken workflow.',
        'Exit 2 for an invalid session id or an outdated schema.',
      ])}`,
    )
    .action((options: OptionValues) =>
      settle(status, () =>
        runDoctor(findWorkspace(invocationCwdPath()), {
          asJson: options.json === true,
          ...(typeof options.session === 'string' ? { session: options.session } : {}),
        })),
    );

  program
    .command('update')
    .description('Update Migent to the latest published version.')
    .option('--check', 'Only report whether an update is available.')
    .option('--dry-run', 'Same as --check.')
    .option('--json', 'Print the result as one JSON object.')
    .addHelpText('after', exitText(['Exit 0 when up to date, when only checking, or after a successful update.', 'Exit 1 when the registry or the upgrade command fails.']))
    .action((options: OptionValues) =>
      settle(status, () =>
        runUpdate({ check: options.check === true || options.dryRun === true, asJson: options.json === true }),
      ),
    );

  // Removed in favour of per-type `get` commands. Hidden so it no longer appears in help.
  const provider = program.command('provider', { hidden: true });
  provider
    .command('list', { hidden: true })
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
    .command('migrate')
    .description('Upgrade config and workflows to the current schema version.')
    .option('-y, --yes', 'Upgrade without asking. Use this when no terminal is available.')
    .action((options: OptionValues) =>
      settle(status, () => runMigrate(findWorkspace(invocationCwdPath()), { assumeYes: options.yes === true })),
    );
}

/** The init command. */
function registerInitCommand(program: Command, status: CliStatus): void {
  const init = program
    .command('init')
    .description('Set up planner, reviewer, and developer models with implement and plan workflows.')
    .option('--planner-client <client>', 'Planner CLI client. Pass with --planner-model.')
    .option('--planner-model <model>', 'Planner model ID. Pass with --planner-client.')
    .option('--planner-effort <effort>', 'Planner model effort.')
    .option('--planner-option <pair>', 'Planner model option, KEY=VALUE.', collect, [])
    .option('--reviewer-client <client>', 'Reviewer CLI client. Pass with --reviewer-model.')
    .option('--reviewer-model <model>', 'Reviewer model ID. Pass with --reviewer-client.')
    .option('--reviewer-effort <effort>', 'Reviewer model effort.')
    .option('--reviewer-option <pair>', 'Reviewer model option, KEY=VALUE.', collect, [])
    .option('--developer-client <client>', 'Developer CLI client. Pass with --developer-model.')
    .option('--developer-model <model>', 'Developer model ID. Pass with --developer-client.')
    .option('--developer-effort <effort>', 'Developer model effort.')
    .option('--developer-option <pair>', 'Developer model option, KEY=VALUE.', collect, [])
    .option('--client <client>', 'Alias for --developer-client.')
    .option('--model <model>', 'Alias for --developer-model.')
    .option('--effort <effort>', 'Alias for --developer-effort.')
    .option('--option <pair>', 'Alias for --developer-option, KEY=VALUE.', collect, [])
    .addOption(new Option('--planner-provider <provider>').hideHelp())
    .addOption(new Option('--reviewer-provider <provider>').hideHelp())
    .addOption(new Option('--developer-provider <provider>').hideHelp())
    .addOption(new Option('--provider <provider>').hideHelp())
    .addOption(new Option('--skill').hideHelp())
    .option('--no-input', 'Do not prompt. Same as MIGENT_NO_INPUT=1.');
  init.action((options: OptionValues) =>
    settle(status, () => {
      if (options.skill === true) {
        printError('init --skill has been removed. Run `migent init`, then `migent skill install --project`.');
        return 2;
      }
      for (const [legacy, replacement] of [
        ['plannerProvider', '--planner-client'],
        ['reviewerProvider', '--reviewer-client'],
        ['developerProvider', '--developer-client'],
        ['provider', '--client'],
      ] as const) {
        if (options[legacy] !== undefined) {
          const flag = `--${legacy.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
          printError(`${flag} has been removed; use ${replacement} <id> (${CLIENT_MAPPING}).`);
          return 2;
        }
      }
      for (const [name, legacy] of [['developerClient', 'client'], ['developerModel', 'model'], ['developerEffort', 'effort']] as const) {
        if (options[name] !== undefined && options[legacy] !== undefined) {
          printError(`Use only one of --${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} and --${legacy}.`);
          return 2;
        }
      }
      const client = optionalText(options.developerClient ?? options.client);
      const model = optionalText(options.developerModel ?? options.model);
      const interactive = !inputDisabled(options) && Boolean(process.stdin.isTTY);
      return runInit(invocationCwdPath(), {
        client,
        model,
        effort: optionalText(options.developerEffort ?? options.effort),
        options: [...stringList(options.developerOption), ...stringList(options.option)],
        plannerClient: optionalText(options.plannerClient),
        plannerModel: optionalText(options.plannerModel),
        plannerEffort: optionalText(options.plannerEffort),
        plannerOptions: stringList(options.plannerOption),
        reviewerClient: optionalText(options.reviewerClient),
        reviewerModel: optionalText(options.reviewerModel),
        reviewerEffort: optionalText(options.reviewerEffort),
        reviewerOptions: stringList(options.reviewerOption),
        interactive,
      });
    }),
  );
}

/** Config and workflow draft commands, and the removed config subcommands. */
function registerAuthoringCommands(program: Command, status: CliStatus, config: Command): void {
  const authoring = (parent: Command, kind: AuthoringKind, mode: AuthoringMode, summary: string): void => {
    const sub = parent
      .command(`${mode} <draft>`)
      .description(summary)
      .option('--format <format>', 'Draft format: yaml or json. Required for stdin (`-`).')
      .option('--json', 'Print one JSON envelope with the diagnostics.');
    if (kind === 'config') sub.option('--scope <scope>', 'Layer the draft replaces: project or local.', 'project');
    if (kind === 'workflow') {
      sub.option('--target <file>', 'Workflow file name under .migent/workflows/ (default <id>.yaml).');
      sub.option('--session <id>', 'Use the editable workflow draft of an existing session (.migent/sessions/<id>/workflow.yaml) instead of a project workflow. Excludes --target. Save only updates the draft; a prepared session adopts it at start, a started session after `session continue --refresh-workflow`.');
    }
    if (mode !== 'validate') sub.option('--preserve-comments', "Keep the target's comments, key order and line endings.");
    if (mode === 'save') sub.option('--base-hash <sha256>', 'SHA-256 of the file being replaced. Without it, save only creates a new file.');
    sub.action((draft: string, _local: OptionValues, self: Command) => {
      // `config --json` is also declared on the parent, which consumes the flag first.
      const options = self.optsWithGlobals();
      return settle(status, () =>
        runAuthoring({
          kind,
          mode,
          draft,
          ...(typeof options.scope === 'string' ? { scope: options.scope } : {}),
          ...(typeof options.format === 'string' ? { format: options.format } : {}),
          ...(typeof options.target === 'string' ? { target: options.target } : {}),
          ...(typeof options.session === 'string' ? { session: options.session } : {}),
          ...(typeof options.baseHash === 'string' ? { baseHash: options.baseHash } : {}),
          preserveComments: options.preserveComments === true,
          asJson: options.json === true,
        }),
      );
    });
  };
  const modeVerbs = { validate: 'Validate', render: 'Print canonical YAML for', save: 'Validate and save' } as const;
  for (const mode of ['validate', 'render', 'save'] as const) {
    authoring(config, 'config', mode, `${modeVerbs[mode]} a config draft (a file, or - for stdin).`);
  }
  const workflow = program.command('workflow').description('Validate, render, or save workflow drafts.');
  for (const mode of ['validate', 'render', 'save'] as const) {
    authoring(workflow, 'workflow', mode, `${modeVerbs[mode]} a workflow draft (a file, or - for stdin).`);
  }
  for (const removed of ['show', 'model', 'role']) {
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
}

function registerSkillCommands(program: Command, status: CliStatus): void {
  const skill = program
    .command('skill')
    .description('Install or update the Migent skill with `npx skills` (needs Node 22.20 or newer).');
  const scoped = (command: Command): Command =>
    command
      .option('--project', 'Use the current project.')
      .option('--global', 'Use the home directory, for all projects.')
      .option('--client <ids>', 'Comma-separated clients: claude-code, codex, opencode, agy, grok.')
      .option('-y, --yes', 'Do not ask.')
      .option('--no-input', 'Do not prompt. Same as MIGENT_NO_INPUT=1.');
  const skillOptions = (options: OptionValues): SkillOptions | null => {
    if (options.project === true && options.global === true) {
      printError('Pass only one of --project and --global.');
      return null;
    }
    let workspace = invocationCwdPath();
    try {
      workspace = findWorkspace(workspace);
    } catch {
      // No .migent yet: the skill installs into the current directory.
    }
    let scope: 'global' | 'project' | null = null;
    if (options.global === true) scope = 'global';
    else if (options.project === true) scope = 'project';
    return {
      workspace,
      scope,
      clients: optionalText(options.client)?.split(',') ?? [],
      yes: options.yes === true,
      interactive: !inputDisabled(options) && Boolean(process.stdin.isTTY),
    };
  };
  scoped(skill.command('install').description("Install the Migent skill into the clients' skill directories.")).action(
    (options: OptionValues) => settle(status, () => {
      const resolved = skillOptions(options);
      return resolved === null ? 2 : installSkill(resolved);
    }),
  );
  scoped(skill.command('update').description('Reinstall installed Migent skill copies that differ from the bundled skill.')).action(
    (options: OptionValues) => settle(status, () => {
      const resolved = skillOptions(options);
      return resolved === null ? 2 : updateSkill(resolved);
    }),
  );
  skill
    .command('path')
    .description('Print the directory of the skill bundled with this CLI.')
    .action(() => settle(status, () => printSkillPath()));
  showHelpWhenBare(status, skill);
}

function registerServiceCommands(program: Command, status: CliStatus): void {
  const service = program.command('service').description('Run the local workspace registry service.');
  service
    .command('start')
    .description('Start the registry service, or adopt one that is already running.')
    .option('--port <port>', 'Bind 127.0.0.1 on this port. The default is 47321.')
    .option('--foreground', 'Serve in this process instead of detaching.')
    .action((options: OptionValues) =>
      settle(status, () => {
        const port = options.port === undefined ? null : parsePort(String(options.port));
        return runServiceStart(port, options.foreground === true);
      }),
    );
  service
    .command('stop')
    .description('Stop the registry service when its process identity matches. Stop is idempotent and exits 0 when the service is already absent.')
    .action(() => settle(status, () => runServiceStop()));
  service
    .command('status')
    .description('Report whether the registry service is running. Status is a query and exits 1 when the service is stopped.')
    .option('--json', 'Print one JSON object.')
    .addHelpText('after', exitText(['Exit 0 when the service is running.', 'Exit 1 when the service is stopped.']))
    .action((options: OptionValues) => settle(status, () => runServiceStatus(options.json === true)));
  showHelpWhenBare(status, service);
}

function registerWorkspaceCommands(program: Command, status: CliStatus): void {
  const workspace = program.command('workspace').description("Register this machine's Migent workspaces.");
  workspace
    .command('register')
    .description('Register the workspace that contains .migent/config.yaml.')
    .option('--path <path>', 'Workspace root or a directory inside it.')
    .option('--name <name>', 'Display name. Defaults to the directory name.')
    .action((options: OptionValues) =>
      settle(status, () => runRegister(optionalText(options.path), optionalText(options.name))),
    );
  workspace
    .command('list')
    .description('List registered workspaces.')
    .option('--json', 'Print one JSON object.')
    .action((options: OptionValues) => settle(status, () => runWorkspaceList(options.json === true)));
  workspace
    .command('remove')
    .description('Remove one registered workspace by id.')
    .argument('<id>', 'Workspace id to remove.')
    .action((id: string) => settle(status, () => runRemove(id)));
  showHelpWhenBare(status, workspace);
}

const RUN_SPLIT = 'Pass --workflow for a workflow run, or --role for an agent run.';

function registerSessionCommand(program: Command, status: CliStatus): void {
  const session = program.command('session').description('Create, run, resume, and inspect sessions.');
  registerSessionRunCommands(session, status);
  registerSessionLifecycleCommands(session, (action) => settle(status, action));
  registerSessionQueryCommands(session, (action) => settle(status, action));
  showHelpWhenBare(status, session);
}

/** run, prepare, and continue. */
function registerSessionRunCommands(session: Command, status: CliStatus): void {
  const run = session
    .command('run')
    .description('Run a workflow (create with --workflow, or start a prepared session with --session), or one role with --role.')
    .option('--workflow <workflow>', 'Workflow id, or a path to a workflow file. Required to create a workflow session. Omit to run one role, or to start a prepared session with --session.')
    .option('--task <task>', 'Workflow: one-line task stored in task.md. Role: label for a new session.')
    .option('--session <session>', 'Workflow: prepared session to start; --workflow is optional. Role: session to continue.');
  addDispatchOptions(run, 'Dispatch the next eligible stage once. Workflow mode only.');
  run
    .option('--skip-preflight', 'Workflow mode: start without the doctor checks that run over the whole workflow first. Use when a check is wrong or the run is urgent.')
    .option('--role <role>', 'Role to run. Omit --workflow.')
    .option('--client <client>', 'CLI client for this role. Pass with --model, or omit both.')
    .option('--model <model>', 'Native model id for this role. Pass with --client, or omit both.')
    .option('--option <pair>', 'KEY=VALUE overriding one client option for this turn.', collect, [])
    .addOption(new Option('--provider <provider>').hideHelp())
    .option('--prompt <prompt>', 'Prompt text for a role run.')
    .option('--file <file>', 'Read the role prompt from this file.')
    .option('--stdin', 'Read the role prompt from stdin.')
    .option('--json', 'Print the role result as one JSON object.')
    .addHelpText(
      'after',
      `Before a workflow run starts (--workflow, or --session on a prepared session), the doctor checks run over every stage. ${PREFLIGHT_EXIT}\nWorkflow run:\n${exitText(LOOP_EXITS)}Workflow run with --once:\n${exitText(STAGE_EXITS)}Role run:\n${exitText(ROLE_EXITS)}Examples:\n  migent session run --workflow plan --task "<one line>"\n  migent session run --session <prepared-session>\n  migent session run --role reviewer --prompt "<prompt>"\n`,
    )
    .action((options: OptionValues) => settle(status, () => runSessionCommand(options)));

  session
    .command('prepare')
    .description('Create a prepared session with task.md and an editable workflow.yaml, then exit. Fill them in, then session run --session <id>.')
    .argument('<title>', 'Session title shown in the list, such as "some task title". The session id is a UUID.')
    .requiredOption('--workflow <workflow>', 'Workflow id, or a path to a workflow file.')
    .option('--prior <session>', PRIOR_HELP)
    .addHelpText(
      'after',
      `${exitText(['Exit 0 when the session is prepared.', 'Exit 2 on a configuration error.'])}Examples:\n  migent session prepare "some task title" --workflow plan\n`,
    )
    .action((id: string, options: OptionValues) =>
      settle(status, () =>
        prepareWorkflowSession(findWorkspace(invocationCwdPath()), id, String(options.workflow), optionalText(options.prior)),
      ),
    );

  const continueCommand = session
    .command('continue')
    .description('Resume a stopped workflow or role session. A workflow session runs until it stops and resets revision counts. --once dispatches one workflow stage and does not reset them.')
    .argument('<session>', 'Session to resume.');
  addDispatchOptions(
    continueCommand,
    'Dispatch the next eligible stage once and do not reset revision counts. Without --once, continue resets them.',
  );
  continueCommand
    .option('--reply <text>', 'Reply for a blocked or cancelled stage, or a pending question. The new execution prompt body is this text.')
    .option('--reply-file <file>', "Read the stage's reply from this file.")
    .addHelpText(
      'after',
      `Workflow session:\n${exitText(LOOP_EXITS)}With --once:\n${exitText(STAGE_EXITS)}Role session:\n${exitText(ROLE_EXITS)}Examples:\n  migent session continue <session>\n  migent session continue <session> --once\n  migent session continue <session> --reply "<reply>"\n  migent session continue <session> --stage plan --reply-file answer.md\n`,
    )
    .action((id: string, options: OptionValues) => settle(status, () => continueSession(id, options)));
}

function runSessionCommand(options: OptionValues): number | Promise<number> {
  if (options.stage !== undefined && optionalText(options.stage) === null) {
    printError('--stage is empty.');
    return 2;
  }
  const workflowProvided = options.workflow !== undefined;
  const workflowId = optionalText(options.workflow);
  if (workflowProvided && workflowId === null) {
    printError('--workflow is empty.');
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
      printError('Pass --workflow and --task, or --session, not both.');
      return 2;
    }
    if (!prepared && task === null && options.prior === undefined) {
      printError('Pass --task.');
      return 2;
    }
    return runWorkflowCommand({
      workflowId,
      task,
      sessionId,
      prepared,
      once: options.once === true,
      options,
      output: outputFlags(options),
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
    options.client !== undefined ||
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

function continueSession(session: string, options: OptionValues): number | Promise<number> {
  if (options.stage !== undefined && optionalText(options.stage) === null) {
    printError('--stage is empty.');
    return 2;
  }
  const workspace = findWorkspace(invocationCwdPath());
  if (isAgentSession(workspace, session)) return continueRoleSession(workspace, session, options, readReply);
  if (rejectOnce(options)) return 2;
  const reply = readReply(options);
  if (reply === 'invalid') return 2;
  const stageId = optionalText(options.stage);
  // With --reply and no --once, --stage only picks the stage that receives the reply; the workflow keeps running.
  if (options.once === true || (stageId !== null && reply === null)) {
    return executeWorkflow(findWorkspace(invocationCwdPath()), {
      action: 'stage',
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
  if (typeof ceiling === 'string') return 2;
  return executeWorkflow(findWorkspace(invocationCwdPath()), {
    action: 'continue',
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

function readReply(options: OptionValues): string | null | 'invalid' {
  const hasReply = options.reply !== undefined;
  const hasFile = options.replyFile !== undefined;
  if (!hasReply && !hasFile) return null;
  if (hasReply && hasFile) {
    printError('Pass only one of --reply or --reply-file.');
    return 'invalid';
  }
  if (hasFile) {
    const file = optionalText(options.replyFile);
    if (file === null) {
      printError('--reply-file is empty.');
      return 'invalid';
    }
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      printError(`Unable to read reply file: ${file} (${reason})`);
      return 'invalid';
    }
    if (text.trim() === '') {
      printError('--reply is empty.');
      return 'invalid';
    }
    return text;
  }
  const reply = rawText(options.reply);
  if (reply === null || reply.trim() === '') {
    printError('--reply is empty.');
    return 'invalid';
  }
  return reply;
}

function addDispatchOptions(command: Command, onceDescription: string): void {
  command
    .option('--once', onceDescription)
    .option('--stage <stage>', 'Dispatch this ready stage once. It does not have to be the first ready stage.')
    .option('--prior <session>', PRIOR_HELP)
    .option(
      '--max-dispatches <count>',
      `Stage dispatches allowed in this command. Default: ${DEFAULT_MAX_DISPATCHES}. Pass --unlimited-dispatches to remove the ceiling.`,
    )
    .option('--unlimited-dispatches', 'Remove the dispatch ceiling for this command.')
    .option('--progress', PROGRESS_HELP)
    .option('--verbose', VERBOSE_HELP)
    .option(
      '--refresh-workflow',
      'Use the current workflow, agents, and role responsibilities for this session. Requires an existing session that has a frozen workflow. A prepared-session start reads its recorded workflow source instead and does not need this flag.',
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

function inputDisabled(options: OptionValues): boolean {
  return options.noInput === true || noInputRequested();
}
