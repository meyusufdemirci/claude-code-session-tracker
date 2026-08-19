import { createReadStream } from 'node:fs';

/** `\n`. Transcripts are newline-delimited JSON; `\r` is left for the parser to ignore. */
const NEWLINE = 0x0a;

/** How much of the file to pull at once. Large enough to amortise syscalls, small enough to forget. */
const CHUNK_BYTES = 256 * 1024;

export interface TranscriptLine {
  /** The line, or only its opening when the line was larger than the cap. */
  text: string;
  /** What the line actually occupied on disk, whether or not we kept all of it. */
  bytes: number;
  /** True when `text` is a prefix — the record is real, we just refused to hold it. */
  truncated: boolean;
}

/**
 * Read a transcript one record at a time, never holding more than `maxBytes` of any
 * single one.
 *
 * `readline` would be the obvious tool, but it has no ceiling: it hands you whatever
 * the writer put on one line, and Claude Code puts tool results there. The largest
 * single record on the machine this was written against is **9.4 MB**, and parsing it
 * pushed peak RSS to 183 MB for a file whose interesting content is a few hundred KB.
 * Capping the line is what keeps memory a function of this reader rather than of
 * whatever the largest tool output in the session happened to be.
 *
 * A truncated line is reported, never silently dropped, so callers can decide what an
 * unread record means to them.
 */
export async function* readLines(
  path: string,
  maxBytes: number,
): AsyncGenerator<TranscriptLine> {
  const stream = createReadStream(path, { highWaterMark: CHUNK_BYTES });

  let held: Buffer[] = [];
  /** Bytes kept in `held`; never above `maxBytes`. */
  let heldBytes = 0;
  /** Bytes seen for the current line, including the ones we chose not to keep. */
  let lineBytes = 0;

  const take = (segment: Buffer): void => {
    lineBytes += segment.length;
    const room = maxBytes - heldBytes;
    if (room <= 0) return;
    const keep = segment.length <= room ? segment : segment.subarray(0, room);
    held.push(keep);
    heldBytes += keep.length;
  };

  const flush = (): TranscriptLine => {
    // Decoding only at the line break means a multi-byte character split across two
    // chunks is rejoined before anyone sees it. The single exception is the cut of a
    // truncated line, and that tail is discarded rather than parsed.
    const line: TranscriptLine = {
      text: held.length === 1 ? (held[0] as Buffer).toString('utf8') : Buffer.concat(held).toString('utf8'),
      bytes: lineBytes,
      truncated: lineBytes > heldBytes,
    };
    held = [];
    heldBytes = 0;
    lineBytes = 0;
    return line;
  };

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(NEWLINE, start);
      if (newline === -1) {
        take(chunk.subarray(start));
        break;
      }
      take(chunk.subarray(start, newline));
      yield flush();
      start = newline + 1;
    }
  }

  // A final record with no trailing newline — a session still being written to.
  if (lineBytes > 0) yield flush();
}
