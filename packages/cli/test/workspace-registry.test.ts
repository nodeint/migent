import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ServiceEndpoint } from "@nodeint/migent-registry";
import { expect, test } from "vitest";
import { PACKAGE_VERSION } from "../src/version.ts";
import { workspaceApi } from "../src/commands/workspace-registry.ts";
import { main } from "../src/index.ts";
import { capture } from "./support.ts";

const endpoint = new ServiceEndpoint("127.0.0.1", 9, "token", "instance", 7);

async function withHome(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  const home = path.join(root, "home");
  mkdirSync(home);
  const previous = process.env.MIGENT_HOME;
  const api = { ...workspaceApi };
  process.env.MIGENT_HOME = home;
  try {
    await fn(root);
  } finally {
    Object.assign(workspaceApi, api);
    if (previous === undefined) delete process.env.MIGENT_HOME;
    else process.env.MIGENT_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

function project(directory: string): string {
  const config = path.join(directory, ".migent");
  mkdirSync(config, { recursive: true });
  writeFileSync(path.join(config, "config.yaml"), "schema_version: 1\n", "utf8");
  return directory;
}

test("register from a subdirectory sends the absolute root", async () => {
  await withHome(async (root) => {
    const workspace = project(path.join(root, "demo"));
    const child = path.join(workspace, "src");
    mkdirSync(child);
    const calls: unknown[][] = [];
    let started = 0;
    workspaceApi.startDetached = async () => {
      started += 1;
      return endpoint;
    };
    workspaceApi.callService = async (...args) => {
      calls.push(args);
      const body = args[5] as { path: string };
      return [201, { id: "ws_demo", path: body.path, available: true }];
    };
    const captured = await capture(() => main(["workspace", "register"], child));
    expect(captured.value).toBe(0);
    expect(started).toBe(1);
    const body = calls[0]?.[5] as { path: string; tool: { name: string; version: string } };
    expect(calls[0]?.[3]).toBe("POST");
    const absolute = realpathSync(workspace);
    expect(body.path).toBe(absolute);
    expect(path.isAbsolute(body.path)).toBe(true);
    expect(body.tool).toEqual({ name: "migent", version: PACKAGE_VERSION });
    expect(captured.stderr).toContain("Registered ws_demo.");
    expect(captured.stderr).toContain(absolute);
    // stdout is JSON, which escapes Windows backslashes.
    expect(captured.stdout).toContain(JSON.stringify(absolute).slice(1, -1));
  });
});

test("register relative path resolves against the invocation cwd", async () => {
  await withHome(async (root) => {
    const workspace = project(path.join(root, "demo"));
    mkdirSync(path.join(workspace, "src", "pkg"), { recursive: true });
    const calls: unknown[][] = [];
    workspaceApi.startDetached = async () => endpoint;
    workspaceApi.callService = async (...args) => {
      calls.push(args);
      const body = args[5] as { path: string };
      return [201, { id: "ws_demo", path: body.path, available: true }];
    };
    const captured = await capture(() => main(["workspace", "register", "--path", "src/pkg"], workspace));
    expect(captured.value).toBe(0);
    expect((calls[0]?.[5] as { path: string }).path).toBe(realpathSync(workspace));
  });
});

test("register without a workspace exits 2 and does not start", async () => {
  await withHome(async (root) => {
    let started = 0;
    workspaceApi.startDetached = async () => {
      started += 1;
      return endpoint;
    };
    const captured = await capture(() => main(["workspace", "register"], root));
    expect(captured.value).toBe(2);
    expect(started).toBe(0);
    expect(captured.stderr).toContain("config.yaml");
  });
});

test("list json exits 0 and remove of unknown id exits 2", async () => {
  await withHome(async (root) => {
    const registry = path.join(root, "home", "registry");
    mkdirSync(registry);
    writeFileSync(
      path.join(registry, "service.json"),
      JSON.stringify({
        schema_version: 1,
        instance_id: "instance",
        pid: 7,
        pgid: 7,
        start_key: "start",
        boot_id: "boot",
        hostname: "host",
        host: "127.0.0.1",
        port: 9,
        token: "token",
        started_at: "2026-09-26T08:07:57Z",
      }),
      "utf8",
    );
    const rows = [{ id: "ws_abc", name: "demo", path: "/tmp/demo", available: true }];
    workspaceApi.callService = async (...args) => {
      if (args[3] === "GET") return [200, { workspaces: rows }];
      return [404, { error: "workspace_not_found", message: "unknown id" }];
    };
    const listed = await capture(() => main(["workspace", "list", "--json"]));
    expect(listed.value).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual({ workspaces: rows });
    const removed = await capture(() => main(["workspace", "remove", "ws_missing"]));
    expect(removed.value).toBe(2);
    expect(removed.stderr).toContain("unknown id");
  });
});
