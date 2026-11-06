import { isRoleStage, type AgentDefinitionEntry, type WorkflowDocument } from "@nodeint/migent-kernel";

/** The key an availability or effort check of a stage's inline agent is stored under. */
export function stageAgentKey(workflowId: string, stageId: string): string {
  return `stages.${workflowId}.${stageId}.agent`;
}

/**
 * The complete agents that stages carry inline. They are checked like named agents; `field`
 * names the stage in messages, and `key` keeps equal stage ids of different workflows apart.
 */
export function stageAgentDefinitions(documents: Iterable<WorkflowDocument>): AgentDefinitionEntry[] {
  const entries: AgentDefinitionEntry[] = [];
  for (const document of documents) {
    for (const stage of Object.values(document.stages)) {
      if (!isRoleStage(stage) || stage.agent?.kind !== "inline") continue;
      entries.push({
        key: stageAgentKey(document.id, stage.id),
        value: stage.agent.value,
        field: `stages.${stage.id}.agent`,
        path: ["stages", stage.id, "agent"],
      });
    }
  }
  return entries;
}
