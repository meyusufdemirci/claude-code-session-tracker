import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FileCache } from '../../src/core/cache.ts';

const PATH = '/Users/y/projects/a/session.jsonl';

describe('FileCache', () => {
  it('returns work already done for this version of the file', () => {
    const cache = new FileCache<string>();
    cache.set(PATH, { mtimeMs: 10, size: 100 }, 'parsed');

    strictEqual(cache.get(PATH, { mtimeMs: 10, size: 100 }), 'parsed');
  });

  it('forgets the moment the file is appended to', () => {
    // Both halves of the stamp matter: an append moves mtime and size together,
    // but a rewrite in the same millisecond only moves size.
    const cache = new FileCache<string>();
    cache.set(PATH, { mtimeMs: 10, size: 100 }, 'parsed');

    strictEqual(cache.get(PATH, { mtimeMs: 11, size: 100 }), undefined);
    strictEqual(cache.get(PATH, { mtimeMs: 10, size: 101 }), undefined);
  });

  it('misses on a path it has never seen', () => {
    const cache = new FileCache<string>();

    strictEqual(cache.get(PATH, { mtimeMs: 10, size: 100 }), undefined);
  });

  it('replaces a growing file rather than trailing dead entries behind it', () => {
    // A live session restamps itself every poll. Keying by path is what stops that
    // from filling the cache with one entry per version of the same transcript.
    const cache = new FileCache<string>();
    cache.set(PATH, { mtimeMs: 10, size: 100 }, 'first');
    cache.set(PATH, { mtimeMs: 11, size: 200 }, 'second');

    strictEqual(cache.size, 1);
    strictEqual(cache.get(PATH, { mtimeMs: 11, size: 200 }), 'second');
  });

  it('evicts the least recently used once it is full', () => {
    const cache = new FileCache<string>(2);
    cache.set('a', { mtimeMs: 1, size: 1 }, 'a');
    cache.set('b', { mtimeMs: 1, size: 1 }, 'b');

    // Reading 'a' makes 'b' the stale one, so adding 'c' should cost 'b'.
    cache.get('a', { mtimeMs: 1, size: 1 });
    cache.set('c', { mtimeMs: 1, size: 1 }, 'c');

    strictEqual(cache.size, 2);
    strictEqual(cache.get('a', { mtimeMs: 1, size: 1 }), 'a');
    strictEqual(cache.get('b', { mtimeMs: 1, size: 1 }), undefined);
    strictEqual(cache.get('c', { mtimeMs: 1, size: 1 }), 'c');
  });

  it('holds at least one entry however small it is asked to be', () => {
    const cache = new FileCache<string>(0);
    cache.set('a', { mtimeMs: 1, size: 1 }, 'a');

    strictEqual(cache.get('a', { mtimeMs: 1, size: 1 }), 'a');
  });
});
