import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contextWindowFor } from '../../../src/sources/claude-code/models.ts';

describe('contextWindowFor', () => {
  it('knows the million-token models from the 200k ones', () => {
    strictEqual(contextWindowFor('claude-opus-5'), 1_000_000);
    strictEqual(contextWindowFor('claude-sonnet-5'), 1_000_000);
    strictEqual(contextWindowFor('claude-haiku-4-5'), 200_000);
    strictEqual(contextWindowFor('claude-3-5-sonnet'), 200_000);
  });

  it('reads a dated snapshot id as its alias', () => {
    // Transcripts record whichever form the turn used, and both mean one model.
    strictEqual(contextWindowFor('claude-haiku-4-5-20251001'), 200_000);
    strictEqual(contextWindowFor('claude-opus-5-20260115'), 1_000_000);
  });

  it('says nothing rather than guessing at a model it has not seen', () => {
    // A guess would put a wrong bar on the page. Skipping the maths shows no bar,
    // which is the honest answer for a model released after this table was written.
    strictEqual(contextWindowFor('claude-opus-9'), undefined);
    strictEqual(contextWindowFor('gpt-4o'), undefined);
    strictEqual(contextWindowFor(''), undefined);
    strictEqual(contextWindowFor(undefined), undefined);
  });

  it('does not mistake a date-like suffix for a snapshot', () => {
    strictEqual(contextWindowFor('claude-opus-5-2026011'), undefined);
  });
});
