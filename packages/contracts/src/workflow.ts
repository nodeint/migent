import Type, { type Static } from 'typebox';

import { id, nullable } from './common.js';
import { NonBlankString, RoleAgent } from './config.js';

/**
 * Structure of an authored workflow file at the current `schema_version` (7). Pure data: error
 * codes, messages, and semantic rules (duplicate ids, `depends_on` targets, cycles, routes, artifact
 * producers, glob compilation, verify paths) live in the kernel. Unlike the output contracts, these
 * objects are closed: an unknown key is an error. Documents older than the current version are read
 * by the kernel's version-gated readers and are not described here.
 */

export const WORKFLOW_SCHEMA_VERSION = 7;

/** Artifact ids: a letter, then letters, digits, `_` or `-`. */
export const ARTIFACT_ID_PATTERN = '^[A-Za-z][A-Za-z0-9_-]*$';

/** A whole number written as a YAML integer or a digit string. */
const Count = Type.Union([Type.Integer({ minimum: 0 }), Type.String({ pattern: '^\\s*\\d+\\s*$' })], {
  description: 'A whole number, written as an integer or a digit string.',
});

/** A whole number of at least 1, written as an integer or a digit string. */
const PositiveCount = Type.Union([Type.Integer({ minimum: 1 }), Type.String({ pattern: '^\\s*0*[1-9]\\d*\\s*$' })], {
  description: 'A whole number of at least 1, written as an integer or a digit string.',
});

/** One line of text, surrounding whitespace allowed. */
export const WorkflowLine = Type.String({ pattern: '^\\s*\\S([^\\r\\n]*\\S)?\\s*$', description: 'A single non-blank line.' });

/** One line with no newline anywhere, surrounding spaces allowed. */
const RawLine = Type.String({ pattern: '^[^\\r\\n]*\\S[^\\r\\n]*$', description: 'A single non-blank line.' });

/** `schema_version` as the loader reads it: a non-negative integer or a digit string. */
const SchemaVersion = Type.Union([Type.Integer({ minimum: 0 }), Type.String({ pattern: '^\\s*\\d+\\s*$' })], {
  description: 'Document version, an integer or a digit string.',
});

const StringList = (description: string) => Type.Array(NonBlankString, { description });

/** `file`, `description`, `required` of one artifact. Used for the registry and for inline decision artifacts. */
export const WorkflowArtifact = Type.Object(
  {
    file: Type.String({ pattern: '^\\s*(?!\\.{1,2}\\s*$)[^/\\\\\\s][^/\\\\]*$', description: "File name inside the session's output directory. No path separators." }),
    description: Type.Optional(nullable(NonBlankString)),
    required: Type.Optional(nullable(Type.Boolean({ description: 'Default `true`. A required artifact must exist when its producer completes.' }))),
  },
  { $id: id('workflow/artifact'), title: 'Workflow artifact', description: 'An artifact definition.', additionalProperties: false },
);

export const WorkflowDecisionEntry = Type.Object(
  {
    when: Type.Optional(NonBlankString),
    navigate: Type.Union([NonBlankString, Type.Array(NonBlankString, { minItems: 1 })], {
      description: 'A stage id, `complete`, or a list of stage ids to run next.',
    }),
    artifacts: Type.Optional(
      Type.Union([Type.Array(NonBlankString), Type.Record(Type.String(), WorkflowArtifact, { propertyNames: { pattern: ARTIFACT_ID_PATTERN } })], {
        description: 'Artifacts produced under this decision: registry ids, or a mapping of inline artifact definitions.',
      }),
    ),
  },
  {
    $id: id('workflow/decision-entry'),
    title: 'Decision entry',
    description: 'The body of one decision value: when to choose it and where to go next.',
    additionalProperties: false,
  },
);

/** One list item of `decision`: exactly one decision value mapped to its body. */
export const WorkflowDecisionItem = Type.Record(Type.String(), WorkflowDecisionEntry, {
  minProperties: 1,
  maxProperties: 1,
  description: 'Exactly one decision value, mapped to its body.',
});

export const WorkflowDecisionList = Type.Array(WorkflowDecisionItem, { minItems: 1, description: 'Decision values and their routes.' });

export const WorkflowSession = Type.Object(
  { resume_from: Type.Optional(nullable(NonBlankString)) },
  { $id: id('workflow/session'), title: 'Stage session', description: 'Continue the client session of a dependency.', additionalProperties: false },
);

export const WorkflowRunWhen = Type.Object(
  { changed_paths: Type.Array(NonBlankString, { minItems: 1, description: 'Glob patterns. The stage runs only when a changed path matches.' }) },
  { $id: id('workflow/run-when'), title: 'Run condition', description: 'Runs the stage only when the session changed matching files.', additionalProperties: false },
);

export const WorkflowStage = Type.Object(
  {
    id: NonBlankString,
    description: Type.Optional(nullable(WorkflowLine)),
    role: Type.Optional(nullable(NonBlankString)),
    depends_on: Type.Optional(nullable(StringList('Stage ids that must complete first.'))),
    instructions: Type.Optional(nullable(StringList('Instructions added to the stage prompt.'))),
    agent: Type.Optional(nullable(RoleAgent)),
    ask: Type.Optional(Type.Literal('human', { description: '`human` lets the stage ask the user a question.' })),
    max_revisions: Type.Optional(Count),
    verify: Type.Optional(nullable(Type.Union([WorkflowLine, Type.Array(WorkflowLine, { minItems: 1 })], { description: 'Shell command or commands run after the stage.' }))),
    max_verify: Type.Optional(nullable(PositiveCount)),
    verify_timeout: Type.Optional(nullable(PositiveCount)),
    artifacts: Type.Optional(nullable(Type.Array(NonBlankString, { description: 'Registry artifact ids the stage produces.' }))),
    decision: Type.Optional(nullable(WorkflowDecisionList)),
    session: Type.Optional(nullable(WorkflowSession)),
    run_when: Type.Optional(nullable(WorkflowRunWhen)),
  },
  { $id: id('workflow/stage'), title: 'Workflow stage', description: 'One stage of a workflow.', additionalProperties: false },
);

export const WorkflowDownstream = Type.Object(
  {
    workflow: NonBlankString,
    task: RawLine,
    artifacts: Type.Optional(Type.Record(Type.String(), NonBlankString, { description: 'Downstream artifact name mapped to a registry artifact id.' })),
  },
  { $id: id('workflow/downstream'), title: 'Downstream suggestion', description: 'A workflow to suggest after this one completes.', additionalProperties: false },
);

export const WorkflowDocumentInput = Type.Object(
  {
    schema_version: Type.Optional(SchemaVersion),
    id: Type.Optional(nullable(NonBlankString)),
    stages: Type.Optional(Type.Array(WorkflowStage, { description: "The workflow's stages." })),
    artifacts: Type.Optional(nullable(Type.Record(Type.String(), WorkflowArtifact, { propertyNames: { pattern: ARTIFACT_ID_PATTERN }, description: 'Published artifacts by id.' }))),
    concurrency: Type.Optional(nullable(PositiveCount)),
    constraints: Type.Optional(nullable(StringList('Constraints included in every prompt.'))),
    downstream: Type.Optional(Type.Array(WorkflowDownstream, { description: 'Workflows to suggest next.' })),
    completion: Type.Optional(Type.Null({ description: 'Not allowed from schema_version 2; kept so older files report a migration hint.' })),
  },
  { $id: id('workflow/document'), title: 'Workflow file', description: 'An authored workflow file at schema_version 7.', additionalProperties: false },
);

export type WorkflowDocumentInput = Static<typeof WorkflowDocumentInput>;
export type WorkflowStageInput = Static<typeof WorkflowStage>;
