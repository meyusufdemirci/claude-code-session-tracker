import {
  formatClock,
  formatCompactCount,
  formatCount,
  formatDay,
  formatShare,
  formatStamp,
} from './format.js';
import {
  buildReport,
  download,
  fileName,
  GROUPS,
  groupDays,
  groupWords,
  isoDay,
  toPdf,
  toXlsx,
} from './export.js';

/**
 * The history page: where the tokens went over a stretch of history.
 *
 * One read, not a poll. The dashboard refreshes every two seconds because a session
 * can start or finish while you watch; a month of history cannot move that fast, and
 * re-reading it would cost a sweep of the transcripts to redraw the same bars.
 */

const byId = (id) => document.getElementById(id);
const setText = (id, value) => {
  const node = byId(id);
  if (node) node.textContent = value;
};

/** Input, output and newly-cached tokens — the measure the limit cards size a window by. */
function billedTokens(tokens) {
  return tokens ? tokens.input + tokens.output + tokens.cacheCreate : 0;
}

/** Weekday rows, Monday first — the week a working day sits in. */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Half hours in a day: the grain the server reads at, and the grid's columns. */
const COLUMNS = 48;

/**
 * The floor a nonzero cell is drawn at.
 *
 * Shade is linear above it. One heavy afternoon can outweigh a quiet week by two
 * orders of magnitude, and a purely linear ramp would render every quiet half hour
 * as empty — which is a different claim from "nothing happened here".
 */
const CELL_FLOOR = 0.14;

/**
 * The ranges the picker offers, in whole local days.
 *
 * Whole days, and `until` at tomorrow's midnight rather than at this instant, so
 * that "last 30 days" draws thirty columns rather than thirty-one part-days — the
 * range and the chart under it agree because they are the same days.
 */
const RANGES = {
  '7d': () => lastDays(7),
  '30d': () => lastDays(30),
  '90d': () => lastDays(90),
  custom: () => customRange(),
};

/** The last `count` local days, today included. */
function lastDays(count) {
  return { since: daysAgo(count - 1), until: nextDay(daysAgo(0)) };
}

/**
 * Where the controls sit when nobody has touched them.
 *
 * Said once, because both the fallback for a hand-edited query string and the
 * parameters `syncUrl` leaves out lean on it, and they would be a quiet bug apart.
 */
const DEFAULT_VIEW = { range: '30d', from: '', to: '', group: 'day' };

/** The first year there is anything to show: Claude Code shipped in February 2025. */
const FIRST_YEAR = 2025;

const thisYear = () => new Date().getFullYear();

const view = readView();

/** A hand-edited or stale parameter falls back rather than leaving a state the controls cannot show. */
function readView() {
  const params = new URLSearchParams(location.search);
  const range = params.get('range');

  return {
    range: range !== null && Object.hasOwn(RANGES, range) ? range : DEFAULT_VIEW.range,
    from: params.get('from') ?? DEFAULT_VIEW.from,
    to: params.get('to') ?? DEFAULT_VIEW.to,
    group: GROUPS.includes(params.get('group')) ? params.get('group') : DEFAULT_VIEW.group,
    project: params.get('project') ?? undefined,
    year: readYear(params.get('year')),
  };
}

/** A past year the grid can show; the current one is the default, and so is left out of the URL. */
function readYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= FIRST_YEAR && year < thisYear() ? year : undefined;
}

/** Only what differs from the default, so a plain `/history` stays a plain URL. */
function syncUrl(push) {
  const url = new URL(location.href);
  for (const [key, fallback] of Object.entries(DEFAULT_VIEW)) {
    if (view[key] === fallback) url.searchParams.delete(key);
    else url.searchParams.set(key, view[key]);
  }
  if (view.project === undefined) url.searchParams.delete('project');
  else url.searchParams.set('project', view.project);
  if (view.year === undefined) url.searchParams.delete('year');
  else url.searchParams.set('year', String(view.year));

  // Qualified: `history` is this file's word for a payload everywhere else.
  if (push) window.history.pushState({}, '', url);
  else window.history.replaceState({}, '', url);
}

/** Local midnight, `count` days back. */
function daysAgo(count) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - count);
  return date.getTime();
}

function nextDay(at) {
  const date = new Date(at);
  date.setDate(date.getDate() + 1);
  return date.getTime();
}

/**
 * A custom range, with either end allowed to be empty.
 *
 * Both ends are filled in here rather than left to the server, so that a custom
 * range is made of whole local days like every preset: an open end resolved to an
 * instant would leave the chart drawing a part-day column that the day count does
 * not include, and the two would disagree by one.
 *
 * An empty end means as far as this will read — today at one end, the ninety-day
 * ceiling at the other.
 */
function customRange() {
  let from = dayFromIso(view.from);
  let to = dayFromIso(view.to);
  // A backwards pair is a slip of the picker, not a request for nothing.
  if (from !== undefined && to !== undefined && from > to) [from, to] = [to, from];

  const until = to === undefined ? nextDay(daysAgo(0)) : nextDay(to);
  return { since: from ?? shiftDays(until, -MAX_SPAN_DAYS), until };
}

/** The widest range the reader will read; asking for more is narrowed, and said so. */
const MAX_SPAN_DAYS = 90;

/** Stepped by date rather than by milliseconds, so a clock change is still one day. */
function shiftDays(at, count) {
  const date = new Date(at);
  date.setDate(date.getDate() + count);
  return date.getTime();
}

function dayFromIso(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!match) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

async function load() {
  let history;
  const asked = RANGES[view.range]();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(asked)) params.set(key, String(value));
  if (view.project !== undefined) params.set('project', view.project);

  try {
    const res = await fetch(`/api/usage/history?${params}`);
    // 404 is the honest answer from a machine no source can measure, not a failure:
    // the page says there is nothing rather than that something went wrong.
    if (res.status === 404) {
      latest = undefined;
      byId('export').disabled = true;
      showEmpty();
      return;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    history = await res.json();
  } catch (error) {
    showBanner(error);
    return;
  }

  hideBanner();
  render(history, asked);
  loadYear();
}

/**
 * The year grid, read on its own.
 *
 * Its own fetch rather than a wider main one, because the year does not follow the
 * range picker — only the project choice — and because a cold year can take a moment
 * longer than a month: the sections above are drawn first instead of waiting on it.
 */
async function loadYear() {
  const year = view.year ?? thisYear();
  const asked = yearRange(year);
  const read = ++yearRead;
  syncYearControls(year);

  const params = new URLSearchParams({ since: String(asked.since), until: String(asked.until) });
  if (view.project !== undefined) params.set('project', view.project);

  try {
    const res = await fetch(`/api/usage/history?${params}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const history = await res.json();
    // Arrows clicked faster than a year reads: only the last one asked for is drawn.
    if (read !== yearRead) return;
    renderYear(history.buckets, asked, year);
  } catch {
    if (read !== yearRead) return;
    // The rest of the page stands on its own; the grid just says it could not read.
    yearShown = undefined;
    byId('year-share').disabled = true;
    byId('year-wrap').hidden = true;
    byId('year-loading').hidden = false;
    setText('year-loading', 'Could not read the year.');
  }
}

/** Counts the year reads, so a slow answer for a year since left is dropped on arrival. */
let yearRead = 0;

/** One calendar year in local days, stopping at today rather than reading days still to come. */
function yearRange(year) {
  return {
    since: new Date(year, 0, 1).getTime(),
    until: Math.min(new Date(year + 1, 0, 1).getTime(), nextDay(daysAgo(0))),
  };
}

function syncYearControls(year) {
  setText('year-label', String(year));
  byId('year-prev').disabled = year <= FIRST_YEAR;
  byId('year-next').disabled = year >= thisYear();
}

/**
 * Step a year back or forward. Pushed like every other view change, so Back returns
 * to the year you were on; only the grid is read again, since nothing else moved.
 */
function changeYear(step) {
  const year = Math.min(Math.max((view.year ?? thisYear()) + step, FIRST_YEAR), thisYear());
  view.year = year >= thisYear() ? undefined : year;
  syncUrl(true);
  loadYear();
}

function render(history, asked) {
  byId('loading').hidden = true;
  syncControls();

  latest = history.projects.length ? history : undefined;
  // Out in the masthead, so it is on screen even when there is nothing to export.
  byId('export').disabled = latest === undefined;
  if (history.projects.length === 0) {
    showEmpty(history);
    return;
  }

  byId('no-data').hidden = true;
  byId('content').hidden = false;

  renderSummary(history, asked);
  renderSelection(history);
  renderDays(history.buckets, history.range);
  renderHours(history.buckets);
  renderProjects(history.projects, history.project);
  renderModels(history.models);
  setText('read-at', `Read ${formatStamp(history.generatedAt)}`);
}

/**
 * What the page is narrowed to, said in words above the drawings.
 *
 * Only when the server confirmed the narrowing: a slug that matched nothing comes
 * back without `project`, and the page has to read as "nothing here" rather than
 * as a project that spent nothing.
 */
function renderSelection(history) {
  const chosen = history.project
    ? history.projects.find((project) => project.slug === history.project)
    : undefined;

  byId('selection').hidden = chosen === undefined;
  if (chosen) setText('selection-name', chosen.name);
}

function showEmpty(history) {
  byId('loading').hidden = true;
  byId('content').hidden = true;
  byId('no-data').hidden = false;
  if (history) setText('range-line', rangeLine(history.range));
}

/**
 * The totals for what is actually on screen.
 *
 * Summed from the series rather than from the project list, because the series is
 * the half that narrows: with one project picked, a Billed figure covering all
 * thirty-two would contradict every drawing under it. The project count is the one
 * number that keeps its whole-range meaning, so when a project is picked it says
 * which of how many rather than pretending the others are gone.
 */
function renderSummary(history, asked) {
  const totals = sumOf(history.buckets);

  setText('range-line', rangeLine(history.range, asked));
  setText('s-billed', formatCount(billedTokens(totals.tokens)));
  setText('s-cache', formatCount(totals.tokens.cacheRead));
  setText('s-turns', formatCount(totals.turns));
  setText(
    's-projects',
    history.project ? `1 of ${history.projects.length}` : formatCount(history.projects.length),
  );
  setText('s-models', formatCount(history.models.length));
  setText('s-busiest', busiestDay(history.buckets));
}

/**
 * The heaviest local day in the range.
 *
 * Folded here rather than on the server: the buckets arrive at half-hour grain in
 * absolute time, and which day one of them belongs to is a question only the reader's
 * own timezone can answer.
 */
function busiestDay(buckets) {
  const days = new Map();

  for (const bucket of buckets) {
    const day = new Date(bucket.at).setHours(0, 0, 0, 0);
    days.set(day, (days.get(day) ?? 0) + billedTokens(bucket.tokens));
  }

  let best;
  for (const [day, billed] of days) {
    if (!best || billed > best.billed) best = { day, billed };
  }
  return best ? `${formatDay(best.day)} · ${formatCompactCount(best.billed)}` : '—';
}

/**
 * Spend per local day, as a bar each.
 *
 * Continuous across the whole range rather than only the days that hold buckets: a
 * quiet Sunday is a fact about the week, and a chart that closed the gap would draw
 * a busy fortnight and a scattered month identically. Heights are linear — a bar
 * chart that is not is a lie about proportion — so one heavy day flattens the rest,
 * which is the shape of the truth rather than a fault in the drawing.
 */
function renderDays(buckets, range) {
  const group = view.group;
  const days = dailySeries(buckets, range);
  // A week or a month is the days in it added up, cut to the range at either end.
  const bars =
    group === 'day'
      ? days
      : groupDays(days, group, (period, day) => {
          period.billed = (period.billed ?? 0) + day.billed;
          period.turns = (period.turns ?? 0) + day.turns;
          period.limited = Boolean(period.limited || day.limited);
        });
  const peak = Math.max(...bars.map((bar) => bar.billed), 0);
  // Up to ten labels, and fewer where the chart is narrow: a label wants about
  // 3.5rem of its own, or on a phone they run into one another.
  const room = Math.floor(byId('days').clientWidth / 56) || 10;
  const step = Math.max(1, Math.ceil(bars.length / Math.max(2, Math.min(10, room))));

  const unit = groupWords(group).unit;
  setText('days-title', `Spend per ${unit}`);
  setText('days-hint', `Billed tokens per local ${unit}${group === 'week' ? ', Monday to Sunday' : ''}. A mark under a bar is a turn Claude refused.`);
  const active = bars.filter((bar) => bar.billed > 0).length;
  setText('days-count', `${active} active`);
  byId('days').replaceChildren(
    ...bars.map((bar, index) => {
      const height = peak ? (bar.billed / peak) * 100 : 0;
      const column = document.createElement('div');
      column.className = 'day';
      if (bar.limited) column.dataset.limited = 'true';
      column.title = barTitle(bar, group);
      // A bar that billed nothing draws nothing at all. The one-pixel minimum below
      // it is there so a bar that billed a little is never rounded out of sight —
      // which is the opposite claim, and must not be made for one that was quiet.
      column.innerHTML = `
        <span class="day-bar">${bar.billed ? `<span style="height:${height.toFixed(2)}%"></span>` : ''}</span>
        <span class="day-label">${index % step === 0 ? barLabel(bar, group) : ''}</span>`;
      return column;
    }),
  );
}

function barLabel(bar, group) {
  if (group === 'month') return formatMonth(bar.at);
  return formatDay(bar.at);
}

function formatMonth(at) {
  return new Date(at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/** One day's tooltip — the year grid's cells as well as the daily bars. */
function dayTitle(day) {
  return barTitle(day, 'day');
}

function barTitle(bar, group) {
  const spend = bar.billed
    ? `${formatCount(bar.billed)} billed · ${formatCount(bar.turns)} turns`
    : 'Nothing billed';
  const when =
    group === 'month'
      ? formatMonth(bar.at)
      : group === 'week' && bar.end !== bar.at
        ? `${formatDay(bar.at)} – ${formatDay(bar.end)}`
        : formatDay(bar.at);
  return `${when} · ${spend}${bar.limited ? ' · Claude refused a turn' : ''}`;
}

/** One entry per local day in the range, whether or not anything was billed in it. */
function dailySeries(buckets, range) {
  const totals = new Map();

  for (const bucket of buckets) {
    const day = startOfDay(bucket.at);
    const existing = totals.get(day) ?? { billed: 0, turns: 0, limited: false };
    existing.billed += billedTokens(bucket.tokens);
    existing.turns += bucket.turns;
    existing.limited = existing.limited || bucket.limited;
    totals.set(day, existing);
  }

  const days = [];
  // Stepped with `setDate` rather than by adding a day in milliseconds, so the two
  // days a year that are not 24 hours long still come out as one day each.
  for (const cursor = new Date(startOfDay(range.since)); cursor.getTime() < range.until; ) {
    const at = cursor.getTime();
    days.push({ at, ...(totals.get(at) ?? { billed: 0, turns: 0, limited: false }) });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function startOfDay(at) {
  return new Date(at).setHours(0, 0, 0, 0);
}

/**
 * Every half hour of the range laid over a single week.
 *
 * The one reading the daily bars cannot give: whether the five-hour window keeps
 * being opened at nine in the morning or at eleven at night. It is only possible
 * because the series arrives at the grain the transcripts were read at.
 */
function renderHours(buckets) {
  const cells = new Array(WEEKDAYS.length * COLUMNS).fill(0);

  for (const bucket of buckets) {
    const at = new Date(bucket.at);
    // `getDay` is Sunday-first; the grid is Monday-first, as a week of work reads.
    const row = (at.getDay() + 6) % 7;
    const column = at.getHours() * 2 + (at.getMinutes() >= 30 ? 1 : 0);
    cells[row * COLUMNS + column] += billedTokens(bucket.tokens);
  }

  const peak = Math.max(...cells, 0);
  const grid = byId('hours');
  grid.replaceChildren();

  WEEKDAYS.forEach((weekday, row) => {
    const line = document.createElement('div');
    line.className = 'hours-row';
    line.innerHTML = `<span class="hours-day">${weekday}</span>`;

    for (let column = 0; column < COLUMNS; column += 1) {
      const billed = cells[row * COLUMNS + column];
      const fill = billed && peak ? CELL_FLOOR + (1 - CELL_FLOOR) * (billed / peak) : 0;
      const cell = document.createElement('span');
      cell.className = 'hours-cell';
      cell.style.setProperty('--fill', fill.toFixed(3));
      cell.title = `${weekday} ${halfHourLabel(column)} · ${billed ? `${formatCount(billed)} billed` : 'nothing billed'}`;
      line.append(cell);
    }

    grid.append(line);
  });

  grid.append(hourAxis());
}

/**
 * A cell per local day, weeks across and weekdays down, like a contribution graph.
 *
 * Shaded in five steps against the quartiles of the active days rather than linearly
 * against the peak: over a year one heavy day would otherwise wash every other day
 * out to the faintest shade, and the grid is read for rhythm, not proportion — the
 * daily bars above are where proportion is kept.
 */
function renderYear(buckets, range, year) {
  const series = dailySeries(buckets, range);
  const byDay = new Map(series.map((day) => [day.at, day]));
  const active = series.filter((day) => day.billed > 0).map((day) => day.billed).sort((a, b) => a - b);
  const cuts = [0.25, 0.5, 0.75].map((q) => active[Math.floor(q * (active.length - 1))] ?? 0);
  const level = (billed) => (billed <= 0 ? 0 : 1 + cuts.filter((cut) => billed > cut).length);

  // Whole weeks, Monday to Sunday, around the year; the days either side of it keep
  // their slots so every row stays one weekday, but are drawn as nothing. Days still
  // to come are drawn, empty, so the current year reads as a whole year.
  const jan1 = new Date(year, 0, 1).getTime();
  const dec31 = new Date(year, 11, 31).getTime();
  const start = shiftDays(jan1, -weekdayIndex(jan1));
  const end = shiftDays(dec31, 6 - weekdayIndex(dec31));
  const today = daysAgo(0);

  const weeks = [];
  for (let at = start; at <= end; at = shiftDays(at, 1)) {
    if (weekdayIndex(at) === 0) weeks.push([]);
    const day = byDay.get(at);
    weeks.at(-1).push({
      at,
      shown: at >= jan1 && at <= dec31,
      future: at > today,
      level: day ? level(day.billed) : 0,
      day: day ?? { at, billed: 0, turns: 0, limited: false },
    });
  }

  const grid = byId('year');
  grid.style.gridTemplateColumns = `2.2rem repeat(${weeks.length}, minmax(0, 1fr))`;
  grid.replaceChildren();

  // The first column: an empty corner over the weekday labels.
  grid.append(document.createElement('span'));
  for (const weekday of WEEKDAYS) {
    const label = document.createElement('span');
    label.className = 'hours-day';
    label.textContent = weekday;
    grid.append(label);
  }

  for (const week of weeks) {
    const month = document.createElement('span');
    month.className = 'year-month';
    month.textContent = monthStarting(week, year) ?? '';
    grid.append(month);

    for (const entry of week) {
      const cell = document.createElement('span');
      cell.className = 'year-cell';
      if (entry.shown) {
        cell.dataset.level = String(entry.level);
        cell.title = entry.future ? `${formatDay(entry.at)} · still to come` : dayTitle(entry.day);
      } else {
        cell.dataset.hidden = 'true';
      }
      grid.append(cell);
    }
  }

  yearShown = {
    year,
    weeks,
    active: active.length,
    billed: active.reduce((sum, billed) => sum + billed, 0),
  };

  setText('year-count', `${active.length} active days`);
  byId('year-share').disabled = active.length === 0;
  byId('year-loading').hidden = true;
  byId('year-wrap').hidden = false;
}

/** Monday is 0: the grid is Monday-first, as a week of work reads. */
function weekdayIndex(at) {
  return (new Date(at).getDay() + 6) % 7;
}

/** The short name of the month whose first day falls in this week, if one does. */
function monthStarting(week, year) {
  const first = week.find((entry) => {
    const date = new Date(entry.at);
    return date.getDate() === 1 && date.getFullYear() === year;
  });
  return first ? new Date(first.at).toLocaleDateString(undefined, { month: 'short' }) : undefined;
}

/** The grid on screen, kept for the share image. */
let yearShown;

byId('year-prev').addEventListener('click', () => changeYear(-1));
byId('year-next').addEventListener('click', () => changeYear(1));

/** Marks the quarters of the day rather than every column — 48 labels do not fit. */
function hourAxis() {
  const axis = document.createElement('div');
  axis.className = 'hours-axis';
  axis.innerHTML = '<span class="hours-day"></span>';

  for (let column = 0; column < COLUMNS; column += 1) {
    const label = document.createElement('span');
    label.className = 'hours-tick';
    if (column % 12 === 0) label.textContent = halfHourLabel(column);
    axis.append(label);
  }
  return axis;
}

/** Column 18 is 09:00, in whatever way the reader's locale writes it. */
function halfHourLabel(column) {
  const at = new Date();
  at.setHours(Math.floor(column / 2), (column % 2) * 30, 0, 0);
  return formatClock(at.getTime());
}

function renderProjects(projects, selected) {
  const total = billedTokens(sumOf(projects).tokens);

  const labels = disambiguate(projects);

  fillTable('projects', projects, (project) => {
    const share = total ? billedTokens(project.tokens) / total : 0;
    return `
      <td class="project">
        <button type="button" class="project-pick">
          <span class="project-name"></span>
          <span class="project-path mono"></span>
        </button>
      </td>
      <td class="num">${formatCount(project.turns)}</td>
      <td class="num">${formatCount(billedTokens(project.tokens))}</td>
      <td class="num soft">${formatCompactCount(project.tokens.cacheRead)}</td>
      <td class="num">${formatShare(share)}</td>`;
  }, (row, project) => {
    // Text rather than markup, because a project name is a directory name and a
    // directory can be called anything at all.
    row.querySelector('.project-name').textContent = labels.get(project.slug);
    row.querySelector('.project-path').textContent = project.path;
    if (project.slug === selected) row.dataset.selected = 'true';

    const pick = row.querySelector('.project-pick');
    pick.setAttribute('aria-pressed', String(project.slug === selected));
    // Picking the project already picked is how you let go of it, which is what the
    // row being a toggle rather than a link buys.
    pick.addEventListener('click', () => choose(project.slug === selected ? undefined : project.slug));
  });
}

/**
 * Row labels that identify the row.
 *
 * A project's name is its directory's basename, and two checkouts can share one —
 * `Tivi/iOS` and `Apa/iOS` both read as `iOS`. Where that happens the parent goes in
 * front; where it does not, the plain name stands, because most rows do not need it.
 */
function disambiguate(projects) {
  const seen = new Map();
  for (const project of projects) seen.set(project.name, (seen.get(project.name) ?? 0) + 1);

  return new Map(
    projects.map((project) => {
      if (seen.get(project.name) === 1) return [project.slug, project.name];
      const parent = project.path.split('/').at(-2);
      return [project.slug, parent ? `${parent} / ${project.name}` : project.name];
    }),
  );
}

/**
 * Narrow to one project, or let go of the one in force.
 *
 * The choice goes in the query string rather than in a variable, so a reload comes
 * back to the same view, a bookmark keeps it, and Back undoes it — the same rule the
 * dashboard's range and sort already follow.
 */
function choose(slug) {
  view.project = slug;
  syncUrl(true);
  load();
}

function renderModels(models) {
  const total = billedTokens(sumOf(models).tokens);

  fillTable('models', models, (model) => {
    const share = total ? billedTokens(model.tokens) / total : 0;
    return `
      <td class="mono"></td>
      <td class="num">${formatCount(model.turns)}</td>
      <td class="num">${formatCount(billedTokens(model.tokens))}</td>
      <td class="num soft">${formatCompactCount(model.tokens.cacheRead)}</td>
      <td class="num">${formatShare(share)}</td>`;
  }, (row, model) => {
    row.querySelector('.mono').textContent = model.model;
  });
}

/** One shape for both tables: fill it, count it, or say it is empty. */
function fillTable(name, rows, cells, fill) {
  const body = byId(`${name}-body`);
  body.replaceChildren();

  for (const item of rows) {
    const row = document.createElement('tr');
    row.innerHTML = cells(item);
    fill(row, item);
    body.append(row);
  }

  setText(`${name}-count`, rows.length ? String(rows.length) : '');
  byId(`${name}-wrap`).hidden = rows.length === 0;
  byId(`${name}-empty`).hidden = rows.length > 0;
}

function sumOf(rows) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let turns = 0;

  for (const row of rows) {
    tokens.input += row.tokens.input;
    tokens.output += row.tokens.output;
    tokens.cacheRead += row.tokens.cacheRead;
    tokens.cacheCreate += row.tokens.cacheCreate;
    turns += row.turns;
  }

  return { tokens, turns };
}

/**
 * The range the server actually read, and a word when that is not the one asked for.
 *
 * The reader is entitled to know they are looking at ninety days of a year they
 * asked for. The server narrows rather than refuses — that is the right call for a
 * read this expensive — but only if the page passes the fact on.
 */
function rangeLine(range, asked) {
  const days = Math.round((range.until - range.since) / 86_400_000);
  const line = `${formatDay(range.since)} – ${formatDay(range.until - 1)} · ${days} days`;
  const narrowed = asked?.since !== undefined && range.since > asked.since;
  return narrowed ? `${line} · narrowed from what was asked for` : line;
}

/* -------------------------------------------------------------- the controls */

const rangeSelect = byId('range');
const fromInput = byId('range-from');
const toInput = byId('range-to');

/** The controls follow the state, so a reload with `?range=90d` opens with the picker saying so. */
function syncControls() {
  rangeSelect.value = view.range;
  fromInput.value = view.from;
  toInput.value = view.to;
  byId('from-field').hidden = view.range !== 'custom';
  byId('to-field').hidden = view.range !== 'custom';
  // How many labels fit depends on the chart's width, so a resize redraws the bars.
let resizeFrame = 0;
addEventListener('resize', () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    if (latest && !byId('content').hidden) renderDays(latest.buckets, latest.range);
  });
});

for (const button of byId('group').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.group === view.group));
  }
}

/**
 * Day, week or month bars. Redrawn from the read already on screen — grouping is
 * arithmetic on the same days, not a question for the server.
 */
for (const button of byId('group').querySelectorAll('button')) {
  button.addEventListener('click', () => {
    if (view.group === button.dataset.group) return;
    view.group = button.dataset.group;
    syncControls();
    syncUrl(true);
    if (latest) renderDays(latest.buckets, latest.range);
  });
}

/**
 * A change of range is a page state of its own, so it is pushed rather than replaced:
 * Back returns to the range you were looking at, the same way it drops a selection.
 */
function changeRange(next) {
  Object.assign(view, next);
  syncControls();
  syncUrl(true);
  load();
}

rangeSelect.addEventListener('change', () => {
  const range = rangeSelect.value;
  // Switching to Custom with no dates yet would ask for everything on disk, so it
  // waits for a date instead: the fields appear, and nothing is re-read until one lands.
  if (range === 'custom' && !view.from && !view.to) {
    Object.assign(view, { range });
    syncControls();
    syncUrl(true);
    return;
  }
  changeRange({ range });
});

for (const input of [fromInput, toInput]) {
  input.addEventListener('change', () => {
    changeRange({ range: 'custom', from: fromInput.value, to: toInput.value });
  });
}

// Reading again is something you ask for, since nothing here polls.
byId('refresh').addEventListener('click', () => load());

function showBanner(error) {
  byId('loading').hidden = true;
  setText('banner-text', 'Could not read the history.');
  setText('banner-hint', error instanceof Error ? error.message : String(error));
  byId('banner').hidden = false;
}

function hideBanner() {
  byId('banner').hidden = true;
}

byId('selection-clear').addEventListener('click', () => choose(undefined));

/* ------------------------------------------------------------------ the export */

/** The last read that had something in it — what the export dialog opens on. */
let latest;

/**
 * The read the dialog is describing: the page's own until other dates are picked,
 * then one made for those dates. The file is written from exactly its range.
 */
let preview;

const exportDialog = byId('export-dialog');
const exportPeriod = byId('export-period');
const exportFrom = byId('export-from');
const exportTo = byId('export-to');
const exportScope = byId('export-scope');
const exportGroup = byId('export-group');
const exportGo = byId('export-go');
const exportPreview = byId('export-preview');

/** Export and Preview write the same report, so they are ready or not together. */
function lockExport(locked) {
  exportGo.disabled = locked;
  exportPreview.disabled = locked;
}

/**
 * Open the dialog on the dates on screen, and the project on screen if one is picked.
 *
 * Both can be changed here, because exporting another stretch or one repository is
 * a fair thing to want without first turning the whole page to it. Whatever is
 * picked, the dialog says it back in full before anything is written.
 */
function openExport() {
  if (!latest) return;

  exportPeriod.value = 'page';
  exportFrom.value = isoDay(latest.range.since);
  exportTo.value = isoDay(latest.range.until - 1);
  byId('export-dates').hidden = true;
  byId('export-error').hidden = true;
  // Rows start as the bars on the page do; the file can still be cut another way.
  exportGroup.value = view.group;

  preview = latest;
  fillScope(latest.project ?? '');
  describeExport();
  exportDialog.showModal();
}

/** The dates the dialog asks for, in whole local days like the page's own ranges. */
function exportAsk() {
  const period = exportPeriod.value;
  if (period === 'page') return latest.range;
  if (period !== 'custom') return RANGES[period]();

  let from = dayFromIso(exportFrom.value);
  let to = dayFromIso(exportTo.value);
  if (from === undefined || to === undefined) return undefined;
  // A backwards pair is a slip of the picker, as it is on the page.
  if (from > to) [from, to] = [to, from];
  return { since: from, until: nextDay(to) };
}

/** Counts the reads, so a slow answer for dates since changed is dropped on arrival. */
let previewRead = 0;

/** New dates: read them, then describe what they hold. */
async function changeExportDates() {
  byId('export-dates').hidden = exportPeriod.value !== 'custom';
  byId('export-error').hidden = true;

  const asked = exportAsk();
  const read = ++previewRead;
  preview = undefined;
  lockExport(true);

  if (!asked) {
    // Nothing described rather than the last dates, which are no longer the ones asked for.
    setText('export-range', 'Pick both dates');
    setText('export-projects', '—');
    setText('export-billed', '—');
    byId('export-contents').replaceChildren();
    return;
  }
  if (exportPeriod.value === 'page') {
    preview = latest;
  } else {
    setText('export-billed', 'Reading…');
    try {
      const params = new URLSearchParams({ since: String(asked.since), until: String(asked.until) });
      const res = await fetch(`/api/usage/history?${params}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const history = await res.json();
      if (read !== previewRead) return;
      preview = { ...history, asked };
    } catch (error) {
      if (read !== previewRead) return;
      showExportError(error);
      return;
    }
  }

  fillScope(exportScope.value);
  describeExport();
}

/** The projects that billed in the dates picked, keeping the one chosen if it is still there. */
function fillScope(keep) {
  const labels = disambiguate(preview.projects);
  exportScope.replaceChildren(
    new Option(`All projects (${preview.projects.length})`, ''),
    ...preview.projects.map((project) => new Option(labels.get(project.slug), project.slug)),
  );
  exportScope.value = preview.projects.some((project) => project.slug === keep) ? keep : '';
}

const longDay = (at) =>
  new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

/** What the file will hold, said before it is written. */
function describeExport() {
  if (!preview) return;
  const labels = disambiguate(preview.projects);
  const slug = exportScope.value;
  const chosen = slug ? preview.projects.filter((project) => project.slug === slug) : preview.projects;
  const format = exportFormat();

  const { range } = preview;
  const days = Math.round((range.until - range.since) / 86_400_000);
  // The server narrows a span wider than it will read; the reader is owed the fact.
  const narrowed = preview.asked !== undefined && range.since > preview.asked.since;
  setText(
    'export-range',
    `${longDay(range.since)} – ${longDay(range.until - 1)} (${days} days)` +
      (narrowed ? ' · narrowed to the longest range that can be read' : ''),
  );

  if (chosen.length === 0) {
    setText('export-projects', '—');
    setText('export-billed', 'Nothing billed in these dates');
    byId('export-contents').replaceChildren();
    lockExport(true);
    return;
  }

  setText(
    'export-projects',
    slug ? `${labels.get(slug)} — ${chosen[0]?.path ?? ''}` : `All ${chosen.length} projects`,
  );
  const totals = sumOf(chosen);
  setText(
    'export-billed',
    `${formatCount(billedTokens(totals.tokens))} tokens · ${formatCount(totals.turns)} turns`,
  );

  const contents = [
    'Totals at the top: billed, input, output, cache writes, cache reads, turns and active days',
    ...(chosen.length > 1 ? [`Each of the ${chosen.length} projects ranked by billed tokens, with its share`] : []),
    `${groupWords(exportGroup.value).rows} token usage${chosen.length > 1 ? ' per project' : ''} — one row for every ${groupWords(exportGroup.value).unit} that billed something`,
    format === 'xlsx'
      ? `Two sheets, Summary and ${groupWords(exportGroup.value).rows}, with real numbers and dates you can sort and filter`
      : 'An A4 document, one table per project with a total row',
  ];
  byId('export-contents').replaceChildren(
    ...contents.map((text) => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    }),
  );
  lockExport(false);
}

function showExportError(error) {
  setText('export-error', `Could not export: ${error instanceof Error ? error.message : String(error)}`);
  byId('export-error').hidden = false;
}

function exportFormat() {
  return exportDialog.querySelector('input[name="format"]:checked')?.value ?? 'pdf';
}

/**
 * Read the dates again with each project's own series, and build the report.
 *
 * A second read rather than the preview's, because the preview only carries the
 * merged series; splitting a day by project needs the server to keep them apart.
 * Same range to the millisecond, so the file and the dialog agree.
 */
async function readReport() {
  const params = new URLSearchParams({
    since: String(preview.range.since),
    until: String(preview.range.until),
    perProject: '1',
  });
  if (exportScope.value) params.set('project', exportScope.value);

  const res = await fetch(`/api/usage/history?${params}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const history = await res.json();
  return buildReport(history, disambiguate(history.projects), exportGroup.value);
}

async function runExport() {
  if (!preview) return;
  lockExport(true);
  byId('export-error').hidden = true;

  try {
    const report = await readReport();
    const format = exportFormat();
    download(format === 'xlsx' ? toXlsx(report) : toPdf(report), fileName(report, format));
    exportDialog.close();
  } catch (error) {
    showExportError(error);
    lockExport(false);
  }
}

/**
 * The report as a PDF in a new tab, with the dialog left open to change and export.
 *
 * The tab is opened before the read rather than after it: a window opened once a
 * fetch has come back is no longer the click's doing, and popup blockers say no.
 */
async function runPreview() {
  if (!preview) return;
  const tab = window.open('', '_blank');
  if (!tab) {
    showExportError(new Error('the browser blocked the new tab'));
    return;
  }
  tab.document.title = 'Preparing report…';
  tab.document.body.textContent = 'Preparing the report…';

  lockExport(true);
  byId('export-error').hidden = true;

  try {
    const url = URL.createObjectURL(toPdf(await readReport()));
    tab.location.href = url;
    // Long enough for the viewer to have read it; the tab keeps what it loaded.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    tab.close();
    showExportError(error);
  } finally {
    lockExport(false);
  }
}

byId('export').addEventListener('click', openExport);
exportScope.addEventListener('change', describeExport);
exportGroup.addEventListener('change', describeExport);
exportPeriod.addEventListener('change', () => {
  // Custom starts from the dates last shown, so it is an edit rather than a blank.
  if (exportPeriod.value === 'custom' && preview) {
    exportFrom.value = isoDay(preview.range.since);
    exportTo.value = isoDay(preview.range.until - 1);
  }
  changeExportDates();
});
for (const input of [exportFrom, exportTo]) input.addEventListener('change', changeExportDates);
for (const radio of exportDialog.querySelectorAll('input[name="format"]')) {
  radio.addEventListener('change', describeExport);
}
byId('export-cancel').addEventListener('click', () => exportDialog.close());
exportPreview.addEventListener('click', runPreview);
byId('export-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runExport();
});

// Back and Forward move between views, because each one is a real page state — so
// the state has to be re-read from the URL rather than kept only in this module.
/* ------------------------------------------------------------------- the share */

const shareDialog = byId('share-dialog');

/** The picture last drawn for the dialog, ready before a network is picked. */
let shareImage;

/**
 * Draw the year as a picture and open the dialog on it.
 *
 * Drawn up front rather than on the click, because the click has to copy the
 * picture and open a tab while the browser still counts it as the click — a
 * drawing in between could lose that, and the new tab would be blocked.
 */
async function openShare() {
  if (!yearShown) return;
  const canvas = drawYear(yearShown);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return;

  if (shareImage) URL.revokeObjectURL(shareImage.url);
  shareImage = { blob, url: URL.createObjectURL(blob), year: yearShown.year };

  byId('share-preview').src = shareImage.url;
  const download = byId('share-download');
  download.href = shareImage.url;
  download.download = `claude-code-${yearShown.year}.png`;
  setText('share-status', '');
  shareDialog.showModal();
}

/** What goes in the post beside the picture. */
function shareCaption() {
  const { year, active, billed } = yearShown;
  const days = `${formatCount(active)} active ${active === 1 ? 'day' : 'days'}`;
  return `My ${year} with Claude Code: ${days} and ${formatCompactCount(billed)} tokens billed.`;
}

const SHARE_TARGETS = {
  x: (text) => `https://x.com/intent/post?text=${encodeURIComponent(text)}`,
  linkedin: (text) => `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}`,
};

/**
 * Copy the picture, then open the network's composer with the caption in it.
 *
 * Neither network takes an image through a link, so the picture rides on the
 * clipboard and is pasted in. Where the clipboard will not take an image, it is
 * saved instead, and the line under the buttons says which happened.
 */
async function shareTo(target) {
  if (!shareImage || !yearShown) return;
  const composer = SHARE_TARGETS[target](shareCaption());

  // Saved as well as copied, every time: the clipboard is easy to overwrite before
  // the post is open, and a file in Downloads is still there to attach.
  let copied = false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': shareImage.blob })]);
    copied = true;
  } catch {
    // Said below; the saved file covers it.
  }
  const download = byId('share-download');
  download.click();

  window.open(composer, '_blank', 'noopener');
  const file = download.download;
  setText(
    'share-status',
    copied
      ? `Image copied and saved as ${file}. In the post, press ⌘V or Ctrl+V — or attach the file with the post's image button.`
      : `Image saved as ${file} in your downloads. Attach it with the post's image button.`,
  );
}

/**
 * The grid redrawn on a canvas, in the theme on screen.
 *
 * Redrawn rather than captured: the page has no way to photograph itself, and a
 * drawing made for the purpose can carry a title and the totals, which the panel
 * leaves to the section heading.
 */
function drawYear(shown) {
  const root = getComputedStyle(document.documentElement);
  const token = (name) => root.getPropertyValue(name).trim();
  // The shades as the page resolved them, so the picture matches the grid exactly.
  const shades = [...document.querySelectorAll('.year-legend .year-cell')].map(
    (cell) => getComputedStyle(cell).backgroundColor,
  );
  const sans = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

  const cell = 16;
  const gap = 3;
  const pad = 44;
  const labelWidth = 46;
  const gridLeft = pad + labelWidth;
  const gridTop = pad + 108;
  const gridWidth = shown.weeks.length * (cell + gap) - gap;
  const gridHeight = 7 * (cell + gap) - gap;
  const width = gridLeft + gridWidth + pad;
  const height = gridTop + gridHeight + 56 + pad;

  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = token('--surface');
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = token('--accent');
  ctx.fillRect(0, 0, width, 4);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = token('--ink-faint');
  ctx.font = `600 13px ${mono}`;
  ctx.fillText('CLAUDE CODE', pad, pad + 6);

  ctx.fillStyle = token('--ink');
  ctx.font = `600 34px ${sans}`;
  ctx.fillText(String(shown.year), pad, pad + 46);

  ctx.fillStyle = token('--ink-soft');
  ctx.font = `17px ${sans}`;
  ctx.fillText(
    `${formatCount(shown.active)} active days · ${formatCount(shown.billed)} tokens billed`,
    pad,
    pad + 76,
  );

  ctx.fillStyle = token('--ink-faint');
  ctx.font = `12px ${mono}`;
  shown.weeks.forEach((week, column) => {
    const month = monthStarting(week, shown.year);
    if (month) ctx.fillText(month, gridLeft + column * (cell + gap), gridTop - 8);
  });

  ctx.textBaseline = 'middle';
  WEEKDAYS.forEach((weekday, row) => {
    ctx.fillText(weekday.toUpperCase(), pad, gridTop + row * (cell + gap) + cell / 2);
  });

  shown.weeks.forEach((week, column) => {
    week.forEach((entry, row) => {
      if (!entry.shown) return;
      ctx.fillStyle = shades[entry.level] ?? token('--rule');
      ctx.beginPath();
      ctx.roundRect(gridLeft + column * (cell + gap), gridTop + row * (cell + gap), cell, cell, 2);
      ctx.fill();
    });
  });

  // The legend, right-aligned under the grid as it sits on the page.
  const legendY = gridTop + gridHeight + 28;
  const legendCell = 13;
  const more = 'More';
  ctx.fillStyle = token('--ink-faint');
  ctx.textAlign = 'right';
  let x = gridLeft + gridWidth;
  ctx.fillText(more, x, legendY);
  x -= ctx.measureText(more).width + 6 + legendCell;
  for (let level = shades.length - 1; level >= 0; level -= 1) {
    ctx.fillStyle = shades[level];
    ctx.beginPath();
    ctx.roundRect(x, legendY - legendCell / 2, legendCell, legendCell, 2);
    ctx.fill();
    x -= legendCell + 3;
  }
  ctx.fillStyle = token('--ink-faint');
  ctx.fillText('Less', x + legendCell - 3, legendY);

  ctx.textAlign = 'left';
  ctx.fillText('Billed tokens per day', gridLeft, legendY);

  return canvas;
}

byId('year-share').addEventListener('click', openShare);
byId('share-close').addEventListener('click', () => shareDialog.close());
for (const button of shareDialog.querySelectorAll('[data-target]')) {
  button.addEventListener('click', () => shareTo(button.dataset.target));
}
// A click on the backdrop lands on the dialog itself, not on anything inside it.
shareDialog.addEventListener('click', (event) => {
  if (event.target === shareDialog) shareDialog.close();
});

addEventListener('popstate', () => {
  Object.assign(view, readView());
  syncControls();
  load();
});

syncControls();
load();
