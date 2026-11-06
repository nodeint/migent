import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { AgyProvider, ClaudeProvider, CodexProvider, GrokProvider, OpencodeProvider } from "../src/index.ts";

function stream(...events: Record<string, unknown>[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

const RATE_TEXT = "You have exceeded the 5-hour usage quota. It will reset at 2026-10-22 18:43:08 +0800 CST.";

test("opencode: model text and a bare exit is exit-only, and a rate-limit sentence in it is no quota", () => {
  const provider = new OpencodeProvider();
  const out = stream({ type: "text", sessionID: "s", part: { text: `status: complete\n\n${RATE_TEXT}` } });
  expect(provider.parseResponse(out, "")[2]).toBe("model");
  const failure = provider.classifyFailure(out, 1);
  expect(failure).toMatchObject({ kind: "provider", origin: "exit-only" });
});

test("opencode: an error event next to model text is a provider error, and the two channels stay apart", () => {
  const provider = new OpencodeProvider();
  const out = stream(
    { type: "text", sessionID: "s", part: { text: "status: complete\n\ndone" } },
    { type: "error", sessionID: "s", message: "boom" },
  );
  const [text, , source] = provider.parseResponse(out, "");
  expect(text).toContain("done");
  expect(source).toBe("model");
  expect(provider.classifyFailure(out, 1)).toMatchObject({ origin: "provider-error", message: "boom" });
});

test("opencode: raw stdout is never model text", () => {
  const provider = new OpencodeProvider();
  expect(provider.parseResponse("segfault", "")).toEqual(["segfault", null, "error"]);
  expect(provider.parseResponse("", "")[2]).toBe("none");
  expect(provider.classifyFailure("segfault", 139)).toMatchObject({ origin: "exit-only", message: "segfault" });
});

test("claude: a bare non-zero exit is exit-only; an error result or a rejected rate limit is a provider error", () => {
  const provider = new ClaudeProvider();
  const ok = stream({ type: "result", is_error: false, result: "status: complete\n\ndone", session_id: "c" });
  expect(provider.parseResponse(ok, "")[2]).toBe("model");
  expect(provider.classifyFailure(ok, 1)).toMatchObject({ kind: "provider", origin: "exit-only" });
  const assistant = stream({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } });
  expect(provider.parseResponse(assistant, "")[2]).toBe("model");
  const bad = stream({ type: "result", is_error: true, result: "nope", session_id: "c" });
  expect(provider.parseResponse(bad, "")[2]).toBe("error");
  expect(provider.classifyFailure(bad, 1)).toMatchObject({ origin: "provider-error" });
  const limited = stream({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt: 1_800_000_000, rateLimitType: "five_hour" },
  });
  expect(provider.classifyFailure(limited, 1)).toMatchObject({ kind: "quota", origin: "provider-error" });
});

test("codex: a last-message file is model text, and turn.failed next to it is still a provider error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "migent-origin-"));
  try {
    const file = path.join(dir, "last.txt");
    writeFileSync(file, "status: complete\n\ndone", "utf8");
    const provider = new CodexProvider();
    const out = stream({ type: "turn.failed", error: { message: "stream broke" } });
    expect(provider.parseResponse(out, file)).toEqual(["status: complete\n\ndone", null, "model"]);
    expect(provider.classifyFailure(out, 1)).toMatchObject({ origin: "provider-error", message: "stream broke" });
    expect(provider.parseResponse(out, path.join(dir, "missing"))).toEqual(["stream broke", null, "error"]);
    const clean = stream({ type: "item.completed", item: { type: "agent_message", text: "hi" } });
    expect(provider.parseResponse(clean, path.join(dir, "missing"))[2]).toBe("model");
    expect(provider.classifyFailure(clean, 1)).toMatchObject({ origin: "exit-only", message: "hi" });
    expect(provider.parseResponse("oops", path.join(dir, "missing"))).toEqual(["oops", null, "error"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grok: text is model output, an error event is a provider error, a bare exit is exit-only", () => {
  const provider = new GrokProvider();
  const text = stream({ type: "text", data: "status: complete\n\nok" }, { type: "end", sessionId: "g" });
  expect(provider.parseResponse(text, "")[2]).toBe("model");
  expect(provider.classifyFailure(text, 1)).toMatchObject({ origin: "exit-only" });
  const bad = stream({ type: "text", data: "partial" }, { type: "error", message: "denied" });
  expect(provider.classifyFailure(bad, 1)).toMatchObject({ origin: "provider-error", message: "denied" });
  expect(provider.parseResponse(stream({ type: "error", message: "denied" }), "")[2]).toBe("error");
  expect(provider.parseResponse("plain", "")).toEqual(["plain", null, "error"]);
});

test("agy: a SUCCESS result is model text, a failed result is a provider error, a bare exit is exit-only", () => {
  const provider = new AgyProvider();
  const ok = stream({ event: "result", result: { status: "SUCCESS", response: "status: complete\n\nok" } });
  expect(provider.parseResponse(ok, "")[2]).toBe("model");
  expect(provider.classifyFailure(ok, 1)).toMatchObject({ origin: "exit-only" });
  const failed = stream({ event: "result", result: { status: "FAILED", error: "bad" } });
  expect(provider.parseResponse(failed, "")[2]).toBe("error");
  expect(provider.classifyFailure(failed, 1)).toMatchObject({ origin: "provider-error" });
  expect(provider.classifyFailure("crash", 1)).toMatchObject({ origin: "exit-only" });
});
