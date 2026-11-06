import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyFailure } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { AgyClient, ClaudeCodeClient, CodexClient, GrokClient, OpencodeClient } from "../src/index.ts";

function stream(...events: Record<string, unknown>[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

const RATE_TEXT = "You have exceeded the 5-hour usage quota. It will reset at 2026-10-22 18:43:08 +0800 CST.";

test("opencode: model text and a bare exit is exit-only, and a rate-limit sentence in it is no quota", () => {
  const client = new OpencodeClient();
  const out = stream({ type: "text", sessionID: "s", part: { text: `status: complete\n\n${RATE_TEXT}` } });
  expect(client.parseRun(out, "").source).toBe("model");
  const failure = classifyFailure(client, out, 1);
  expect(failure).toMatchObject({ kind: "provider", origin: "exit-only" });
});

test("opencode: an error event next to model text is a provider error, and the two channels stay apart", () => {
  const client = new OpencodeClient();
  const out = stream(
    { type: "text", sessionID: "s", part: { text: "status: complete\n\ndone" } },
    { type: "error", sessionID: "s", message: "boom" },
  );
  const { text, source } = client.parseRun(out, "");
  expect(text).toContain("done");
  expect(source).toBe("model");
  expect(classifyFailure(client, out, 1)).toMatchObject({ origin: "provider-error", message: "boom" });
});

test("opencode: raw stdout is never model text", () => {
  const client = new OpencodeClient();
  expect(client.parseRun("segfault", "")).toEqual({ text: "segfault", sessionId: null, source: "error" });
  expect(client.parseRun("", "").source).toBe("none");
  expect(classifyFailure(client, "segfault", 139)).toMatchObject({ origin: "exit-only", message: "segfault" });
});

test("claude: a bare non-zero exit is exit-only; an error result or a rejected rate limit is a provider error", () => {
  const client = new ClaudeCodeClient();
  const ok = stream({ type: "result", is_error: false, result: "status: complete\n\ndone", session_id: "c" });
  expect(client.parseRun(ok, "").source).toBe("model");
  expect(classifyFailure(client, ok, 1)).toMatchObject({ kind: "provider", origin: "exit-only" });
  const assistant = stream({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } });
  expect(client.parseRun(assistant, "").source).toBe("model");
  const bad = stream({ type: "result", is_error: true, result: "nope", session_id: "c" });
  expect(client.parseRun(bad, "").source).toBe("error");
  expect(classifyFailure(client, bad, 1)).toMatchObject({ origin: "provider-error" });
  const limited = stream({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt: 1_800_000_000, rateLimitType: "five_hour" },
  });
  expect(classifyFailure(client, limited, 1)).toMatchObject({ kind: "quota", origin: "provider-error" });
});

test("codex: a last-message file is model text, and turn.failed next to it is still a provider error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "migent-origin-"));
  try {
    const file = path.join(dir, "last.txt");
    writeFileSync(file, "status: complete\n\ndone", "utf8");
    const client = new CodexClient();
    const out = stream({ type: "turn.failed", error: { message: "stream broke" } });
    expect(client.parseRun(out, file)).toEqual({ text: "status: complete\n\ndone", sessionId: null, source: "model" });
    expect(classifyFailure(client, out, 1)).toMatchObject({ origin: "provider-error", message: "stream broke" });
    expect(client.parseRun(out, path.join(dir, "missing"))).toEqual({ text: "stream broke", sessionId: null, source: "error" });
    const clean = stream({ type: "item.completed", item: { type: "agent_message", text: "hi" } });
    expect(client.parseRun(clean, path.join(dir, "missing")).source).toBe("model");
    expect(classifyFailure(client, clean, 1)).toMatchObject({ origin: "exit-only", message: "hi" });
    expect(client.parseRun("oops", path.join(dir, "missing"))).toEqual({ text: "oops", sessionId: null, source: "error" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grok: text is model output, an error event is a provider error, a bare exit is exit-only", () => {
  const client = new GrokClient();
  const text = stream({ type: "text", data: "status: complete\n\nok" }, { type: "end", sessionId: "g" });
  expect(client.parseRun(text, "").source).toBe("model");
  expect(classifyFailure(client, text, 1)).toMatchObject({ origin: "exit-only" });
  const bad = stream({ type: "text", data: "partial" }, { type: "error", message: "denied" });
  expect(classifyFailure(client, bad, 1)).toMatchObject({ origin: "provider-error", message: "denied" });
  expect(client.parseRun(stream({ type: "error", message: "denied" }), "").source).toBe("error");
  expect(client.parseRun("plain", "")).toEqual({ text: "plain", sessionId: null, source: "error" });
});

test("agy: a SUCCESS result is model text, a failed result is a provider error, a bare exit is exit-only", () => {
  const client = new AgyClient();
  const ok = stream({ event: "result", result: { status: "SUCCESS", response: "status: complete\n\nok" } });
  expect(client.parseRun(ok, "").source).toBe("model");
  expect(classifyFailure(client, ok, 1)).toMatchObject({ origin: "exit-only" });
  const failed = stream({ event: "result", result: { status: "FAILED", error: "bad" } });
  expect(client.parseRun(failed, "").source).toBe("error");
  expect(classifyFailure(client, failed, 1)).toMatchObject({ origin: "provider-error" });
  expect(classifyFailure(client, "crash", 1)).toMatchObject({ origin: "exit-only" });
});
