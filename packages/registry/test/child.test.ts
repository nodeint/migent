import { closeSync } from "node:fs";
import { expect, test } from "vitest";
import { childMain, readReadyLine } from "../src/child.ts";
import { setNonBlocking, socketpair } from "../src/posix.ts";
import { monotonic } from "../src/time.ts";

test("child main rejects argv without a complete handshake", async () => {
  expect(await childMain([])).toBe(2);
  expect(await childMain(["--child", "--home", "/tmp", "--port", "1"])).toBe(2);
  expect(await childMain(["--child", "--home", "/tmp", "--port", "1", "--handshake-fd", "-1"])).toBe(2);
});

test("read ready line returns none when the deadline passes", async () => {
  const [parent, child] = socketpair();
  setNonBlocking(parent);
  try {
    expect(await readReadyLine(parent, monotonic() + 0.05)).toBeNull();
  } finally {
    closeSync(parent);
    closeSync(child);
  }
});
