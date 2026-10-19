import { parseArgs } from 'node:util';
import { AutoContinue, waitToContinue, type LimitClock, type LimitReading, type StopFailureInput } from './auto-continue.ts';
import { createConfig } from './config.ts';
import type { UsageLimits } from './core/types.ts';
import { defaultIo, findTracker, PORTS, type Io } from './status.ts';

const USAGE = `
  Usage
    $ claude-code-session-tracker auto-continue on|off|status
    $ claude-code-session-tracker auto-continue wait   (run by the plugin's hook)

  Continues a Claude Code session that stopped on a usage limit once the limit resets.
  The waiting is done by the session-tracker plugin's hook, so the plugin has to be
  installed for anything to continue.
`;

const PLUGIN_LINES: Record<string, string> = {
  ready: 'installed',
  missing: 'not installed. Run /plugin install session-tracker@claude-code-session-tracker in Claude Code',
  outdated: 'too old to carry the hook. Run /plugin update session-tracker in Claude Code',
  disabled: 'installed but disabled. Turn it on with /plugin in Claude Code',
};

export async function autoContinueCommand(args: string[], io: Io = defaultIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { 'claude-dir': { type: 'string' } }, allowPositionals: true });
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 1;
  }
  const [action] = parsed.positionals;
  const autoContinue = new AutoContinue({ claudeDir: createConfig({ claudeDir: parsed.values['claude-dir'] }).claudeDir });

  if (action === 'wait') return wait(autoContinue);
  if (action === 'on' || action === 'off') {
    autoContinue.setEnabled(action === 'on');
    io.out(`\n  Auto continue  ${action}\n\n`);
    if (action === 'on' && autoContinue.plugin() !== 'ready') io.out(`  The plugin is ${PLUGIN_LINES[autoContinue.plugin()]}.\n\n`);
    return 0;
  }
  if (action === 'status') {
    const status = autoContinue.status();
    let text = `\n  Auto continue  ${status.enabled ? 'on' : 'off'}\n  Plugin         ${PLUGIN_LINES[status.plugin]}\n`;
    for (const entry of status.pending) {
      text += `  Waiting        ${entry.cwd ?? entry.sessionId}  continues ${new Date(entry.continueAt).toLocaleString()}\n`;
    }
    io.out(`${text}\n`);
    return 0;
  }

  io.err(`${USAGE}\n`);
  return 1;
}

/**
 * The hook itself. Claude Code runs it in the background and wakes the session when
 * it exits 2, so the exit code is the whole answer; nothing is printed on stdout.
 */
async function wait(autoContinue: AutoContinue): Promise<number> {
  let input: StopFailureInput = {};
  try {
    input = JSON.parse(await readStdin()) as StopFailureInput;
  } catch {
    return 0;
  }

  // The session ending ends its hooks too. Whatever it was waiting for goes with it.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => {
      autoContinue.unregister(process.pid);
      process.exit(0);
    });
  }

  return waitToContinue(input, {
    autoContinue,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readings,
    pid: process.pid,
    say: (text) => process.stderr.write(`${text}\n`),
  });
}

/** What a running tracker reads each limit as, keyed the way a refusal names its clock. */
async function readings(): Promise<Partial<Record<LimitClock, LimitReading>> | undefined> {
  const tracker = await findTracker({ fetch, ports: PORTS });
  if (!tracker) return undefined;
  try {
    const response = await fetch(`${tracker.url}/api/limits`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return undefined;
    const limits = (await response.json()) as UsageLimits;
    const read = (limit: UsageLimits['session'] | undefined): LimitReading | undefined =>
      limit?.reported ? { percent: limit.reported.percent, fetchedAt: limit.reported.fetchedAt, ...(limit.reported.resetsAt !== undefined ? { resetsAt: limit.reported.resetsAt } : {}) } : undefined;
    const fiveHour = read(limits.session);
    const weekly = read(limits.weekly);
    return { ...(fiveHour ? { five_hour: fiveHour } : {}), ...(weekly ? { weekly } : {}) };
  } catch {
    return undefined;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
