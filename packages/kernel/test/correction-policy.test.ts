import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { AgentToolRunner } from "../src/index.ts";
import {
  CORRECTION_FAILURE_REASONS, CORRECTION_POLICY, classifyGateError, decideCorrection, readCorrectionLedger,
} from "../src/correction-policy.ts";
import { HandoffFileError } from "../src/handoff.ts";
import { QuestionFileError } from "../src/questions.ts";
import { ResponseContractError, parseStageOutcome } from "../src/stage-outcome.ts";
import { ScriptedClient, registryOf, writePlanReviewSession } from "./support.ts";

function execution(workspace: string, sessionId: string, executionId: string): Record<string, any> {
  return JSON.parse(readFileSync(
    path.join(workspace, ".migent", "sessions", sessionId, "executions", executionId, "execution.json"), "utf8",
  ));
}

async function runPlan(responses: string[], artifacts: Array<string | null>) {
  const [workspace, sessionId] = writePlanReviewSession();
  const provider = new ScriptedClient(responses, artifacts);
  const result = await new AgentToolRunner(registryOf({ fake: provider }), 10).run({
    client: "fake", model: "m1", prompt: "plan", workspace, sessionId, stageId: "plan",
  });
  return { provider, result, record: execution(workspace, sessionId, result.execution_id) };
}

test("classify maps typed gate errors to a kind and leaves other errors alone", () => {
  expect(classifyGateError(new ResponseContractError("x"))?.kind).toBe("response_contract");
  expect(classifyGateError(new QuestionFileError("missing", "d", "/f"))?.kind).toBe("question_file");
  expect(classifyGateError(new Error("provider"))).toBeNull();
});

test("every handoff error kind maps to the handoff correction kind", () => {
  for (const kind of ["missing", "empty", "invalid_json", "invalid_schema", "invalid_decision", "question_not_allowed"] as const) {
    expect(classifyGateError(new HandoffFileError(kind, "d", "/f"))).toMatchObject({ kind: "handoff", errorKind: kind, detail: "d" });
  }
  expect(CORRECTION_POLICY.handoff).toMatchObject({
    budget: 1, contract: "full", turnKind: "handoff_correction", event: "handoff.file_invalid",
    failureReason: "handoff_file_invalid", keepFile: true,
  });
});

test("handoff and stage_output budgets are independent and the ledger round-trips corrections.handoff", () => {
  const ledger = readCorrectionLedger({ corrections: { handoff: { turn: 1, error_kind: "missing", error_detail: "d" } } });
  expect(ledger.handoff).toMatchObject({ turn: 1, error_kind: "missing" });
  expect(decideCorrection("handoff", ledger, 2)).toBe("exhausted");
  expect(decideCorrection("handoff", ledger, 1)).toBe("resend");
  expect(decideCorrection("stage_output", ledger, 2)).toBe("correct");
});

test("decide grants once per kind, resends at the same turn, then exhausts", () => {
  expect(decideCorrection("response_contract", {}, 1)).toBe("correct");
  const ledger = { response_contract: { turn: 1, error_kind: "contract", error_detail: "d" } };
  expect(decideCorrection("response_contract", ledger, 1)).toBe("resend");
  expect(decideCorrection("response_contract", ledger, 2)).toBe("exhausted");
  expect(decideCorrection("stage_output", ledger, 2)).toBe("correct");
});

test("a legacy question_correction is read as the question_file entry", () => {
  const ledger = readCorrectionLedger({ question_correction: { turn: 2, error_kind: "missing", error_detail: "d" } });
  expect(ledger.question_file).toMatchObject({ turn: 2, error_kind: "missing" });
  const both = readCorrectionLedger({
    question_correction: { turn: 2 }, corrections: { question_file: { turn: 3, error_kind: "a", error_detail: "b" } },
  });
  expect(both.question_file?.turn).toBe(3);
});

test("failure reasons come from the policy table", () => {
  expect(CORRECTION_FAILURE_REASONS).toEqual(Object.values(CORRECTION_POLICY).map((rule) => rule.failureReason));
  expect(CORRECTION_FAILURE_REASONS).toContain("response_contract_invalid");
  expect(CORRECTION_FAILURE_REASONS).toContain("stage_output_missing");
  expect(CORRECTION_FAILURE_REASONS).toContain("handoff_file_invalid");
});

test("a missing status header lists the statuses the stage allows", () => {
  expect(() => parseStageOutcome("hello", true, [], null)).toThrow("`status: complete` or `status: blocked`");
  expect(() => parseStageOutcome("hello", true, [], "human")).toThrow("`status: complete`, `status: blocked` or `status: question`");
});

test("a missing handoff gets one full-contract correction and the rewritten handoff completes", async () => {
  const { provider, result, record } = await runPlan(["no header", "status: complete\n\nplanned"], [null, "# Plan\n"]);
  expect(provider.calls).toHaveLength(2);
  expect(provider.calls[1]?.prompt).toContain("## Invalid handoff file");
  expect(provider.calls[1]?.prompt).toContain("## Response contract\n\nWrite one JSON document");
  expect(provider.calls[1]?.prompt).toContain("## Do\n\nRewrite the whole handoff file");
  expect(result.failure_reason).toBe("");
  expect(record.status).toBe("completed");
  expect(record.response_protocol).toBe(3);
  expect(record.corrections.handoff).toMatchObject({ turn: 1, error_kind: "missing" });
  expect(record.question_correction).toBeUndefined();
});

test("a second handoff violation fails with the original error and the kind's reason", async () => {
  const { provider, result, record } = await runPlan(["no header", "still none", "never sent"], [null, null, null]);
  expect(provider.calls).toHaveLength(2);
  expect(result.failure_reason).toBe("handoff_file_invalid");
  expect(result.failure_detail).toContain("handoff.json");
  expect(result.failure_detail).toContain("(missing)");
  expect(record).toMatchObject({ status: "failed", failure_reason: "handoff_file_invalid" });
  expect(String(record.error)).toContain("handoff.json");
});

test("an invalid handoff keeps its file for the correction turn", async () => {
  const { provider, record } = await runPlan(["status: complete\n\n<<FILE>>{broken", "status: complete\n\nfixed"], [null, "# Plan\n"]);
  expect(provider.calls[1]?.prompt).toContain("(invalid_json)");
  expect(record.corrections.handoff).toMatchObject({ error_kind: "invalid_json" });
  expect(record.status).toBe("completed");
});

test("a missing artifact gets one reminder correction and writing it completes the stage", async () => {
  const { provider, result, record } = await runPlan(["status: complete\n\nplanned", "status: complete\n\nfixed"], [null, "# Plan\n"]);
  expect(provider.calls).toHaveLength(2);
  expect(provider.calls[1]?.prompt).toContain("## Stage output missing");
  expect(provider.calls[1]?.prompt).not.toContain("## Response contract\n\nStart the response");
  expect(result.failure_reason).toBe("");
  expect(record.status).toBe("completed");
  expect(record.corrections.stage_output).toMatchObject({ turn: 1, error_kind: "artifact" });
});

test("under protocol 3 the artifact correction asks to rewrite the handoff and passes when it does", async () => {
  const { provider, record } = await runPlan(["status: complete\n\nplanned", "status: complete\n\nfixed"], [null, "# Plan\n"]);
  expect(provider.calls[1]?.prompt).toContain("rewrite the handoff file");
  expect(provider.calls[1]?.prompt).toContain("## Do\n\nWrite the missing files, then rewrite the handoff file.");
  expect(record.corrections.handoff).toBeUndefined();
  expect(record.status).toBe("completed");
});

test("an artifact correction whose reply leaves no handoff moves to the handoff kind, not a loop", async () => {
  const { provider, result, record } = await runPlan(
    ["status: complete\n\nplanned", "fixed the artifact", "status: complete\n\nlast", "never"], [null, "# Plan\n", null, null],
  );
  expect(provider.calls).toHaveLength(3);
  expect(record.corrections.stage_output).toBeDefined();
  expect(record.corrections.handoff).toMatchObject({ error_kind: "missing" });
  expect(result.execution_status).toBe("completed");
});

test("a still-missing artifact fails with stage_output_missing", async () => {
  const { provider, result, record } = await runPlan(["status: complete\n\nplanned", "status: complete\n\nagain"], [null, null]);
  expect(provider.calls).toHaveLength(2);
  expect(result.failure_reason).toBe("stage_output_missing");
  expect(String(record.error)).toContain("artifact missing");
  expect(record.failure_reason).toBe("stage_output_missing");
});

test("budgets are counted per kind: a contract fix does not spend the output correction", async () => {
  const { provider, result } = await runPlan(
    ["no header", "status: complete\n\nplanned", "status: complete\n\nfixed"], [null, null, "# Plan\n"],
  );
  expect(provider.calls).toHaveLength(3);
  expect(result.failure_reason).toBe("");
  expect(result.execution_status).toBe("completed");
});
