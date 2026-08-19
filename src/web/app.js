/** How often we ask the server for the session list. Phase 5 may replace this with SSE. */
const SESSIONS_INTERVAL_MS = 2000;
const HEALTH_INTERVAL_MS = 15000;
/** Uptime is redrawn on its own beat so the clock ticks between polls. */
const TICK_MS = 1000;

const DEFAULT_LIMIT = 50;
/** Matches the server's ceiling; asking for more just gets clamped. */
const MAX_LIMIT = 2000;

const STATUS_LABELS = { busy: 'busy', waiting: 'waiting', idle: 'idle', ended: 'ended' };
/** Busy first, then anything needing a human, then the quiet ones. */
const STATUS_RANK = { busy: 0, waiting: 1, idle: 2, ended: 3 };

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
};

async function getJson(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/* ---------------------------------------------------------------- polling */

function setHealthState(tone, message) {
  document.querySelector('#health .dot')?.setAttribute('data-state', tone);
  setText('health-text', message);
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
  } catch {
    // The session poll owns the connection indicator; a stale fact panel is harmless.
  }
}

async function pollSessions() {
  let result;
  try {
    result = await getJson(`/api/sessions?limit=${state.limit}`);
  } catch (error) {
    setHealthState('bad', `disconnected · ${error.message}`);
    return;
  }

  const sessions = result.sessions ?? [];
  // The server never truncates running sessions, so this split is also the split
  // between "a process is alive" and "all that is left is a transcript".
  state.live = sessions.filter((session) => session.live);
  state.recent = sessions.filter((session) => !session.live);
  state.total = result.total ?? sessions.length;

  setHealthState('ok', `connected · ${state.live.length} running`);
  render();
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
        row.innerHTML = columns;
        rows.set(session.id, row);
      }
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
  set('.branch', session.project.gitBranch);
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
    <td class="mono branch"></td>
    <td class="num uptime"></td>
    <td class="mono version"></td>
    <td class="num mono pid"></td>`,
  fill: (set, session, row) => {
    fillShared(set, session);
    set('.session-sub', session.name ?? session.id.slice(0, 8));
    set('.badge-text', STATUS_LABELS[session.status] ?? session.status);
    row.querySelector('.badge')?.setAttribute('data-status', session.status);
    set('.waiting-for', session.waitingFor ?? '');
    set('.uptime', formatUptime(session.startedAt));
    set('.version', session.version);
    set('.pid', session.live?.pid ? String(session.live.pid) : undefined);
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
    <td class="mono branch"></td>
    <td class="mono model"></td>
    <td class="num when"></td>
    <td class="num size"></td>`,
  fill: (set, session) => {
    fillShared(set, session);
    const sub = session.lastPrompt ?? session.firstPrompt ?? '';
    set('.session-sub', sub, sub);
    set('.model', shortModel(session.model));
    set('.when', formatWhen(session.lastActiveAt), new Date(session.lastActiveAt).toLocaleString());
    set('.size', formatBytes(session.sizeBytes));
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

/** Relative while it is still news, then a plain date. */
function formatWhen(at) {
  if (!at) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;

  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

function formatBytes(bytes) {
  if (!bytes) return '—';
  const mb = bytes / 1048576;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
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

byId('search')?.addEventListener('input', (event) => {
  state.query = event.target.value.trim().toLowerCase();
  render();
});

byId('more-button')?.addEventListener('click', () => setLimit(state.limit * 4));

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
