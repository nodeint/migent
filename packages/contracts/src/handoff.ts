import Type, { type Static } from 'typebox';

import { id } from './common.js';
import { HANDOFF_SCHEMA_VERSION } from './data/versions.js';

export { HANDOFF_SCHEMA_VERSION };

/**
 * Structure of the handoff document an agent writes under response protocol 3. Pure data: the
 * kernel adds the stage-dependent rules (the decision must be one the stage allows, `question`
 * needs `ask: human`) and normalizes questions (assigns IDs and option letters). Closed objects:
 * an unknown key is an error.
 */

const Text = Type.String({ pattern: '\\S', description: 'Non-blank text.' });

export const HandoffQuestionOption = Type.Object(
  {
    id: Type.Optional(Type.String({ pattern: '^[A-Z]$', description: 'Omit it: Migent letters options A, B, C… in order.' })),
    label: Text,
    description: Type.Optional(Text),
  },
  { additionalProperties: false },
);

export const HandoffQuestion = Type.Object(
  {
    id: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$', description: 'Omit it: Migent numbers questions 1, 2, 3… in order.' })),
    question: Text,
    context: Text,
    selection: Type.Union([Type.Literal('single'), Type.Literal('multiple')]),
    options: Type.Array(HandoffQuestionOption, { minItems: 2, maxItems: 26 }),
    recommended: Type.Optional(Type.Array(Type.String({ pattern: '^[A-Z]$' }), { minItems: 1, description: 'Option letters; at most one for `single`.' })),
  },
  { additionalProperties: false },
);

export const HandoffDocument = Type.Union(
  [
    Type.Object(
      {
        schema_version: Type.Literal(HANDOFF_SCHEMA_VERSION),
        status: Type.Literal('complete'),
        decision: Type.Optional(Text),
        summary: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { schema_version: Type.Literal(HANDOFF_SCHEMA_VERSION), status: Type.Literal('blocked'), blocker: Text },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schema_version: Type.Literal(HANDOFF_SCHEMA_VERSION),
        status: Type.Literal('question'),
        questions: Type.Array(HandoffQuestion, { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
  ],
  {
    $id: id('handoff/document'),
    title: 'Stage handoff document',
    description: 'The one JSON file a stage writes to `handoff.json` in its execution directory (response protocol 3).',
  },
);

export type HandoffDocumentType = Static<typeof HandoffDocument>;
