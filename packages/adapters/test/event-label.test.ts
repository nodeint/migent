import { expect, test } from "vitest";
import { AgyProvider, ClaudeProvider, CodexProvider, GrokProvider, OpencodeProvider } from "../src/index.ts";

const SECRET = "reply text that must never become a label";

test("claude-code labels by event type and content kind, never by content", () => {
  const provider = new ClaudeProvider();
  const label = (event: Record<string, unknown>) => provider.eventLabel(JSON.stringify(event));
  expect(label({ type: "assistant", message: { content: [{ type: "text", text: SECRET }] } })).toBe("assistant:text");
  expect(label({ type: "assistant", message: { content: [{ type: "tool_use", id: "1" }] } })).toBe("assistant:tool_use");
  expect(label({ type: "result", is_error: true, result: SECRET })).toBe("result:error");
  expect(label({ type: "result", is_error: false })).toBe("result");
  expect(label({ type: SECRET })).toBe("other");
  expect(provider.eventLabel("plain text")).toBeNull();
});

test("codex labels item events with the item type", () => {
  const provider = new CodexProvider();
  expect(provider.eventLabel(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: SECRET } }))).toBe(
    "item.completed:agent_message",
  );
  expect(provider.eventLabel(JSON.stringify({ type: "turn.failed", error: { message: SECRET } }))).toBe("turn.failed");
});

test("grok and opencode label by type", () => {
  expect(new GrokProvider().eventLabel(JSON.stringify({ type: "tool_call", toolCallId: "1" }))).toBe("tool_call");
  expect(new OpencodeProvider().eventLabel(JSON.stringify({ type: "step_finish" }))).toBe("step_finish");
});

test("agy labels by event and step type, and flags a failed result", () => {
  const provider = new AgyProvider();
  expect(provider.eventLabel(JSON.stringify({ event: "step_update", step_update: { step_type: "tool" } }))).toBe("step_update:tool");
  expect(provider.eventLabel(JSON.stringify({ event: "step_update", step_update: { step_type: SECRET } }))).toBe("step_update:other");
});

test("an identifier-shaped payload in a type field is not a label", () => {
  const line = JSON.stringify({ type: "SECRET_TOKEN_123", event: "SECRET_TOKEN_123" });
  for (const provider of [new ClaudeProvider(), new CodexProvider(), new GrokProvider(), new OpencodeProvider(), new AgyProvider()]) {
    expect(provider.eventLabel(line)).toBe("other");
  }
  expect(new CodexProvider().eventLabel(JSON.stringify({ type: "item.completed", item: { type: "SECRET_TOKEN_123" } }))).toBe(
    "item.completed:other",
  );
  expect(new AgyProvider().eventLabel(JSON.stringify({ event: "step_update", step_update: { step_type: "SECRET_TOKEN_123" } }))).toBe(
    "step_update:other",
  );
});

const stream = (...events: Record<string, unknown>[]) => events.map((event) => JSON.stringify(event)).join("\n");

test("a protocol error at exit 0 is a provider error for codex, grok and agy", () => {
  const codex = stream({ type: "turn.failed", error: { message: "boom" } });
  expect(new CodexProvider().classifyFailure(codex, 0)).toMatchObject({ kind: "provider", origin: "provider-error", message: "boom" });
  const grok = stream({ type: "error", message: "bad" });
  expect(new GrokProvider().classifyFailure(grok, 0)).toMatchObject({ kind: "provider", origin: "provider-error", message: "bad" });
  const agy = stream({ event: "result", result: { status: "FAILED" } });
  expect(new AgyProvider().classifyFailure(agy, 0)?.origin).toBe("provider-error");
});

test("a clean exit 0 and a control-plane warning are still no failure", () => {
  expect(new CodexProvider().classifyFailure(stream({ type: "turn.completed" }), 0)).toBeNull();
  expect(new CodexProvider().classifyFailure(stream({ type: "error", message: "failed to refresh available models" }), 0)).toBeNull();
  expect(new GrokProvider().classifyFailure(stream({ type: "end" }), 0)).toBeNull();
  expect(new AgyProvider().classifyFailure(stream({ event: "result", result: { status: "SUCCESS" } }), 0)).toBeNull();
});
