import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { AgentToolRunner } from "../src/agent-runner.ts";
import { executeNamedWorkflow } from "../src/execute.ts";
import { parseWorkflowMapping } from "../src/workflow.ts";
import { parseStageOutcome } from "../src/stage-outcome.ts";
import { SessionStore } from "../src/session-store.ts";
import { watchSnapshot } from "../src/query.ts";
import { repairSession } from "../src/session-repair.ts";
import { SessionLock } from "../src/session-lock.ts";
import { ScriptedProvider } from "./support.ts";

const scopeQuestion = {
  id: "1", question: "Support existing sessions?", context: "Migration costs more.",
  selection: "single", options: [{ id: "A", label: "New sessions only" }, { id: "B", label: "Include existing sessions" }],
};
const question = "status: question\n\n" + JSON.stringify({ schema_version: 1, questions: [scopeQuestion] });

function workspace(stages: string, extra = ""): string {
  const root = mkdtempSync(path.join(tmpdir(), "migent-question-"));
  mkdirSync(path.join(root, ".migent/workflows"), { recursive: true });
  writeFileSync(path.join(root, ".migent/config.yaml"), "schema_version: 3\nroles:\n  planner:\n    default_model: { provider: fake, model: fake }\n");
  writeFileSync(path.join(root, ".migent/workflows/plan.yaml"), `schema_version: 3\nid: plan\n${extra}stages:\n${stages}`);
  return root;
}

test("question requires an opted-in recipient and a structured question document", () => {
  expect(() => parseStageOutcome(question, true)).toThrow("requires ask: human");
  expect(() => parseStageOutcome("status: question\nquestion: Plain text", true, [], "human")).toThrow("JSON question document");
  expect(parseStageOutcome(question.replace("status: question", "status: question\ndecision: approved"), true, ["approved"], "human")?.toJson()).toMatchObject({ status: "question", question: "Support existing sessions?", questions: [scopeQuestion] });
});

test.each(["jev", "some-role", true, null, { when: "Ask" }])("rejects unsupported ask recipient %j", (ask) => {
  expect(() => parseWorkflowMapping({ schema_version: 3, stages: [{ id: "plan", role: "planner", ask }] }, "plan.yaml")).toThrow("ask must be human");
});

test("verify-only stages cannot ask", () => {
  expect(() => parseWorkflowMapping({ schema_version: 3, stages: [{ id: "check", verify: ["node --version"], ask: "human" }] }, "plan.yaml")).toThrow("ask requires a role");
});

test("question persists through repair, waits without reply, and resumes the conversation with an artifact", async () => {
  const root = workspace("  - id: plan\n    role: planner\n    ask: human\n    produces: { artifact: plan.md }\n", "outputs:\n  - { name: plan, from_stage: plan, artifact: plan.md }\n");
  try {
    const provider = new ScriptedProvider([question, "status: complete\n\nDone"], ["# Partial plan", null]);
    const runner = new AgentToolRunner({ fake: provider }, 10);
    const first = await executeNamedWorkflow(root, { workflowId: "plan", task: "Plan" }, runner);
    expect(first.code).toBe(9);
    expect(first.stopReason).toBe("question");
    const sessionDir = path.join(root, ".migent/sessions", first.sessionId);
    const history = () => JSON.parse(readFileSync(path.join(sessionDir, "questions.json"), "utf8"));
    expect(history().questions).toMatchObject([{ id: "1", status: "pending", selection: "single", options: scopeQuestion.options }]);
    const questionFile = path.join(sessionDir, "executions/0001-plan--attempt-01/questions.json");
    expect(JSON.parse(readFileSync(questionFile, "utf8")).questions).toEqual([scopeQuestion]);
    rmSync(questionFile);
    rmSync(path.join(sessionDir, "questions.json"));
    expect(readFileSync(path.join(sessionDir, "workflow.frozen.yaml"), "utf8")).toContain("ask: human");
    repairSession(root, first.sessionId);
    expect(JSON.parse(readFileSync(questionFile, "utf8")).questions).toEqual([scopeQuestion]);
    expect(history().questions[0].status).toBe("pending");
    expect(new SessionStore(root).readSessionStatus(first.sessionId).questions).toMatchObject([{ stage_id: "plan", question: "Support existing sessions?" }]);
    const again = await executeNamedWorkflow(root, { sessionId: first.sessionId }, runner);
    expect(again.code).toBe(9);
    expect(provider.calls).toHaveLength(1);
    const result = await executeNamedWorkflow(root, { sessionId: first.sessionId, reply: "New sessions only" }, runner);
    expect(result.code).toBe(0);
    expect(provider.calls[1]?.agentId).toBe("native-session-1");
    expect(provider.calls[1]?.prompt).toContain("Reply to: Support existing sessions?");
    expect(provider.calls[1]?.prompt).toContain("New sessions only");
    expect(readFileSync(path.join(sessionDir, "outputs/plan.md"), "utf8")).toBe("# Partial plan");
    expect(new SessionStore(root).executionSnapshots(first.sessionId)).toHaveLength(2);
    expect(new SessionStore(root).readSessionStatus(first.sessionId).questions).toBeUndefined();
    expect(history().questions).toMatchObject([{ status: "answered", answer: { question_id: "1", text: "New sessions only" } }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("blocked takes priority, questions stay visible, and a reply targets only its stage", async () => {
  const root = workspace("  - { id: plan, role: planner, ask: human }\n  - { id: resources, role: planner }\n");
  try {
    const provider = new ScriptedProvider([question, "status: blocked\nblocker: Missing resource\n", "status: complete\n"]);
    const runner = new AgentToolRunner({ fake: provider }, 10);
    const first = await executeNamedWorkflow(root, { workflowId: "plan", task: "Plan" }, runner);
    expect(first.code).toBe(1);
    const store = new SessionStore(root);
    expect(store.readSessionStatus(first.sessionId).status).toBe("blocked");
    expect(store.questionStages(first.sessionId)).toHaveLength(1);
    expect(watchSnapshot(path.join(root, ".migent/sessions", first.sessionId)).questions).toMatchObject([{ stage_id: "plan" }]);
    const result = await executeNamedWorkflow(root, { sessionId: first.sessionId, stageId: "plan", reply: "New only" }, runner);
    expect(result.code).toBe(1);
    expect(store.blockedStages(first.sessionId).map((row) => row.stageId)).toEqual(["resources"]);
    expect(store.questionStages(first.sessionId)).toHaveLength(0);
    expect(provider.calls).toHaveLength(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a question stops its dependents but independent stages continue", async () => {
  const root = workspace("  - { id: plan, role: planner, ask: human }\n  - { id: dependent, role: planner, depends_on: [plan] }\n  - { id: independent, role: planner }\n");
  try {
    const provider = new ScriptedProvider([question, "status: complete\n"]);
    const first = await executeNamedWorkflow(root, { workflowId: "plan", task: "Plan" }, new AgentToolRunner({ fake: provider }, 10));
    expect(first.code).toBe(9);
    expect(new SessionStore(root).executionSnapshots(first.sessionId).map((row) => row.stageId)).toEqual(["plan", "independent"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a stage without ask cannot question", async () => {
  const root = workspace("  - { id: plan, role: planner }\n");
  try {
    const result = await executeNamedWorkflow(root, { workflowId: "plan", task: "Plan" }, new AgentToolRunner({ fake: new ScriptedProvider([question]) }, 10));
    expect(result.code).toBe(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("question between verify repairs carries the artifact and failure budget", async () => {
  const root = workspace(`  - id: plan\n    role: planner\n    ask: human\n    produces: { artifact: plan.md }\n    max_verify: 2\n    verify:\n      - '${JSON.stringify(process.execPath)} verify.cjs'\n`);
  try {
    writeFileSync(path.join(root, "verify.cjs"), "process.exit(1)");
    const provider = new ScriptedProvider(["status: complete\n", question, "status: complete\n"], ["# Draft", null, null]);
    const runner = new AgentToolRunner({ fake: provider }, 10);
    const first = await executeNamedWorkflow(root, { workflowId: "plan", task: "Plan" }, runner);
    expect(first.code).toBe(9);
    const store = new SessionStore(root);
    const old = store.executionSnapshots(first.sessionId)[0]!;
    const oldMetadata = JSON.parse(readFileSync(path.join(path.dirname(old.artifactDirectory), "execution.json"), "utf8"));
    expect(oldMetadata.verify.red).toBe(1);
    const result = await executeNamedWorkflow(root, { sessionId: first.sessionId, reply: "Keep the behavior" }, runner);
    expect(result.code).toBe(6);
    expect(provider.calls).toHaveLength(3);
    const latest = store.executionSnapshots(first.sessionId).at(-1)!;
    const metadata = JSON.parse(readFileSync(path.join(path.dirname(latest.artifactDirectory), "execution.json"), "utf8"));
    expect(metadata.verify.red).toBe(2);
    expect(metadata.verify.runs).toBe(2);
    expect(readFileSync(path.join(latest.artifactDirectory, "plan.md"), "utf8")).toBe("# Draft");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("once returns 9 for a question while independent work is still ready", async () => {
  const root = workspace("  - { id: plan, role: planner, ask: human }\n  - { id: independent, role: planner }\n");
  try {
    const provider = new ScriptedProvider([question, "status: complete\n"]);
    const runner = new AgentToolRunner({ fake: provider }, 10);
    const first = await executeNamedWorkflow(root, { workflowId: "plan", task: "Plan", once: true }, runner);
    expect(first.code).toBe(9);
    expect(first.stopReason).toBe("question");
    expect(new SessionStore(root).readSessionStatus(first.sessionId).status).toBe("active");
    const rest = await executeNamedWorkflow(root, { sessionId: first.sessionId }, runner);
    expect(rest.code).toBe(9);
    expect(provider.calls).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("multiple questions require a target and an answered stage can ask again", async () => {
  const root = workspace("  - { id: plan, role: planner, ask: human }\n  - { id: other, role: planner, ask: human }\n");
  try {
    const provider = new ScriptedProvider([question, question, question, "status: complete\n"]);
    const runner = new AgentToolRunner({ fake: provider }, 10);
    const first = await executeNamedWorkflow(root, { workflowId: "plan", task: "Plan" }, runner);
    await expect(executeNamedWorkflow(root, { sessionId: first.sessionId, reply: "New only" }, runner)).rejects.toThrow("--reply needs --stage");
    expect(provider.calls).toHaveLength(2);
    await executeNamedWorkflow(root, { sessionId: first.sessionId, stageId: "plan", reply: "New only" }, runner);
    const waiting = await executeNamedWorkflow(root, { sessionId: first.sessionId }, runner);
    expect(waiting.code).toBe(9);
    expect(provider.calls).toHaveLength(3);
    await executeNamedWorkflow(root, { sessionId: first.sessionId, stageId: "plan", reply: "Confirmed" }, runner);
    expect(new SessionStore(root).questionStages(first.sessionId).map((row) => row.stageId)).toEqual(["other"]);
    const history = JSON.parse(readFileSync(path.join(root, ".migent/sessions", first.sessionId, "questions.json"), "utf8"));
    expect(history.questions.map((row: { status: string }) => row.status)).toEqual(["answered", "pending", "answered"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an answer survives interruption before the next execution is created", async () => {
  const root = workspace("  - { id: plan, role: planner, ask: human }\n");
  try {
    const provider = new ScriptedProvider([question, "status: complete\n"]);
    const runner = new AgentToolRunner({ fake: provider }, 10);
    const first = await executeNamedWorkflow(root, { workflowId: "plan", task: "Plan" }, runner);
    const lock = SessionLock.acquire(path.join(root, ".migent/sessions", first.sessionId));
    try { new SessionStore(root).resumeQuestion(first.sessionId, "plan", "Saved answer"); }
    finally { lock.release(); }
    const result = await executeNamedWorkflow(root, { sessionId: first.sessionId }, runner);
    expect(result.code).toBe(0);
    expect(provider.calls[1]?.prompt).toContain("Saved answer");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verification passes after repeated questions without consuming extra failures", async () => {
  const root = workspace(`  - id: plan\n    role: planner\n    ask: human\n    produces: { artifact: plan.md }\n    max_verify: 2\n    verify:\n      - '${JSON.stringify(process.execPath)} verify.cjs'\n`);
  try {
    writeFileSync(path.join(root, "verify.cjs"), "const fs=require('node:fs'); if (!fs.existsSync('ready')) process.exit(1)");
    const provider = new ScriptedProvider(["status: complete\n", question, question, "status: complete\n"], ["# Draft", null, null, null]);
    const runner = new AgentToolRunner({ fake: provider }, 10);
    const first = await executeNamedWorkflow(root, { workflowId: "plan", task: "Plan" }, runner);
    await executeNamedWorkflow(root, { sessionId: first.sessionId, reply: "Please clarify" }, runner);
    writeFileSync(path.join(root, "ready"), "yes");
    const last = await executeNamedWorkflow(root, { sessionId: first.sessionId, reply: "Proceed" }, runner);
    expect(last.code).toBe(0);
    const latest = new SessionStore(root).executionSnapshots(first.sessionId).at(-1)!;
    const metadata = JSON.parse(readFileSync(path.join(path.dirname(latest.artifactDirectory), "execution.json"), "utf8"));
    expect(metadata.verify.red).toBe(1);
    expect(metadata.verify.runs).toBe(2);
    expect(provider.calls[3]?.prompt).toContain("Previous verify report:");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a reply keeps the questioning execution even when session.resume_from names a dependency", async () => {
  const root = workspace("  - { id: base, role: planner }\n  - id: plan\n    role: planner\n    ask: human\n    depends_on: [base]\n    session: { resume_from: base }\n");
  try {
    const provider = new ScriptedProvider(["status: complete\n", question, "status: complete\n"]);
    const runner = new AgentToolRunner({ fake: provider }, 10);
    const first = await executeNamedWorkflow(root, { workflowId: "plan", task: "Plan" }, runner);
    await executeNamedWorkflow(root, { sessionId: first.sessionId, reply: "Proceed" }, runner);
    const rows = new SessionStore(root).executionSnapshots(first.sessionId);
    const latest = rows.at(-1)!;
    const metadata = JSON.parse(readFileSync(path.join(path.dirname(latest.artifactDirectory), "execution.json"), "utf8"));
    expect(metadata.resumes_execution_id).toBe(rows[1]!.executionId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a selected question returns 9 even when another branch is blocked", async () => {
  const root = workspace("  - { id: resources, role: planner }\n  - { id: plan, role: planner, ask: human }\n");
  try {
    const provider = new ScriptedProvider(["status: blocked\nblocker: Missing resource\n", question]);
    const runner = new AgentToolRunner({ fake: provider }, 10);
    const first = await executeNamedWorkflow(root, { workflowId: "plan", task: "Plan", stageId: "resources" }, runner);
    const result = await executeNamedWorkflow(root, { sessionId: first.sessionId, stageId: "plan" }, runner);
    expect(result.code).toBe(9);
    expect(result.stopReason).toBe("question");
    expect(new SessionStore(root).readSessionStatus(first.sessionId).status).toBe("blocked");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a batch validates single and multiple selections before resuming and records every answer", async () => {
  const root = workspace("  - { id: plan, role: planner, ask: human }\n");
  const batch = "status: question\n\n" + JSON.stringify({ schema_version: 1, questions: [
    scopeQuestion,
    { id: "2", question: "Which platforms?", context: "Select all supported platforms.", selection: "multiple",
      options: [{ id: "A", label: "Linux" }, { id: "B", label: "Windows" }] },
    { id: "3", question: "Is the migration requirement clear?", context: "Confirm before planning migration.", selection: "single",
      options: [{ label: "Clear" }, { label: "Explain further" }] },
  ] });
  try {
    const provider = new ScriptedProvider([batch, "status: complete\n"]);
    const runner = new AgentToolRunner({ fake: provider }, 10);
    const first = await executeNamedWorkflow(root, { workflowId: "plan", task: "Plan" }, runner);
    const file = path.join(root, ".migent/sessions", first.sessionId, "questions.json");
    expect(JSON.parse(readFileSync(file, "utf8")).questions).toHaveLength(3);
    await expect(executeNamedWorkflow(root, { sessionId: first.sessionId, reply: '{"1":["A","B"],"2":["A"],"3":"unclear"}' }, runner)).rejects.toThrow("exactly one");
    expect(provider.calls).toHaveLength(1);
    expect(new SessionStore(root).readSessionStatus(first.sessionId).status).toBe("question");
    const result = await executeNamedWorkflow(root, { sessionId: first.sessionId, reply: '1A, 2A+B, 3 chưa rõ - giải thích thêm' }, runner);
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8")).questions).toMatchObject([
      { status: "answered", answer: { selected: ["A"] } },
      { status: "answered", answer: { selected: ["A", "B"] } },
      { status: "answered", answer: { selected: [], text: "chưa rõ - giải thích thêm" } },
    ]);
    expect(provider.calls[1]?.prompt).toContain('"labels": [');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
