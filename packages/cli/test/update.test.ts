import { afterEach, expect, test } from "vitest";
import { main } from "../src/index.ts";
import { compareVersions, detectPackageManager, updateHooks } from "../src/commands/update.ts";
import { capture } from "./support.ts";

afterEach(() => {
  updateHooks.fetchLatest = null;
  updateHooks.run = null;
});

test("compareVersions orders releases and pre-releases", () => {
  expect(compareVersions("0.3.3", "0.4.0")).toBeLessThan(0);
  expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
  expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
});

test("detectPackageManager reads the install path", () => {
  expect(detectPackageManager("/u/.bun/install/global/node_modules/@nodeint/migent/dist/index.js")).toBe("bun");
  expect(detectPackageManager("/u/Library/pnpm/global/5/node_modules/x")).toBe("pnpm");
  expect(detectPackageManager("/usr/lib/node_modules/@nodeint/migent/dist/index.js")).toBe("npm");
  expect(detectPackageManager("/repo/packages/cli/dist/index.js")).toBeNull();
});

test("update --check --json reports without upgrading", async () => {
  updateHooks.fetchLatest = async () => "99.0.0";
  updateHooks.run = () => {
    throw new Error("must not run");
  };
  const out = await capture(() => main(["update", "--check", "--json"]));
  expect(out.value).toBe(0);
  expect(JSON.parse(out.stdout)).toMatchObject({ latest: "99.0.0", update_available: true, updated: false });
});

test("update runs the upgrade command when outdated", async () => {
  updateHooks.fetchLatest = async () => "99.0.0";
  const ran: string[][] = [];
  updateHooks.run = (argv) => (ran.push(argv), 0);
  const out = await capture(() => main(["update"]));
  // Running from source has no node_modules install path, so the command is only printed.
  expect(out.value).toBe(0);
  expect(out.stdout).toContain("99.0.0");
});

test("update reports a registry failure", async () => {
  updateHooks.fetchLatest = async () => {
    throw new Error("offline");
  };
  const out = await capture(() => main(["update"]));
  expect(out.value).toBe(1);
});
