/** How often we ask the server for the session list. Phase 5 may replace this with SSE. */
const SESSIONS_INTERVAL_MS = 2000;
const HEALTH_INTERVAL_MS = 15000;
/**
 * How often the limit cards are re-read.
 *
 * Far slower than the session list, because it is a far wider read — weeks of
 * transcripts rather than the rows on screen — and because neither a five-hour
 * window nor a week moves fast enough to be worth asking about every two seconds.
 * The countdown beside them ticks locally, so they still feel live between readings.
 */
const LIMITS_INTERVAL_MS = 15000;
/** Uptime is redrawn on its own beat so the clock ticks between polls. */
const TICK_MS = 1000;
/** Where a window stops being read in clock time and starts being read in days. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How often an open panel re-reads its session. Only for live ones — a finished
 * transcript cannot change, and the server caches on mtime, so a re-read of a quiet
 * session costs nothing anyway. Slower than the list poll because a live session's
 * file really is being appended to, and each read streams the whole of it.
 */
const DETAIL_INTERVAL_MS = 10000;

const DEFAULT_LIMIT = 10;
/** Matches the server's ceiling; asking for more just gets clamped. */
const MAX_LIMIT = 2000;

const STATUS_LABELS = { busy: 'busy', waiting: 'waiting', idle: 'idle', ended: 'ended' };
/** Busy first, then anything needing a human, then the quiet ones. */
const STATUS_RANK = { busy: 0, waiting: 1, idle: 2, ended: 3 };

/** Which keys move between rows, and by how far. */
const ROW_STEPS = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' };

const byId = (id) => document.getElementById(id);
const setText = (id, value) => {
  const node = byId(id);
  if (node) node.textContent = value;
};

/**
 * Where each range begins and ends, in local time.
 *
 * Counted in whole days rather than in hours: "today" means since midnight, not
 * "the last 24 hours". A window that slides forward as the clock ticks is not one
 * you can compare two readings of. `startOfDay` walks the calendar rather than
 * subtracting milliseconds, so the two days a year that are not 24 hours long still
 * begin at midnight like every other day.
 */
const RANGES = {
  all: () => ({}),
  today: () => ({ since: startOfDay(0) }),
  yesterday: () => ({ since: startOfDay(1), until: startOfDay(0) }),
  '3d': () => ({ since: startOfDay(2) }),
  '7d': () => ({ since: startOfDay(6) }),
  '30d': () => ({ since: startOfDay(29) }),
  custom: () => customRange(),
};

/**
 * How the Recent table is ordered. Matches the server's own orderings, which is what
 * makes the two agree: the server ranks across the whole window and sends the top
 * `limit` of it, and this puts the rows that survive the text filter back in that
 * same order — including on the one poll that raced a change to the picker.
 */
const RECENT_ORDERS = {
  recent: (a, b) => b.lastActiveAt - a.lastActiveAt,
  'tokens-desc': (a, b) => totalTokens(b) - totalTokens(a) || b.lastActiveAt - a.lastActiveAt,
  'tokens-asc': (a, b) => totalTokens(a) - totalTokens(b) || b.lastActiveAt - a.lastActiveAt,
};

/**
 * Where the Recent controls sit when nobody has touched them.
 *
 * Said once, because three places lean on it — the fallbacks a hand-edited query
 * string falls back to, the parameters `syncUrl` leaves out, and what Reset restores
 * — and they would be a quiet bug apart.
 */
const DEFAULT_VIEW = { range: 'all', from: '', to: '', sort: 'recent' };

const view = readView();

const state = {
  live: [],
  recent: [],
  /** Sessions in the window, which is more than we asked for whenever `limit` bites. */
  total: 0,
  query: '',
  limit: view.limit,
  /** Which of `RANGES` bounds the Recent table. `all` is every transcript on disk. */
  range: view.range,
  /** The two ends of the custom range, as the `YYYY-MM-DD` the date inputs speak. */
  from: view.from,
  to: view.to,
  /** Which of `RECENT_ORDERS` the Recent table is in. */
  sort: view.sort,
  /** The last reading of the two usage limits, or null before the first one. */
  limits: null,
  /** No source could find its data. The strip and the tables all step aside for the notice. */
  noData: false,
  /** Consecutive failed polls. One is a blip; two is worth interrupting for. */
  failures: 0,
  /** Id of the session the panel is showing, or null when it is closed. */
  openId: null,
  /** The last detail we fetched, kept so a re-read can redraw without a flash of empty. */
  detail: null,
};

async function getJson(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/* ---------------------------------------------------------------- polling */

const LIVE_BADGE_LABELS = { pending: 'Connecting', ok: 'Live', bad: 'Offline' };

function setLiveState(tone) {
  byId('live-badge')?.setAttribute('data-state', tone);
  setText('live-badge-text', LIVE_BADGE_LABELS[tone] ?? tone);
}

async function pollHealth() {
  try {
    const health = await getJson('/api/health');
    setText('fact-version', health.version);
    setText('fact-node', health.node);
    setText('fact-dir', health.claudeDir);
    setText(
      'fact-sources',
      health.sources.map((s) => `${s.label} ${s.available ? '✓' : '✗'}`).join(' · ') || 'none',
    );
    setText('no-data-dir', health.claudeDir);
    renderAvailability(health.sources);
  } catch {
    // The session poll owns the connection indicator; a stale fact panel is harmless.
  }
}

/**
 * No source can find its data — which is not a failure, just an empty machine.
 * The tables would say "no transcripts found" and leave the reader guessing, so
 * they step aside for something that names the directory we looked in.
 */
function renderAvailability(sources) {
  const missing = sources.length > 0 && !sources.some((source) => source.available);
  state.noData = missing;
  const notice = byId('no-data');
  if (notice) notice.hidden = !missing;
  for (const id of ['live-panel', 'recent-panel']) {
    const panel = byId(id);
    if (panel) panel.hidden = missing;
  }
  // The strip has its own reason to be hidden, so it is told rather than set here.
  renderLimits();
}

async function pollLimits() {
  try {
    state.limits = await getJson('/api/limits');
  } catch {
    // The session poll owns the connection indicator. A strip that keeps showing the
    // last reading says less that is wrong than one that vanishes on a single miss.
    return;
  }
  renderLimits();
}

/**
 * Whether a session poll is still out, and whether the window changed while it was.
 *
 * Ordering by tokens makes the server read every transcript in the window, and a
 * first, cold read of a wide one can outlast the two seconds until the next tick.
 * A tick that lands on a busy poll is dropped outright — the answer it would fetch
 * is two seconds away anyway. A change of window is not droppable: what is on the
 * wire answers the question the reader has already moved on from.
 */
let polling = false;
let queued = false;

async function pollSessions() {
  if (polling) return;
  polling = true;
  try {
    await fetchSessions();
  } finally {
    polling = false;
    if (queued) {
      queued = false;
      void pollSessions();
    }
  }
}

/** The window or the ordering changed, so the rows on screen are for the old one. */
function refetchSessions() {
  queued = polling;
  if (!polling) void pollSessions();
}

/**
 * The window as query parameters. Epoch milliseconds rather than dates, because
 * only the browser knows which midnight the reader means.
 */
function sessionsQuery() {
  const params = new URLSearchParams({ limit: String(state.limit) });
  const { since, until } = (RANGES[state.range] ?? RANGES.all)();
  if (since !== undefined) params.set('since', String(since));
  if (until !== undefined) params.set('until', String(until));
  if (state.sort !== 'recent') params.set('sort', state.sort);
  return params;
}

async function fetchSessions() {
  let result;
  try {
    result = await getJson(`/api/sessions?${sessionsQuery()}`);
  } catch (error) {
    state.failures += 1;
    setLiveState('bad');
    // One miss is a blip — a poll that landed mid-restart, a sleeping laptop. Two
    // in a row means the server is gone, and every number on the page is stale.
    if (state.failures > 1) showBanner(error);
    return;
  }

  state.failures = 0;
  hideBanner();

  const sessions = result.sessions ?? [];
  // The server never truncates running sessions, so this split is also the split
  // between "a process is alive" and "all that is left is a transcript".
  state.live = sessions.filter((session) => session.live);
  state.recent = sessions.filter((session) => !session.live);
  state.total = result.total ?? sessions.length;

  setLiveState('ok');
  render();
  // A session that ended while the panel was open should stop claiming it is busy.
  if (state.openId) syncPanelStatus();
}

function showBanner(error) {
  const banner = byId('banner');
  if (!banner || !banner.hidden) return;
  banner.hidden = false;
  setText('banner-text', 'Lost contact with the tracker — everything below is frozen.');
  setText('banner-hint', `Still retrying every ${SESSIONS_INTERVAL_MS / 1000}s · ${error.message}`);
}

function hideBanner() {
  const banner = byId('banner');
  // Guarded so a healthy poll every two seconds is not also a DOM write every two.
  if (banner && !banner.hidden) banner.hidden = true;
}

/* ------------------------------------------------------------------ views */

/**
 * A table that keeps one `<tr>` per session across polls.
 *
 * Rebuilding the rows every two seconds would drop text selection and make the
 * page flicker, so rows are reused and simply re-appended in the new order —
 * `appendChild` moves an existing node rather than copying it.
 */
function createTable({ body, wrap, empty, count, columns, fill, emptyText }) {
  const rows = new Map();

  return function update(sessions, note) {
    setText(count, note);
    wrap.hidden = sessions.length === 0;
    empty.hidden = sessions.length > 0;

    if (sessions.length === 0) {
      empty.textContent = emptyText();
      for (const row of rows.values()) row.remove();
      rows.clear();
      return;
    }

    const seen = new Set();
    let previous = null;
    for (const session of sessions) {
      seen.add(session.id);
      let row = rows.get(session.id);
      if (!row) {
        row = document.createElement('tr');
        row.dataset.id = session.id;
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', `Open session details`);
        row.innerHTML = columns;
        rows.set(session.id, row);
      }
      row.classList.toggle('is-open', session.id === state.openId);
      fill(cellSetter(row), session, row);

      // Only touch the DOM when the order actually changed. Re-appending every row
      // would be correct but costs 800 moves a poll once the whole list is loaded.
      const anchor = previous ? previous.nextSibling : body.firstChild;
      if (row !== anchor) body.insertBefore(row, anchor);
      previous = row;
    }

    for (const [id, row] of rows) {
      if (seen.has(id)) continue;
      row.remove();
      rows.delete(id);
    }
  };
}

/** Writes a cell only when it changed, so untouched text keeps its selection. */
function cellSetter(row) {
  return (selector, value, title) => {
    const node = row.querySelector(selector);
    if (!node) return;
    const text = value ?? '—';
    if (node.textContent !== text) node.textContent = text;

    if (title === undefined) return;
    if (title) node.setAttribute('title', title);
    else node.removeAttribute('title');
  };
}

const PROJECT_CELL = `<td class="project"><span class="project-name"></span><span class="project-path mono"></span></td>`;
const SESSION_CELL = `<td class="session"><span class="session-title"></span><span class="session-sub"></span></td>`;

function fillShared(set, session) {
  set('.project-name', session.project.name);
  set('.project-path', session.project.path, session.project.path);
  set('.session-title', headline(session), headline(session));
}

/** The token cell, tinted by how much of the model's context window went into it. */
function fillTokens(set, session, row) {
  set('.tokens', formatTokens(session.tokens), tokensTitle(session.tokens, session.contextWindow));
  markUsage(row.querySelector('.tokens'), session.tokens, session.contextWindow);
}

const liveTable = createTable({
  body: byId('live-body'),
  wrap: byId('live-wrap'),
  empty: byId('live-empty'),
  count: 'live-count',
  emptyText: () =>
    state.query ? 'No running session matches the filter.' : 'No Claude Code sessions running right now.',
  columns: `
    ${PROJECT_CELL}
    ${SESSION_CELL}
    <td><span class="badge"><span class="badge-dot"></span><span class="badge-text"></span></span><span class="waiting-for"></span></td>
    <td class="mono model"></td>
    <td class="num tokens"></td>
    <td class="num uptime"></td>`,
  fill: (set, session, row) => {
    fillShared(set, session);
    set('.session-sub', session.name ?? session.id.slice(0, 8));
    set('.badge-text', STATUS_LABELS[session.status] ?? session.status);
    row.querySelector('.badge')?.setAttribute('data-status', session.status);
    set('.waiting-for', session.waitingFor ?? '');
    set('.model', shortModel(session.model));
    fillTokens(set, session, row);
    set('.uptime', formatUptime(session.startedAt));
  },
});

const recentTable = createTable({
  body: byId('recent-body'),
  wrap: byId('recent-wrap'),
  empty: byId('recent-empty'),
  count: 'recent-count',
  emptyText: () =>
    state.query ? 'Nothing matches the filter.'
    : state.range === 'all' ? 'No transcripts found yet.'
    : 'No sessions in this date range.',
  columns: `
    ${PROJECT_CELL}
    ${SESSION_CELL}
    <td class="mono model"></td>
    <td class="num when"></td>
    <td class="num tokens"></td>`,
  fill: (set, session, row) => {
    fillShared(set, session);
    const sub = session.lastPrompt ?? session.firstPrompt ?? '';
    set('.session-sub', sub, sub);
    set('.model', shortModel(session.model));
    set('.when', formatWhen(session.lastActiveAt), new Date(session.lastActiveAt).toLocaleString());
    fillTokens(set, session, row);
  },
});

function render() {
  // Only the Recent half takes the range and the ordering. A running session is the
  // point of the tool, so it is shown whatever window is on screen, and busy-first is
  // the only order that makes sense for a table you are watching rather than reading.
  const live = state.live.filter(matchesQuery).sort(byStatusThenProject);
  const recent = state.recent
    .filter(matchesQuery)
    .sort(RECENT_ORDERS[state.sort] ?? RECENT_ORDERS.recent);

  liveTable(live, live.length ? String(live.length) : '');
  recentTable(recent, recent.length ? String(recent.length) : '');
  renderMore(live.length + recent.length);
  renderHint(live.length + recent.length);
}

function renderMore(shown) {
  const more = byId('more');
  const shownAll = state.live.length + state.recent.length;
  // "More" is about what the server is holding back, not about the filter. Coming
  // back with fewer rows than we asked for means there is nothing left to ask for —
  // which is also what happens when a transcript counted on disk cannot be read.
  const canGrow = shownAll >= state.limit && shownAll < state.total && state.limit < MAX_LIMIT;

  if (more) more.hidden = !canGrow;
  if (!canGrow) return;
  const scope = state.range === 'all' ? 'on disk' : 'in range';
  setText(
    'more-note',
    `${shownAll} of ${state.total} ${scope}${shown === shownAll ? '' : ` · ${shown} shown`}`,
  );
}

function renderHint(shown) {
  const total = state.live.length + state.recent.length;
  setText('search-hint', state.query ? `${shown} of ${total} match “${state.query}”` : '');
}

/* ----------------------------------------------------------- usage limits */

/**
 * Claude Code's two limits, drawn side by side above the tables.
 *
 * Neither ceiling is enforced anywhere we can read — both are enforced server-side
 * and the only trace either leaves in a transcript is a turn it refused — so there
 * is no true percentage to show for either. What each bar measures against is the
 * heaviest window this machine has already put through on that clock, and the note
 * under it says so plainly rather than letting a percentage imply a number nobody has.
 */
const LIMIT_CARDS = [
  { id: 'limit-session', key: 'session' },
  { id: 'limit-weekly', key: 'weekly' },
];

function renderLimits() {
  const panel = byId('limits-panel');
  if (!panel) return;

  const limits = state.limits;
  panel.hidden = state.noData || !limits;
  if (panel.hidden) return;

  for (const { id, key } of LIMIT_CARDS) renderLimitCard(byId(id), limits[key]);
}

/**
 * One limit's card. Both are the same shape, which is why they are one function:
 * a week and five hours differ in how their edges are found, not in what is shown.
 */
function renderLimitCard(card, limit) {
  if (!card) return;
  // A server too old to measure this limit leaves the card off rather than drawing
  // an empty one beside a full one.
  card.hidden = !limit;
  if (!limit) return;

  const current = currentWindow(limit);
  const share = limitShare(limit, current);

  setField(card, 'window', current ? windowRange(limit, current) : '');
  setField(card, 'reset', current ? resetLine(limit, current) : '');

  const bar = field(card, 'bar');
  const fill = field(card, 'fill');
  if (bar) bar.hidden = share === undefined;
  if (fill && share !== undefined) {
    // Past the yardstick the bar simply reads full, and its colour says so — there
    // is no more room to draw a window that broke the record it is measured against.
    fill.style.width = `${Math.min(100, share * 100)}%`;
    fill.setAttribute('data-usage', limitLevel(share));
  }

  const stats = field(card, 'stats');
  if (stats) stats.hidden = !current;
  if (current) setField(card, 'used', formatCompactCount(billedTokens(current.tokens)));

  setField(card, 'note', limitNote(limit, current, share));
}

/** A part of one card, by role. The two cards are identical, so ids would collide. */
function field(card, role) {
  return card.querySelector(`[data-role="${role}"]`);
}

const setField = (card, role, value) => {
  const node = field(card, role);
  if (node) node.textContent = value;
};

/**
 * The window in progress, or nothing once it has emptied.
 *
 * The server settles this too, but only every fifteen seconds, and a strip that
 * outlives its own window is a strip telling the reader something false. A rolling
 * week is the exception: it ends at the instant it was measured and slides with the
 * clock, so only a real reset can retire one between polls.
 */
function currentWindow(limit) {
  const current = limit?.current;
  if (!current) return undefined;
  if (limit.clock === 'rolling') return current;
  return current.resetsAt > Date.now() ? current : undefined;
}

/** The window's two ends, at the coarseness its length deserves. */
function windowRange(limit, current) {
  if (limit.clock === 'rolling') return `${formatDay(current.startedAt)} → now`;
  if (limit.windowMs > DAY_MS) {
    return `${formatDay(current.startedAt)} → ${formatDay(current.resetsAt)}`;
  }
  return `${formatClock(current.startedAt)} → ${formatClock(current.resetsAt)}`;
}

/** When it empties and how long that is — or, for a rolling week, that it does not. */
function resetLine(limit, current) {
  // A rolling week ends at the instant it was measured, so there is no reset to name.
  if (limit.clock === 'rolling') return 'Rolling seven days · no reset reported';
  const when = limit.windowMs > DAY_MS ? formatDayClock(current.resetsAt) : formatClock(current.resetsAt);
  return `Resets ${when} · ${formatClockSpan(current.resetsAt - Date.now())} left`;
}

/** How full the window in progress is, against the heaviest one on record. */
function limitShare(limit, current) {
  const used = billedTokens(current?.tokens);
  const ceiling = billedTokens(limit.reference?.tokens);
  return used && ceiling ? used / ceiling : undefined;
}

/**
 * Input, output and newly-cached tokens — how a window is sized.
 *
 * Mirrors `billedTokens` in `limits.ts`; the number on screen and the number the
 * server ranked windows by have to be the same one. Cache reads are left out
 * because they cost a fraction as much and outweigh the rest fifty to one.
 */
function billedTokens(tokens) {
  return tokens ? tokens.input + tokens.output + tokens.cacheCreate : 0;
}

/**
 * The same four-step scale the token cells use, against a limit rather than a
 * context window — so the steps are halves and quarters rather than tenths.
 */
function limitLevel(share) {
  if (share >= 0.9) return 'bad';
  if (share >= 0.75) return 'hot';
  if (share >= 0.5) return 'warn';
  return 'ok';
}

/**
 * One line saying what the bar is a share of.
 *
 * The real ceiling is enforced server-side and never written to disk, so the only
 * honest denominator is the heaviest window this machine has already put through —
 * which the reader has to be told, or the percentage reads as a quota it is not.
 * Everything past that sentence is detail the card is better off without.
 */
function limitNote(limit, current, share) {
  const week = limit.windowMs > DAY_MS;
  const span = week ? 'week' : 'five-hour window';
  // Only worth saying when it is true: an anchored week names its own reset above.
  const guess = week && limit.clock === 'rolling' ? ' No reset reported, so it is counted back from now.' : '';

  if (!current) {
    return week ? 'Nothing billed this week.' : 'No window open — the next prompt starts one.';
  }
  if (share === undefined) {
    return `No earlier ${span} in ${limit.historyDays} days to measure against.${guess}`;
  }

  const heaviest = formatCompactCount(billedTokens(limit.reference.tokens));
  // The weekly bar Claude bills every model against, not one model's own week.
  const scope = week ? 'Every model, against' : 'Against';
  return `${scope} your heaviest ${span} in ${limit.historyDays} days — ${heaviest}.${guess}`;
}

/* --------------------------------------------------------------- filtering */

function matchesQuery(session) {
  if (!state.query) return true;
  return haystack(session).includes(state.query);
}

/** Built per call rather than cached: sessions are replaced wholesale on every poll. */
function haystack(session) {
  return [
    session.project.name,
    session.project.path,
    session.project.gitBranch,
    session.title,
    session.name,
    session.lastPrompt,
    session.firstPrompt,
    session.model,
    session.status,
    session.id,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function byStatusThenProject(a, b) {
  return (
    (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
    a.project.name.localeCompare(b.project.name) ||
    a.startedAt - b.startedAt
  );
}

/* --------------------------------------------------------------- formatting */

/** What this session was about, in one line, best available first. */
function headline(session) {
  return session.title ?? session.firstPrompt ?? session.lastPrompt ?? session.id.slice(0, 8);
}

/** `claude-opus-5` reads as `opus-5`; the vendor half is the same on every row. */
function shortModel(model) {
  return model ? model.replace(/^claude-/, '') : undefined;
}

/** Compact and stable in width: `4d 2h`, `2h 07m`, `9m 12s`, `41s`. */
function formatUptime(startedAt) {
  return startedAt ? formatClockSpan(Date.now() - startedAt) : '—';
}

/** The same shape for a span handed over rather than measured from a start — the
 *  countdown to a window's reset, which runs the other way. */
function formatClockSpan(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** How long ago, in one short phrase. Coarse on purpose: `3d ago`, not `3d 04h`. */
function formatAgo(at) {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Relative while it is still news, then a plain date — a week of `d ago` is enough. */
function formatWhen(at) {
  if (!at) return '—';
  if (Date.now() - at < 7 * 86400_000) return formatAgo(at);

  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Clock time alone: a window's start and its reset are both today or tomorrow. */
function formatClock(at) {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** `19 Aug` — enough to place a window in the week behind you. */
function formatDay(at) {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** `Tue 19 Aug, 3:00 AM` — a reset days out needs the day as well as the hour. */
function formatDayClock(at) {
  return new Date(at).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Local midnight, `daysAgo` days back. */
function startOfDay(daysAgo) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.getTime();
}

/**
 * The custom range, read from the two date fields.
 *
 * Both ends are whole days and both are inclusive — the same date twice means that
 * one day — and either may be left empty for an end that stays open.
 */
function customRange() {
  let from = dayStart(state.from);
  let to = dayStart(state.to);
  // A backwards range is a slip of the picker, not a request for nothing.
  if (from !== undefined && to !== undefined && from > to) [from, to] = [to, from];

  return {
    ...(from === undefined ? {} : { since: from }),
    ...(to === undefined ? {} : { until: startOfNextDay(to) }),
  };
}

/** Local midnight on a `YYYY-MM-DD`. `new Date(iso)` would read it as UTC and slip a day. */
function dayStart(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!match) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

/** The far end of an inclusive day, which is the exclusive start of the next one. */
function startOfNextDay(at) {
  const date = new Date(at);
  date.setDate(date.getDate() + 1);
  return date.getTime();
}

/** What the token column adds up, so the column and the ordering never disagree. */
function totalTokens(session) {
  return session.tokens ? session.tokens.input + session.tokens.output : 0;
}

/** Thousands separators, in the reader's own locale. */
function formatCount(value) {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

/** `12.3K`, `4.1M` — a table cell has no room for a comma-grouped count. */
function formatCompactCount(value) {
  return compactCountFormat.format(value);
}
const compactCountFormat = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** One cell for all three totals, since a row has room for a phrase but not three columns. */
function formatTokens(tokens) {
  if (!tokens) return '—';
  const total = tokens.input + tokens.output;
  if (!total) return '—';
  return `${formatCompactCount(tokens.input)} / ${formatCompactCount(tokens.output)} / ${formatCompactCount(total)}`;
}

/** The exact counts the compact cell rounds away, for a reader who hovers. */
function tokensTitle(tokens, contextWindow) {
  if (!tokens) return undefined;
  const total = tokens.input + tokens.output;
  if (!total) return undefined;
  const counts = `Input ${formatCount(tokens.input)} · Output ${formatCount(tokens.output)} · Total ${formatCount(total)}`;
  // The colour on the cell is a share of something the cell never names, so the
  // hover says what it is a share of.
  const share = shareOfWindow(total, contextWindow);
  return share ? `${counts} · ${share}` : counts;
}

/** `27% of the 1M window` — what a colour means, for whoever hovers to ask. */
function shareOfWindow(total, contextWindow) {
  if (!contextWindow || !total) return undefined;
  return `${formatShare(total / contextWindow)} of the ${formatCompactCount(contextWindow)} window`;
}

/**
 * Where a token total falls on the four-step usage scale, or `undefined` when there
 * is nothing to place: no tokens yet, or a model whose window we do not know.
 *
 * The share is of the model's context window — so the same 140K reads as heavy on a
 * 200K model and light on a 1M one. Every token total on the page is ranked by this
 * one function, whether it is a whole session or a single prompt inside one.
 */
function usageLevel(tokens, contextWindow) {
  const total = tokens ? tokens.input + tokens.output : 0;
  if (!contextWindow || !total) return undefined;

  const share = total / contextWindow;
  if (share >= 0.2) return 'bad';
  if (share >= 0.15) return 'hot';
  if (share >= 0.1) return 'warn';
  return 'ok';
}

/** Tints one element by the share of the window its total came to. */
function markUsage(node, tokens, contextWindow) {
  if (!node) return;
  const level = usageLevel(tokens, contextWindow);
  if (level) node.setAttribute('data-usage', level);
  else node.removeAttribute('data-usage');
}

/**
 * A share as a whole percent, except near zero, where `0%` would read as none at all.
 *
 * Rounded down, not to nearest, so the number stays on the same side of the colour
 * thresholds as the cell it explains — 19.96% is orange, and must not say `20%`.
 */
function formatShare(share) {
  const percent = share * 100;
  return percent >= 1 ? `${Math.floor(percent)}%` : `${percent.toFixed(1)}%`;
}

/** A duration in prose: `2h 14m`, `9m 12s`, `41s`. Unlike uptime this never ticks. */
function formatSpan(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const seconds = Math.round(ms / 1000);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * An absolute moment, because the panel is where you check exactly when — with the
 * relative half after it, because that is the part you read without doing sums.
 */
function formatStamp(at) {
  return at ? `${new Date(at).toLocaleString()} · ${formatAgo(at)}` : '—';
}

/* ------------------------------------------------------------------- panel */

const drawer = byId('drawer');
const scrim = byId('scrim');

/** The element focus came from, so closing the panel puts it back where it was. */
let returnFocusTo = null;
let detailTimer = null;
/**
 * Which fetch is current. A slow read of a large transcript must not overwrite the
 * panel after the user has already moved to another session.
 */
let detailRequest = 0;

function openPanel(id, source) {
  if (!drawer) return;
  returnFocusTo = source ?? null;
  state.openId = id;
  state.detail = null;

  drawer.hidden = false;
  if (scrim) scrim.hidden = false;
  document.body.classList.add('drawer-open');

  // Show what the list already knows so the panel is never blank while it loads.
  const known = [...state.live, ...state.recent].find((session) => session.id === id);
  setText('drawer-title', known ? headline(known) : 'Session');
  setText('drawer-project', known ? known.project.name : '—');

  byId('drawer-content').hidden = true;
  byId('drawer-error').hidden = true;
  byId('drawer-loading').hidden = false;
  byId('drawer-body').scrollTop = 0;
  byId('drawer-close')?.focus();

  render();
  loadDetail();
  restartDetailTimer();
}

function closePanel() {
  if (!drawer || drawer.hidden) return;
  drawer.hidden = true;
  if (scrim) scrim.hidden = true;
  document.body.classList.remove('drawer-open');
  state.openId = null;
  state.detail = null;
  stopDetailTimer();
  render();

  // Only take focus back if it is still inside the panel; the user may have clicked away.
  if (returnFocusTo?.isConnected) returnFocusTo.focus();
  returnFocusTo = null;
}

function restartDetailTimer() {
  stopDetailTimer();
  detailTimer = setInterval(() => {
    // A finished session's numbers are final. Re-reading it would only re-stream a
    // file that cannot have changed.
    if (state.openId && state.detail?.live) loadDetail();
  }, DETAIL_INTERVAL_MS);
}

function stopDetailTimer() {
  if (detailTimer !== null) clearInterval(detailTimer);
  detailTimer = null;
}

async function loadDetail() {
  const id = state.openId;
  const request = ++detailRequest;

  let detail;
  try {
    detail = await getJson(`/api/sessions/${encodeURIComponent(id)}`);
  } catch (error) {
    if (request !== detailRequest || state.openId !== id) return;
    byId('drawer-loading').hidden = true;
    // A panel already showing numbers keeps them; a failure to refresh is not a reason
    // to throw away what is on screen.
    if (state.detail) return;
    const failed = byId('drawer-error');
    failed.hidden = false;
    failed.textContent = `Could not read this session — ${error.message}`;
    return;
  }

  if (request !== detailRequest || state.openId !== id) return;
  state.detail = detail;
  fillPanel(detail);
}

function fillPanel(detail) {
  byId('drawer-loading').hidden = true;
  byId('drawer-error').hidden = true;
  byId('drawer-content').hidden = false;

  setText('drawer-title', headline(detail));
  setText('drawer-project', detail.project.name);
  syncPanelStatus();

  const summary = byId('d-summary');
  summary.hidden = !detail.awaySummary;
  if (detail.awaySummary) summary.textContent = detail.awaySummary;

  setText('d-in', formatCount(detail.tokens.input));
  setText('d-out', formatCount(detail.tokens.output));
  fillTotal(detail);
  setText('d-cache-read', formatCount(detail.tokens.cacheRead));
  setText('d-cache-create', formatCount(detail.tokens.cacheCreate));

  fillContext(detail.context, detail.model);
  fillPromptUsage(detail.promptUsage, detail.contextWindow);

  setText('d-models', detail.models.map(shortModel).join(', ') || shortModel(detail.model) || '—');
  setText('d-started', formatStamp(detail.startedAt));
  setText('d-last', formatStamp(detail.lastActiveAt));
  setText('d-elapsed', formatSpan(detail.lastActiveAt - detail.startedAt));
  setText('d-active', detail.activeMs === undefined ? '—' : formatSpan(detail.activeMs));

  fillPrompt('d-prompt-first-wrap', 'd-prompt-first', detail.firstPrompt);
  fillPrompt('d-prompt-last-wrap', 'd-prompt-last', detail.lastPrompt);
  byId('d-prompts-section').hidden = !detail.firstPrompt && !detail.lastPrompt;
}

/** The one number the list's token column colours, repeated here with its colour. */
function fillTotal(detail) {
  const total = detail.tokens.input + detail.tokens.output;
  const node = byId('d-total');
  if (!node) return;

  node.textContent = formatCount(total);
  markUsage(node, detail.tokens, detail.contextWindow);
  const share = shareOfWindow(total, detail.contextWindow);
  if (share) node.title = share;
  else node.removeAttribute('title');
}

/**
 * A snapshot of how full the window is right now — unlike the Tokens section above
 * it, which sums every turn the session ever billed for.
 */
function fillContext(context, model) {
  const section = byId('d-context-section');
  if (!section) return;

  section.hidden = !context;
  if (!context) return;

  const { staticTokens, conversationTokens, windowTokens, freeTokens } = context;
  setText('d-context-static', formatCount(staticTokens));
  setText('d-context-convo', formatCount(conversationTokens));

  const known = windowTokens !== undefined;
  byId('d-context-bar').hidden = !known;
  byId('d-context-free-row').hidden = !known;

  if (!known) {
    setText('d-context-note', `Context window size unknown for ${shortModel(model) ?? 'this model'}.`);
    return;
  }

  const current = staticTokens + conversationTokens;
  const widthPct = (value) => `${Math.min(100, (value / windowTokens) * 100)}%`;
  byId('d-context-bar-static').style.width = widthPct(staticTokens);
  byId('d-context-bar-convo').style.width = widthPct(conversationTokens);

  setText('d-context-free', formatCount(freeTokens));
  const usedPct = Math.round((current / windowTokens) * 100);
  setText('d-context-note', `${usedPct}% of ${formatCompactCount(windowTokens)} tokens · ${shortModel(model) ?? 'model'}`);
}

/** Already sorted high to low by the server; the panel just lays it out. */
function fillPromptUsage(promptUsage, contextWindow) {
  const list = byId('d-prompt-usage');
  const section = byId('d-prompt-usage-section');
  if (!list || !section) return;

  const entries = promptUsage ?? [];
  section.hidden = entries.length === 0;
  list.innerHTML = '';

  for (const entry of entries) {
    const item = document.createElement('li');
    item.className = 'prompt-usage-row';

    const text = document.createElement('span');
    text.className = 'prompt-usage-text';
    text.textContent = entry.text;
    text.title = entry.text;

    const tokens = document.createElement('span');
    tokens.className = 'prompt-usage-tokens mono';
    tokens.textContent = formatTokens(entry.tokens);
    // One prompt is measured against the same window as the session it sits in, so a
    // row that ran the window up shows the colour the whole session would.
    markUsage(tokens, entry.tokens, contextWindow);
    const title = tokensTitle(entry.tokens, contextWindow);
    if (title) tokens.title = title;

    item.append(text, tokens);
    list.append(item);
  }
}

/**
 * Status comes from the list poll rather than the detail read, so a running session's
 * badge keeps up between the ten-second re-reads.
 */
function syncPanelStatus() {
  const detail = state.detail;
  if (!detail) return;

  const current = [...state.live, ...state.recent].find((session) => session.id === detail.id);
  const status = current?.status ?? detail.status;
  const waitingFor = current?.waitingFor ?? detail.waitingFor;

  byId('d-badge')?.setAttribute('data-status', status);
  const text = byId('d-badge')?.querySelector('.badge-text');
  if (text) text.textContent = STATUS_LABELS[status] ?? status;
  setText('d-waiting', waitingFor ?? '');
}

function fillPrompt(wrapId, textId, value) {
  const wrap = byId(wrapId);
  wrap.hidden = !value;
  if (value) byId(textId).textContent = value;
}

/* ------------------------------------------------------------------- theme */

const THEME_KEY = 'cst-theme';
const THEME_CHOICES = new Set(['system', 'light', 'dark']);
/** The same query the inline script in the page head consults before first paint. */
const darkMedia = matchMedia('(prefers-color-scheme: dark)');

/**
 * Storage is wrapped because a browser is allowed to refuse it — a private window,
 * a blocked-cookies setting. Losing the preference is survivable; a page that fails
 * to boot over it is not.
 */
function readTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return THEME_CHOICES.has(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function storeTheme(choice) {
  try {
    // Following the OS is the absence of a preference, so it is stored as one.
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Then it lasts for this page view only.
  }
}

function applyTheme(choice) {
  const dark = choice === 'dark' || (choice === 'system' && darkMedia.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === choice));
  }
}

/* ---------------------------------------------------------------- keyboard */

/** Both tables walk as one list, because that is how the page reads. */
function rowsInOrder() {
  return [...document.querySelectorAll('#live-body tr[data-id], #recent-body tr[data-id]')];
}

/** `step` is a signed offset, or `'first'` / `'last'`. */
function moveRowFocus(from, step) {
  const rows = rowsInOrder();
  if (rows.length === 0) return;

  const at = from ? rows.indexOf(from) : -1;
  const next =
    step === 'first' ? 0
    : step === 'last' ? rows.length - 1
    // Arriving from outside the table lands on the first row rather than the second.
    : at === -1 ? 0
    : Math.min(rows.length - 1, Math.max(0, at + step));

  rows[next]?.focus();
}

function isTyping(target) {
  return target instanceof HTMLElement && target.matches('input, textarea, select');
}

/* ------------------------------------------------------------------ wiring */

/** Everything about the view that survives a reload, taken from the query string. */
function readView() {
  const params = new URLSearchParams(location.search);
  const limit = Number.parseInt(params.get('limit') ?? '', 10);
  const range = params.get('range');
  const sort = params.get('sort');

  return {
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
    // A hand-edited or stale parameter falls back rather than leaving the page in a
    // state its own controls cannot show.
    range: range !== null && Object.hasOwn(RANGES, range) ? range : DEFAULT_VIEW.range,
    from: params.get('from') ?? DEFAULT_VIEW.from,
    to: params.get('to') ?? DEFAULT_VIEW.to,
    sort: sort !== null && Object.hasOwn(RECENT_ORDERS, sort) ? sort : DEFAULT_VIEW.sort,
  };
}

/**
 * Mirror the view into the address bar, so a reload — or a bookmark, or a link to a
 * colleague on the same machine — comes back to the same stretch of history.
 *
 * Defaults are dropped rather than spelled out, which keeps a plain visit to
 * `http://127.0.0.1:3099/` plain. Replace rather than push: paging deeper and
 * narrowing a range are not places you want the back button to walk through.
 */
function syncUrl() {
  const url = new URL(location.href);
  const set = (key, value, fallback) => {
    if (value === fallback) url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  };

  set('limit', state.limit, DEFAULT_LIMIT);
  for (const [key, fallback] of Object.entries(DEFAULT_VIEW)) set(key, state[key], fallback);
  history.replaceState(null, '', url);
}

function setLimit(limit) {
  state.limit = Math.min(limit, MAX_LIMIT);
  syncUrl();
  refetchSessions();
}

const rangeSelect = byId('range');
const sortSelect = byId('sort');
const fromInput = byId('range-from');
const toInput = byId('range-to');

const resetButton = byId('reset');

/** Whether the Recent controls are all still where they started. */
function isDefaultView() {
  return Object.entries(DEFAULT_VIEW).every(([key, value]) => state[key] === value);
}

/**
 * The parts of the picker that come and go: the two date fields, which belong to
 * Custom alone, and Reset, which only appears once there is something to undo — a
 * control that would do nothing is one more thing to read past.
 */
function renderFilters() {
  const custom = state.range === 'custom';
  const from = byId('from-field');
  const to = byId('to-field');
  if (from) from.hidden = !custom;
  if (to) to.hidden = !custom;
  if (resetButton) resetButton.hidden = isDefaultView();
}

/** Push the state back into the controls, for a first paint and for Reset. */
function syncControls() {
  if (rangeSelect) rangeSelect.value = state.range;
  if (sortSelect) sortSelect.value = state.sort;
  if (fromInput) fromInput.value = state.from;
  if (toInput) toInput.value = state.to;
  renderFilters();
}

/** One control moved: mirror it, redraw the picker around it, and go and ask again. */
function applyFilters() {
  renderFilters();
  syncUrl();
  // Redraw from what is already here so the table answers the click rather than the
  // round trip; the fetch is what widens the window past the rows already on screen.
  render();
  refetchSessions();
}

rangeSelect?.addEventListener('change', () => {
  state.range = rangeSelect.value;
  applyFilters();
});

sortSelect?.addEventListener('change', () => {
  state.sort = sortSelect.value;
  applyFilters();
});

for (const [input, key] of [[fromInput, 'from'], [toInput, 'to']]) {
  input?.addEventListener('change', () => {
    state[key] = input.value;
    applyFilters();
  });
}

// Only the range and the ordering. The text filter above the tables is its own
// control, with its own Escape, and it narrows the Active table too — folding it in
// here would make one button reach outside the panel it sits in. `limit` stays as
// well: how deep you have paged is not something you set and then have to undo.
resetButton?.addEventListener('click', () => {
  Object.assign(state, DEFAULT_VIEW);
  syncControls();
  syncUrl();
  render();
  refetchSessions();
  // Reset has just hidden itself, so leave focus somewhere that still exists.
  rangeSelect?.focus();
});

const search = byId('search');

search?.addEventListener('input', (event) => {
  state.query = event.target.value.trim().toLowerCase();
  render();
});

search?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && search.value) {
    // Clearing beats closing: a type-ahead you cannot undo with Escape is a trap.
    event.stopPropagation();
    search.value = '';
    state.query = '';
    render();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'Enter') {
    event.preventDefault();
    moveRowFocus(null, 'first');
  }
});

byId('more-button')?.addEventListener('click', () => setLimit(state.limit * 4));

// One listener per table rather than per row: rows come and go on every poll.
for (const body of [byId('live-body'), byId('recent-body')]) {
  body?.addEventListener('click', (event) => {
    // Let a link or a button inside a row do its own job.
    if (event.target.closest('button, a')) return;
    const row = event.target.closest('tr[data-id]');
    if (row) openPanel(row.dataset.id, row);
  });

  body?.addEventListener('keydown', (event) => {
    const row = event.target.closest('tr[data-id]');
    if (!row) return;

    if (event.key === 'Enter' || event.key === ' ') {
      // Space scrolls the page by default, which is not what a pressed row should do.
      event.preventDefault();
      openPanel(row.dataset.id, row);
      return;
    }

    const step = ROW_STEPS[event.key];
    if (step === undefined) return;
    // Arrows would scroll the table instead; the browser catches up as focus moves.
    event.preventDefault();
    moveRowFocus(row, step);
  });
}

byId('drawer-close')?.addEventListener('click', closePanel);
byId('scrim')?.addEventListener('click', closePanel);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.openId) {
    closePanel();
    return;
  }

  // The panel is modal, so a shortcut that jumps behind it would be a broken promise.
  if (state.openId || isTyping(event.target)) return;

  if (event.key === '/') {
    event.preventDefault();
    search?.focus();
    search?.select();
  }
});

/**
 * Keep Tab inside the panel while it is open.
 *
 * It is `aria-modal`, so letting focus wander into the table behind it would be a
 * promise the page does not keep.
 */
byId('drawer')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const focusable = [...byId('drawer').querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  }
});

for (const button of document.querySelectorAll('[data-theme-choice]')) {
  button.addEventListener('click', () => {
    const choice = button.dataset.themeChoice;
    storeTheme(choice);
    applyTheme(choice);
  });
}

// Only meaningful while following the OS, but the listener costs nothing either way.
darkMedia.addEventListener('change', () => {
  if (readTheme() === 'system') applyTheme('system');
});

applyTheme(readTheme());
// The controls follow the state rather than the other way round, so a reload with
// `?range=7d&sort=tokens-desc` opens with the picker already saying so.
syncControls();

pollHealth();
pollSessions();
pollLimits();
setInterval(pollHealth, HEALTH_INTERVAL_MS);
setInterval(pollSessions, SESSIONS_INTERVAL_MS);
setInterval(pollLimits, LIMITS_INTERVAL_MS);
setInterval(() => {
  // The clock, not the data — redrawing between polls keeps uptimes honest.
  for (const session of state.live) {
    const cell = document.querySelector(`#live-body tr[data-id="${session.id}"] .uptime`);
    if (cell) cell.textContent = formatUptime(session.startedAt);
  }
  // Same reason, and it is also what retires a window the moment it empties rather
  // than up to fifteen seconds later.
  renderLimits();
}, TICK_MS);
