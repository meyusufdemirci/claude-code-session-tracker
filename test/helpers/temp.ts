import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';

/**
 * A directory that lives for exactly one test.
 *
 * Fixtures here are real files rather than mocks, because the things worth testing
 * in this project are properties of real files: a multi-byte character cut by a
 * chunk boundary, a slug only the directory tree can disambiguate, a cache that
 * turns on mtime. A mocked `fs` would assert our assumptions back at us.
 *
 * `t.after` runs even when the test fails, so a failed assertion never leaves a
 * tree behind.
 */
export async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cst-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Creates `dir/path` as a directory, parents included. Returns the absolute path. */
export async function makeDir(dir: string, path: string): Promise<string> {
  const target = join(dir, path);
  await mkdir(target, { recursive: true });
  return target;
}

/** Writes a file, creating its parents. Returns the absolute path. */
export async function makeFile(dir: string, path: string, contents = ''): Promise<string> {
  const target = join(dir, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
  return target;
}
