import { expect, test } from "vitest";
import { CommandExecutor } from "../src/command-executor.ts";
import { UnpassableArgument, assertArgumentsPassable, spawnProviderSync } from "../src/provider-spawn.ts";

const resolveTo = (resolved: string | null) => () => resolved;

test("line breaks are refused only for Windows batch shims", () => {
  const args = ["--append-system-prompt", "line one\nline two"];
  expect(() => assertArgumentsPassable("claude", args, "win32", resolveTo("C:\\npm\\claude.CMD"))).toThrow(
    UnpassableArgument,
  );
  expect(() => assertArgumentsPassable("tool", args, "win32", resolveTo("C:\\bin\\tool.bat"))).toThrow(
    UnpassableArgument,
  );
  expect(() => assertArgumentsPassable("claude", args, "win32", resolveTo("C:\\bin\\claude.exe"))).not.toThrow();
  expect(() => assertArgumentsPassable("claude", ["-p", "one line"], "win32", resolveTo("C:\\npm\\claude.cmd"))).not.toThrow();
  expect(() => assertArgumentsPassable("claude", args, "darwin", resolveTo("/usr/bin/claude"))).not.toThrow();
  expect(() => assertArgumentsPassable("claude.cmd", args, "win32", resolveTo(null))).toThrow(UnpassableArgument);
});

test("sync spawn runs a command and reports a missing one", () => {
  const ok = spawnProviderSync(process.execPath, ["-e", "process.stdout.write('hi')"], { encoding: "utf8" });
  expect(ok.status).toBe(0);
  expect(ok.stdout).toBe("hi");
  const missing = spawnProviderSync("migent-no-such-binary", [], { encoding: "utf8" });
  expect((missing.error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
});

test.runIf(process.platform === "win32")("executor refuses a multi-line argument to a .cmd shim", async () => {
  const [, error] = await new CommandExecutor(10).run({ argv: ["npm", "--version\nx"] }, process.cwd());
  expect(error).toMatch(/batch script/);
});
