import { z } from 'zod';

export const stageArtifactSchema = z.object({
  id: z.string(),
  file: z.string(),
  description: z.string().nullable(),
  required: z.boolean(),
  scope: z.enum(['published', 'local']),
});

export const stageFieldSchema = {
  ask: z.literal('human').optional(),
  id: z.string(),
  description: z.string().nullable(),
  artifacts: z.array(stageArtifactSchema),
  decisionArtifacts: z.record(z.string(), z.array(stageArtifactSchema)),
  decisionValues: z.array(z.string()),
  decisionInstructions: z.record(z.string(), z.string()).optional(),
  dependsOn: z.array(z.string()),
  resumeFrom: z.string().nullable(),
  instructions: z.array(z.string()),
  agent: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('named'), name: z.string() }),
      z.object({ kind: z.literal('inline'), value: z.record(z.string(), z.unknown()) }),
    ])
    .nullable(),
  options: z.record(z.string(), z.string()),
  maxRevisions: z.number().int().nonnegative().nullable(),
  routes: z.record(z.string(), z.union([z.string(), z.array(z.string()).min(1)])),
  verify: z.array(z.string()),
  verifyTimeoutSec: z.number().int().min(1).nullable(),
  runWhen: z.object({ changedPaths: z.array(z.string()).min(1) }).nullable(),
};

export const stageSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    ...stageFieldSchema,
    kind: z.literal('role'),
    role: z.string(),
    maxVerify: z.number().int().min(1),
  }),
  z.object({
    ...stageFieldSchema,
    kind: z.literal('verify'),
    role: z.null(),
    verify: z.array(z.string()).min(1),
    maxVerify: z.literal(0),
  }),
]);

export const workflowOutputSchema = z.object({
  name: z.string(),
  fromStage: z.string(),
  artifact: z.string(),
  required: z.boolean().optional(),
  decision: z.string().nullable().optional(),
});

export const artifactSpecSchema = stageArtifactSchema.extend({
  producer: z.object({ stage: z.string(), decision: z.string().nullable() }),
});

export const workflowCompletionSchema = z.object({
  stage: z.string(),
  decision: z.string().nullable(),
  outputs: z.array(workflowOutputSchema),
});

export const workflowRequiresSchema = z.object({
  workflow: z.string(),
  decision: z.string().nullable(),
});

export const workflowDocumentSchema = z.object({
  id: z.string(),
  stages: z.record(z.string(), stageSpecSchema),
  completion: workflowCompletionSchema.nullable(),
  requires: workflowRequiresSchema.nullable(),
  constraints: z.array(z.string()),
  source: z.string().nullable(),
  schemaVersion: z.number().int().nonnegative().optional(),
  concurrency: z.number().int().positive().optional(),
  outputs: z.array(workflowOutputSchema).optional(),
  artifacts: z.array(artifactSpecSchema).optional(),
  downstream: z.array(z.object({
    workflow: z.string(),
    task: z.string(),
    artifacts: z.record(z.string(), z.string()).optional(),
  })).optional(),
});
