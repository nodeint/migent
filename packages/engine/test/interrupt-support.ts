import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { BuildCommandInput, CliRunOutput, CommandSpec, InterruptOutcome } from '@nodeint/migent-kernel';
import { raiseCancellation } from '@nodeint/migent-kernel';
import { createWorkflowSession } from '@nodeint/migent-session';

import { FakeClient, tempDir } from './support.ts';

const CONFIG = `\
agents:
  fake:
    client:
      type: fake
    model: m1
roles:
  developer:
    agent: fake
`;

const WORKFLOW = `\
id: wf
stages:
  - id: implement
    role: developer
completion:
  stage: implement
`;

/** Signal number the cancellation request carries (SIGTERM). */
const CANCEL_SIGNAL = 15;
const POLL_INTERVAL_MS = 50;

export const PRE_ID = 'ses_0123456789abABCDEFGHIJKLMN';

export function setup(): { workspace: string; sessionId: string } {
  const workspace = tempDir('migent-interrupt-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), WORKFLOW, 'utf8');
  return { workspace, sessionId: createWorkflowSession(workspace, 'wf', { task: 'Finish the notes' }) };
}

/** Hangs like a client of a shared server; the interrupt command logs whether the client still lives. */
export class ServerProvider extends FakeClient {
  public readonly pidFile: string;
  public readonly interruptLog: string;
  public outcomes: InterruptOutcome[] = [];
  public reportedId: string | null = null;
  public hang = true;

  constructor(root: string) {
    super();
    this.pidFile = path.join(root, 'pid');
    this.interruptLog = path.join(root, 'interrupts.log');
  }

  public newSessionId(): string | null {
    return PRE_ID;
  }

  public override runCommand(input: BuildCommandInput): CommandSpec {
    if (!this.hang) return super.runCommand(input);
    this.calls.push({ ...input, options: { ...input.options } });
    const announce =
      this.reportedId === null ? '' : `console.log(JSON.stringify({sessionID:${JSON.stringify(this.reportedId)}}));`;
    // Announce first and publish the pid later: the test cancels as soon as the pid file exists, and the
    // parent must have read the announced id by then (a slow runner otherwise cancels before it does).
    const writePid = `require("fs").writeFileSync(${JSON.stringify(this.pidFile)}, String(process.pid));`;
    const code =
      announce === ''
        ? writePid + 'setInterval(() => {}, 1000);'
        : announce + `setTimeout(() => {${writePid}}, 1000);setInterval(() => {}, 1000);`;
    return { argv: [process.execPath, '-e', code] };
  }

  public override parseRun(stdout: string, lastMessageFile: string): CliRunOutput {
    return this.hang ? { text: stdout, sessionId: null, source: 'model' } : super.parseRun(stdout, lastMessageFile);
  }

  public interruptCommand(agentId: string): CommandSpec {
    const code =
      'const fs=require("fs");let alive="unknown";' +
      `try{process.kill(Number(fs.readFileSync(${JSON.stringify(this.pidFile)},"utf8")),0);alive="alive"}catch(e){alive="dead"}` +
      `fs.appendFileSync(${JSON.stringify(this.interruptLog)}, process.argv[1]+" "+alive+"\\n");`;
    return { argv: [process.execPath, '-e', code, agentId] };
  }

  public classifyInterrupt(_stdout: string, _exitCode: number | null): InterruptOutcome {
    return this.outcomes.shift() ?? 'interrupted';
  }

  public sessionIdFromLine(line: string): string | null {
    try {
      const id = (JSON.parse(line) as { sessionID?: unknown }).sessionID;
      return typeof id === 'string' ? id : null;
    } catch {
      return null;
    }
  }

  public interrupts(): string[] {
    return existsSync(this.interruptLog) ? readFileSync(this.interruptLog, 'utf8').trim().split('\n') : [];
  }
}

export function cancelWhenStarted(provider: ServerProvider): () => void {
  const timer = setInterval(() => {
    if (!existsSync(provider.pidFile) || readFileSync(provider.pidFile, 'utf8').trim() === '') return;
    clearInterval(timer);
    try {
      raiseCancellation(CANCEL_SIGNAL);
    } catch {
      // The waiters were woken; the throw is for signal handlers.
    }
  }, POLL_INTERVAL_MS);
  return () => clearInterval(timer);
}
