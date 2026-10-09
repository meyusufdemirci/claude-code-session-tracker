import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseUtilization } from '../../../src/sources/claude-code/quota.ts';

const RESET = '2026-10-10T13:00:00+00:00';

describe('parseUtilization', () => {
  it('takes the all-models week out of `limits` when `seven_day` is null', () => {
    const usage = parseUtilization(
      {
        seven_day: null,
        limits: [
          { kind: 'session', group: 'session', percent: 10, resets_at: RESET, scope: null },
          { kind: 'weekly_scoped', group: 'weekly', percent: 4, resets_at: RESET, scope: { model: { display_name: 'Fable' } } },
          { kind: 'weekly', group: 'weekly', percent: 37, resets_at: RESET, scope: null },
        ],
      },
      1,
      'server',
    );
    deepStrictEqual(usage.weekly, { percent: 37, resetsAt: Date.parse(RESET) });
  });

  it("falls back to a model's own week, named after the model, when there is no all-models one", () => {
    const usage = parseUtilization(
      {
        seven_day: null,
        limits: [
          { kind: 'session', group: 'session', percent: 10, resets_at: RESET, scope: null },
          { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: RESET, scope: { model: { id: null, display_name: 'Fable' } } },
        ],
      },
      1,
      'server',
    );
    deepStrictEqual(usage.weekly, { percent: 0, resetsAt: Date.parse(RESET), scope: 'Fable' });
  });

  it('still prefers `seven_day` when the readout has one', () => {
    const usage = parseUtilization(
      {
        seven_day: { utilization: 33, resets_at: RESET },
        limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: RESET, scope: { model: { display_name: 'Fable' } } }],
      },
      1,
      'server',
    );
    strictEqual(usage.weekly?.percent, 33);
    strictEqual(usage.weekly?.scope, undefined);
  });
});
