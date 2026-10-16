export const SESSION_COLUMN = {
  updatedAt: 0,
  session: 1,
  workflow: 2,
  status: 3,
  execution: 4,
  decision: 5,
  outputs: 6,
  task: 7,
} as const;

export interface SessionFields {
  session: string;
  workflow: string;
  status: string;
  execution: string;
  decision: string;
  outputs: string;
  task: string;
}

export function sessionFields(row: readonly string[]): SessionFields {
  return {
    session: row[SESSION_COLUMN.session] ?? "",
    workflow: row[SESSION_COLUMN.workflow] ?? "",
    status: row[SESSION_COLUMN.status] ?? "",
    execution: row[SESSION_COLUMN.execution] ?? "",
    decision: row[SESSION_COLUMN.decision] ?? "",
    outputs: row[SESSION_COLUMN.outputs] ?? "",
    task: row[SESSION_COLUMN.task] ?? "",
  };
}
