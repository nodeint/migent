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
3. Run `migent doctor --json` and resolve reported problems. To customize
   the generated roles or workflows, follow [config.md](config.md)
   and validate again before starting a workflow.

Install the project skill separately when needed:

```bash
migent skill install --project -y
```

Refresh an installed skill with `migent skill update` after upgrading Migent.
