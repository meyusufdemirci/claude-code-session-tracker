import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readLines, type TranscriptLine } from '../../../src/sources/claude-code/lines.ts';
import { tempDir } from '../../helpers/temp.ts';
import { writeTranscript } from '../../helpers/records.ts';

/** The reader pulls the file in 256 KB chunks, so this is where its seams are. */
const CHUNK_BYTES = 256 * 1024;

/** Big enough that nothing in a test truncates unless the test means it to. */
const NO_CAP = 1024 * 1024;

async function collect(path: string, maxBytes = NO_CAP): Promise<TranscriptLine[]> {
  const lines: TranscriptLine[] = [];
  for await (const line of readLines(path, maxBytes)) lines.push(line);
  return lines;
}

describe('readLines', () => {
  it('yields one entry per record, with the bytes each occupied', async (t) => {
    const dir = await tempDir(t);
    const path = await writeTranscript(dir, 'a.jsonl', ['{"n":1}', '{"n":2}']);

    const lines = await collect(path);

    deepStrictEqual(
      lines.map((line) => line.text),
      ['{"n":1}', '{"n":2}'],
    );
    deepStrictEqual(
      lines.map((line) => line.bytes),
      [7, 7],
    );
    ok(lines.every((line) => !line.truncated));
  });

  it('yields a final record that has no trailing newline', async (t) => {
    // A live session's transcript ends mid-write, and that last record is the one
    // carrying the status a row wants to show.
    const dir = await tempDir(t);
    const path = await writeTranscript(dir, 'live.jsonl', ['{"n":1}', '{"n":2}'], {
      trailingNewline: false,
    });

    const lines = await collect(path);

    deepStrictEqual(
      lines.map((line) => line.text),
      ['{"n":1}', '{"n":2}'],
    );
  });

  it('yields nothing for an empty file', async (t) => {
    const dir = await tempDir(t);
    const path = await writeTranscript(dir, 'empty.jsonl', [], { trailingNewline: false });

    deepStrictEqual(await collect(path), []);
  });

  it('yields blank lines as empty records rather than skipping them', async (t) => {
    // Callers do the skipping. The reader reporting a line it saw is the honest
    // contract — a reader that silently dropped input would hide format drift.
    const dir = await tempDir(t);
    const path = await writeTranscript(dir, 'blanks.jsonl', ['{"n":1}', '', '{"n":2}']);

    deepStrictEqual(
      (await collect(path)).map((line) => line.text),
      ['{"n":1}', '', '{"n":2}'],
    );
  });

  it('caps a huge record, reports the cut, and reads on', async (t) => {
    // The point of the whole module: one 9.4 MB tool result must not become 9.4 MB
    // of resident memory, and must not cost us the records after it either.
    const dir = await tempDir(t);
    const path = await writeTranscript(dir, 'huge.jsonl', ['a'.repeat(64), '{"n":2}']);

    const lines = await collect(path, 8);

    strictEqual(lines.length, 2);
    strictEqual(lines[0]?.text, 'aaaaaaaa');
    strictEqual(lines[0]?.bytes, 64, 'reports what the record really occupied');
    strictEqual(lines[0]?.truncated, true);
    strictEqual(lines[1]?.text, '{"n":2}', 'the record after a cut one is intact');
    strictEqual(lines[1]?.truncated, false);
  });

  it('rejoins a multi-byte character split across two chunk reads', async (t) => {
    // The reader slices at byte offsets, so a 4-byte character can land half in one
    // chunk and half in the next. Decoding only at the newline is what saves it.
    const dir = await tempDir(t);
    const path = join(dir, 'wide.jsonl');
    const emoji = '\u{1F600}'; // four bytes
    const head = 'a'.repeat(CHUNK_BYTES - 2); // leaves the emoji straddling the seam
    await writeFile(path, `${head}${emoji}tail\n`);

    const lines = await collect(path);

    strictEqual(lines.length, 1);
    ok(lines[0]?.text.includes(emoji), 'the character survived the seam');
    ok(!lines[0]?.text.includes('�'), 'and was never decoded in halves');
    strictEqual(lines[0]?.text.endsWith(`${emoji}tail`), true);
  });

  it('leaves carriage returns in place for the parser to ignore', async (t) => {
    const dir = await tempDir(t);
    const path = join(dir, 'crlf.jsonl');
    await writeFile(path, '{"n":1}\r\n{"n":2}\r\n');

    deepStrictEqual(
      (await collect(path)).map((line) => line.text),
      ['{"n":1}\r', '{"n":2}\r'],
    );
  });
});
