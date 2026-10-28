# Set up a project

For an existing `.migent/` project, follow [config.md](config.md)
to inspect and update its configuration instead of running init again.

1. Run `migent provider list --json`. Select a provider and model for the
   developer and reviewer from the returned catalog, using the user's choices
   when given. The same model may serve both.
2. Initialize from the project root with the selected IDs:

   ```bash
   migent init --no-input --provider <developer-provider> --model <developer-model> --reviewer-provider <reviewer-provider> --reviewer-model <reviewer-model>
   ```

   Pass model options as repeated `--option KEY=VALUE` or
   `--reviewer-option KEY=VALUE` flags when needed.
3. Run `migent doctor --json` and resolve reported problems. To customize
   the generated roles or workflows, follow [config.md](config.md)
   and validate again before starting a workflow.
