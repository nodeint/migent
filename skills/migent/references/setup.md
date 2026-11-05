# Set up a project

For an existing `.migent/` project, follow [config.md](config.md)
to inspect and update its configuration instead of running init again.

1. Run `migent provider list --json`. Select a provider and model for the
   planner, reviewer, and developer from the returned catalog, using the user's
   choices when given. The same model may serve all three.
2. Initialize from the project root with the selected IDs:

   ```bash
   migent init --no-input --planner-provider <planner-provider> --planner-model <planner-model> --reviewer-provider <reviewer-provider> --reviewer-model <reviewer-model> --provider <developer-provider> --model <developer-model>
   ```

   Pass model options as repeated `--planner-option KEY=VALUE`,
   `--reviewer-option KEY=VALUE`, or `--option KEY=VALUE` flags when needed.
   Init writes shared role instructions to `.migent/config.yaml` and the
   selected role models to `.migent/config.local.yaml`. The local file is
   ignored by Git; each machine can set its own models there.
3. Run `migent doctor --json` and resolve reported problems. Use
   [config.md](config.md) for model and role changes, or
   [schema-workflow.yaml](schema-workflow.yaml) to edit workflows.

Install the project skill separately when needed:

```bash
migent skill install --project -y
```

After upgrading Migent, refresh installed copies with
`migent skill update --project -y` or `migent skill update --global -y`, matching
their installation scope.
