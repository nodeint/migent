import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { TailBuffer } from "../src/tail-buffer.ts";
import {
  CancellationRequested,
  CommandExecutor,
  createWrapperStepParser,
  describeStartFailure,
  raiseCancellation,
  resetCancellation,
  startWrapper,
  waitForReady,
} from "../src/command-executor.ts";
import { bindCancellationSignals } from "../../cli/src/signals.ts";
import {
  ENDPOINT_ALIVE,
  ENDPOINT_GONE,
  type EndpointState,
  PID_GONE,
  type ProcessStartInfo,
  probeEndpointSync,
  probePid,
} from "../src/process-ownership.ts";

test("records a live endpoint while the provider runs", async () => {
  let info: ProcessStartInfo | null = null;
  let during: EndpointState | null = null;
  const { stdout, error } = await new CommandExecutor(10).run(
    // Keeps running after its output so the endpoint can be probed from the output callback.
    {
      argv: [process.execPath, "-e", "process.stdin.pipe(process.stdout); process.stdin.on('end', () => setTimeout(() => {}, 300))"],
      stdin: "hello\n",
    },
    process.cwd(),
    {
      onOutput: () => {
        if (info !== null) during = probeEndpointSync(info.endpoint, 1000);
      },
      onStart: (started) => {
        info = started;
      },
    },
  );
  expect(error).toBeNull();
  expect(stdout).toBe("hello");
  expect(info).not.toBeNull();
  const started = info as unknown as ProcessStartInfo;
  expect(started.ownerPid).toBe(process.pid);
  expect(during).toBe(ENDPOINT_ALIVE);
  expect(probeEndpointSync(started.endpoint, 1000)).toBe(ENDPOINT_GONE);
});

test("timeout stops the provider tree", async () => {
  // The grandchild ignores SIGTERM, so only the group-wide SIGKILL after the grace period ends it.
  const script = `
    const { spawn } = require("child_process");
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `;
  let grandchild = -1;
  const { error } = await new CommandExecutor(1).run(
    { argv: [process.execPath, "-e", script] },
    process.cwd(),
    {
      onOutput: (line) => {
        grandchild = Number(line);
      },
    },
  );
  expect(error).toBe("Sub-agent timed out after 1s.");
  expect(grandchild).toBeGreaterThan(0);
  const deadline = Date.now() + 2000;
  while (probePid(grandchild) !== PID_GONE && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(probePid(grandchild)).toBe(PID_GONE);
}, 15000);

test("one cancellation stops every running command until reset", async () => {
  const hang = [process.execPath, "-e", "setInterval(() => {}, 1000)"];
  let ready = 0;
  let markReady: () => void = () => {};
  const bothReady = new Promise<void>((resolve) => {
    markReady = () => {
      ready += 1;
      if (ready === 2) resolve();
    };
  });
  const first = new CommandExecutor().run({ argv: hang }, process.cwd(), { onStart: () => markReady() });
  const second = new CommandExecutor().run({ argv: hang }, process.cwd(), { onStart: () => markReady() });
  // Attach before the flag is raised. Both reject together after the kill grace period.
  const firstError = first.then(
    () => new Error("first command should have been cancelled"),
    (error: unknown) => error,
  );
  const secondError = second.then(
    () => new Error("second command should have been cancelled"),
    (error: unknown) => error,
  );
  try {
    await Promise.race([
      bothReady,
      new Promise((_, reject) => setTimeout(() => reject(new Error("commands did not start")), 10000)),
    ]);
    try {
      raiseCancellation(15);
    } catch {
      // The flag stays set so both commands observe it.
    }
    expect(await firstError).toBeInstanceOf(CancellationRequested);
    expect(await secondError).toBeInstanceOf(CancellationRequested);
    resetCancellation();
    const { error: cleared } = await new CommandExecutor(10).run(
      { argv: [process.execPath, "-e", "process.stdout.write('ok')"] },
      process.cwd(),
    );
    expect(cleared).toBeNull();
    try {
      raiseCancellation(2);
    } catch {
      // Unbind clears the kernel flag as well as the CLI flag.
    }
    const unbind = bindCancellationSignals();
    unbind();
    const { error: afterUnbind } = await new CommandExecutor(10).run(
      { argv: [process.execPath, "-e", "process.stdout.write('ok')"] },
      process.cwd(),
    );
    expect(afterUnbind).toBeNull();
  } finally {
    resetCancellation();
    await Promise.allSettled([first, second]);
  }
}, 30000);

test("missing executable is reported", async () => {
  const { error, failure } = await new CommandExecutor(10).run({ argv: ["migent-no-such-binary"] }, process.cwd());
  expect(error).toBe("CLI executable not found: migent-no-such-binary");
  expect(failure?.phase).toBe("spawn");
  expect(failure?.code).toBe("ENOENT");
  expect(failure?.argCount).toBe(0);
});

test("a provider that cannot be started reports its real cause", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "migent-exec-"));
  try {
    const file = path.join(directory, "not-executable");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o644);
    const { error, failure } = await new CommandExecutor(10).run({ argv: [file] }, process.cwd());
    expect(error).toContain("EACCES");
    expect(error).not.toContain("not found");
    expect(failure?.kind).toBe("start");
    expect(failure?.phase).toBe("spawn");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a wrapper that cannot listen reports the endpoint and stderr", async () => {
  // A stand-in for a wrapper that dies before it is ready.
  const child = spawn(process.execPath, ["-e", "process.stderr.write('boom\\n'); process.exit(3)"], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const result = await waitForReady(child, { settleMs: 20 });
  expect(result).toEqual({ kind: "exited", code: 3, signal: null });
  expect(describeStartFailure(result, { command: "x", stderrTail: "a\nboom\n" })).toBe(
    "Provider process wrapper exited before it was ready (code 3). stderr: a | boom",
  );
});

test("a spawn error that fired before waiting is still reported", async () => {
  const child = startWrapper({ argv: ["x"] }, "/nonexistent-migent-cwd", "/tmp/x.sock");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const result = await waitForReady(child, { settleMs: 20 });
  expect(result.kind).toBe("spawn-error");
  expect((result as { code?: string }).code).toBe("ENOENT");
});

test("a wrapper-reported failure is described by its errno, not its phase", () => {
  const base = { kind: "wrapper-reported" as const, phase: "spawn" as const, message: "spawn x EPERM" };
  expect(describeStartFailure({ ...base, code: "ENOENT" }, { command: "x" })).toBe("CLI executable not found: x");
  expect(describeStartFailure({ ...base, code: "EPERM", syscall: "spawn x" }, { command: "x" })).toBe(
    "Provider CLI could not be started: x: EPERM (spawn x) spawn x EPERM",
  );
  expect(describeStartFailure(base, { command: "x" })).toBe("Provider wrapper failed (spawn): spawn x EPERM");
  expect(
    describeStartFailure({ kind: "wrapper-reported", phase: "listen", message: "EACCES" }, { command: "x" }),
  ).toBe("Provider wrapper failed to start (listen): EACCES");
});

test("a signal exit during the settle window is cancellation, not a startup failure", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  try {
    const pending = waitForReady(child, { settleMs: 400 });
    child.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      raiseCancellation(2);
    } catch {
      // expected
    }
    expect(await pending).toEqual({ kind: "cancelled" });
  } finally {
    resetCancellation();
  }
});

test("a signal exit with no cancellation is a startup failure after the window", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const pending = waitForReady(child, { settleMs: 50 });
  child.kill("SIGKILL");
  expect(await pending).toEqual({ kind: "exited", code: null, signal: "SIGKILL" });
});

test("a non-zero provider exit with stderr output is recorded", async () => {
  const { error, exitCode, failure } = await new CommandExecutor(10).run(
    { argv: [process.execPath, "-e", "console.error('provider says no'); process.exit(4)"] },
    process.cwd(),
  );
  expect(exitCode).toBe(4);
  expect(error).toBe("CLI exited with code 4.");
  expect(failure?.kind).toBe("provider-exit");
  expect(failure?.stderrTail).toContain("provider says no");
});

test("tail buffer keeps only the last bytes", () => {
  const tail = new TailBuffer(10);
  tail.append("0123456789");
  tail.append("abcdef");
  expect(tail.toString()).toBe("6789abcdef");
});

test("a cancellation that lands while the pipes drain is not recorded as a failure", async () => {
  try {
    const run = new CommandExecutor(10).run(
      { argv: [process.execPath, "-e", "console.error('late'); process.exit(4)"] },
      process.cwd(),
      {
        onDebug: (step) => {
          // Fires right before the executor waits for the pipes to close.
          if (!step.startsWith("provider exit")) return;
          try {
            raiseCancellation(2);
          } catch {
            // the flag stays set
          }
        },
      },
    );
    await expect(run).rejects.toBeInstanceOf(CancellationRequested);
  } finally {
    resetCancellation();
  }
});

test("a closed owner stderr pipe cannot crash the tee", async () => {
  await new CommandExecutor(10).run(
    { argv: [process.execPath, "-e", "console.error('x')"] },
    process.cwd(),
  );
  // Without an error listener on process.stderr, an EPIPE emitted later would be uncaught.
  expect(() => process.stderr.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
});

test("wrapper step parser stays bounded on long newline-free output and keeps later traces", () => {
  const steps: string[] = [];
  const parse = createWrapperStepParser((step) => steps.push(step));
  const noise = "x".repeat(1024 * 1024);
  for (let index = 0; index < 8; index += 1) parse(noise);
  parse("\n[migent-wrapper] 2026-01-01T00:00:00.000Z listening\n");
  // A trace split across chunks, after an oversized wrapper-prefixed line.
  parse(`[migent-wrapper] ${"y".repeat(10_000)}\n[migent-wr`);
  parse("apper] provider spawned\r\nnot a trace\n");
  expect(steps).toEqual(["listening", "provider spawned"]);
});
