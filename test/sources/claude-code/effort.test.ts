import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effortIn, readEffort } from '../../../src/sources/claude-code/effort.ts';
import { makeFile, tempDir } from '../../helpers/temp.ts';

describe('effortIn', () => {
  it('prefers the model’s own level over the general one', () => {
    const settings = { effortLevel: 'xhigh', modelSettings: { 'claude-opus-5': { effortLevel: 'high' } } };
    strictEqual(effortIn(settings, 'claude-opus-5'), 'high');
    strictEqual(effortIn(settings, 'claude-sonnet-5'), 'xhigh');
  });

  it('reads a dated snapshot id as its alias', () => {
    const settings = { modelSettings: { 'claude-opus-5': { effortLevel: 'low' } } };
    strictEqual(effortIn(settings, 'claude-opus-5-20260115'), 'low');
  });

  it('says nothing for missing or malformed settings', () => {
    strictEqual(effortIn(undefined, 'claude-opus-5'), undefined);
    strictEqual(effortIn({ effortLevel: 3 }, 'claude-opus-5'), undefined);
    strictEqual(effortIn({ modelSettings: [] }, undefined), undefined);
  });
});

describe('readEffort', () => {
  it('lets project settings override the user’s', async (t) => {
    const dir = await tempDir(t);
    await makeFile(dir, 'claude/settings.json', JSON.stringify({ effortLevel: 'xhigh' }));
    await makeFile(dir, 'proj/.claude/settings.json', JSON.stringify({ effortLevel: 'medium' }));
    await makeFile(dir, 'proj/.claude/settings.local.json', '{ not json');
    strictEqual(await readEffort(`${dir}/claude`, `${dir}/proj`, 'claude-opus-5'), 'medium');
    strictEqual(await readEffort(`${dir}/claude`, `${dir}/elsewhere`, 'claude-opus-5'), 'xhigh');
    strictEqual(await readEffort(`${dir}/nothing`, undefined, 'claude-opus-5'), undefined);
  });
});
