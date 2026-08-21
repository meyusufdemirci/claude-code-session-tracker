import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { filterAlive } from '../../../src/sources/claude-code/liveness.ts';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number): string => String(n).padStart(2, '0');

/** `Www Mmm DD HH:MM:SS YYYY` read off the UTC clock — the way Claude Code writes it. */
function ctimeUtc(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** The same instant read off the local clock — the way `ps` prints it. */
function ctimeLocal(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`;
}

/** When this process really started, according to the same `ps` the code asks. */
function realStart(pid: number): number {
  const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)]).toString().trim();
  const [, month, day, clock, year] = out.split(/\s+/);
  const [hour, minute, second] = (clock ?? '').split(':').map(Number);
  return new Date(
    Number(year),
    MONTHS.indexOf(month ?? ''),
    Number(day),
    hour ?? 0,
    minute ?? 0,
    second ?? 0,
  ).getTime();
}

/** A pid that is certainly gone: spawned, exited, and reaped before we look. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid ?? 0;
}

const HOUR = 3_600_000;

describe('filterAlive', () => {
  it('keeps a session whose process is really running', async () => {
    const alive = await filterAlive([
      { pid: process.pid, procStart: ctimeLocal(realStart(process.pid)) },
    ]);

    deepStrictEqual(alive.length, 1);
  });

  it('drops a session whose process has exited', async () => {
    deepStrictEqual(await filterAlive([{ pid: deadPid(), procStart: undefined }]), []);
  });

  it('drops a recycled pid, which is what the second gate is for', async () => {
    // The signal check alone would say yes: the pid exists. Only the start time
    // reveals that it belongs to a different process than the one recorded.
    const alive = await filterAlive([
      { pid: process.pid, procStart: ctimeLocal(realStart(process.pid) - HOUR) },
    ]);

    deepStrictEqual(alive, []);
  });

  it('accepts a claim written in UTC against a ps reading in local time', async (t) => {
    // Claude Code records `procStart` in UTC while `ps` prints local, so in any zone
    // but UTC a naive string compare marks every session on the machine dead. Forcing
    // a UTC+3 zone here is what makes the two readings actually differ on CI too.
    const original = process.env['TZ'];
    process.env['TZ'] = 'Asia/Istanbul';
    t.after(() => {
      if (original === undefined) delete process.env['TZ'];
      else process.env['TZ'] = original;
    });

    const started = realStart(process.pid);
    const asUtc = ctimeUtc(started);
    const asLocal = ctimeLocal(started);

    strictEqual(asUtc === asLocal, false, 'the two readings must differ for this to prove anything');
    strictEqual((await filterAlive([{ pid: process.pid, procStart: asUtc }])).length, 1);
    strictEqual((await filterAlive([{ pid: process.pid, procStart: asLocal }])).length, 1);
  });

  it('decides per record, so two records naming one pid cannot vouch for each other', async () => {
    const started = realStart(process.pid);
    const alive = await filterAlive([
      { pid: process.pid, procStart: ctimeLocal(started) },
      { pid: process.pid, procStart: ctimeLocal(started - HOUR) },
    ]);

    strictEqual(alive.length, 1);
    strictEqual(alive[0]?.procStart, ctimeLocal(started));
  });

  it('keeps a record that makes no start-time claim', async () => {
    // Nothing to check against; the signal is all the evidence there is, and
    // hiding a running session is the worse error.
    strictEqual((await filterAlive([{ pid: process.pid, procStart: undefined }])).length, 1);
  });

  it('keeps a record whose start-time claim cannot be parsed', async () => {
    // The format is undocumented and may change. An unreadable claim must not be
    // read as evidence that the session is dead.
    for (const claim of ['sometime tuesday', '', 'Wed Xxx aa bb:cc:dd eeee', 'Wed Aug 19 05 2026']) {
      strictEqual(
        (await filterAlive([{ pid: process.pid, procStart: claim }])).length,
        1,
        `expected ${JSON.stringify(claim)} to be treated as no claim at all`,
      );
    }
  });

  it('rejects a pid that could never name a process', async () => {
    // These would also make `ps` bail on the whole batch, so they have to go first.
    deepStrictEqual(
      await filterAlive([
        { pid: 0, procStart: undefined },
        { pid: -1, procStart: undefined },
        { pid: 1.5, procStart: undefined },
        { pid: Number.NaN, procStart: undefined },
      ]),
      [],
    );
  });

  it('does not shell out when there is nothing to check', async () => {
    deepStrictEqual(await filterAlive([]), []);
  });
});
