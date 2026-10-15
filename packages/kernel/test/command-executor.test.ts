import { expect, test } from "vitest";
import { CommandExecutor } from "../src/command-executor.ts";
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
  const [stdout, error] = await new CommandExecutor(10).run(
    // Keeps running after its output so the endpoint can be probed from the output callback.
    {
      argv: [process.execPath, "-e", "process.stdin.pipe(process.stdout); process.stdin.on('end', () => setTimeout(() => {}, 300))"],
      stdin: "hello\n",
    },
    process.cwd(),
    () => {
      if (info !== null) during = probeEndpointSync(info.endpoint, 1000);
    },
    null,
    (started) => {
      info = started;
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
  const [, error] = await new CommandExecutor(1).run(
    { argv: [process.execPath, "-e", script] },
    process.cwd(),
    (line) => {
      grandchild = Number(line);
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

test("missing executable is reported", async () => {
  const [, error] = await new CommandExecutor(10).run({ argv: ["migent-no-such-binary"] }, process.cwd());
  expect(error).toBe("CLI executable not found: migent-no-such-binary");
});
