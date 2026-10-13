import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { forgetLibraryPath, linkDir, prepareRelaunch, PROCESS_NAME } from '../src/process-name.ts';
import { makeFile, tempDir } from './helpers/temp.ts';

describe('linkDir', () => {
  it('uses the user cache folder on macOS and Linux', () => {
    strictEqual(linkDir('darwin', '/Users/a', {}), '/Users/a/Library/Caches/claude-code-session-tracker');
    strictEqual(linkDir('linux', '/home/a', {}), '/home/a/.cache/claude-code-session-tracker');
    strictEqual(linkDir('linux', '/home/a', { XDG_CACHE_HOME: '/xdg' }), '/xdg/claude-code-session-tracker');
  });

  it('leaves Windows alone', () => {
    strictEqual(linkDir('win32', 'C:\\Users\\a', {}), undefined);
  });
});

describe('prepareRelaunch', () => {
  it('links node under the project name and keeps the environment', async (t) => {
    const dir = await tempDir(t);
    const node = await makeFile(dir, 'nodejs/bin/node', 'binary');
    const relaunch = prepareRelaunch(node, join(dir, 'cache'), 'darwin', { HOME: '/Users/a' });

    strictEqual(relaunch?.file, join(dir, 'cache', PROCESS_NAME));
    deepStrictEqual(relaunch.env, { HOME: '/Users/a' });
    strictEqual(statSync(relaunch.file).ino, statSync(node).ino);
  });

  it('follows node to a new file after an upgrade', async (t) => {
    const dir = await tempDir(t);
    const cache = join(dir, 'cache');
    prepareRelaunch(await makeFile(dir, 'v1/bin/node', 'old'), cache, 'linux', {});
    const upgraded = await makeFile(dir, 'v2/bin/node', 'new');
    const relaunch = prepareRelaunch(upgraded, cache, 'linux', {});

    strictEqual(statSync(relaunch!.file).ino, statSync(upgraded).ino);
    ok(!existsSync(`${relaunch!.file}.${process.pid}`));
  });

  it('points dyld at a shared libnode on macOS, after any fallback path already set', async (t) => {
    const dir = await tempDir(t);
    const node = await makeFile(dir, 'Cellar/node/26/bin/node', 'binary');
    await makeFile(dir, 'Cellar/node/26/lib/libnode.147.dylib', 'lib');
    // Resolved like node's own path, since the temp folder can sit behind a symlink.
    const lib = join(realpathSync(dir), 'Cellar/node/26/lib');

    strictEqual(prepareRelaunch(node, join(dir, 'a'), 'darwin', {})?.env['DYLD_FALLBACK_LIBRARY_PATH'], lib);
    strictEqual(prepareRelaunch(node, join(dir, 'b'), 'darwin', { DYLD_FALLBACK_LIBRARY_PATH: '/mine' })?.env['DYLD_FALLBACK_LIBRARY_PATH'], `/mine:${lib}`);
  });

  it('stays as node for a shared libnode elsewhere', async (t) => {
    const dir = await tempDir(t);
    const node = await makeFile(dir, 'node/bin/node', 'binary');
    await makeFile(dir, 'node/lib/libnode.so.127', 'lib');

    strictEqual(prepareRelaunch(node, join(dir, 'cache'), 'linux', {}), undefined);
  });

  it('stays as node when the link cannot be made', async (t) => {
    const dir = await tempDir(t);
    const blocker = await makeFile(dir, 'cache', 'a file where the folder should be');

    strictEqual(prepareRelaunch(await makeFile(dir, 'bin/node', 'binary'), blocker, 'darwin', {}), undefined);
  });
});

describe('forgetLibraryPath', () => {
  it('takes back exactly what the relaunch added', async (t) => {
    const dir = await tempDir(t);
    const node = await makeFile(dir, 'node/bin/node', 'binary');
    await makeFile(dir, 'node/lib/libnode.147.dylib', 'lib');

    const fresh = { ...prepareRelaunch(node, join(dir, 'a'), 'darwin', { HOME: '/Users/a' })!.env };
    forgetLibraryPath(fresh);
    deepStrictEqual(fresh, { HOME: '/Users/a' });

    const kept = { ...prepareRelaunch(node, join(dir, 'b'), 'darwin', { DYLD_FALLBACK_LIBRARY_PATH: '/mine' })!.env };
    forgetLibraryPath(kept);
    deepStrictEqual(kept, { DYLD_FALLBACK_LIBRARY_PATH: '/mine' });
  });

  it('leaves a path it did not set', () => {
    const env = { DYLD_FALLBACK_LIBRARY_PATH: '/mine' };
    forgetLibraryPath(env);
    deepStrictEqual(env, { DYLD_FALLBACK_LIBRARY_PATH: '/mine' });
  });
});
