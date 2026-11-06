import { classifyFailure } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { AgyClient, ClaudeCodeClient, CodexClient, GrokClient, OpencodeClient } from "../src/index.ts";

const SECRET = "reply text that must never become a label";

test("claude-code labels by event type and content kind, never by content", () => {
  const client = new ClaudeCodeClient();
  const label = (event: Record<string, unknown>) => client.eventLabel(JSON.stringify(event));
  expect(label({ type: "assistant", message: { content: [{ type: "text", text: SECRET }] } })).toBe("assistant:text");
  expect(label({ type: "assistant", message: { content: [{ type: "tool_use", id: "1" }] } })).toBe("assistant:tool_use");
  expect(label({ type: "result", is_error: true, result: SECRET })).toBe("result:error");
  expect(label({ type: "result", is_error: false })).toBe("result");
  expect(label({ type: SECRET })).toBe("other");
  expect(client.eventLabel("plain text")).toBeNull();
});

test("codex labels item events with the item type", () => {
  const client = new CodexClient();
  expect(client.eventLabel(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: SECRET } }))).toBe(
    "item.completed:agent_message",
  );
  expect(client.eventLabel(JSON.stringify({ type: "turn.failed", error: { message: SECRET } }))).toBe("turn.failed");
});

test("grok and opencode label by type", () => {
  expect(new GrokClient().eventLabel(JSON.stringify({ type: "tool_call", toolCallId: "1" }))).toBe("tool_call");
  expect(new OpencodeClient().eventLabel(JSON.stringify({ type: "step_finish" }))).toBe("step_finish");
});

test("agy labels by event and step type, and flags a failed result", () => {
  const client = new AgyClient();
  expect(client.eventLabel(JSON.stringify({ event: "step_update", step_update: { step_type: "tool" } }))).toBe("step_update:tool");
  expect(client.eventLabel(JSON.stringify({ event: "step_update", step_update: { step_type: SECRET } }))).toBe("step_update:other");
});

test("an identifier-shaped payload in a type field is not a label", () => {
  const line = JSON.stringify({ type: "SECRET_TOKEN_123", event: "SECRET_TOKEN_123" });
  for (const client of [new ClaudeCodeClient(), new CodexClient(), new GrokClient(), new OpencodeClient(), new AgyClient()]) {
    expect(client.eventLabel(line)).toBe("other");
  }
  expect(new CodexClient().eventLabel(JSON.stringify({ type: "item.completed", item: { type: "SECRET_TOKEN_123" } }))).toBe(
    "item.completed:other",
  );
  expect(new AgyClient().eventLabel(JSON.stringify({ event: "step_update", step_update: { step_type: "SECRET_TOKEN_123" } }))).toBe(
    "step_update:other",
  );
});

const stream = (...events: Record<string, unknown>[]) => events.map((event) => JSON.stringify(event)).join("\n");

test("a protocol error at exit 0 is a provider error for codex, grok and agy", () => {
  const codex = stream({ type: "turn.failed", error: { message: "boom" } });
  expect(classifyFailure(new CodexClient(), codex, 0)).toMatchObject({ kind: "provider", origin: "provider-error", message: "boom" });
  const grok = stream({ type: "error", message: "bad" });
  expect(classifyFailure(new GrokClient(), grok, 0)).toMatchObject({ kind: "provider", origin: "provider-error", message: "bad" });
  const agy = stream({ event: "result", result: { status: "FAILED" } });
  expect(classifyFailure(new AgyClient(), agy, 0)?.origin).toBe("provider-error");
});

test("a clean exit 0 and a control-plane warning are still no failure", () => {
  expect(classifyFailure(new CodexClient(), stream({ type: "turn.completed" }), 0)).toBeNull();
  expect(classifyFailure(new CodexClient(), stream({ type: "error", message: "failed to refresh available models" }), 0)).toBeNull();
  expect(classifyFailure(new GrokClient(), stream({ type: "end" }), 0)).toBeNull();
  expect(classifyFailure(new AgyClient(), stream({ event: "result", result: { status: "SUCCESS" } }), 0)).toBeNull();
});
