import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  pathToSlug,
  projectNameFromPath,
  resolveSlugPath,
  slugToPathGuess,
} from '../../../src/sources/claude-code/slug.ts';
import { makeDir, makeFile, tempDir } from '../../helpers/temp.ts';

describe('pathToSlug', () => {
  it('flattens the three characters Claude Code flattens', () => {
    strictEqual(pathToSlug('/Users/y/Work/Timfog-FS'), '-Users-y-Work-Timfog-FS');
    strictEqual(pathToSlug('/Users/y/my.app'), '-Users-y-my-app');
    strictEqual(pathToSlug('/Users/y/my_app'), '-Users-y-my-app');
  });

  it('is lossy, which is why a recorded cwd always wins', () => {
    // Three different directories, one slug. Nothing downstream can undo this,
    // so `resolveSlugPath` is a fallback and never the first answer.
    strictEqual(pathToSlug('/a/b'), pathToSlug('/a.b'));
    strictEqual(pathToSlug('/a/b'), pathToSlug('/a_b'));
  });
});

describe('projectNameFromPath', () => {
  it('names a project by its directory', () => {
    strictEqual(projectNameFromPath('/Users/y/Work/Timfog-FS'), 'Timfog-FS');
  });

  it('falls back to the path when there is no basename', () => {
    strictEqual(projectNameFromPath('/'), '/');
  });
});

describe('slugToPathGuess', () => {
  it('reads every dash as a slash', () => {
    strictEqual(slugToPathGuess('-Users-y-Work'), '/Users/y/Work');
  });

  it('hands back the input when there is nothing to read', () => {
    strictEqual(slugToPathGuess(''), '');
  });
});

describe('resolveSlugPath', () => {
  it('lets the filesystem settle what the slug cannot say', async (t) => {
    // `-a-b` could be `a/b`, `a.b`, `a_b`, or a directory called `a-b`. Only the
    // real tree knows which, so the walk asks it rather than guessing.
    const dir = await tempDir(t);
    const real = await makeDir(dir, 'project.name');

    strictEqual(await resolveSlugPath(pathToSlug(real)), real);
  });

  it('prefers the longest directory name that fits', async (t) => {
    // With both `Tivi` and `Tivi-FE` present, `...-Tivi-FE` is the second one --
    // a shortest-match walk would descend into `Tivi` and look for `FE` inside it.
    const dir = await tempDir(t);
    await makeDir(dir, 'Tivi');
    const real = await makeDir(dir, 'Tivi-FE');

    strictEqual(await resolveSlugPath(pathToSlug(real)), real);
  });

  it('backtracks out of a branch that leads nowhere', async (t) => {
    // `Tivi-FE` matches first and has no `src` under it, so the walk has to come
    // back up and try `Tivi/FE/src` instead.
    const dir = await tempDir(t);
    await makeDir(dir, 'Tivi-FE');
    const real = await makeDir(dir, 'Tivi/FE/src');

    strictEqual(await resolveSlugPath(pathToSlug(real)), real);
  });

  it('backs out when the walk steps onto a file', async (t) => {
    // `-tmp-a-b` looks like it starts with a directory `a`, but `a` is a file, so
    // that branch of the walk is dead rather than an error.
    const dir = await tempDir(t);
    await makeFile(dir, 'a', 'not a directory');
    const slug = pathToSlug(`${dir}/a/b`);

    // Nothing on disk can satisfy it, so what comes back is the naive reading.
    strictEqual(await resolveSlugPath(slug), slugToPathGuess(slug));
  });

  it('falls back to the naive reading when nothing on disk matches', async () => {
    // The project was moved or deleted. A legible wrong answer beats no answer.
    strictEqual(
      await resolveSlugPath('-nope-not-here-at-all-3f9c'),
      '/nope/not/here/at/all/3f9c',
    );
  });

  it('does not walk for a slug that was never a path we encoded', async () => {
    strictEqual(await resolveSlugPath('relative-looking'), 'relative/looking');
  });
});
