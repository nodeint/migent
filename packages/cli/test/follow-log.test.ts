import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { followSession } from "../src/commands/watch.ts";
import { replayFollowLines } from "../src/follow-log.ts";
import { capture } from "./support.ts";

const EXECUTION = "0001-plan--attempt-01";
const OTHER = "0002-review--attempt-01";

function line(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

function project(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((item) => item.startsWith("{"))
    .map((item) => JSON.parse(item) as Record<string, unknown>)
    .map((event) => ({
      event: event.event,
      timestamp: event.timestamp,
      stage_id: event.stage_id,
      execution_id: event.execution_id,
      summary: event.summary ?? null,
    }));
}

test("follow merges a stream by timestamp for each cursor", () => {
  const early = line({
    v: 2,
    seq: 1,
    event: "execution.started",
    timestamp: "2026-10-19T00:00:00Z",
    execution_id: EXECUTION,
    stage_id: "plan",
  });
  const later = line({
    v: 2,
    seq: 4,
    event: "provider.stage_started",
    timestamp: "2026-10-19T00:00:10Z",
    execution_id: EXECUTION,
    stage_id: "plan",
    summary: "later-event",
  });
  const eventsText = early + later;
  const streamText = [
    line({
      v: 2,
      seq: 2,
      event: "provider.item_started",
      timestamp: "2026-10-19T00:00:02Z",
      execution_id: EXECUTION,
      stage_id: "plan",
      summary: "early-stream",
    }),
    line({
      v: 2,
      seq: 3,
      event: "provider.item_completed",
      timestamp: "2026-10-19T00:00:05Z",
      execution_id: EXECUTION,
      stage_id: "plan",
      summary: "mid-stream",
    }),
    line({
      v: 2,
      seq: 5,
      event: "provider.item_completed",
      timestamp: "2026-10-19T00:00:11Z",
      execution_id: EXECUTION,
      stage_id: "plan",
      summary: "late-stream",
    }),
  ].join("");
  const otherText = line({
    v: 2,
    seq: 6,
    event: "provider.item_started",
    timestamp: "2026-10-19T00:00:03Z",
    execution_id: OTHER,
    stage_id: "review",
    summary: "other-execution",
  });
  const streams = [
    { path: `executions/${EXECUTION}/stream.jsonl`, text: streamText },
    { path: `executions/${OTHER}/stream.jsonl`, text: otherText },
  ];
  const all = replayFollowLines({ cursor: 0, eventsText, streams }).map((item) => JSON.parse(item) as { summary?: string });
  expect(all.map((item) => item.summary ?? null)).toEqual([
    null,
    "early-stream",
    "other-execution",
    "mid-stream",
    "later-event",
    "late-stream",
  ]);

  const mid = Buffer.byteLength(early);
  const fromMid = replayFollowLines({ cursor: mid, eventsText, streams }).map(
    (item) => JSON.parse(item) as { summary?: string },
  );
  expect(fromMid.map((item) => item.summary ?? null)).toEqual(["later-event", "late-stream"]);

  const atEnd = replayFollowLines({ cursor: Buffer.byteLength(eventsText), eventsText, streams });
  expect(atEnd).toEqual([]);

  const tail = replayFollowLines({
    cursor: null,
    eventsText,
    streams: [...streams, { path: "executions/0003-plan--attempt-02/stream.jsonl", text: line({
      event: "provider.item_started",
      timestamp: "2026-10-19T00:00:01Z",
      execution_id: "0003-plan--attempt-02",
      stage_id: "plan",
      summary: "started-after-follow",
    }), appearedAfterStart: true }],
  });
  expect(tail.map((item) => (JSON.parse(item) as { summary?: string }).summary)).toEqual(["started-after-follow"]);
});

test("session follow replays the merged log and filters by execution", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-follow-"));
  try {
    const sessionDirectory = path.join(workspace, ".migent", "sessions", "run-1");
    const executionDirectory = path.join(sessionDirectory, "executions", EXECUTION);
    mkdirSync(executionDirectory, { recursive: true });
    const early = line({
      event: "execution.started",
      timestamp: "2026-10-19T00:00:00Z",
      execution_id: EXECUTION,
      stage_id: "plan",
    });
    const later = line({
      event: "provider.stage_started",
      timestamp: "2026-10-19T00:00:10Z",
      execution_id: EXECUTION,
      stage_id: "plan",
      summary: "later-event",
    });
    writeFileSync(path.join(sessionDirectory, "events.jsonl"), early + later, "utf8");
    writeFileSync(
      path.join(executionDirectory, "stream.jsonl"),
      line({
        event: "provider.item_started",
        timestamp: "2026-10-19T00:00:02Z",
        execution_id: EXECUTION,
        stage_id: "plan",
        summary: "early-stream",
      }) +
        line({
          event: "provider.item_completed",
          timestamp: "2026-10-19T00:00:11Z",
          execution_id: EXECUTION,
          stage_id: "plan",
          summary: "late-stream",
        }) +
        line({
          event: "provider.item_started",
          timestamp: "2026-10-19T00:00:03Z",
          execution_id: OTHER,
          stage_id: "review",
          summary: "other-execution",
        }),
      "utf8",
    );
    writeFileSync(
      path.join(executionDirectory, "execution.json"),
      JSON.stringify({ execution_id: EXECUTION, stage_id: "plan", status: "completed" }),
      "utf8",
    );
    writeFileSync(
      path.join(sessionDirectory, "status.json"),
      JSON.stringify({
        session_id: "run-1",
        status: "completed",
        latest_execution_id: EXECUTION,
        updated_at: "2026-10-19T00:00:10Z",
      }),
      "utf8",
    );

    const replayed = await capture(() =>
      followSession(workspace, "run-1", { jsonLines: true, cursor: 0, exitWhenDone: true }),
    );
    expect(replayed.value).toBe(0);
    expect(project(replayed.stdout)).toEqual([
      {
        event: "execution.started",
        timestamp: "2026-10-19T00:00:00Z",
        stage_id: "plan",
        execution_id: EXECUTION,
        summary: null,
      },
      {
        event: "provider.item_started",
        timestamp: "2026-10-19T00:00:02Z",
        stage_id: "plan",
        execution_id: EXECUTION,
        summary: "early-stream",
      },
      {
        event: "provider.item_started",
        timestamp: "2026-10-19T00:00:03Z",
        stage_id: "review",
        execution_id: OTHER,
        summary: "other-execution",
      },
      {
        event: "provider.stage_started",
        timestamp: "2026-10-19T00:00:10Z",
        stage_id: "plan",
        execution_id: EXECUTION,
        summary: "later-event",
      },
      {
        event: "provider.item_completed",
        timestamp: "2026-10-19T00:00:11Z",
        stage_id: "plan",
        execution_id: EXECUTION,
        summary: "late-stream",
      },
    ]);

    const filtered = await capture(() =>
      followSession(workspace, "run-1", {
        jsonLines: true,
        cursor: 0,
        exitWhenDone: true,
        executionId: EXECUTION,
      }),
    );
    expect(filtered.value).toBe(0);
    expect(project(filtered.stdout).map((event) => event.summary)).toEqual([
      null,
      "early-stream",
      "later-event",
      "late-stream",
    ]);

    const middle = Buffer.byteLength(early);
    const fromMiddle = await capture(() =>
      followSession(workspace, "run-1", { jsonLines: true, cursor: middle, exitWhenDone: true }),
    );
    expect(project(fromMiddle.stdout).map((event) => event.summary)).toEqual(["later-event", "late-stream"]);

    const end = statSync(path.join(sessionDirectory, "events.jsonl")).size;
    const atEnd = await capture(() =>
      followSession(workspace, "run-1", { jsonLines: true, cursor: end, exitWhenDone: true }),
    );
    expect(project(atEnd.stdout)).toEqual([]);

    const snapshot = await capture(() => followSession(workspace, "run-1", { exitWhenDone: true }));
    expect(snapshot.value).toBe(0);
    expect(snapshot.stdout).toContain("run-1");
    expect(snapshot.stdout).not.toContain("early-stream");
    expect(snapshot.stdout).not.toContain("later-event");
    expect(readFileSync(path.join(sessionDirectory, "events.jsonl"), "utf8")).toContain("later-event");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("session follow keeps the stream timestamp floor after a torn line is closed", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-follow-"));
  try {
    const sessionDirectory = path.join(workspace, ".migent", "sessions", "run-1");
    const executionDirectory = path.join(sessionDirectory, "executions", EXECUTION);
    mkdirSync(executionDirectory, { recursive: true });
    const early = line({
      event: "execution.started",
      timestamp: "2026-10-19T00:00:00Z",
      execution_id: EXECUTION,
      stage_id: "plan",
    });
    const later = line({
      event: "provider.stage_started",
      timestamp: "2026-10-19T00:00:10Z",
      execution_id: EXECUTION,
      stage_id: "plan",
      summary: "later-event",
    });
    writeFileSync(path.join(sessionDirectory, "events.jsonl"), early + later, "utf8");
    const torn = JSON.stringify({
      event: "provider.item_started",
      timestamp: "2026-10-19T00:00:02Z",
      execution_id: EXECUTION,
      stage_id: "plan",
      summary: "old-stream",
    });
    const streamPath = path.join(executionDirectory, "stream.jsonl");
    writeFileSync(streamPath, torn, "utf8");
    writeFileSync(
      path.join(executionDirectory, "execution.json"),
      JSON.stringify({ execution_id: EXECUTION, stage_id: "plan", status: "running" }),
      "utf8",
    );
    writeFileSync(
      path.join(sessionDirectory, "status.json"),
      JSON.stringify({ session_id: "run-1", status: "active" }),
      "utf8",
    );
    const followed = await capture(async () => {
      const pending = followSession(workspace, "run-1", {
        jsonLines: true,
        cursor: Buffer.byteLength(early),
        untilTerminal: true,
        executionId: EXECUTION,
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      appendFileSync(
        streamPath,
        `\n${line({
          event: "provider.item_completed",
          timestamp: "2026-10-19T00:00:11Z",
          execution_id: EXECUTION,
          stage_id: "plan",
          summary: "new-stream",
        })}`,
      );
      writeFileSync(
        path.join(executionDirectory, "execution.json"),
        JSON.stringify({
          execution_id: EXECUTION,
          stage_id: "plan",
          status: "completed",
          outcome: { status: "complete" },
        }),
        "utf8",
      );
      return pending;
    });
    expect(followed.value).toBe(0);
    expect(project(followed.stdout).map((event) => event.summary)).toEqual(["later-event", "new-stream"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function deadOwnerSession(workspace: string): { sessionDirectory: string; executionPath: string } {
  const sessionDirectory = path.join(workspace, ".migent", "sessions", "run-1");
  const executionDirectory = path.join(sessionDirectory, "executions", EXECUTION);
  mkdirSync(executionDirectory, { recursive: true });
  writeFileSync(
    path.join(sessionDirectory, "manifest.yaml"),
    [
      "session_id: run-1",
      "workflow_id: agent",
      "role: reviewer",
      "task: \"review\"",
      "created_at: 2026-10-19T00:00:00Z",
      "schema_version: 3",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(sessionDirectory, "events.jsonl"),
    line({
      v: 2,
      seq: 1,
      event: "session.created",
      timestamp: "2026-10-19T00:00:00Z",
      data: { workflow_id: "agent", role: "reviewer", task: "review" },
    }) +
      line({
        v: 2,
        seq: 2,
        event: "execution.started",
        timestamp: "2026-10-19T00:00:01Z",
        execution_id: EXECUTION,
        stage_id: "reviewer",
        data: { execution_order: 1, stage_attempt: 1, provider: "fake", model: "m1" },
      }),
    "utf8",
  );
  const executionPath = path.join(executionDirectory, "execution.json");
  writeFileSync(
    executionPath,
    JSON.stringify({
      session_id: "run-1",
      execution_id: EXECUTION,
      execution_order: 1,
      stage_id: "reviewer",
      stage_attempt: 1,
      provider: "fake",
      model: "m1",
      options: {},
      status: "running",
      schema_version: 1,
      created_at: "2026-10-19T00:00:01Z",
      hostname: os.hostname(),
      owner_pid: 2 ** 30,
    }),
    "utf8",
  );
  writeFileSync(
    path.join(sessionDirectory, "status.json"),
    JSON.stringify({ session_id: "run-1", workflow_id: "agent", status: "active", role: "reviewer" }),
    "utf8",
  );
  return { sessionDirectory, executionPath };
}

test("follow until ends after a dead owner and waits while the lock is held", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-follow-dead-"));
  try {
    const { executionPath } = deadOwnerSession(workspace);
    const ended = await capture(() =>
      followSession(workspace, "run-1", {
        untilTerminal: true,
        executionId: EXECUTION,
      }),
    );
    expect(ended.value).toBe(1);
    expect(JSON.parse(readFileSync(executionPath, "utf8")).status).toBe("failed");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  const held = mkdtempSync(path.join(tmpdir(), "migent-follow-held-"));
  try {
    const { sessionDirectory, executionPath } = deadOwnerSession(held);
    writeFileSync(
      path.join(sessionDirectory, "session.lock"),
      JSON.stringify({
        pid: 4242,
        host: "other-host",
        started_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        nonce: "holder",
      }),
    );
    const followed = await capture(async () => {
      const pending = followSession(held, "run-1", {
        untilTerminal: true,
        executionId: EXECUTION,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(JSON.parse(readFileSync(executionPath, "utf8")).status).toBe("running");
      const record = JSON.parse(readFileSync(executionPath, "utf8")) as Record<string, unknown>;
      record.status = "completed";
      record.outcome = { status: "complete" };
      writeFileSync(executionPath, JSON.stringify(record), "utf8");
      return pending;
    });
    expect(followed.value).toBe(0);
  } finally {
    rmSync(held, { recursive: true, force: true });
  }
});
