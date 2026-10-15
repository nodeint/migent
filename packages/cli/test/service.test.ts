import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ServiceEndpoint, ServiceError, StopResult } from "@nodeint/migent-registry";
import { expect, test } from "vitest";
import { serviceApi } from "../src/commands/service.ts";
import { main } from "../src/index.ts";
import { capture } from "./support.ts";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  const previous = process.env.MIGENT_HOME;
  const api = { ...serviceApi };
  process.env.MIGENT_HOME = home;
  try {
    await fn(home);
  } finally {
    Object.assign(serviceApi, api);
    if (previous === undefined) delete process.env.MIGENT_HOME;
    else process.env.MIGENT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test("status json is stopped without a service file", async () => {
  await withHome(async () => {
    const captured = await capture(() => main(["service", "status", "--json"]));
    expect(captured.value).toBe(0);
    expect(JSON.parse(captured.stdout)).toEqual({ state: "stopped" });
  });
});

test("status json is stopped when identity does not match", async () => {
  await withHome(async (home) => {
    const registry = path.join(home, "registry");
    mkdirSync(registry);
    writeFileSync(
      path.join(registry, "service.json"),
      JSON.stringify({
        schema_version: 1,
        instance_id: "instance-under-test",
        pid: 424242,
        pgid: 424242,
        start_key: "start-key",
        boot_id: "boot-1",
        hostname: "host.example",
        host: "127.0.0.1",
        port: 9,
        token: "secret-token-value",
        started_at: "2026-09-26T08:07:57Z",
      }),
      "utf8",
    );
    const captured = await capture(() => main(["service", "status", "--json"]));
    expect(captured.value).toBe(0);
    expect(JSON.parse(captured.stdout)).toEqual({ state: "stopped" });
    expect(captured.stdout).not.toContain("secret-token-value");
    expect(captured.stderr).not.toContain("secret-token-value");
  });
});

test("start unverified identity exits 1 without a token", async () => {
  await withHome(async () => {
    serviceApi.startDetached = async () => {
      throw new ServiceError("Service identity is unverified.");
    };
    const captured = await capture(() => main(["service", "start"]));
    expect(captured.value).toBe(1);
    expect(captured.stdout).toBe("");
    expect(captured.stderr).toContain("Service identity is unverified.");
  });
});

test("stop still alive exits 1 and leaves the file", async () => {
  await withHome(async (home) => {
    const registry = path.join(home, "registry");
    mkdirSync(registry);
    const file = path.join(registry, "service.json");
    writeFileSync(file, '{"keep": true}\n', "utf8");
    const original = readFileSync(file);
    serviceApi.stop = async () => new StopResult("error", "The process is still alive.");
    const captured = await capture(() => main(["service", "stop"]));
    expect(captured.value).toBe(1);
    expect(captured.stderr).toContain("The process is still alive.");
    expect(readFileSync(file)).toEqual(original);
  });
});

test("detached start prints the endpoint and not the token", async () => {
  await withHome(async () => {
    const endpoint = new ServiceEndpoint("127.0.0.1", 47321, "secret-token-value", "instance", 3);
    let started = 0;
    let foreground = 0;
    serviceApi.startDetached = async () => {
      started += 1;
      return endpoint;
    };
    serviceApi.serveForeground = async () => {
      foreground += 1;
      return endpoint;
    };
    const captured = await capture(() => main(["service", "start"]));
    expect(captured.value).toBe(0);
    expect(started).toBe(1);
    expect(foreground).toBe(0);
    expect(captured.stdout.trim()).toBe("127.0.0.1:47321");
    expect(captured.stdout).not.toContain("secret-token-value");
  });
});

test("foreground start serves in process", async () => {
  await withHome(async () => {
    const endpoint = new ServiceEndpoint("127.0.0.1", 47321, "secret-token-value", "instance", 3);
    let started = 0;
    let foreground = 0;
    serviceApi.serveForeground = async () => {
      foreground += 1;
      return endpoint;
    };
    serviceApi.startDetached = async () => {
      started += 1;
      return endpoint;
    };
    const captured = await capture(() => main(["service", "start", "--foreground"]));
    expect(captured.value).toBe(0);
    expect(foreground).toBe(1);
    expect(started).toBe(0);
    expect(captured.stdout).not.toContain("secret-token-value");
  });
});

test("stop absent exits 0", async () => {
  await withHome(async () => {
    serviceApi.stop = async () => new StopResult("absent");
    const captured = await capture(() => main(["service", "stop"]));
    expect(captured.value).toBe(0);
  });
});
