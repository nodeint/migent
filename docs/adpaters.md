# Adapters

Adapters connect Migent to headless coding-agent CLIs. The implementation lives
in `packages/adapters`; it is an internal library with no stable public API.
This document describes the shared architecture and contracts. Model configuration
belongs in [Agent configuration](agents.md), workflow behavior
in [Workflows](workflows.md), and process troubleshooting in
[Diagnostics](diagnostics.md).

## Responsibilities and boundaries

- A **CLI client** knows the executable, command syntax, discovery commands,
  output protocol, session identifiers, failure facts, and usage fields printed
  by that CLI.
- **Migent policy** sits above the client in the kernel: it selects default
  session options, maps failure facts to `quota` or the historical `provider`
  failure kind, and normalizes cumulative usage.

Each `CliClient` owns its protocol completely. Parsing native CLI output belongs
in the client; shared text parsing helpers belong in `src/utils`.

The CLI owns authentication, tool execution, and its conversation history.
Migent owns model selection, prompt construction, workflow routing, process
execution, and persistence. Adapters describe commands; they do not schedule
workflow stages or execute subprocesses themselves.

## Layout and contracts

| Location | Responsibility |
| --- | --- |
| `src/types.ts` | Adapter contracts and normalized data types (a structural mirror of the kernel contract) |
| `src/clients/` | Client command builders, protocol parsers, and the client registry |
| `src/utils/` | Reusable parsing helpers without client selection logic |
| `src/options/` | Captured headless help samples |
| `src/catalog.ts` | Model catalog and model-specific option values |
| `src/index.ts` | Exports and `clientIds()` / `createClient()` |
| `test/` | Contract tests and protocol fixtures |

The kernel defines the runner-facing client contract in
`packages/kernel/src/cli-client.ts`. Changes to shared contract shapes must
remain structurally compatible across these packages. The adapter
`CliClient` keeps the adapter-only discovery methods `optionsCommand` and
`parseOptions`. The doctor loads model catalogs; the CLI orchestrates headless
option discovery. Neither operation belongs inside a pure text parser.

## Client selection

`createClient(id)` builds a fresh registered client and rejects an unknown ID.
`clientIds()` returns the registered IDs, sorted. An agent names its client
through `client.type`. When `client.type` is omitted, the kernel asks the registry's
optional `clientsForModel(model)` which clients list the model and uses the one match.
The CLI composition root implements it with the doctor's synchronous catalog loader
(`loadCatalogSync`, which shares the PATH check, parsing, and error messages with the async
`loadCatalog`) and the lookup policy `clientsListingModel` (exact match; opencode's `#variant`
suffix is stripped). Each registry instance lists a client's models at most once, and only when an
agent omits `client.type`. The kernel spawns nothing itself.

The kernel resolves an agent to a `{client, model, options}` target through a
registry lookup. A missing, unknown, unlisted (`client-not-found`), or ambiguous (`client-ambiguous`)
client is a configuration error, not a silent fallback. `migent get clients` lists the available clients.


## Building and reading a turn

`runCommand(input)` returns a `CommandSpec` with `argv` and optional `stdin`.
Its input includes the model, workspace, prompt, prior or new agent ID, prompt
file, last-message file, and resolved string-valued options. The client chooses
how to encode these inputs for its CLI. It validates its own options and applies
its defaults before building the command. The runner launches the process.
Keep argument boundaries in the argv array; do not construct a shell command.

`parseRun(stdout, lastMessageFile)` returns final text, a session ID, and a
`source` describing the text: `model` (assistant output, including a last-message
file), `error` (an error payload, or raw stdout when nothing parsed as protocol
events), or `none`. Raw stdout is never `model`. A client that returns no
attested `model` text cannot complete a failed turn. Clients may read
the last-message file when their protocol uses it. Progress is separate:
`createEventParser()` returns a per-run function that consumes output lines and
returns a normalized event or null. Stateful parsers must not leak state across runs.


## Sessions and interruption

Clients may implement `newSessionId()` when the CLI accepts a caller-generated
identity. Otherwise the CLI supplies the session identity. `sessionIdFromLine()`
can reveal it before the process finishes. A resumed turn passes the existing
agent ID back through the command builder.

Some CLIs keep server-side work alive after their local process ends. Optional
`interruptCommand()` and `classifyInterrupt()` describe how to stop and interpret
that work. Outcomes are `interrupted`, `idle`, `not-found`, or `failed`.
Stopping the local process tree remains a runner responsibility. Workflow resume
and artifact dependencies are described in [Sessions](sessions.md).

## Model and version discovery

`modelsCommand()` and `parseModels()` produce a `CliModelCatalog` containing
model IDs, an optional default ID, and model-specific option values.
`ModelCatalog.valuesFor(model, option)` returns known values or null when unknown.
An empty known list is distinct from null: it means the model accepts no values
for that option.

`optionValuesCommand(option, model)` supplies an additional discovery command
when necessary, or null when none exists. `parseOptionValues()` interprets its
output. The doctor checks catalog values first and only probes separately when
needed. A known-value list can support selection and validation; unknown values
must not be treated as an empty list.

`versionCommand()` and `parseVersion()` expose CLI version information for
execution records and diagnostics.

## Headless option discovery

Each client owns `optionsCommand()` and `parseOptions(help)`. The command asks
for help in the execution mode used for headless turns. The parser returns
`HeadlessOption[]`; it does not select a client or launch a process.

Clients may call `utils/parse-help-options.ts` with their help-table format.
A client whose format cannot be represented by that helper should implement
its own parser. The helper strips terminal colors, reads the selected options
section, joins wrapped descriptions, and extracts documented metadata.

| Field | Meaning |
| --- | --- |
| `name` | First long flag without leading dashes, or the short flag when no long flag exists |
| `flags` | Flag spellings listed in the option header |
| `description` | Joined description, including help metadata |
| `argument` | Argument placeholder as printed, or null |
| `valueMode` | `required`, `optional`, `none`, or `unknown` |
| `type` | `string`, `number`, `boolean`, `array`, or `unknown` |
| `choices` | Enumerated values extracted from supported help annotations, or null |
| `defaultValue` | Default text extracted from help, or null |

The result is JSON serializable. Unknown information stays unknown. The parser
does not infer numeric constraints from prose or guarantee that every choice,
alias, dependency, or default mentioned in prose has been extracted. A CLI can
also display interactive flags in headless help. Discovery alone does not make
a flag suitable for Migent configuration.

The options runner combines stdout and stderr on successful exit, since help
may use either stream. It applies a 15-second timeout and reports launch or
nonzero-exit failures. Parsing fails when no option table can be read. Catalogs
are fetched on each listing; there is no persistent cache or version-keyed cache.

## Listing and JSON output

```bash
migent get clients --json
migent get models --client codex --json
migent get options --native --client codex --json
migent get efforts --client codex --json
```

The machine types are keyed by CLI client. Each client's own catalog command and
parser run, including its stdin input, so `claude-code` does not depend on a
legacy provider entry. They do not require project
configuration. Each list is a plain array; every view has `kind`, `name`,
snake_case fields, `null` for absent values, and `problems` where it applies.

| Type | Fields |
| --- | --- |
| `client` | `name`, `command`, `available`, `path`, `effort_option`, `problems` |
| `model` | `name`, `client`, `default` |
| `option` (configured) | `name`, `client`, `source: "configured"`, `prompt`, `allow_default`, `overridable` |
| `option --native` | `name`, `client`, `source: "native"`, `flags`, `description`, `argument`, `value_mode`, `type`, `choices`, `default` |
| `effort` | `name` (the model), `client`, `model`, `option`, `values` |

`clients` runs no subprocess. It reports PATH facts only,
so its `problems` contain `<command> is not on PATH.` and never a catalog or help
failure. `models`, `options --native`, and `efforts` run the client's discovery
commands: a client that is not on PATH is skipped without spawning and prints
`warning: <client>: <command> is not on PATH; skipped.`; a failed command, a
non-zero exit, or an unreadable catalog prints `warning: <client>: <error>`.
stdout still carries only the rendered rows, the other clients still print, and
the command exits 0. These failures never appear in `get clients`.

A singular `model`, `option`, or `effort` lookup identifies a row by (client,
name). With `--client` it searches only that client and reports why a skipped or
failed client could not answer. Without it, exactly one match prints; no match
exits 2 and names the clients searched, skipped, or failed; two or more matches
exit 2 with the matching clients and a request for `--client`.

`get efforts` probes per-model option values only when the catalog does not
already carry them. The old `{ok, providers}` envelope, `headless_options`, and
the exit-1-when-no-models
rule are gone; see [CLI: Get](cli.md#get) for the per-type commands.

## Configuration and validation

Model options form the base settings; command-line overrides apply last. The
agent-level `effort` alias resolves to the selected client's `effortOption`. An
alias and its native option cannot both be set on an agent. See
[Agent effort](agents.md#agent-effort).

The existing `options()` metadata controls prompting, default selection, and
which settings `sessionOptions()` retains on a session. These are Migent
policies, not facts that a CLI help parser can determine.

`validateOptions()` currently remains client-owned. Configuration resolution and
the runner call it; interactive configuration also checks discovered per-model
values where available. The new headless catalog does **not yet replace** these
validators, populate configuration prompts, or drive argv generation.

Before using it for validation, the integration must account for options Migent
controls, such as prompts, output protocol, model selection, and session IDs.
Native flag names may differ from stored configuration names. CLI config-key
overrides may also expose a different surface from execution flags. The client
must retain responsibility for that mapping and encoding.

## Failures and usage

`extractFailure(stdout, exitCode)` returns native failure facts or null for a
successful run. A nonzero exit must produce a failure fact, which the runner may
still accept (see below). Every failure carries an `origin`: `provider-error`
when the CLI protocol reported an error (an error event, `is_error`, a failed
result), even if model text exists too; `exit-only` for a non-zero exit with no
reported error. The runner adds `start` when there is no usable exit code or the
process died from a signal. Only `exit-only` can be accepted: when its reply has
`source: model` and passes the checks an exit-0 reply passes, the turn completes
and Migent records `provider.exit_anomaly`. Never derive a rate limit from model
text; only the protocol or an error payload may state one. A protocol can
identify rate limits with an optional reset time and window. The kernel's
`classifyFailure(client, stdout, exitCode)` turns those facts into `quota` or
`provider` failures; it does not infer a reset time absent from the CLI
protocol. Runner process-start diagnostics are separate
from failures reported by a running CLI; see [Diagnostics](diagnostics.md).

A client may implement the optional `eventLabel(line)` capability. It returns a
short label from the CLI's own vocabulary (`text`, `item.completed:agent_message`,
`result:error`) for one output line, or `null` when the line is not an event.
The runner counts labels into the
`stream_summary` of `diagnostics.json`, so a client that omits it gets counts
without labels. A label must come from a closed vocabulary the client lists (event and subtype
names); `labelOf(value, allowed)` in `clients/json.ts` maps any other value to
`other`, so a payload that merely looks like an identifier is never a label. The
kernel additionally limits label length, characters and number of distinct labels.
`extractFailure` also reports a protocol error at exit 0 (an error event, a failed
result); a control-plane warning is not one.

`captureUsage()` selects the CLI's usage payload and stores it as a raw capture.
`readUsage()` translates it into nullable token and cost fields and identifies
which fields are cumulative across the conversation. `normalizeUsage()` subtracts
the previous capture for cumulative fields. Missing values and negative deltas
become null; per-turn fields pass through. Missing usage must not become zero.

Normalized fields are `input_tokens`, `output_tokens`, `reasoning_tokens`,
`cache_read_tokens`, `cache_write_tokens`, and `cost_usd`. Input excludes cache
reads; reasoning is reported alongside output and is not added to it. Costs come
from reported usage, without a Migent price table.

When a workflow completes, metrics normalize stored captures and write
`metrics.json`. Later adapter changes do not rewrite that file. Aggregation,
partial totals, and uncaptured turns are described in [Session metrics](session-metrics.md).

## Extending and verifying adapters

Implement the CLI contract in a client, reuse parsing helpers where appropriate,
and register the client factory in `clients/registry.ts`. Add kernel policy in
`client-policy.ts` only when defaults or accounting require it.

Use captured help and protocol fixtures to test parsing without authentication
or model execution. Cover wrapped text, aliases, optional arguments, metadata,
unknown fields, and malformed output. Test discovery failures independently of
model failures. For execution protocols, cover initial and resumed sessions,
progress, failed runs, usage capture, and cumulative deltas. Run relevant tests
and the workspace build after changing shared contracts.
