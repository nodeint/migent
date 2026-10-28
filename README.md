# Migent

<p align="center">
  <img src="https://raw.githubusercontent.com/nodeint/migent/main/assets/stylized-m.svg" alt="Migent logo" width="150" /><br>
  <strong>Compose AI coding agents into repeatable engineering workflows.
</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nodeint/migent"><img src="https://img.shields.io/npm/v/@nodeint/migent.svg?style=flat-square" alt="npm version" /></a>
  <a href="https://github.com/nodeint/migent/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License: MIT" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg?style=flat-square" alt="Node.js 22+" /></a>
</p>

---


Migent connects coding-agent CLIs from different providers through explicit,
repository-defined workflows. One model can plan, another can review, and the
first can revise—while Migent carries artifacts between them and remembers
where the process is.

## Contents

- [Migent](#migent)
  - [Contents](#contents)
  - [Why Migent?](#why-migent)
  - [Supported CLIs](#supported-clis)
  - [Quickstart](#quickstart)
    - [With an AI agent](#with-an-ai-agent)
    - [Manually](#manually)
    - [Run](#run)
    - [Join an existing project](#join-an-existing-project)
  - [Workflow as code](#workflow-as-code)
    - [Start with one role and one stage](#start-with-one-role-and-one-stage)
    - [Add planning and review](#add-planning-and-review)
  - [Concepts](#concepts)
  - [Current scope](#current-scope)
  - [Documentation](#documentation)
  - [License](#license)

## Why Migent?

Calling two agent CLIs from a shell script is easy. Reliably coordinating them
across reviews, revisions, failures, and resumed sessions is not.

Migent is built around three ideas:

- **Use models for what they do best.** Assign each role to a provider and model
  suited to the work, rather than asking one agent to do everything.
- **Treat AI engineering process as code.** Keep stages, handoffs, review gates,
  and revision policies in version control beside the project they govern.
- **Keep orchestration explicit.** The team defines the process; models execute
  roles inside it. A supervisor model does not invent or dynamically control
  the workflow.

**Models describe execution. Roles describe intent.** Changing the model behind
a role does not require rewriting the workflow.

**Common workflow model, native provider capabilities.** Migent coordinates
the process, while each provider CLI remains responsible for authentication,
agent execution, and its own tools and options.

```mermaid
flowchart TD
    A[Task] --> B[Planner - Codex]
    B -->|plan.md| C[Reviewer - Grok]
    C -->|revise| B
    C -->|approved| D[Complete]
```

## Supported CLIs

Migent drives each provider through its headless CLI. Install and sign in to the
ones your configuration names.

| Provider           | CLI          |
| -------------------| -------------|
| Google Antigravity | `agy`        |
| Claude             | `claude`     |
| Codex              | `codex`      |
| Grok               | `grok`       |
| BytePlus           | `opencode`   |
| OpenCode           | `opencode`   |

## Quickstart

Requires Node.js 22+ (macOS, Linux, or Windows) and the provider CLIs you plan
to use, installed and signed in. `migent doctor` reports any that are missing.

Install Migent first:

```bash
npm install -g @nodeint/migent
migent --version
```

Upgrade with `npm install -g @nodeint/migent@latest`.

There are two ways to set up a project. Both end with the same files and the
same next command.

### With an AI agent

1. Install the agent skill (requires Node.js 22.20+), then choose the AI
   clients to set up:

   ```bash
   migent skill install
   ```

2. Paste this prompt into your agent (Claude Code, Codex, Antigravity, Cursor,
   etc.):

   ```text
   Use the migent skill to set up Migent in this project.
   ```

The agent handles setup. Ask it for a specific provider, model, or a
plan-and-review workflow if you have a preference.

### Manually

```bash
migent init
```

Choose a provider, model, and workflow: `implement` for coding, or `plan` for
planning and review. `init` creates the configuration and workflow files under
`.migent/`, checks the setup, and prints the command to run next.

### Run

For the `implement` workflow, run this from your project directory with your
own task text. If you chose `plan`, use `--workflow plan` instead:

```bash
migent session run --workflow implement --task "Add a --json flag to the export command"
```

Migent shows progress as it runs. A successful run ends with `completed`;
workflows that publish files also print their paths.

Each run is a session. List sessions or resume a stopped run:

```bash
migent session list
migent session continue <session-id>
```

### Join an existing project

Install and sign in to the provider CLIs the project uses, then run
`migent doctor` and follow its setup instructions. An agent with the Migent
skill can do this for you. Use the project's existing workflows; do not run
`init` again.

## Workflow as code

Workflows live in `.migent/workflows/`. Roles live in `.migent/config.yaml`.
A role names a kind of work and selects a provider and model. A stage assigns
work to a role; a workflow connects those stages.

### Start with one role and one stage

Set the role's provider and model in `default_model`. Use model IDs available
from `migent provider list` in place of the example IDs.

```yaml
# .migent/config.yaml
schema_version: 2
roles:
  developer:
    default_model:
      provider: codex
      model: gpt-5
```

This workflow asks the developer to implement a task, then checks the result:

```yaml
# .migent/workflows/implement.yaml
schema_version: 2
stages:
  - id: implement
    role: developer
    instructions:
      - Implement the task described in task.md.
    verify:
      - pnpm build
      - pnpm test
```

Replace the `verify` commands with your project's build and test commands.
Run it with the same command as the quickstart:

```bash
migent session run --workflow implement --task "Add a --json flag to the export command"
```

If verification fails, Migent asks the agent to fix the problem and checks again.

To change the developer's provider or model, edit its `default_model`. The
workflow still refers to `developer`. After editing configuration or workflows,
run `migent doctor` to check them.

### Add planning and review

For a plan-and-review workflow, define two roles. They can use the same model
or different providers:

```yaml
# .migent/config.yaml
schema_version: 2
roles:
  planner:
    default_model:
      provider: codex
      model: gpt-5
  reviewer:
    default_model:
      provider: grok
      model: grok-4
```

The planner produces `plan.md`. The reviewer receives it through `depends_on`
and decides whether to approve it or send it back for revision:

```yaml
# .migent/workflows/plan.yaml
schema_version: 2
stages:
  - id: plan
    role: planner
    max_revisions: 3
    instructions:
      - Read task.md and write plan.md into artifacts.
    produces:
      artifact: plan.md

  - id: review_plan
    role: reviewer
    depends_on: [plan]
    instructions:
      - Verify plan.md against the codebase.
      - Approve only if implementation can proceed without ambiguity.
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: plan
```

Run this workflow with:

```bash
migent session run --workflow plan --task "Plan a --json flag for the export command"
```

`max_revisions` bounds the review loop. A successful stage's named file is an
**artifact**; `depends_on` makes it available to the next stage. The
**decision** selects a route: `approved` completes the workflow, while `revise`
returns to `plan` with the review feedback.

## Concepts

- **Workflow:** A process made of stages, such as plan, review, and implement.
- **Stage:** One step with instructions for a role, optional checks, and a next step.
- **Role:** A kind of work, such as developer or reviewer, with a default provider and model.
- **Model:** The AI model a role uses, identified by its provider and model ID.
- **Artifact:** A file a stage produces for later stages or the user, such as `plan.md`.
- **Decision:** A stage's choice of what happens next, such as approve or revise.
- **Session:** A saved run of a workflow or role that you can inspect and continue.

## Current scope

Migent runs locally using your installed coding-agent CLIs. You define the
stages, checks, and review routes; Migent coordinates them and saves progress
so you can inspect results or continue stopped work. Each provider CLI handles
its own sign-in, tools, and agent execution.

You can run a single role or a workflow, pass artifacts between stages, and
connect workflows. Use the CLI directly or ask an AI agent with the Migent
skill to operate it for you.

## Documentation

- [Writing workflows](https://github.com/nodeint/migent/blob/main/docs/workflows.md)
- [Providers and model configuration](https://github.com/nodeint/migent/blob/main/docs/providers.md)
- [Sessions and workflow composition](https://github.com/nodeint/migent/blob/main/docs/sessions.md)
- [CLI commands and execution controls](https://github.com/nodeint/migent/blob/main/docs/cli.md)

Run `migent <command> --help` for command options. To contribute to Migent, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

Migent is licensed under the [MIT License](https://github.com/nodeint/migent/blob/main/LICENSE).
