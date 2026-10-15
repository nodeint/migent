import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { childMain } from "../src/child.ts";
import { ServiceEndpointServer, queryEndpoint, requestStop, serviceEndpointPath } from "../src/endpoint.ts";

test("child main rejects incomplete argv", async () => {
  expect(await childMain([])).toBe(2);
  expect(await childMain(["--child", "--home", "/tmp"])).toBe(2);
  expect(await childMain(["--child", "--home", "/tmp", "--port", "1", "--handshake-fd", "3"])).toBe(2);
});

test("endpoint is exclusive, reports its instance, and stops only with the token", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "registry-ep-"));
  const hello = { instance_id: "instance-a", pid: process.pid };
  let stops = 0;
  const first = await ServiceEndpointServer.listen(home, hello, "secret", () => {
    stops += 1;
  });
  try {
    expect(first).not.toBeNull();
    expect(await ServiceEndpointServer.listen(home, { instance_id: "instance-b", pid: 1 }, "x", () => undefined)).toBeNull();
    expect(await queryEndpoint(home)).toEqual({ state: "alive", hello });
    expect(await requestStop(home, "instance-a", "wrong")).toBe(false);
    expect(await requestStop(home, "instance-b", "secret")).toBe(false);
    expect(stops).toBe(0);
    expect(await requestStop(home, "instance-a", "secret")).toBe(true);
    expect(stops).toBe(1);
  } finally {
    first?.close();
  }
  expect(await queryEndpoint(home)).toEqual({ state: "gone" });
  rmSync(home, { recursive: true, force: true });
});

test("long homes fall back to a short socket path", () => {
  const home = path.join("/", "x".repeat(120));
  const endpoint = serviceEndpointPath(home);
  if (process.platform === "win32") expect(endpoint.startsWith("\\\\.\\pipe\\")).toBe(true);
  else expect(Buffer.byteLength(endpoint)).toBeLessThanOrEqual(100);
});
