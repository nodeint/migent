import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { migentHomePath, ensureRegistryHome, homeOs, registryHomePath } from "../src/home.ts";

const envHome = process.env.MIGENT_HOME;

afterEach(() => {
  if (envHome === undefined) delete process.env.MIGENT_HOME;
  else process.env.MIGENT_HOME = envHome;
});

test("migent home overrides the default directory", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "registry-home-"));
  process.env.MIGENT_HOME = tmp;
  expect(migentHomePath()).toBe(tmp);
  expect(registryHomePath()).toBe(path.join(tmp, "registry"));
});

test("default home is dot migent under the user home", () => {
  const home = mkdtempSync(path.join(tmpdir(), "registry-user-"));
  const previous = process.env.MIGENT_HOME;
  delete process.env.MIGENT_HOME;
  const original = homeOs.homedir;
  homeOs.homedir = () => home;
  try {
    expect(migentHomePath()).toBe(path.join(home, ".migent"));
    expect(registryHomePath()).toBe(path.join(home, ".migent", "registry"));
  } finally {
    homeOs.homedir = original;
    if (previous === undefined) delete process.env.MIGENT_HOME;
    else process.env.MIGENT_HOME = previous;
  }
});

test("ensure creates the registry directory mode 0700", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "registry-ensure-"));
  const directory = ensureRegistryHome(path.join(tmp, "registry"));
  expect(statSync(directory).isDirectory()).toBe(true);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
});
