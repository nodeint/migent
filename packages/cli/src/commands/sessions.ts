import { listSessionRows } from "@nodeint/migent-kernel";
import { printSessions } from "../display.js";

export function listSessions(workspace: string, options: { asJson?: boolean } = {}): number {
  const rows = listSessionRows(workspace);
  if (options.asJson) {
    const payload = rows.map((row) => ({
      session: row[1] ?? "",
      workflow: row[2] ?? "",
      status: row[3] ?? "",
      execution: row[4] ?? "",
      decision: row[5] ?? "",
      outputs: row[6] ?? "",
      task: row[7] ?? "",
    }));
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return 0;
  }
  printSessions(rows);
  return 0;
}
