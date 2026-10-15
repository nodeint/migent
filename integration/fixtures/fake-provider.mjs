// Fake codex and grok CLIs for integration tests. bin/<name> (POSIX) and bin/<name>.cmd
// (Windows) run this file with the provider name first, so tests go through the same PATH
// lookup and spawn path as the real CLIs.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

function takeStep() {
  const script = process.env.MIGENT_FAKE_SCRIPT;
  if (!script) return {};
  const steps = JSON.parse(readFileSync(script, "utf8"));
  if (!Array.isArray(steps)) return { text: "script must be a list", exit: 9 };
  const cursor = process.env.MIGENT_FAKE_CURSOR;
  mkdirSync(path.dirname(cursor), { recursive: true });
  return withCursorLock(cursor, () => {
    const raw = existsSync(cursor) ? readFileSync(cursor, "ascii").trim() : "";
    const index = Number.parseInt(raw || "0", 10);
    const step = steps[index];
    writeFileSync(cursor, String(index + 1), "ascii");
    return step && typeof step === "object" ? step : { text: "script exhausted", exit: 9 };
  });
}

function recordInvocation() {
  const log = process.env.MIGENT_FAKE_LOG;
  if (!log) return;
  mkdirSync(path.dirname(log), { recursive: true });
  appendFileSync(log, `${JSON.stringify({ provider, argv: [provider, ...args] })}\n`, "utf8");
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

function codex(step) {
  const prompt = readFileSync(0, "utf8");
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

function grok(step) {
  const promptFile = argAfter("--prompt-file");
  const prompt = promptFile === undefined ? "" : readFileSync(promptFile, "utf8");
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

const step = takeStep();
recordInvocation();
if (provider === "codex") codex(step);
else if (provider === "grok") grok(step);
else {
  process.stderr.write(`unknown fake provider: ${provider}\n`);
  process.exit(2);
}
