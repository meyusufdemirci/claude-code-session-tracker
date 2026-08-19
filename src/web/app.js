/** How often we ask the server for the session list. Phase 5 may replace this with SSE. */
const SESSIONS_INTERVAL_MS = 2000;
const HEALTH_INTERVAL_MS = 15000;
/** Uptime is redrawn on its own beat so the clock ticks between polls. */
const TICK_MS = 1000;

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

const state = {
  live: [],
  recent: [],
  /** Sessions on disk, which is more than we asked for whenever `limit` bites. */
  total: 0,
  query: '',
  limit: readLimit(),
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

function setHealthState(tone, message) {
  document.querySelector('#health .dot')?.setAttribute('data-state', tone);
  setText('health-text', message);
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
  const notice = byId('no-data');
  if (notice) notice.hidden = !missing;
  for (const id of ['live-panel', 'recent-panel']) {
    const panel = byId(id);
    if (panel) panel.hidden = missing;
  }
}

async function pollSessions() {
  let result;
  try {
    result = await getJson(`/api/sessions?limit=${state.limit}`);
  } catch (error) {
    state.failures += 1;
    setHealthState('bad', `disconnected · ${error.message}`);
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

  setHealthState('ok', `connected · ${state.live.length} running`);
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
    set('.tokens', formatTokens(session.tokens), tokensTitle(session.tokens));
    set('.uptime', formatUptime(session.startedAt));
  },
});

const recentTable = createTable({
  body: byId('recent-body'),
  wrap: byId('recent-wrap'),
  empty: byId('recent-empty'),
  count: 'recent-count',
  emptyText: () => (state.query ? 'Nothing matches the filter.' : 'No transcripts found yet.'),
  columns: `
    ${PROJECT_CELL}
    ${SESSION_CELL}
    <td class="mono model"></td>
    <td class="num when"></td>
    <td class="num tokens"></td>`,
  fill: (set, session) => {
    fillShared(set, session);
    const sub = session.lastPrompt ?? session.firstPrompt ?? '';
    set('.session-sub', sub, sub);
    set('.model', shortModel(session.model));
    set('.when', formatWhen(session.lastActiveAt), new Date(session.lastActiveAt).toLocaleString());
    set('.tokens', formatTokens(session.tokens), tokensTitle(session.tokens));
  },
});

function render() {
  const live = state.live.filter(matchesQuery).sort(byStatusThenProject);
  const recent = state.recent.filter(matchesQuery).sort((a, b) => b.lastActiveAt - a.lastActiveAt);

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
  setText('more-note', `${shownAll} of ${state.total} on disk${shown === shownAll ? '' : ` · ${shown} shown`}`);
}

function renderHint(shown) {
  const total = state.live.length + state.recent.length;
  setText('search-hint', state.query ? `${shown} of ${total} match “${state.query}”` : '');
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
  if (!startedAt) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
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
function tokensTitle(tokens) {
  if (!tokens) return undefined;
  const total = tokens.input + tokens.output;
  if (!total) return undefined;
  return `Input ${formatCount(tokens.input)} · Output ${formatCount(tokens.output)} · Total ${formatCount(total)}`;
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
  setText('d-cache-read', formatCount(detail.tokens.cacheRead));
  setText('d-cache-create', formatCount(detail.tokens.cacheCreate));

  fillPromptUsage(detail.promptUsage);

  setText('d-models', detail.models.map(shortModel).join(', ') || shortModel(detail.model) || '—');
  setText('d-started', formatStamp(detail.startedAt));
  setText('d-last', formatStamp(detail.lastActiveAt));
  setText('d-elapsed', formatSpan(detail.lastActiveAt - detail.startedAt));
  setText('d-active', detail.activeMs === undefined ? '—' : formatSpan(detail.activeMs));

  fillPrompt('d-prompt-first-wrap', 'd-prompt-first', detail.firstPrompt);
  fillPrompt('d-prompt-last-wrap', 'd-prompt-last', detail.lastPrompt);
  byId('d-prompts-section').hidden = !detail.firstPrompt && !detail.lastPrompt;
}

/** Already sorted high to low by the server; the panel just lays it out. */
function fillPromptUsage(promptUsage) {
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
    const title = tokensTitle(entry.tokens);
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

function readLimit() {
  const raw = Number.parseInt(new URLSearchParams(location.search).get('limit') ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_LIMIT) : DEFAULT_LIMIT;
}

function setLimit(limit) {
  state.limit = Math.min(limit, MAX_LIMIT);
  const url = new URL(location.href);
  url.searchParams.set('limit', String(state.limit));
  // Replace rather than push: paging deeper is not a place you want to go back to.
  history.replaceState(null, '', url);
  pollSessions();
}

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
pollHealth();
pollSessions();
setInterval(pollHealth, HEALTH_INTERVAL_MS);
setInterval(pollSessions, SESSIONS_INTERVAL_MS);
setInterval(() => {
  // The clock, not the data — redrawing between polls keeps uptimes honest.
  for (const session of state.live) {
    const cell = document.querySelector(`#live-body tr[data-id="${session.id}"] .uptime`);
    if (cell) cell.textContent = formatUptime(session.startedAt);
  }
}, TICK_MS);
