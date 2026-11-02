# Design: render project initialization from canonical templates

## Goal and scope

Use root `templates/` as the single source of project scaffolding. Preserve the
approved instructions and workflow behavior without duplicating YAML in
TypeScript. This design changes initialization and asset packaging, not the
workflow engine or existing workspaces. Implementation is not part of this document.

## Current behavior and evidence

- `packages/cli/src/commands/init.ts:251` writes config, two workflow presets,
  and a generated `.gitignore`. `renderConfig` at line 270 and `renderWorkflow`
  at line 310 currently embed the content in TypeScript.
- `scripts/copy-templates.mjs` already prepares `dist/templates` during both
  workspace and CLI builds, but currently copies only `skills/migent`.
- `packages/cli/package.json` publishes `dist`, so runtime assets must live
  there. Installed CLI execution cannot depend on the repository root or cwd.
- `templates/config.yaml` contains role-specific model placeholders.
  Both workflow templates have `ask: human`; plan has no downstream declaration,
  and implement produces `implement.md`. These are intentional template semantics
  to preserve, rather than reconstruct from the old renderer.

## Architecture

### Canonical assets

Keep these files authoritative:

```text
templates/
  config.yaml
  workflows/
    implement.yaml
    plan.yaml
```

The config is readable YAML with explicit role model placeholders. Do not
introduce conditionals or a generic rendering engine. Workflows have no dynamic
values and are copied as bytes.

The selected role models are runtime inputs from the existing init selection
flow. Placeholders do not change the existing interactive/noninteractive
selection contract.

### Build and asset resolution

Extend the existing copy step to produce:

```text
packages/cli/dist/templates/
  migent/                 # existing skill assets
  project/                # copy of root templates/
    config.yaml
    workflows/
      implement.yaml
      plan.yaml
```

Keep skill paths stable. Resolve project assets relative to the renderer module
using `import.meta.url`, never relative to cwd. Source execution uses the root
`templates/` path; compiled execution uses `dist/templates/project/`.

Make source and compiled layouts explicit: a missing packaged asset must fail
with an actionable error, rather than silently use repository files. Do not
search arbitrary ancestor directories or fetch assets over the network.

### Renderer boundary

Introduce a CLI-owned project-template module. Its public contract takes the
three selected model objects and returns a complete list of destination-relative
paths and rendered contents. It performs no workspace writes and no provider
discovery. Keep `ModelChoice` in that module or a neutral CLI type module to avoid
a dependency from the renderer back to the init command.

Responsibilities:

1. Load all required assets and reject missing or malformed templates.
2. Parse config as a YAML document and replace exactly
   `roles.<planner|reviewer|developer>.default_model`.
3. Return workflow contents unchanged, alongside rendered config and the existing
   generated `.gitignore`.

Use a YAML document API that retains comments and ordering, with `yaml` declared
as a direct CLI dependency. Do not import a transitive dependency accidentally,
use regex to rewrite YAML, or round-trip the entire config through plain objects.

Each replacement contains `provider`, `model`, and `options` only when supplied.
Replace the complete placeholder node and retain the current selection semantics.
Represent model values as YAML scalar strings so punctuation and scalar-like
values remain safe. Unknown template content outside the replacement nodes is
retained.

Keep the supported presets explicit (`implement`, `plan`). Do not interpret every
file found in the directory as a public workflow. Adding a preset should be an
intentional API decision with matching validation and tests; no manifest is
needed for these three assets.

### Initialization boundary

`runInit` continues to own workspace classification, provider/model selection,
diagnostics, and display. Replace embedded render functions with the template
module. Produce and validate the complete rendered file set before creating or
writing workspace files, so an asset/render failure does not leave a partial
project.

Keep the existing ready/conflict behavior: initialization does not update an
already initialized project. Template changes apply to new workspaces only.
Filesystem failures during writing can still leave partial output; atomic
directory transactions and upgrade/migration tooling are outside this scope.

Use existing kernel configuration/workflow validation in asset tests and normal
init diagnostics. Avoid creating another schema validator. A template contract
error should name the asset and missing/invalid node and surface through the
existing CLI configuration-error handling.

## Contracts and risks

- Approved template text owns role instructions, stages, decisions, artifacts,
  constraints, schema versions, and downstream declarations. Renderer code must
  not append legacy instructions or restore the old downstream behavior.
- Supported roles and their model replacement paths form the small, explicit
  contract between config assets and renderer code. Missing nodes are errors,
  not opportunities to create a silently incomplete template.
- Templates are trusted package assets. User-provided template paths, plugins,
  template overrides, and arbitrary expression evaluation are outside scope.
- YAML config formatting may normalize around replaced nodes. Workflow bytes
  should remain identical to source assets, including comments and blank lines.
- Build-copy omissions are a release risk: validate the packaged layout as well
  as source execution. Existing skill packaging must continue to work.

## Validation criteria

- Generated config retains template role instructions and unrelated fields while
  replacing all three model nodes independently, including selected options.
- A choice without options leaves no template effort/client/options behind.
  Scalar-like and punctuation-containing strings survive YAML parsing unchanged.
- Generated workflows equal canonical assets byte for byte and pass existing
  workflow validation. Expectations reflect the approved new behavior.
- Missing assets and invalid config replacement paths fail before workspace
  files are written and identify the failing asset/node.
- Build output includes project and skill assets. An isolated packed CLI can
  initialize from an unrelated cwd using fake providers, without repository files.
- Existing init tests continue to cover ready/conflict behavior and independent
  role selection. Update tests asserting old workflow wording/structure to the
  canonical template contract; do not weaken behavior checks.

## Decisions and trade-offs

Structured YAML editing adds a direct dependency already used by the kernel,
but avoids fragile text substitution and keeps templates valid YAML. Copying
workflows unchanged preserves the approved text and keeps rendering small.
An explicit fixed preset list is sufficient now; a manifest or extensible
template engine would add a second configuration system without a current need.

There are no unresolved architecture decisions for this scope. Changing init to
accept automatic model defaults would be a separate user-facing decision.
