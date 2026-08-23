import { formatCount, formatCompactCount, formatDay, formatShare, formatStamp } from './format.js';

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

async function load() {
  let history;
  try {
    const res = await fetch('/api/usage/history');
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
  renderProjects(history.projects);
  renderModels(history.models);
  setText('read-at', `Read ${formatStamp(history.generatedAt)}`);
}

function showEmpty(history) {
  byId('loading').hidden = true;
  byId('content').hidden = true;
  byId('no-data').hidden = false;
  if (history) setText('range-line', rangeLine(history.range));
}

function renderSummary(history) {
  const totals = sumOf(history.projects);

  setText('range-line', rangeLine(history.range));
  setText('s-billed', formatCount(billedTokens(totals.tokens)));
  setText('s-cache', formatCount(totals.tokens.cacheRead));
  setText('s-turns', formatCount(totals.turns));
  setText('s-projects', formatCount(history.projects.length));
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

function renderProjects(projects) {
  const total = billedTokens(sumOf(projects).tokens);

  fillTable('projects', projects, (project) => {
    const share = total ? billedTokens(project.tokens) / total : 0;
    return `
      <td class="project">
        <span class="project-name"></span>
        <span class="project-path mono"></span>
      </td>
      <td class="num">${formatCount(project.turns)}</td>
      <td class="num">${formatCount(billedTokens(project.tokens))}</td>
      <td class="num soft">${formatCompactCount(project.tokens.cacheRead)}</td>
      <td class="num">${formatShare(share)}</td>`;
  }, (row, project) => {
    // Text rather than markup, because a project name is a directory name and a
    // directory can be called anything at all.
    row.querySelector('.project-name').textContent = project.name;
    row.querySelector('.project-path').textContent = project.path;
  });
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

load();
