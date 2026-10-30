import { readdirSync } from "node:fs";
import path from "node:path";
import { AgentToolRunner, SessionStore } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { continueAgent, dispatchAgent } from "../src/commands/agent.ts";
import { listSessions } from "../src/commands/sessions.ts";
import { followSession } from "../src/commands/watch.ts";
import { executeWorkflow } from "../src/commands/execute.ts";
import { capture, removeWorkspace, ScriptedProvider, writeFakeWorkflowWorkspace } from "./support.ts";

const question = "status: question\n\n" + JSON.stringify({ schema_version: 1, questions: [{
  id: "1", question: "Include old sessions?", context: "Migration is required.", selection: "single",
  options: [{ id: "A", label: "New sessions only" }, { id: "B", label: "Include old sessions" }],
}] });

test("standalone role questions wait, list and follow with exit 9, then accept a reply", async () => {
  const root = writeFakeWorkflowWorkspace({});
  const provider = new ScriptedProvider([
    question,
    "status: complete\n\nUse new sessions only.",
  ]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  try {
    const first = await capture(() => dispatchAgent(root, { role: "reviewer", prompt: "Review scope", runner, asJson: true }));
    expect(first.value).toBe(9);
    const id = readdirSync(path.join(root, ".migent/sessions"))[0]!;
    expect(new SessionStore(root).readSessionStatus(id).status).toBe("question");
    const list = await capture(() => listSessions(root, { status: "question", asJson: true }));
    expect(list.value).toBe(0);
    expect(JSON.parse(list.stdout)).toHaveLength(1);
    const shown = await capture(() => followSession(root, id, { once: true }));
    expect(shown.value).toBe(0);
    expect(shown.stdout).toContain("Include old sessions?");
    expect(shown.stdout).toContain("A free-text answer is always allowed.");
    const follow = await capture(() => followSession(root, id, { exitWhenDone: true }));
    expect(follow.value).toBe(9);
    const waiting = await capture(() => continueAgent(root, { sessionId: id, reply: null, runner }));
    expect(waiting.value).toBe(9);
    expect(provider.calls).toHaveLength(1);
    const replied = await capture(() => continueAgent(root, { sessionId: id, reply: "New only", runner }));
    expect(replied.value).toBe(0);
    expect(provider.calls[1]?.agent_id).toBe("native-session-1");
    expect(provider.calls[1]?.prompt).toContain("New only");
  } finally { removeWorkspace(root); }
});

test("workflow run prints the pending question and its response after a newer sibling finishes", async () => {
  const root = writeFakeWorkflowWorkspace({ plan: "schema_version: 3\nid: plan\nstages:\n  - { id: plan, role: planner, ask: human }\n  - { id: docs, role: planner }\n" });
  const provider = new ScriptedProvider([
    question,
    "status: complete\n\nDocs inspected.",
  ]);
  try {
    const result = await capture(() => executeWorkflow(root, {
      action: "start", workflowId: "plan", task: "Plan", runner: new AgentToolRunner({ fake: provider }, 10),
    }));
    expect(result.value).toBe(9);
    expect(result.stderr).toContain("1. Include old sessions? (choose one; stage plan)");
    expect(result.stderr).toContain("A. New sessions only");
    expect(result.stderr).toContain("questions.json");
    expect(result.stderr).toContain('--stage plan --reply "<answer>"');
  } finally { removeWorkspace(root); }
});
