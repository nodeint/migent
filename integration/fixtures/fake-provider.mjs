// Fake codex and grok CLIs for integration tests. bin/<name> (POSIX) and bin/<name>.cmd
// (Windows) run this file with the provider name first, so tests go through the same PATH
// lookup and spawn path as the real CLIs.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const [provider, ...args] = process.argv.slice(2);

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withCursorLock(cursor, fn) {
  const lock = `${cursor}.lock`;
  for (let tries = 0; ; tries += 1) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || tries > 500) throw error;
      sleepMs(10);
    }
  }
  try {
    return fn();
  } finally {
    unlinkSync(lock);
  }
}

function promptStage(prompt) {
  const match = /^Stage: (\S+)/m.exec(prompt);
  return match ? match[1] : "";
}

// A later visit is only "Continue this stage." Several of those prompts match, so claim one
// running execution inside the cursor lock. The lowest order is claimed first.
function continuationMatches(prompt) {
  const cwd = argAfter("--cwd") || process.cwd();
  const sessions = path.join(cwd, ".migent", "sessions");
  if (!existsSync(sessions)) return [];
  const matches = [];
  for (const session of readdirSync(sessions)) {
    const executions = path.join(sessions, session, "executions");
    if (!existsSync(executions)) continue;
    for (const id of readdirSync(executions)) {
      const directory = path.join(executions, id);
      let meta;
      try {
        meta = JSON.parse(readFileSync(path.join(directory, "execution.json"), "utf8"));
      } catch {
        continue;
      }
      if (!meta || meta.status !== "running" || typeof meta.stage_id !== "string") continue;
      let saved = "";
      try {
        saved = readFileSync(path.join(directory, "prompt.md"), "utf8");
      } catch {
        continue;
      }
      if (saved !== prompt) continue;
      matches.push({
        stage: meta.stage_id,
        order: Number(meta.execution_order) || 0,
        id: typeof meta.execution_id === "string" ? meta.execution_id : id,
      });
    }
  }
  matches.sort((left, right) => left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return matches;
}

function takeStep(prompt) {
  const script = process.env.MIGENT_FAKE_SCRIPT;
  if (!script) return {};
  const steps = JSON.parse(readFileSync(script, "utf8"));
  if (!Array.isArray(steps)) return { text: "script must be a list", exit: 9 };
  const cursor = process.env.MIGENT_FAKE_CURSOR;
  mkdirSync(path.dirname(cursor), { recursive: true });
  const staged = steps.some((step) => step && typeof step === "object" && typeof step.stage === "string");
  if (!staged) {
    return withCursorLock(cursor, () => {
      const raw = existsSync(cursor) ? readFileSync(cursor, "ascii").trim() : "";
      const index = Number.parseInt(raw || "0", 10);
      const step = steps[index];
      writeFileSync(cursor, String(index + 1), "ascii");
      return step && typeof step === "object" ? step : { text: "script exhausted", exit: 9 };
    });
  }
  return withCursorLock(cursor, () => {
    const raw = existsSync(cursor) ? readFileSync(cursor, "ascii").trim() : "";
    const used = new Set(raw.startsWith("s:") ? raw.slice(2).split(",").filter(Boolean) : []);
    const named = promptStage(prompt);
    const candidates = named
      ? [{ stage: named, id: "" }]
      : continuationMatches(prompt).filter((match) => !existsSync(`${cursor}.claim.${match.id}`));
    for (const candidate of candidates) {
      const chosenIndex = steps.findIndex(
        (step, index) => !used.has(String(index)) && step && step.stage === candidate.stage,
      );
      if (chosenIndex < 0) continue;
      if (!named) writeFileSync(`${cursor}.claim.${candidate.id}`, candidate.stage);
      used.add(String(chosenIndex));
      writeFileSync(cursor, `s:${[...used].join(",")}`, "ascii");
      const step = steps[chosenIndex];
      return step && typeof step === "object" ? step : { text: "script exhausted", exit: 9 };
    }
    const openIndex = steps.findIndex(
      (step, index) => !used.has(String(index)) && step && typeof step === "object" && step.stage == null,
    );
    if (openIndex < 0) return { text: "script exhausted", exit: 9 };
    used.add(String(openIndex));
    writeFileSync(cursor, `s:${[...used].join(",")}`, "ascii");
    const step = steps[openIndex];
    return step && typeof step === "object" ? step : { text: "script exhausted", exit: 9 };
  });
}

function markSeen(stage) {
  const cursor = process.env.MIGENT_FAKE_CURSOR;
  if (!cursor || !stage) return;
  writeFileSync(`${cursor}.seen.${stage}`, "1");
}

function waitForStage(stage) {
  const cursor = process.env.MIGENT_FAKE_CURSOR;
  const seen = `${cursor}.seen.${stage}`;
  const deadline = Date.now() + 20_000;
  while (!existsSync(seen)) {
    if (Date.now() > deadline) {
      process.stderr.write(`timed out waiting for ${stage}\n`);
      process.exit(9);
    }
    sleepMs(20);
  }
}

function recordInvocation(extra) {
  const log = process.env.MIGENT_FAKE_LOG;
  if (!log) return;
  mkdirSync(path.dirname(log), { recursive: true });
  appendFileSync(log, `${JSON.stringify({ provider, argv: [provider, ...args], ...extra })}\n`, "utf8");
}

function responseText(prompt, step) {
  if ("text" in step) return String(step.text);
  if (process.env.MIGENT_FAKE_OUTCOME === "invalid") return "not a status header";
  if (prompt.includes("decision: approved|revise")) return "status: complete\ndecision: approved\n\nok";
  return "status: complete\n\nready";
}

function writeArtifact(prompt, step) {
  if (step.skip_artifact === true) return;
  const marker = "Migent artifact directory:\n";
  if (!prompt.includes(marker)) return;
  const lines = prompt.split(marker)[1].split(/\r?\n/);
  if (lines.length === 0) return;
  const directory = lines[0].trim();
  let name = null;
  for (const line of lines.slice(1, 6)) {
    if (line.includes("as `")) {
      name = line.split("as `")[1].split("`")[0];
      break;
    }
  }
  if (!name) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, name), typeof step.artifact === "string" ? step.artifact : "# ready\n", "utf8");
}

function argAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function codex(prompt, step) {
  writeArtifact(prompt, step);
  const exitCode = Number(step.exit || 0);
  if (exitCode) process.exit(exitCode);
  const text = responseText(prompt, step);
  const fileText = "file_text" in step ? step.file_text : text;
  const stdoutText = "stdout_text" in step ? step.stdout_text : text;
  const lastMessage = argAfter("--output-last-message");
  if (lastMessage !== undefined) writeFileSync(lastMessage, String(fileText), "utf8");
  emit({ type: "thread.started", thread_id: "fake-codex-thread" });
  emit({ type: "item.completed", item: { type: "agent_message", text: stdoutText } });
}

function grok(prompt, step) {
  writeArtifact(prompt, step);
  const exitCode = Number(step.exit || 0);
  if (exitCode) process.exit(exitCode);
  const text = responseText(prompt, step);
  const events = step.events || "text";
  if (events === "error") {
    emit({ type: "error", message: step.message || "provider failed" });
  } else if (events === "tool") {
    emit({ type: "text", data: "I'll update the file.\n" });
    emit({ type: "tool_call", toolCallId: "call-1", toolName: "write", rawInput: { path: "note.md" } });
    emit({ type: "text", data: text });
  } else {
    emit({ type: "text", data: text });
  }
  emit({ type: "end", sessionId: "fake-grok-session" });
}

const startedAt = Date.now();
const prompt = provider === "codex"
  ? readFileSync(0, "utf8")
  : (() => {
      const promptFile = argAfter("--prompt-file");
      return promptFile === undefined ? "" : readFileSync(promptFile, "utf8");
    })();
const step = takeStep(prompt);
const stage = promptStage(prompt) || (typeof step.stage === "string" ? step.stage : "");
markSeen(stage);
if (typeof step.wait_stage === "string" && step.wait_stage) waitForStage(step.wait_stage);
if (typeof step.delay_ms === "number" && step.delay_ms > 0) sleepMs(step.delay_ms);
recordInvocation({ started_at: startedAt, ended_at: Date.now(), stage });
if (provider === "codex") codex(prompt, step);
else if (provider === "grok") grok(prompt, step);
else {
  process.stderr.write(`unknown fake provider: ${provider}\n`);
  process.exit(2);
}
