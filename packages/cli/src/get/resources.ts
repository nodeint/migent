import {
  createProviderResolver,
  getConfigView,
  getAgentView,
  getRoleView,
  getSessionWorkflowView,
  getWorkflowView,
  listAgentViews,
  listRoleViews,
  listWorkflowViews,
  ConfigurationError,
  type ProviderResolver,
} from "@nodeint/migent-kernel";
import { providerMap } from "../provider.js";
import { field, count } from "./columns.js";
import { MACHINE_RESOURCES } from "./machine-resources.js";
import { cell, type Column } from "./render.js";
import type { ProjectResource, Resource } from "./resource-types.js";

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

const PROJECT_RESOURCES: readonly ProjectResource[] = [
  {
    scope: "project",
    kind: "workflow",
    names: ["workflow", "workflows", "wf"],
    summary: "Workflows in .migent/workflows, or one session's workflow with --session.",
    columns: [field("NAME", "name"), field("FILE", "file"), field("STAGES", "stages"), field("ROLES", "roles"), count("PROBLEMS", "problems")],
    list: (workspace) => listWorkflowViews(workspace),
    get: (workspace, name, resolve, session) =>
      session !== null
        ? getSessionWorkflowView(workspace, session, name, resolve)
        : getWorkflowView(workspace, requireName("workflow", name), resolve),
  },
  {
    scope: "project",
    kind: "role",
    names: ["role", "roles"],
    summary: "Roles in the effective config with their agent and description.",
    columns: [field("NAME", "name"), field("AGENT", "agent"), targetField("PROVIDER", "provider"), targetField("MODEL", "model"), field("DESCRIPTION", "description"), count("PROBLEMS", "problems")],
    list: (workspace, resolve) => listRoleViews(workspace, resolve),
    get: (workspace, name, resolve) => getRoleView(workspace, requireName("role", name), resolve),
  },
  {
    scope: "project",
    kind: "agent",
    names: ["agent", "agents"],
    summary: "Agents the project names: provider, model, effort, and CLI client (see `migent get providers` and `migent get clients`).",
    columns: [field("NAME", "name"), field("PROVIDER", "provider"), field("MODEL", "model"), field("CLIENT", "client"), field("LOCAL", "local"), count("PROBLEMS", "problems")],
    list: (workspace, resolve) => listAgentViews(workspace, resolve),
    get: (workspace, name, resolve) => getAgentView(workspace, requireName("agent", name), resolve),
  },
  {
    scope: "project",
    kind: "config",
    names: ["config"],
    summary: "The effective config: config.yaml with config.local.yaml merged over it.",
    columns: [],
    get: (workspace) => getConfigView(workspace),
  },
];

export const RESOURCES: readonly Resource[] = [...PROJECT_RESOURCES, ...MACHINE_RESOURCES];

export function findResource(type: string): Resource | undefined {
  return RESOURCES.find((resource) => resource.names.includes(type));
}

export function resourceTypes(): string {
  return RESOURCES.map((resource) => resource.names.slice(0, 2).join("|")).join(", ");
}

/** Pure lookup: resolving a provider never spawns a CLI. */
export function providerResolver(): ProviderResolver {
  return createProviderResolver(providerMap());
}
