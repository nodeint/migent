# Plan: install the Migent skill through `npx skills`

## Goal

Replace the hand-written skill installer with a thin wrapper around
[`npx skills`](https://github.com/vercel-labs/skills) (vercel-labs/skills), so
that:

- the skill can be installed at **project** or **global** scope;
- each **client** (not provider) gets the skill in the directory it actually
  reads (Claude Code does not read `.agents/skills`);
- the installed skill always matches the CLI version that is installed;
- `migent doctor` reports every installed copy that differs from the bundled
  skill.

`migent skill install` and `migent skill update` stay, as aliases that call
`npx skills add`. `migent skill path` is new.

## Findings that drive the design

All verified on this machine (Node 24, Windows) unless marked otherwise.

- `npx skills add <local path> -s migent -a <clients> [-g] -y --copy` works.
  `references/` is copied, and the copy is byte-identical to the source
  (`diff -rq`, project and global).
- Project scope writes `./<client dir>/migent` and `skills-lock.json`.
  Global scope writes `~/<client dir>/migent` and `~/.agents/.skill-lock.json`.
- `--copy` avoids symlinks, which are unreliable on Windows.
- `skills add` does not accept npm packages as a source. A local path works,
  so the skill bundled in the npm package of the CLI can be the source.
- `skills update` does not move a pinned or local source to a newer version.
  Updating means running `add` again. Whether `add` overwrites an existing copy
  cleanly is **not verified yet** (step 0).
- `skills` needs Node >= 22.20 and sends anonymous telemetry
  (`DISABLE_TELEMETRY=1` or `DO_NOT_TRACK=1` turns it off).
- Skill directories per client (docs, 2026-10):

| Client      | Project            | Global                          | Status                                   |
|-------------|--------------------|---------------------------------|------------------------------------------|
| claude-code | `.claude/skills`   | `~/.claude/skills`              | confirmed (Claude Code docs)             |
| codex       | `.agents/skills`   | `~/.agents/skills`              | confirmed (OpenAI docs)                  |
| opencode    | `.agents/skills`   | `~/.config/opencode/skills`     | confirmed; `.opencode/skills` also read  |
| grok        | `.grok/skills`     | `~/.grok/skills`                | confirmed (xAI docs)                     |
| agy         | `.agents/skills`   | depends on the Antigravity build| project confirmed; global **open**       |

Antigravity global is `~/.gemini/antigravity/skills` (IDE),
`~/.gemini/antigravity-cli/skills` (CLI) or `~/.gemini/config/skills` (2.0).
The `byteplus` provider has no directory of its own: it runs through another
client, and the skill follows that client.

## Open decisions

1. Which Antigravity build does the `agy` client drive? This sets its global
   path. Default if undecided: `~/.gemini/antigravity/skills`.
2. opencode project path: `.agents/skills` (shared with codex, one copy) or
   `.opencode/skills`. Default if undecided: `.agents/skills`.

## Steps

### 0. Verify `add` overwrites an existing copy

In a temp project and a temp `HOME`: install, edit one file in the installed
copy, change a template file, run `add` again, and compare with `diff -rq`.
Also check that a file removed from the template disappears from the copy. If
it does not, `skill update` removes the old directory first (only when the
directory is recognised as the Migent skill, see step 3).

### 1. Bundle and expose the skill

- `packages/cli/src/commands/skill.ts`: add `skillSourceDirectory()` returning
  the absolute path of `dist/templates/migent` (resolve from
  `import.meta.url`, as `readTemplate()` does today).
- `migent skill path` prints that path and nothing else, exit 0.
- No version stamping in the build. The bundle ships inside the npm package of
  the CLI, so its content is the version.
- Delete `.agents/skills/migent/.migent-template.json` (tracked dev copy).

### 2. Client table

New `packages/cli/src/skill-targets.ts`, the only place with paths:

```ts
export interface SkillTarget {
  client: string;      // migent client id: claude, codex, agy, grok, opencode
  skillsAgent: string; // value for `skills -a`: claude-code, codex, antigravity, grok, opencode
  project: string;     // relative to the workspace
  global: string;      // relative to the home directory
}
```

- Values come from the table above, once the two open decisions are settled.
- Check the real client ids against `packages/adapters/src/clients/*` and the
  provider constructors (`clientId` defaults) before writing the table.
- `resolveDirectory(target, scope, { workspace, home })` returns the absolute
  skill directory. `home` is injected for tests (default `os.homedir()`).
- Group targets by resolved directory so clients that share one (codex, agy,
  opencode) are handled once.

### 3. Scanner shared by `doctor` and `skill update`

New `packages/cli/src/skill-scan.ts`:

- `scanInstalledSkills({ workspace, home })` checks every target in both scopes
  (all known clients, not only the ones in `.migent/config.yaml`).
- A directory counts as the Migent skill when `<dir>/migent/SKILL.md` exists and
  its frontmatter has `name: migent`. Other `migent` directories are ignored.
- Returns one entry per resolved directory:
  `{ scope, directory, clients, state }` with `state` one of `current`,
  `different`.
- Digest: SHA-256 over every file in the directory, sorted by relative path,
  with `\r\n` normalised to `\n`. The same function digests the bundled skill.
  `state` is `current` when both digests match.
- Pure function over the filesystem, so tests can use temp directories.

### 4. `migent skill install` and `migent skill update`

`packages/cli/src/commands/skill.ts`, `packages/cli/src/program.ts`.

```
migent skill install [--global | --project] [--client <ids>] [-y]
migent skill update  [--global | --project] [--client <ids>] [-y]
migent skill path
```

- Both build and run:
  `npx -y skills add <skill path> -s migent --copy [-g] -a <skillsAgent...> -y`
  with inherited stdio. The command runner is injected (`runCommand`), as in
  the `config.local` tests.
- Preflight: Node >= 22.20 and `npx` on PATH. Otherwise print one clear error,
  exit 1.
- `install`:
  - scope from `--global` or `--project`; when missing and interactive, ask
    "Project (this repo)" or "Global (all projects)"; when missing and not
    interactive, exit 2 with a message, like `init` does;
  - clients from `--client`; when missing, default to the clients in
    `.migent/config.yaml` (project scope) and let `skills` prompt when it runs
    interactively. Pass `-y` only when the user did.
  - Needs a workspace only for project scope. Global scope works anywhere.
- `update`:
  - runs the scanner, keeps `different` entries (all of them, or those matching
    `--global`, `--project`, `--client`);
  - groups by scope and runs one `skills add` per scope with the clients of that
    group;
  - prints "Already up to date" when nothing differs and "Migent skill is not
    installed; run `migent skill install`" when nothing is installed;
  - asks for confirmation before overwriting (`-y` skips), because a `different`
    copy may contain local edits.
- Remove the old digest, state file and write logic from `skill.ts`.

### 5. `doctor`

`packages/cli/src/commands/doctor.ts` (and `display.ts` if the output needs a
section).

- Add a skill check built on the scanner. One line per installed copy, with the
  path (`~/...` for global) and the clients using it.
- Nothing installed anywhere: one warning, "Migent skill is not installed; run
  `migent skill install`".
- A copy that differs from the bundled skill: warning naming the CLI version and
  the fix, `migent skill update` (with `-g` when global).
- The check only adds warnings. It never changes the exit code. `--json` output
  carries the entries in `items` and `warnings` like the other checks.

### 6. `init`

`packages/cli/src/commands/init.ts`.

- `--skill` and the interactive question stay, but call the install flow from
  step 4 (project scope, clients from the provider/client just chosen) instead
  of `installSkill`.
- The question no longer names `.agents/skills/migent`; it names the directory
  for the chosen client, from the client table.

### 7. Tests

- `packages/cli/test/skill.test.ts`: rewrite. Cover the command line built for
  install and update (project, global, several clients, shared directory),
  preflight failures, `skill path`, and the confirmation on `update`.
- New tests for the scanner: current, different, edited file, extra file, CRLF
  copy, a non-Migent `migent` directory, shared directory reported once.
- Doctor tests: not installed (warning, exit unchanged), current, different.
- `init.test.ts`: update for the changed prompt text and flow.

### 8. Docs and changelog

- `docs/cli.md`, `docs/providers.md` (still names `.agents/skills/migent`),
  `docs/workflows.md`, `README.md`, the `--skill` help text in `program.ts`.
- Mention `npx skills`, the Node >= 22.20 requirement and the telemetry opt-out.
- `CHANGELOG.md`, under `## Unreleased`:
  - Added: `migent skill path`, global and per-client skill install, doctor
    check for installed skills.
  - Changed: `migent skill install` and `update` run `npx skills`.
  - Removed: the `.migent-template.json` state file.
- No change to the `release` skill: nothing is stamped at build time.

## Risks

- Depends on a third-party CLI and its flags. Mitigated by a small, injected
  command builder and tests that pin the exact argument list.
- Offline use, or Node older than 22.20, cannot install. The error says so.
- `skills` records the local source path in its lock file. After a CLI upgrade
  the lock does not know the skill changed, so `migent skill update` and the
  doctor warning are the only upgrade path. Document that `npx skills update`
  does not upgrade this skill.
- A copy edited by hand shows as `different` and is overwritten by `update`
  after confirmation.
- Client directories can change. They live in one table and the scanner only
  reads them.

## Order of work

0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Steps 3 to 5 can land in one commit; step 0
decides whether step 4 needs the "remove old directory first" branch.
