import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { HandoffFileError, loadHandoffFile } from "../src/handoff.ts";
import { renderProviderPrompt } from "@nodeint/migent-prompts";
import { loadQuestionFile } from "../src/questions.ts";

const question = {
  question: "Scope?", context: "Pick one.", selection: "single",
  options: [{ label: "New" }, { label: "All" }],
};

function load(content: string | null, rules: { decisionValues?: string[]; ask?: "human" | null } = {}) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "migent-handoff-")), "handoff.json");
  if (content !== null) writeFileSync(file, content);
  return loadHandoffFile(file, { decisionValues: rules.decisionValues ?? [], ask: rules.ask ?? null });
}

function kindOf(content: string | null, rules = {}): string {
  try {
    load(content, rules);
  } catch (error) {
    if (error instanceof HandoffFileError) return error.kind;
    throw error;
  }
  return "ok";
}

test("accepts the three statuses", () => {
  expect(load(JSON.stringify({ schema_version: 1, status: "complete", summary: "done" }))).toMatchObject({ status: "complete", decision: null });
  expect(load(JSON.stringify({ schema_version: 1, status: "blocked", blocker: "no schema" }))).toMatchObject({ status: "blocked", blocker: "no schema" });
  const asked = load(JSON.stringify({ schema_version: 1, status: "question", questions: [question] }), { ask: "human" });
  expect(asked.questions[0]).toMatchObject({ id: "1", options: [{ id: "A" }, { id: "B" }] });
});

test("rejects unusable files with a specific kind", () => {
  expect(kindOf(null)).toBe("missing");
  expect(kindOf("  \n")).toBe("empty");
  expect(kindOf("{nope")).toBe("invalid_json");
  expect(kindOf(JSON.stringify({ schema_version: 1, status: "done" }))).toBe("invalid_schema");
  expect(kindOf(JSON.stringify({ schema_version: 1, status: "complete", extra: 1 }))).toBe("invalid_schema");
  expect(kindOf(JSON.stringify({ schema_version: 1, status: "blocked" }))).toBe("invalid_schema");
  expect(kindOf(JSON.stringify({ schema_version: 2, status: "complete" }))).toBe("invalid_schema");
});

test("enforces the question batch invariants through the shared schema", () => {
  const ask = { ask: "human" as const };
  expect(kindOf(JSON.stringify({ schema_version: 1, status: "question", questions: [] }), ask)).toBe("invalid_schema");
  expect(kindOf(JSON.stringify({ schema_version: 1, status: "question", questions: [{ ...question, id: "2" }] }), ask)).toBe("invalid_schema");
  expect(kindOf(JSON.stringify({ schema_version: 1, status: "question", questions: [{ ...question, options: [{ label: "x" }] }] }), ask)).toBe("invalid_schema");
});

test("normalizes questions exactly as the protocol 2 question file does", () => {
  const document = { schema_version: 1, questions: [question, { ...question, question: "Other?" }] };
  const file = path.join(mkdtempSync(path.join(tmpdir(), "migent-handoff-")), "q.json");
  writeFileSync(file, JSON.stringify(document));
  const legacy = loadQuestionFile(file);
  const handoff = load(JSON.stringify({ ...document, status: "question" }), { ask: "human" });
  expect(handoff.questions).toEqual(legacy);
});

test("checks the decision against the stage", () => {
  const rules = { decisionValues: ["approved", "revise"] };
  expect(kindOf(JSON.stringify({ schema_version: 1, status: "complete" }), rules)).toBe("invalid_decision");
  expect(kindOf(JSON.stringify({ schema_version: 1, status: "complete", decision: "maybe" }), rules)).toBe("invalid_decision");
  expect(load(JSON.stringify({ schema_version: 1, status: "complete", decision: "Approved" }), rules).decision).toBe("approved");
  expect(load(JSON.stringify({ schema_version: 1, status: "blocked", blocker: "x" }), rules).decision).toBeNull();
});

test("a question needs a stage that asks a human", () => {
  expect(kindOf(JSON.stringify({ schema_version: 1, status: "question", questions: [question] }))).toBe("question_not_allowed");
});

test("the examples in the rendered contract pass the loader", () => {
  const prompt = renderProviderPrompt("body", { contract: true, ask: "human", decisionValues: ["approved", "revise"], handoffFile: "/h.json" });
  const lines = /```json\n([\s\S]*?)\n```/.exec(prompt)![1]!.split("\n");
  expect(lines).toHaveLength(3);
  for (const line of lines) expect(kindOf(line, { decisionValues: ["approved", "revise"], ask: "human" }), line).toBe("ok");
});
