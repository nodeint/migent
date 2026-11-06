# Set up a project

Work from the project root. If `.migent/` already exists, use
[config.md](config.md) to inspect and update it instead of running init again.

## Choose models

Run `migent get models --json` to discover available model IDs for each CLI
client. Respect the user's choices when provided. Otherwise, choose a
model and effort for each role independently, based on its responsibilities
and the available models.

## Initialize

The default workflows use three roles:

- **Planner:** designs the approach and identifies trade-offs.
- **Reviewer:** checks the plan or implementation and identifies required fixes.
- **Developer:** implements and verifies the work.

Use the selected provider and model IDs:

```bash
migent init --no-input \
  --planner-provider <provider> --planner-model <model> --planner-effort <effort> \
  --reviewer-provider <provider> --reviewer-model <model> --reviewer-effort <effort> \
  --developer-provider <provider> --developer-model <model> --developer-effort <effort>
```

Effort flags are optional. Use values supported by each model; see
[config.md](config.md).

Init writes role responsibilities and selected agents to `.migent/config.yaml`.
It also creates an empty `.migent/config.local.yaml` for machine-specific
overrides; Git ignores the local file.

## Verify

Run `migent doctor --json` and resolve reported problems. For changes, use
[config.md](config.md) for agents and roles or
[schema-workflow.yaml](schema-workflow.yaml) for workflows.

## Update the skill

If doctor reports that an installed skill differs from the bundled version,
run the suggested `migent skill update` command for the reported scope.
