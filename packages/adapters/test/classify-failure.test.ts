import { expect, test } from "vitest";
import { AgyAdapter } from "../src/agy-adapter.ts";
import { ClaudeAdapter } from "../src/claude-adapter.ts";
import { CodexAdapter } from "../src/codex-adapter.ts";
import { GrokAdapter } from "../src/grok-adapter.ts";
import { OpencodeAdapter } from "../src/opencode-adapter.ts";

const QUOTA = [
  '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1792560600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":1,"resetsAt":1792560600},"seven_day":{"utilization":0.45,"resetsAt":1792947600}}},"session_id":"37a685f1-59ec-44a9-9530-0f66e1098c02"}',
  '{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"You\'ve hit your session limit · resets 12:30pm (Asia/Saigon)"}],"usage":{"input_tokens":0,"output_tokens":0}},"session_id":"37a685f1-59ec-44a9-9530-0f66e1098c02","error":"rate_limit","api_error_status":429,"api_error":"usage_limit_reached"}',
  '{"type":"result","is_error":true,"subtype":"success","api_error_status":429,"api_error":"usage_limit_reached","terminal_reason":"api_error","num_turns":1,"total_cost_usd":0,"result":"You\'ve hit your session limit · resets 12:30pm (Asia/Saigon)","session_id":"37a685f1-59ec-44a9-9530-0f66e1098c02","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}',
].join("\n");

const EXIT_ZERO_ERROR = [
  '{"type":"result","is_error":true,"subtype":"success","result":"claude failed closed","session_id":"sess-1"}',
].join("\n");

test("claude quota uses the rate limit window and ignores a later unified window", () => {
  const failure = new ClaudeAdapter().classifyFailure(QUOTA, 1);
  expect(failure).toEqual({
    kind: "quota",
    message: "You've hit your session limit · resets 12:30pm (Asia/Saigon)",
    resetAt: "2026-10-21T05:30:00.000Z",
    window: "five_hour",
  });
});

test("claude without a rate limit event is a provider failure, including exit 0", () => {
  expect(new ClaudeAdapter().classifyFailure('{"type":"result","is_error":true,"result":"nope"}', 1)).toMatchObject({
    kind: "provider",
  });
  expect(new ClaudeAdapter().classifyFailure(EXIT_ZERO_ERROR, 0)).toMatchObject({
    kind: "provider",
    message: "claude failed closed",
  });
  expect(new ClaudeAdapter().classifyFailure('{"type":"result","is_error":false,"result":"ok"}', 0)).toBeNull();
});

test("codex, grok, and agy classify a numeric failure as provider and exit 0 as null", () => {
  for (const adapter of [new CodexAdapter(), new GrokAdapter(), new AgyAdapter()]) {
    expect(adapter.classifyFailure("{}", 0)).toBeNull();
    expect(adapter.classifyFailure("provider said no", 2)?.kind).toBe("provider");
  }
});

test("opencode classifies an error event as provider, even at exit 0", () => {
  const adapter = new OpencodeAdapter();
  expect(adapter.classifyFailure('{"type":"error","message":"nope"}', 0)).toEqual({
    kind: "provider",
    message: "nope",
  });
  expect(adapter.classifyFailure('{"type":"step_start"}', 0)).toBeNull();
  expect(adapter.classifyFailure("provider said no", 2)?.kind).toBe("provider");
});
