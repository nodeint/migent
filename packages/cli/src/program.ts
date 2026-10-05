import { defineCommand, type ArgsDef, type CommandDef } from "citty";
import { ConfigurationError, DEFAULT_MAX_DISPATCHES } from "@migent/kernel";
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
import { repeated } from "./provider.js";
import { findWorkspace, invocationCwdPath } from "./workspace.js";

const START_HELP = [
  "Create a session and continue until it stops.",
  "Exit 0 when the session is completed.",
  "Exit 1 when the session is blocked.",
  "Exit 2 on a configuration error.",
  "Exit 3 when --attempts is spent. The session stays active.",
  "Exit 4 when a route would exceed max_revisions. The session stays active.",
  "Exit 5 when --max-dispatches is spent. The session stays active.",
  "Exit 130 when cancelled.",
].join(" ");

const CONTINUE_HELP = [
  "Resume a session until it stops.",
  "Exit 0 when the session is completed.",
  "Exit 1 when the session is blocked.",
  "Exit 2 on a configuration error.",
  "Exit 3 when --attempts is spent. The session stays active.",
  "Exit 4 when a route would exceed max_revisions. The session stays active.",
  "Exit 5 when --max-dispatches is spent. The session stays active.",
  "Exit 130 when cancelled.",
].join(" ");

const STAGE_HELP = [
  "Advance one stage. Dispatch the next eligible stage once.",
  "Exit 0 when the stage outcome is complete, or the session is already completed.",
  "Exit 1 when the stage is not complete, or the session is blocked.",
  "Exit 2 on a configuration error.",
  "Exit 4 when a route would exceed max_revisions. The session stays active.",
  "Exit 130 when cancelled.",
].join(" ");

const dispatchArgs = {
  prior: { type: "string", description: "Completed session whose workflow and decision match requires." },
  attempts: { type: "string", description: "Failed executions allowed for one stage. Default: 3." },
  "max-dispatches": {
    type: "string",
    description: `Stage dispatches allowed in this command. Default: ${DEFAULT_MAX_DISPATCHES}. Pass --unlimited-dispatches to remove the ceiling.`,
  },
  "unlimited-dispatches": { type: "boolean", description: "Remove the dispatch ceiling for this command." },
} as const;

export const root = defineCommand({
  meta: {
    name: "migent",
    description: "Run named workflows and standalone roles from .migent/.",
  },
  subCommands: {
    start: defineCommand({
      meta: { name: "start", description: START_HELP },
      args: {
        workflow: { type: "positional", description: "Workflow id, or a path to a workflow file.", required: true },
        task: { type: "string", description: "Task recorded on the new session.", required: true },
        ...dispatchArgs,
      },
      async run({ args, rawArgs }) {
        const ceiling = dispatchCeiling(args["max-dispatches"], args["unlimited-dispatches"]);
        if (typeof ceiling === "string") return 2;
        return executeWorkflow(findWorkspace(invocationCwdPath()), {
          action: "start",
          workflowId: args.workflow,
          task: args.task,
          priorSessionId: args.prior,
          maxAttempts: attemptsOf(args.attempts),
          maxDispatches: ceiling,
        });
      },
    }),
    continue: defineCommand({
      meta: { name: "continue", description: CONTINUE_HELP },
      args: {
        session: { type: "positional", description: "Session to resume.", required: true },
        ...dispatchArgs,
      },
      async run({ args }) {
        const ceiling = dispatchCeiling(args["max-dispatches"], args["unlimited-dispatches"]);
        if (typeof ceiling === "string") return 2;
        return executeWorkflow(findWorkspace(invocationCwdPath()), {
          action: "continue",
          sessionId: args.session,
          priorSessionId: args.prior,
          maxAttempts: attemptsOf(args.attempts),
          maxDispatches: ceiling,
        });
      },
    }),
    stage: defineCommand({
      meta: { name: "stage", description: STAGE_HELP },
      args: {
        session: { type: "positional", description: "Session to advance. Omit when passing --workflow.", required: false },
        workflow: { type: "string", description: "Workflow id or path. Creates a session and dispatches its next stage once." },
        task: { type: "string", description: "Task recorded on the new session. Required with --workflow." },
        prior: { type: "string", description: "Completed session whose workflow and decision match requires." },
      },
      async run({ args }) {
        const session = text(args.session);
        const workflow = text(args.workflow);
        const task = text(args.task);
        if (session !== null && (workflow !== null || task !== null)) {
          printError("Pass SESSION, or --workflow and --task, not both.");
          return 2;
        }
        if (session === null && (workflow === null || task === null)) {
          printError("Pass SESSION, or both --workflow and --task.");
          return 2;
        }
        return executeWorkflow(findWorkspace(invocationCwdPath()), {
          action: "stage",
          workflowId: workflow,
          task,
          sessionId: session,
          priorSessionId: args.prior,
          maxAttempts: null,
          maxDispatches: null,
        });
      },
    }),
    init: defineCommand({
      meta: { name: "init", description: "Create a minimal config, one workflow, and a sessions gitignore." },
      args: {
        provider: { type: "string", description: "Provider for the default model. Pass with --model." },
        model: { type: "string", description: "Model id for the default model. Pass with --provider." },
        option: { type: "string", description: "KEY=VALUE stored under models.*.options." },
        preset: { type: "string", description: "Workflow to create: implement or plan. Default: implement.", default: "implement" },
      },
      async run({ args, rawArgs }) {
        const provider = text(args.provider);
        const model = text(args.model);
        const options = repeated(rawArgs, "--option");
        const interactive = provider === null && Boolean(process.stdin.isTTY);
        return runInit(invocationCwdPath(), { provider, model, options, preset: args.preset, interactive });
      },
    }),
    config: defineCommand({
      meta: { name: "config", description: "Update models and roles in .migent/config.yaml." },
      subCommands: {
        show: defineCommand({
          meta: { name: "show", description: "Print .migent/config.yaml." },
          run() {
            return runConfigShow(findWorkspace(invocationCwdPath()));
          },
        }),
        model: defineCommand({
          meta: { name: "model", description: "List models, or create and update one model name." },
          args: {
            name: { type: "positional", description: "Name to show or update.", required: false },
            provider: { type: "string", description: "Provider for this name. Pass with --model." },
            model: { type: "string", description: "Model id for this name. Pass with --provider." },
            option: { type: "string", description: "KEY=VALUE stored under this model's options." },
            "clear-option": { type: "string", description: "Remove one key from this model's options." },
            json: { type: "boolean", description: "Print one JSON object." },
          },
          async run({ args, rawArgs }) {
            const provider = text(args.provider);
            const model = text(args.model);
            const options = repeated(rawArgs, "--option");
            const clearOptions = repeated(rawArgs, "--clear-option");
            const mutating = provider !== null || model !== null || options.length > 0 || clearOptions.length > 0;
            const interactive = Boolean(process.stdin.isTTY) && !args.json && !mutating;
            return runConfigModel(findWorkspace(invocationCwdPath()), {
              key: text(args.name),
              provider,
              model,
              options,
              clearOptions,
              asJson: Boolean(args.json),
              interactive,
            });
          },
        }),
        role: defineCommand({
          meta: { name: "role", description: "List roles, or point roles at a model." },
          args: {
            role: { type: "positional", description: "Role to show or update.", required: false },
            "model-name": { type: "string", description: "Point the roles at this model." },
            provider: { type: "string", description: "Provider for this role only. Pass with --model." },
            model: { type: "string", description: "Model id for this role only. Pass with --provider." },
            option: { type: "string", description: "KEY=VALUE stored under this role's options." },
            "clear-option": { type: "string", description: "Remove one key from this role's options." },
            json: { type: "boolean", description: "Print one JSON object." },
          },
          async run({ args, rawArgs }) {
            const roles = [text(args.role), ...rawArgs.filter((arg) => !arg.startsWith("-") && arg !== args.role)].filter(
              (role): role is string => role !== null && role !== args["model-name"] && role !== args.provider && role !== args.model,
            );
            const unique = roles.filter((role, index) => roles.indexOf(role) === index);
            const provider = text(args.provider);
            const model = text(args.model);
            const modelName = text(args["model-name"]);
            const options = repeated(rawArgs, "--option");
            const clearOptions = repeated(rawArgs, "--clear-option");
            const mutating = modelName !== null || provider !== null || model !== null || options.length > 0 || clearOptions.length > 0;
            const interactive = Boolean(process.stdin.isTTY) && !args.json && !mutating;
            return runConfigRole(findWorkspace(invocationCwdPath()), {
              roles: unique,
              modelName,
              provider,
              model,
              options,
              clearOptions,
              asJson: Boolean(args.json),
              interactive,
            });
          },
        }),
      },
    }),
    doctor: defineCommand({
      meta: { name: "doctor", description: "Check config, workflows, and provider CLIs." },
      args: { json: { type: "boolean", description: "Print the checks as one JSON object." } },
      run({ args }) {
        return runDoctor(findWorkspace(invocationCwdPath()), { asJson: Boolean(args.json) });
      },
    }),
    migrate: defineCommand({
      meta: { name: "migrate", description: "Upgrade config and workflows to the current schema version." },
      args: {
        yes: { type: "boolean", alias: "y", description: "Upgrade without asking. Use this when no terminal is available." },
      },
      run({ args }) {
        return runMigrate(findWorkspace(invocationCwdPath()), { assumeYes: Boolean(args.yes) });
      },
    }),
    sessions: defineCommand({
      meta: { name: "sessions", description: "List sessions and their latest status." },
      args: { json: { type: "boolean", description: "Print the same rows as a JSON array." } },
      run({ args }) {
        return listSessions(findWorkspace(invocationCwdPath()), { asJson: Boolean(args.json) });
      },
    }),
    watch: defineCommand({
      meta: { name: "watch", description: "Follow a session." },
      args: {
        session: { type: "positional", description: "Session to follow.", required: true },
        execution: { type: "string", description: "Limit followed events and --until to this execution." },
        json: { type: "boolean", description: "With --once, print one JSON snapshot. While following, print JSON lines." },
        cursor: { type: "string", description: "Replay events.jsonl from this byte offset. 0 replays the whole log." },
        once: { type: "boolean", description: "Print the snapshot and events cursor, then exit." },
        until: { type: "boolean", description: "Exit when --execution reaches completed, failed, or cancelled." },
      },
      run({ args }) {
        const cursor = args.cursor === undefined ? null : Number(args.cursor);
        if (args.cursor !== undefined && (!Number.isInteger(cursor) || (cursor ?? 0) < 0)) {
          throw new ConfigurationError("--cursor must be >= 0.");
        }
        return watchSession(findWorkspace(invocationCwdPath()), String(args.session), {
          once: Boolean(args.once),
          executionId: text(args.execution),
          untilTerminal: Boolean(args.until),
          jsonLines: Boolean(args.json),
          cursor,
        });
      },
    }),
    agent: defineCommand({
      meta: { name: "agent", description: "Run one role outside a workflow." },
      subCommands: {
        start: defineCommand({
          meta: { name: "start", description: "Create a session and dispatch one turn." },
          args: agentArgs(false),
          async run(context) {
            return runAgent(context.rawArgs, context.args, null);
          },
        }),
        continue: defineCommand({
          meta: { name: "continue", description: "Append a turn to a session." },
          args: agentArgs(true),
          async run(context) {
            return runAgent(context.rawArgs, context.args, text(context.args.session));
          },
        }),
      },
    }),
    skill: defineCommand({
      meta: { name: "skill", description: "Install or update the Migent skill in this project." },
      subCommands: {
        install: defineCommand({
          meta: { name: "install", description: "Install the Migent skill without replacing an existing directory." },
          run() {
            return installSkill(findWorkspace(invocationCwdPath()));
          },
        }),
        update: defineCommand({
          meta: { name: "update", description: "Update a managed Migent skill to the bundled template." },
          args: { force: { type: "boolean", description: "Replace a locally modified managed skill with the bundled template." } },
          run({ args }) {
            return updateSkill(findWorkspace(invocationCwdPath()), { force: Boolean(args.force) });
          },
        }),
      },
    }),
    service: defineCommand({
      meta: { name: "service", description: "Run the local workspace registry service." },
      subCommands: {
        start: defineCommand({
          meta: {
            name: "start",
            description: "Start the registry service, or adopt one that is already running.",
          },
          args: {
            port: { type: "string", description: "Bind 127.0.0.1 on this port. The default is 47321." },
            foreground: { type: "boolean", description: "Serve in this process instead of detaching." },
          },
          run({ args }) {
            const port = args.port === undefined ? null : parsePort(String(args.port));
            return runServiceStart(port, args.foreground === true);
          },
        }),
        stop: defineCommand({
          meta: { name: "stop", description: "Stop the registry service when its process identity matches." },
          run() {
            return runServiceStop();
          },
        }),
        status: defineCommand({
          meta: { name: "status", description: "Report whether the registry service is running." },
          args: { json: { type: "boolean", description: "Print one JSON object." } },
          run({ args }) {
            return runServiceStatus(args.json === true);
          },
        }),
      },
    }),
    workspace: defineCommand({
      meta: { name: "workspace", description: "Register this machine's Migent workspaces." },
      subCommands: {
        register: defineCommand({
          meta: { name: "register", description: "Register the workspace that contains .migent/config.yaml." },
          args: {
            path: { type: "string", description: "Workspace root or a directory inside it." },
            name: { type: "string", description: "Display name. Defaults to the directory name." },
          },
          run({ args }) {
            return runRegister(text(args.path), text(args.name));
          },
        }),
        list: defineCommand({
          meta: { name: "list", description: "List registered workspaces." },
          args: { json: { type: "boolean", description: "Print one JSON object." } },
          run({ args }) {
            return runWorkspaceList(args.json === true);
          },
        }),
        remove: defineCommand({
          meta: { name: "remove", description: "Remove one registered workspace by id." },
          args: {
            id: { type: "positional", description: "Workspace id to remove.", required: true },
          },
          run({ args }) {
            return runRemove(String(args.id));
          },
        }),
      },
    }),
  },
});

function agentArgs(withSession: boolean): ArgsDef {
  return {
    ...(withSession
      ? { session: { type: "positional", description: "Session to continue.", required: true } }
      : {}),
    role: { type: "string", description: "Key under roles in .migent/config.yaml.", required: true },
    task: { type: "string", description: "Label stored on the new session. Defaults to the role key." },
    provider: { type: "string", description: "Provider for this role. Pass with --model, or omit both." },
    model: { type: "string", description: "Native model id for this role. Pass with --provider, or omit both." },
    option: { type: "string", description: "KEY=VALUE overriding one provider option for this turn." },
    prompt: { type: "string", description: "Prompt text." },
    file: { type: "string", description: "Read the prompt from this file." },
    stdin: { type: "boolean", description: "Read the prompt from stdin." },
    json: { type: "boolean", description: "Print the result as one JSON object." },
  };
}

async function runAgent(
  rawArgs: string[],
  args: Record<string, string | boolean | undefined>,
  sessionId: string | null,
): Promise<number> {
  const provider = text(typeof args.provider === "string" ? args.provider : null);
  const model = text(typeof args.model === "string" ? args.model : null);
  if ((provider === null) !== (model === null)) {
    printError("Pass both --provider and --model, or omit both.");
    return 2;
  }
  const prompt = text(typeof args.prompt === "string" ? args.prompt : null);
  const promptFile = text(typeof args.file === "string" ? args.file : null);
  const promptStdin = args.stdin === true;
  const selected = Number(prompt !== null) + Number(promptFile !== null) + Number(promptStdin);
  if (selected !== 1) {
    printError("Pass one of --prompt, --file, or --stdin.");
    return 2;
  }
  return dispatchAgent(findWorkspace(invocationCwdPath()), {
    role: String(args.role),
    task: text(typeof args.task === "string" ? args.task : null),
    sessionId,
    provider,
    model,
    options: repeated(rawArgs, "--option"),
    prompt,
    promptFile,
    promptStdin,
    asJson: args.json === true,
  });
}

function dispatchCeiling(maxDispatches: string | undefined, unlimited: boolean | undefined): number | null | "error" {
  if (unlimited && maxDispatches !== undefined) {
    printError("--max-dispatches cannot be combined with --unlimited-dispatches.");
    return "error";
  }
  if (unlimited) return null;
  if (maxDispatches === undefined) return DEFAULT_MAX_DISPATCHES;
  return integerFlag(maxDispatches, "--max-dispatches");
}

function attemptsOf(raw: string | undefined): number {
  if (raw === undefined) return 3;
  return integerFlag(raw, "--attempts");
}

function integerFlag(raw: string, flag: string): number {
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) {
    throw new ConfigurationError(`${flag} must be at least 1.`);
  }
  return Number(raw);
}

function text(value: string | boolean | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const stripped = value.trim();
  return stripped === "" ? null : stripped;
}

export type AnyCommand = CommandDef<ArgsDef>;
