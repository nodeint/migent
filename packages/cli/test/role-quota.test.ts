import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { AgentToolRunner, type FailureClassification, type RunResult, resetCancellation, raiseCancellation } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { dispatchAgent } from "../src/commands/agent.ts";
import { ScriptedProvider, removeWorkspace, repoWorkflowText, writeFakeWorkflowWorkspace } from "./support.ts";

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

class ClassifiedProvider extends ScriptedProvider {
  private readonly kinds: Array<FailureClassification | null>;

  constructor(responses: string[], kinds: Array<FailureClassification | null>) {
    super(responses);
    this.kinds = [...kinds];
  }

  override classifyFailure(): FailureClassification | null {
    const next = this.kinds.shift();
    return next === undefined ? null : next;
  }
}

function quota(resetAt: string | null): FailureClassification {
  return { kind: "quota", message: "limited", resetAt, window: null };
}

function workspace(): string {
  return writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
}

function runner(provider: ClassifiedProvider) {
  return new AgentToolRunner({ fake: provider }, 10);
}

test("a role quota waits and reruns with the original prompt", async () => {
  const root = workspace();
  const provider = new ClassifiedProvider(
    ["status: complete\n\nlimited", "status: complete\n\ndone"],
    [quota(FUTURE), null],
  );
  const now = { value: Date.parse(PAST) };
  try {
    const code = await dispatchAgent(root, {
      role: "reviewer",
      prompt: "Review the latest changes",
      runner: runner(provider),
      waitHooks: {
        now: () => now.value,
        sleep: async () => {
          now.value = Date.parse(FUTURE);
        },
      },
    });
    expect(code).toBe(0);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.prompt).toBe(provider.calls[0]?.prompt);
    expect(provider.calls[1]?.prompt).toContain("Review the latest changes");
    const sessionId = readSessionId(root);
    const executions = readdirSync(path.join(root, ".migent", "sessions", sessionId, "executions")).sort();
    const second = JSON.parse(
      readFileSync(path.join(root, ".migent", "sessions", sessionId, "executions", executions[1]!, "execution.json"), "utf8"),
    ) as { resumes_execution_id?: string };
    expect(second.resumes_execution_id).toBe(executions[0]);
  } finally {
    resetCancellation();
    removeWorkspace(root);
  }
});

test("a role quota that is not later returns 1 without another call", async () => {
  const root = workspace();
  const provider = new ClassifiedProvider(
    ["status: complete\n\nfirst", "status: complete\n\nsecond", "status: complete\n\nthird"],
    [quota(FUTURE), quota(FUTURE), null],
  );
  const now = { value: Date.parse(PAST) };
  try {
    const code = await dispatchAgent(root, {
      role: "reviewer",
      prompt: "Review",
      runner: new AgentToolRunner({ fake: provider }, 10),
      waitHooks: {
        now: () => now.value,
        sleep: async () => {
          now.value = Date.parse(FUTURE);
        },
      },
    });
    expect(code).toBe(1);
    expect(provider.calls).toHaveLength(2);
  } finally {
    resetCancellation();
    removeWorkspace(root);
  }
});

test("a role quota without reset_at and a provider failure return 1", async () => {
  const root = workspace();
  try {
    const missing = new ClassifiedProvider(["status: complete\n\nx"], [quota(null)]);
    expect(
      await dispatchAgent(root, {
        role: "reviewer",
        prompt: "Review",
        runner: new AgentToolRunner({ fake: missing }, 10),
        waitHooks: { sleep: async () => { throw new Error("waited"); } },
      }),
    ).toBe(1);
    expect(missing.calls).toHaveLength(1);
    const provider = new ClassifiedProvider(["status: complete\n\nx"], [{ kind: "provider", message: "down" }]);
    expect(
      await dispatchAgent(root, {
        role: "reviewer",
        prompt: "Review",
        runner: new AgentToolRunner({ fake: provider }, 10),
        waitHooks: { sleep: async () => { throw new Error("waited"); } },
      }),
    ).toBe(1);
  } finally {
    resetCancellation();
    removeWorkspace(root);
  }
});

test("cancel during a role wait returns 130", async () => {
  const root = workspace();
  const provider = new ClassifiedProvider(["status: complete\n\nx"], [quota(FUTURE)]);
  try {
    const code = await dispatchAgent(root, {
      role: "reviewer",
      prompt: "Review",
      runner: new AgentToolRunner({ fake: provider }, 10),
      waitHooks: {
        now: () => Date.parse(PAST),
        sleep: async () => {
          raiseCancellation(2);
        },
      },
    });
    expect(code).toBe(130);
    expect(provider.calls).toHaveLength(1);
  } finally {
    resetCancellation();
    removeWorkspace(root);
  }
});

test("a single verify-exhausted role result returns 1", async () => {
  const root = workspace();
  const result: RunResult = {
    agent_id: "a",
    options: {},
    session_id: "s",
    execution_id: "e",
    artifact_directory: "",
    outcome_status: "",
    outcome_decision: "",
    session_status: "active",
    response: "",
    failure_reason: "verify_exhausted",
    failure_kind: "",
    reset_at: "",
    provider: "fake",
  };
  const runner = {
    run: async () => result,
  } as unknown as AgentToolRunner;
  try {
    expect(await dispatchAgent(root, { role: "reviewer", prompt: "Review", runner })).toBe(1);
  } finally {
    removeWorkspace(root);
  }
});

test("a cancelled role quota reruns with the last user prompt", async () => {
  const root = workspace();
  class HangProvider extends ScriptedProvider {
    override buildCommand(input: Parameters<ScriptedProvider["buildCommand"]>[0]) {
      super.buildCommand(input);
      return { argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"] };
    }
  }
  const hanging = new HangProvider(["status: complete\n\nunused"]);
  const timer = setTimeout(() => {
    try {
      raiseCancellation(15);
    } catch {
      // The flag stays set for the command.
    }
  }, 200);
  try {
    const cancelled = await dispatchAgent(root, {
      role: "reviewer",
      prompt: "Review the saved turn",
      runner: new AgentToolRunner({ fake: hanging }, 10),
    });
    expect(cancelled).toBe(130);
    resetCancellation();
    const provider = new ClassifiedProvider(
      ["status: complete\n\nlimited", "status: complete\n\ndone"],
      [quota(FUTURE), null],
    );
    const now = { value: Date.parse(PAST) };
    const code = await dispatchAgent(root, {
      role: "reviewer",
      prompt: "this prompt must not be read",
      promptFile: null,
      runner: new AgentToolRunner({ fake: provider }, 10),
      waitHooks: {
        now: () => now.value,
        sleep: async () => {
          now.value = Date.parse(FUTURE);
        },
      },
      sessionId: readSessionId(root),
    });
    expect(code).toBe(0);
    expect(provider.calls[1]?.prompt).toContain("Review the saved turn");
    expect(provider.calls[1]?.prompt).not.toContain("this prompt must not be read");
  } finally {
    clearTimeout(timer);
    resetCancellation();
    removeWorkspace(root);
  }
});

function readSessionId(root: string): string {
  const names = readdirSync(path.join(root, ".migent", "sessions")).filter((name) => !name.startsWith("."));
  const session = names[0];
  if (!session) throw new Error("missing session");
  return session;
}
