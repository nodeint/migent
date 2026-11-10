import { ConfigurationError, type ClientRegistry } from "@nodeint/migent-kernel";
import { getConfigView, getAgentView, getRoleView, getSessionWorkflowView, getWorkflowView, listAgentViews, listRoleViews, listWorkflowViews } from "@nodeint/migent-engine";
import { GetAgent, GetConfig, GetRole, GetWorkflow, GetWorkflowSummary } from "@nodeint/migent-contracts";
import { clientRegistry } from "../client.js";
import { field, count } from "./columns.js";
import { MACHINE_RESOURCES } from "./machine-resources.js";
import { cell, type Column } from "./render.js";
import { asView, type ProjectResource, type Resource } from "./resource-types.js";

const targetField = (header: string, key: string): Column => ({
  header,
  cell: (view) => {
    const target = view.target;
    return typeof target === "object" && target !== null ? cell((target as Record<string, unknown>)[key]) : "-";
  },
});

function requireName(label: string, name: string | null): string {
  if (name === null) throw new ConfigurationError(`Pass a ${label} name.`);
  return name;
}

const workflowResource: ProjectResource<typeof GetWorkflow, typeof GetWorkflowSummary> = {
  scope: "project",
  kind: "workflow",
  names: ["workflow", "workflows", "wf"],
  contract: GetWorkflow,
  listContract: GetWorkflowSummary,
  summary: "Workflows in .migent/workflows, or one session's workflow with --session.",
  columns: [field("NAME", "name"), field("FILE", "file"), field("STAGES", "stages"), field("ROLES", "roles"), count("PROBLEMS", "problems")],
  list: (workspace) => listWorkflowViews(workspace).map((view) => asView(GetWorkflowSummary, view)),
  get: (workspace, name, resolve, session) =>
    asView(
      GetWorkflow,
      session !== null
        ? getSessionWorkflowView(workspace, session, name, resolve)
        : getWorkflowView(workspace, requireName("workflow", name), resolve),
    ),
};

const roleResource: ProjectResource<typeof GetRole, typeof GetRole> = {
  scope: "project",
  kind: "role",
  names: ["role", "roles"],
  contract: GetRole,
  listContract: GetRole,
  summary: "Roles in the effective config with their agent and description.",
  columns: [field("NAME", "name"), field("AGENT", "agent"), targetField("CLIENT", "client"), targetField("MODEL", "model"), field("DESCRIPTION", "description"), count("PROBLEMS", "problems")],
  list: (workspace, resolve) => listRoleViews(workspace, resolve).map((view) => asView(GetRole, view)),
  get: (workspace, name, resolve) => asView(GetRole, getRoleView(workspace, requireName("role", name), resolve)),
};

const agentResource: ProjectResource<typeof GetAgent, typeof GetAgent> = {
  scope: "project",
  kind: "agent",
  names: ["agent", "agents"],
  contract: GetAgent,
  listContract: GetAgent,
  summary: "Agents the project names: client, model, effort, and CLI client options (see `migent get clients`).",
  columns: [field("NAME", "name"), field("CLIENT", "client"), field("MODEL", "model"), field("LOCAL", "local"), count("PROBLEMS", "problems")],
  list: (workspace, resolve) => listAgentViews(workspace, resolve).map((view) => asView(GetAgent, view)),
  get: (workspace, name, resolve) => asView(GetAgent, getAgentView(workspace, requireName("agent", name), resolve)),
};

const configResource: ProjectResource<typeof GetConfig, typeof GetConfig> = {
  scope: "project",
  kind: "config",
  names: ["config"],
  contract: GetConfig,
  listContract: GetConfig,
  summary: "The effective config: config.yaml with config.local.yaml merged over it.",
  columns: [],
  get: (workspace) => asView(GetConfig, getConfigView(workspace)),
};

const PROJECT_RESOURCES: readonly Resource[] = [workflowResource, roleResource, agentResource, configResource];

export const RESOURCES: readonly Resource[] = [...PROJECT_RESOURCES, ...MACHINE_RESOURCES];

export function findResource(type: string): Resource | undefined {
  return RESOURCES.find((resource) => resource.names.includes(type));
}

export function resourceTypes(): string {
  return RESOURCES.map((resource) => resource.names.slice(0, 2).join("|")).join(", ");
}

/** Pure lookup: resolving a client never spawns a CLI. */
export function clientResolver(): ClientRegistry {
  return clientRegistry();
}
