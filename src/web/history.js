import {
  formatClock,
  formatCompactCount,
  formatCount,
  formatDay,
  formatShare,
  formatStamp,
} from './format.js';

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

function selectedProject() {
  return new URLSearchParams(location.search).get('project') ?? undefined;
}

async function load() {
  let history;
  const project = selectedProject();
  const query = project === undefined ? '' : `?project=${encodeURIComponent(project)}`;
  try {
    const res = await fetch(`/api/usage/history${query}`);
    // 404 is the honest answer from a machine no source can measure, not a failure:
    // the page says there is nothing rather than that something went wrong.
    if (res.status === 404) {
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
  render(history);
}

function render(history) {
  byId('loading').hidden = true;

  if (history.projects.length === 0) {
    showEmpty(history);
    return;
  }

  byId('no-data').hidden = true;
  byId('content').hidden = false;

  renderSummary(history);
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
function renderSummary(history) {
  const totals = sumOf(history.buckets);

  setText('range-line', rangeLine(history.range));
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
  const days = dailySeries(buckets, range);
  const peak = Math.max(...days.map((day) => day.billed), 0);
  // Roughly ten labels, whatever the range: 30 days is every third, 90 every ninth.
  const step = Math.max(1, Math.ceil(days.length / 10));

  const active = days.filter((day) => day.billed > 0).length;
  setText('days-count', `${active} active`);
  byId('days').replaceChildren(
    ...days.map((day, index) => {
      const height = peak ? (day.billed / peak) * 100 : 0;
      const column = document.createElement('div');
      column.className = 'day';
      if (day.limited) column.dataset.limited = 'true';
      column.title = dayTitle(day);
      // A day that billed nothing draws no bar at all. The one-pixel minimum below
      // it is there so a day that billed a little is never rounded out of sight —
      // which is the opposite claim, and must not be made for a day that was quiet.
      column.innerHTML = `
        <span class="day-bar">${day.billed ? `<span style="height:${height.toFixed(2)}%"></span>` : ''}</span>
        <span class="day-label">${index % step === 0 ? formatDay(day.at) : ''}</span>`;
      return column;
    }),
  );
}

function dayTitle(day) {
  const spend = day.billed
    ? `${formatCount(day.billed)} billed · ${formatCount(day.turns)} turns`
    : 'Nothing billed';
  return `${formatDay(day.at)} · ${spend}${day.limited ? ' · Claude refused a turn' : ''}`;
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
  const url = new URL(location.href);
  if (slug === undefined) url.searchParams.delete('project');
  else url.searchParams.set('project', slug);

  // Qualified: `history` is this file's word for a payload everywhere else.
  window.history.pushState({}, '', url);
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

/** The range the server actually read, which is not always the one that was asked for. */
function rangeLine(range) {
  const days = Math.round((range.until - range.since) / 86_400_000);
  return `${formatDay(range.since)} – ${formatDay(range.until)} · ${days} days`;
}

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

// Back and Forward move between selections, because each one is a real page state.
addEventListener('popstate', () => load());

load();
