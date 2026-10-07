import { formatProjectPath } from './format.js';

/**
 * The history page's export: one report, written as a PDF or as a spreadsheet.
 *
 * Written here, in the page, with no library. The package ships no runtime
 * dependencies, and both formats are small enough to write by hand: a PDF of text
 * and rules in the two fonts every reader carries, and an `.xlsx` that is a zip of
 * a few XML files — which Excel, Numbers and Google Sheets all open as their own.
 *
 * The report is built once, as plain data, and each writer only lays it out. That
 * keeps the two formats saying the same numbers, because there is only one place
 * the numbers are added up.
 */

/** Input, output and newly-cached tokens — the measure the page ranks by. */
function billedTokens(tokens) {
  return tokens.input + tokens.output + tokens.cacheCreate;
}

function emptyTotals() {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, turns: 0 };
}

function addTo(totals, tokens, turns) {
  totals.input += tokens.input;
  totals.output += tokens.output;
  totals.cacheCreate += tokens.cacheCreate;
  totals.cacheRead += tokens.cacheRead;
  totals.turns += turns;
}

/* ------------------------------------------------------------------ periods */

/** How rows are grouped: a local day, a Monday-to-Sunday week, or a calendar month. */
export const GROUPS = ['day', 'week', 'month'];

/** Local midnight of the day, Monday or first of the month that `at` falls in. */
export function periodStart(at, group) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  // `getDay` is Sunday-first; a week of work starts on Monday.
  if (group === 'week') date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  if (group === 'month') date.setDate(1);
  return date.getTime();
}

/** Local midnight of the last day in the period that starts at `start`. */
export function periodLastDay(start, group) {
  const date = new Date(start);
  if (group === 'week') date.setDate(date.getDate() + 6);
  if (group === 'month') date.setMonth(date.getMonth() + 1, 0);
  return date.getTime();
}

/**
 * Consecutive days folded into the periods they fall in.
 *
 * `days` must be in order; each period keeps its first and last day *in the input*,
 * so a week cut by the start of the range says it ran from that start, not from a
 * Monday that was never read. `add` merges one day's figures into the period's.
 */
export function groupDays(days, group, add) {
  const periods = [];
  for (const day of days) {
    const key = periodStart(day.at, group);
    let period = periods.at(-1);
    if (!period || period.key !== key) {
      period = { key, at: day.at, end: day.at };
      periods.push(period);
    }
    add(period, day);
    period.end = day.at;
  }
  return periods;
}

/* ------------------------------------------------------------------ the report */

/**
 * Everything the report says, folded into local days.
 *
 * `history` is a read made with `perProject=1`, so each project carries its own
 * half hours; `labels` are the page's own row names, so a project reads the same
 * in the file as it did on screen. Only days that billed something get a row —
 * a month of zero rows per project would bury the days that matter.
 */
export function buildReport(history, labels, group = 'day') {
  const scoped = history.project
    ? history.projects.filter((project) => project.slug === history.project)
    : history.projects;

  const total = emptyTotals();
  const activeDays = new Set();
  const firstDay = new Date(history.range.since).setHours(0, 0, 0, 0);
  const lastDay = new Date(history.range.until - 1).setHours(0, 0, 0, 0);

  const projects = scoped.map((project) => {
    const days = new Map();
    for (const bucket of project.buckets ?? []) {
      const day = new Date(bucket.at).setHours(0, 0, 0, 0);
      const row = days.get(day) ?? { at: day, ...emptyTotals() };
      addTo(row, bucket.tokens, bucket.turns);
      days.set(day, row);
    }

    const daily = [...days.values()].sort((a, b) => a.at - b.at);
    const totals = emptyTotals();
    for (const row of daily) {
      addTo(totals, row, row.turns);
      activeDays.add(row.at);
    }
    addTo(total, totals, totals.turns);

    // A row says which days it covers: the whole week or month, cut to the range at
    // either end — not just the days in it that happened to bill.
    const rows =
      group === 'day'
        ? daily
        : groupDays(daily, group, (period, day) => {
            if (period.turns === undefined) Object.assign(period, emptyTotals());
            addTo(period, day, day.turns);
          }).map((period) => ({
            ...period,
            at: Math.max(period.key, firstDay),
            end: Math.min(periodLastDay(period.key, group), lastDay),
          }));

    return { name: labels.get(project.slug) ?? project.name, path: formatProjectPath(project), totals, days: rows };
  });

  return {
    range: { first: history.range.since, last: history.range.until - 1, days: dayCount(history.range) },
    scope: history.project ? projects[0]?.name ?? 'One project' : 'All projects',
    group,
    generatedAt: history.generatedAt,
    totals: { ...total, billed: billedTokens(total), projects: projects.length, activeDays: activeDays.size },
    projects,
  };
}

function dayCount(range) {
  return Math.round((range.until - range.since) / 86_400_000);
}

/** `2026-09-14`, in local time — sorts as text and reads the same everywhere. */
export function isoDay(at) {
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const GROUP_WORDS = {
  day: { rows: 'Daily', column: 'Date', unit: 'day' },
  week: { rows: 'Weekly', column: 'Week', unit: 'week' },
  month: { rows: 'Monthly', column: 'Month', unit: 'month' },
};

/** `Daily`, `Weekly`, `Monthly` — and the column and unit words that go with each. */
export function groupWords(group) {
  return GROUP_WORDS[group] ?? GROUP_WORDS.day;
}

/** A row's period, written out: the day, the week's days, or the month. */
function periodLabel(row, group) {
  if (group === 'week') return row.at === row.end ? isoDay(row.at) : `${isoDay(row.at)} to ${isoDay(row.end)}`;
  if (group === 'month') return new Date(row.at).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return `${isoDay(row.at)}  ${weekday(row.at)}`;
}

/** A file name that says what is in it, safe on every filesystem. */
export function fileName(report, extension) {
  const scope = report.scope === 'All projects' ? 'all-projects' : report.scope;
  const safe = scope.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const grouped = report.group === 'day' ? '' : `_${groupWords(report.group).rows.toLowerCase()}`;
  return `claude-code-usage_${safe}${grouped}_${isoDay(report.range.first)}_${isoDay(report.range.last)}.${extension}`;
}

/** Hand the browser a file to save, under a name of our choosing. */
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next turn rather than now: some browsers start the save late.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/* ------------------------------------------------------------------------- xlsx */

/** The columns every token table uses, in one order for both sheets. */
const TOKEN_COLUMNS = [
  ['Turns', (row) => row.turns],
  ['Input', (row) => row.input],
  ['Output', (row) => row.output],
  ['Cache writes', (row) => row.cacheCreate],
  ['Cache reads', (row) => row.cacheRead],
  ['Billed', (row) => billedTokens(row)],
];

/** Style indexes into `STYLES` below. */
const S = { text: 0, bold: 1, count: 2, date: 3, boldCount: 4, title: 5, head: 6, share: 7, month: 8 };

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="mmmm yyyy"/></numFmts>
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF5F3EC"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * Two sheets: a summary that opens with the totals, and the daily rows.
 *
 * The daily sheet is one flat table — date, project, then the counts — rather than
 * a block per project, because a flat table is the one a spreadsheet can filter,
 * sort and pivot. Dates are real dates, not text, for the same reason.
 */
export function toXlsx(report) {
  const strings = new SharedStrings();
  const { totals } = report;
  const grand = report.totals.billed;

  const summary = [
    [[`Claude Code token usage`, S.title]],
    [],
    [['Range', S.bold], `${isoDay(report.range.first)} to ${isoDay(report.range.last)} (${report.range.days} days)`],
    [['Scope', S.bold], report.scope],
    [['Rows', S.bold], groupWords(report.group).rows],
    [['Generated', S.bold], new Date(report.generatedAt).toLocaleString()],
    [],
    [['Totals', S.head], ['', S.head]],
    [['Billed tokens', S.bold], [totals.billed, S.boldCount]],
    ['Input', [totals.input, S.count]],
    ['Output', [totals.output, S.count]],
    ['Cache writes', [totals.cacheCreate, S.count]],
    ['Cache reads', [totals.cacheRead, S.count]],
    ['Turns', [totals.turns, S.count]],
    ['Projects', [totals.projects, S.count]],
    ['Active days', [totals.activeDays, S.count]],
    [],
    [...['Project', 'Path', ...TOKEN_COLUMNS.map(([name]) => name), 'Share'].map((name) => [name, S.head])],
    ...report.projects.map((project) => [
      project.name,
      project.path,
      ...TOKEN_COLUMNS.map(([, read]) => [read(project.totals), S.count]),
      [grand ? billedTokens(project.totals) / grand : 0, S.share],
    ]),
  ];

  const words = groupWords(report.group);
  // A week is a real date — its first day — so it still sorts and filters as one;
  // the last day goes in a column of its own rather than into a string.
  const weekly = report.group === 'week';
  const daily = [
    [
      ...[words.column, ...(weekly ? ['Until'] : []), 'Project', 'Path', ...TOKEN_COLUMNS.map(([name]) => name)].map(
        (name) => [name, S.head],
      ),
    ],
    ...report.projects.flatMap((project) =>
      project.days.map((day) => [
        [excelDate(day.at), report.group === 'month' ? S.month : S.date],
        ...(weekly ? [[excelDate(day.end), S.date]] : []),
        project.name,
        project.path,
        ...TOKEN_COLUMNS.map(([, read]) => [read(day), S.count]),
      ]),
    ),
  ];

  const summaryXml = sheetXml(summary, strings, { widths: [28, 64, 10, 14, 14, 14, 14, 16, 9] });
  const widths = [report.group === 'month' ? 16 : 12, ...(weekly ? [12] : []), 28, 64, 10, 14, 14, 14, 14, 16];
  const dailyXml = sheetXml(daily, strings, {
    widths,
    // The header stays put while the rows scroll, and carries the filter arrows.
    freezeTopRow: true,
    filter: daily.length > 1 ? `A1:${columnName(widths.length - 1)}${daily.length}` : undefined,
  });

  const files = [
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', ROOT_RELS],
    ['xl/workbook.xml', workbook(words.rows)],
    ['xl/_rels/workbook.xml.rels', WORKBOOK_RELS],
    ['xl/styles.xml', STYLES],
    ['xl/sharedStrings.xml', strings.xml()],
    ['xl/worksheets/sheet1.xml', summaryXml],
    ['xl/worksheets/sheet2.xml', dailyXml],
  ];

  return new Blob([zip(files)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** Days since 1899-12-30, the epoch every spreadsheet counts from. */
function excelDate(at) {
  const date = new Date(at);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000 + 25_569;
}

class SharedStrings {
  #index = new Map();
  #count = 0;

  id(text) {
    this.#count += 1;
    let id = this.#index.get(text);
    if (id === undefined) {
      id = this.#index.size;
      this.#index.set(text, id);
    }
    return id;
  }

  xml() {
    const items = [...this.#index.keys()].map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`);
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${this.#count}" uniqueCount="${items.length}">${items.join('')}</sst>`;
  }
}

/** A cell is a bare value or `[value, style]`; numbers stay numbers, everything else is text. */
function sheetXml(rows, strings, { widths, freezeTopRow = false, filter }) {
  const body = rows
    .map((cells, r) => {
      const xml = cells
        .map((cell, c) => {
          const [value, style] = Array.isArray(cell) ? cell : [cell, S.text];
          const ref = `${columnName(c)}${r + 1}`;
          const s = style ? ` s="${style}"` : '';
          if (typeof value === 'number') return `<c r="${ref}"${s}><v>${value}</v></c>`;
          if (value === '' && !style) return '';
          return `<c r="${ref}"${s} t="s"><v>${strings.id(String(value))}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${xml}</row>`;
    })
    .join('');

  const view = freezeTopRow
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const cols = `<cols>${widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${view}${cols}<sheetData>${body}</sheetData>${filter ? `<autoFilter ref="${filter}"/>` : ''}</worksheet>`;
}

function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are not allowed in XML at all, escaped or not.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

/** The second sheet is named for its rows: Daily, Weekly or Monthly. */
function workbook(rows) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Summary" sheetId="1" r:id="rId1"/>
<sheet name="${rows}" sheetId="2" r:id="rId2"/>
</sheets>
</workbook>`;
}

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

/* -------------------------------------------------------------------------- zip */

/**
 * A zip with every entry stored, not deflated.
 *
 * An `.xlsx` only has to be a valid zip, not a small one, and a report of a few
 * hundred rows is tens of kilobytes either way — so the one part of the format that
 * would need a compressor is the part left out.
 */
function zip(files) {
  const encoder = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;

  for (const [name, text] of files) {
    const path = encoder.encode(name);
    const data = encoder.encode(text);
    const crc = crc32(data);

    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true); // names are UTF-8
    head.setUint16(8, 0, true); // stored
    head.setUint16(10, 0, true);
    head.setUint16(12, 0x21, true); // 1980-01-01
    head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, data.length, true);
    head.setUint16(26, path.length, true);
    local.push(new Uint8Array(head.buffer), path, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, 0, true);
    entry.setUint16(14, 0x21, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, path.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), path);

    offset += 30 + path.length + data.length;
  }

  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);

  return concat([...local, ...central, new Uint8Array(end.buffer)]);
}

let crcTable;

function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/* -------------------------------------------------------------------------- pdf */

/**
 * Advance widths of Helvetica and Helvetica-Bold, for codes 32–126, per 1000 em.
 *
 * The standard fonts are not embedded, so nothing tells the page how wide a string
 * is unless this does — and right-aligned numbers and a truncated path both need to.
 */
const WIDTHS = {
  F1: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778,
    722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
    278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
  F2: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778,
    722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
    278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
};

/** The few characters past Latin-1 that WinAnsi still has a code for. */
const WIN_ANSI = { '–': 0x96, '—': 0x97, '•': 0x95, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94 };

/**
 * Text as the standard fonts can draw it.
 *
 * They only know WinAnsi, so anything outside it is folded to its base letter —
 * a project called `Çalışma` prints as `Calisma` rather than as a row of boxes —
 * and what cannot be folded becomes a question mark.
 */
function toWinAnsi(text) {
  let out = '';
  for (const char of String(text).replace(/ı/g, 'i').replace(/İ/g, 'I')) {
    const code = char.codePointAt(0);
    if (code < 0x7f && code >= 0x20) out += char;
    else if (WIN_ANSI[char]) out += String.fromCharCode(WIN_ANSI[char]);
    // Kept as-is from 0x80 up, so text that already went through here passes again
    // unchanged — the ellipsis `fit` adds is one of these.
    else if (code >= 0x80 && code <= 0xff) out += char;
    else {
      const base = char.normalize('NFD').replace(/[̀-ͯ]/g, '');
      out += base.length === 1 && base.codePointAt(0) < 0x7f ? base : '?';
    }
  }
  return out;
}

function textWidth(text, font, size) {
  let units = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    units += code >= 32 && code <= 126 ? WIDTHS[font][code - 32] : 556;
  }
  return (units * size) / 1000;
}

/** Cut from the left for a path — the end of a path is the part that names it. */
function fit(text, font, size, width, fromLeft = false) {
  if (textWidth(text, font, size) <= width) return text;
  const ellipsis = '\x85';
  let cut = text;
  while (cut.length > 1 && textWidth(ellipsis + cut, font, size) > width) {
    cut = fromLeft ? cut.slice(1) : cut.slice(0, -1);
  }
  return fromLeft ? ellipsis + cut : cut + ellipsis;
}

function pdfString(text) {
  let out = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char === '\\' || char === '(' || char === ')') out += `\\${char}`;
    else if (code < 0x20 || code > 0x7e) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += char;
  }
  return `(${out})`;
}

/** Comma-grouped, in every locale: the standard fonts cannot draw a narrow space. */
const pdfCount = (value) => Math.round(value).toLocaleString('en-US');

const PAGE = { width: 595.28, height: 841.89, margin: 42 };
const COLORS = {
  ink: '0.078 0.078 0.075',
  soft: '0.36 0.353 0.322',
  faint: '0.54 0.53 0.47',
  rule: '0.91 0.902 0.863',
  zebra: '0.961 0.953 0.925',
  accent: '0.851 0.467 0.341',
};

/**
 * A page-at-a-time drawing surface.
 *
 * Pages are kept as lists of operators until the end, because the footer says
 * "page 2 of 5" and the 5 is only known once the last row has landed.
 */
class PdfCanvas {
  pages = [];
  y = 0;

  constructor() {
    this.newPage();
  }

  newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = PAGE.height - PAGE.margin;
  }

  /** Room for `height` more points, or a fresh page. Returns whether it broke. */
  ensure(height) {
    if (this.y - height >= PAGE.margin + 18) return false;
    this.newPage();
    return true;
  }

  text(x, y, text, { font = 'F1', size = 9, color = COLORS.ink, align = 'left', width = 0 } = {}) {
    const drawn = toWinAnsi(text);
    const dx = align === 'right' ? width - textWidth(drawn, font, size) : 0;
    this.ops.push(`BT /${font} ${size} Tf ${color} rg ${(x + dx).toFixed(2)} ${y.toFixed(2)} Td ${pdfString(drawn)} Tj ET`);
  }

  rect(x, y, width, height, color) {
    this.ops.push(`${color} rg ${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`);
  }

  line(x1, y1, x2, y2, color = COLORS.rule, weight = 0.6) {
    this.ops.push(`${color} RG ${weight} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }
}

/**
 * The report as a printable A4: totals first, then a table per project.
 *
 * Each project gets its own heading and its own daily table with a subtotal, and a
 * table that runs onto the next page repeats its header there, so a page torn off
 * the stack still says which project and which column it is reading.
 */
export function toPdf(report) {
  const canvas = new PdfCanvas();
  const left = PAGE.margin;
  const width = PAGE.width - PAGE.margin * 2;
  const { totals } = report;

  // Title and what the report covers.
  canvas.text(left, canvas.y - 16, 'Claude Code token usage', { font: 'F2', size: 18 });
  canvas.y -= 24;
  canvas.line(left, canvas.y, left + width, canvas.y, COLORS.accent, 1.5);
  canvas.y -= 16;
  const meta = [
    ['Range', `${isoDay(report.range.first)} to ${isoDay(report.range.last)} (${report.range.days} days)`],
    ['Scope', report.scope],
    ['Rows', groupWords(report.group).rows],
    ['Generated', new Date(report.generatedAt).toLocaleString('en-GB')],
  ];
  for (const [label, value] of meta) {
    canvas.text(left, canvas.y, label.toUpperCase(), { font: 'F2', size: 7, color: COLORS.faint });
    canvas.text(left + 64, canvas.y, fit(toWinAnsi(value), 'F1', 9, width - 64), { size: 9, color: COLORS.soft });
    canvas.y -= 13;
  }

  // The totals, as a block of figures at the top.
  canvas.y -= 10;
  const stats = [
    ['Billed tokens', pdfCount(totals.billed)],
    ['Input', pdfCount(totals.input)],
    ['Output', pdfCount(totals.output)],
    ['Cache writes', pdfCount(totals.cacheCreate)],
    ['Cache reads', pdfCount(totals.cacheRead)],
    ['Turns', pdfCount(totals.turns)],
    ['Projects', pdfCount(totals.projects)],
    ['Active days', pdfCount(totals.activeDays)],
  ];
  const cell = width / 4;
  const boxHeight = 2 * 34 + 12;
  canvas.rect(left, canvas.y - boxHeight, width, boxHeight, COLORS.zebra);
  stats.forEach(([label, value], index) => {
    const x = left + 12 + (index % 4) * cell;
    const y = canvas.y - 18 - Math.floor(index / 4) * 34;
    canvas.text(x, y, label.toUpperCase(), { font: 'F2', size: 7, color: COLORS.faint });
    canvas.text(x, y - 14, value, { font: 'F2', size: index === 0 ? 13 : 11 });
  });
  canvas.y -= boxHeight + 22;

  const numberColumns = [
    ['Turns', 42],
    ['Input', 56],
    ['Output', 64],
    ['Cache writes', 68],
    ['Cache reads', 76],
    ['Billed', 68],
  ];
  const numbersWidth = numberColumns.reduce((sum, [, w]) => sum + w, 0);

  // A ranking of the projects first, when there is more than one to compare.
  if (report.projects.length > 1) {
    section(canvas, left, width, 'Projects');
    const columns = [['Project', width - numbersWidth - 36], ...numberColumns, ['Share', 36]];
    table(canvas, left, columns, report.projects.map((project) => [
      project.name,
      ...numberRow(project.totals),
      shareOf(project.totals, totals.billed),
    ]));
    canvas.y -= 18;
  }

  // Then every project's days, weeks or months.
  const dayColumns = [[groupWords(report.group).column, width - numbersWidth], ...numberColumns];
  for (const project of report.projects) {
    canvas.ensure(70);
    canvas.text(left, canvas.y, fit(toWinAnsi(project.name), 'F2', 12, width), { font: 'F2', size: 12 });
    canvas.y -= 12;
    canvas.text(left, canvas.y, fit(toWinAnsi(project.path), 'F1', 8, width, true), { size: 8, color: COLORS.faint });
    canvas.y -= 12;

    const rows = project.days.map((day) => [periodLabel(day, report.group), ...numberRow(day)]);
    table(canvas, left, dayColumns, rows, ['Total', ...numberRow(project.totals)], project.name);
    canvas.y -= 20;
  }

  // Footers, now that the page count is known.
  canvas.pages.forEach((ops, index) => {
    const y = PAGE.margin - 18;
    ops.push(`${COLORS.rule} RG 0.6 w ${left} ${y + 10} m ${left + width} ${y + 10} l S`);
    const footer = (x, text, align) => {
      const drawn = toWinAnsi(text);
      const dx = align === 'right' ? -textWidth(drawn, 'F1', 7) : 0;
      ops.push(`BT /F1 7 Tf ${COLORS.faint} rg ${(x + dx).toFixed(2)} ${y} Td ${pdfString(drawn)} Tj ET`);
    };
    footer(left, `Claude Code token usage · ${report.scope} · ${isoDay(report.range.first)} to ${isoDay(report.range.last)}`);
    footer(left + width, `Page ${index + 1} of ${canvas.pages.length}`, 'right');
  });

  const title = `Claude Code token usage · ${report.scope} · ${isoDay(report.range.first)} to ${isoDay(report.range.last)}`;
  return new Blob([pdfDocument(canvas.pages, title)], { type: 'application/pdf' });
}

function numberRow(row) {
  return [row.turns, row.input, row.output, row.cacheCreate, row.cacheRead, billedTokens(row)].map(pdfCount);
}

function shareOf(row, total) {
  const percent = total ? (billedTokens(row) / total) * 100 : 0;
  return percent >= 1 || percent === 0 ? `${Math.floor(percent)}%` : `${percent.toFixed(1)}%`;
}

function weekday(at) {
  return new Date(at).toLocaleDateString('en-GB', { weekday: 'short' });
}

function section(canvas, left, width, title) {
  canvas.ensure(50);
  canvas.text(left, canvas.y, title, { font: 'F2', size: 12 });
  canvas.y -= 14;
}

/**
 * A table whose first column is text and the rest right-aligned figures.
 *
 * `continued` names the table on a page it spills onto, so the header there reads
 * as the same table rather than a new one.
 */
function table(canvas, left, columns, rows, footer, continued) {
  const width = columns.reduce((sum, [, w]) => sum + w, 0);
  const rowHeight = 15;

  const header = () => {
    canvas.y -= 4;
    columns.forEach(([name, w], index) => {
      const x = left + columns.slice(0, index).reduce((sum, [, cw]) => sum + cw, 0);
      canvas.text(index === 0 ? x + 4 : x, canvas.y - 8, name.toUpperCase(), {
        font: 'F2',
        size: 6.5,
        color: COLORS.faint,
        align: index === 0 ? 'left' : 'right',
        width: w - 4,
      });
    });
    canvas.y -= 13;
    canvas.line(left, canvas.y, left + width, canvas.y, COLORS.ink, 0.6);
  };

  const draw = (cells, { bold = false, shade = false } = {}) => {
    if (canvas.ensure(rowHeight + 4)) {
      if (continued) {
        canvas.text(left, canvas.y, `${toWinAnsi(continued)} (continued)`, { font: 'F2', size: 9, color: COLORS.soft });
        canvas.y -= 8;
      }
      header();
    }
    if (shade) canvas.rect(left, canvas.y - rowHeight, width, rowHeight, COLORS.zebra);
    let x = left;
    cells.forEach((value, index) => {
      const w = columns[index][1];
      const font = bold ? 'F2' : 'F1';
      const text = index === 0 ? fit(toWinAnsi(value), font, 8.5, w - 8) : value;
      canvas.text(index === 0 ? x + 4 : x, canvas.y - 10.5, text, {
        font,
        size: 8.5,
        align: index === 0 ? 'left' : 'right',
        width: w - 4,
      });
      x += w;
    });
    canvas.y -= rowHeight;
  };

  header();
  if (rows.length === 0) draw(['Nothing billed in this range', ...columns.slice(1).map(() => '')]);
  rows.forEach((cells, index) => draw(cells, { shade: index % 2 === 1 }));
  if (footer) {
    canvas.line(left, canvas.y, left + width, canvas.y, COLORS.ink, 0.6);
    draw(footer, { bold: true });
  }
}

/** The objects around the pages: catalog, page tree, the two fonts, and the xref. */
function pdfDocument(pages, title) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };

  const catalog = add('');
  const tree = add('');
  const regular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const kids = pages.map((ops) => {
    const stream = ops.join('\n');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return add(
      `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
        `/Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`,
    );
  });

  // The title is what a viewer's tab and window show, rather than the file's address.
  const info = add(`<< /Title ${pdfString(toWinAnsi(title))} /Producer (claude-code-session-tracker) >>`);
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R /ViewerPreferences << /DisplayDocTitle true >> >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  // Every character above is a single byte — the text went through `pdfString` —
  // so string length is byte length and the offsets below are exact.
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = objects.map((body, index) => {
    const at = out.length;
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });

  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i += 1) bytes[i] = out.charCodeAt(i);
  return bytes;
}
