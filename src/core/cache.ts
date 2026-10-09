/**
 * Remembers work derived from a file, and forgets it the moment the file changes.
 *
 * Transcripts are append-only and large — 1 GB across 790 files on the machine this
 * was written against — so reading and parsing one has to happen once per *version*
 * of the file, not once per poll. Size and mtime together identify that version
 * closely enough: appending to a transcript moves both.
 *
 * Entries are keyed by path rather than by `path + stamp`, so a file that keeps
 * growing replaces its own entry instead of leaving a trail of dead ones behind.
 */
export interface FileStamp {
  mtimeMs: number;
  size: number;
}

/** Roughly a machine's worth of transcripts; past that, the least recently used goes. */
const DEFAULT_MAX_ENTRIES = 2_000;

export class FileCache<T> {
  readonly #entries = new Map<string, { stamp: string; value: T }>();
  #maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.#maxEntries = Math.max(1, maxEntries);
  }

  get(path: string, stamp: FileStamp): T | undefined {
    const entry = this.#entries.get(path);
    if (!entry || entry.stamp !== stampKey(stamp)) return undefined;

    // Re-inserting moves the key to the end of the Map, which is what makes the
    // eviction below drop the least recently *used* rather than the oldest written.
    this.#entries.delete(path);
    this.#entries.set(path, entry);
    return entry.value;
  }

  set(path: string, stamp: FileStamp, value: T): void {
    this.#entries.delete(path);
    this.#entries.set(path, { stamp: stampKey(stamp), value });

    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  /**
   * Make room for `entries` before a sweep that will visit that many files.
   *
   * A sweep walks its files in the same order every time, and least-recently-used is
   * the worst policy for that once the files outnumber the slots: each one is evicted
   * just before the sweep comes back for it, so nothing ever hits. Growing to the
   * sweep keeps it warm. It never shrinks, and files that leave every window are
   * still the least recently used, so they are the ones that go.
   */
  reserve(entries: number): void {
    this.#maxEntries = Math.max(this.#maxEntries, entries);
  }

  get size(): number {
    return this.#entries.size;
  }
}

function stampKey({ mtimeMs, size }: FileStamp): string {
  return `${mtimeMs}:${size}`;
}
