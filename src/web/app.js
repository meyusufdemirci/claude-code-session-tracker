/** How often we ask the server for the session list. Phase 5 may replace this with SSE. */
const SESSIONS_INTERVAL_MS = 2000;
const HEALTH_INTERVAL_MS = 15000;
/** Uptime is redrawn on its own beat so the clock ticks between polls. */
const TICK_MS = 1000;

const STATUS_LABELS = { busy: 'busy', waiting: 'waiting', idle: 'idle', ended: 'ended' };
/** Busy first, then anything needing a human, then the quiet ones. */
const STATUS_RANK = { busy: 0, waiting: 1, idle: 2, ended: 3 };

const byId = (id) => document.getElementById(id);
const setText = (id, value) => {
  const node = byId(id);
  if (node) node.textContent = value;
};

let sessions = [];
/** Rows are reused across polls so the table does not flicker every two seconds. */
const rows = new Map();

async function getJson(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function setHealthState(state, message) {
  document.querySelector('#health .dot')?.setAttribute('data-state', state);
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
  try {
    const result = await getJson('/api/sessions');
    sessions = result.sessions ?? [];
    setHealthState('ok', `connected · ${sessions.length} running`);
  } catch (error) {
    setHealthState('bad', `disconnected · ${error.message}`);
    return;
  }
  render();
}

function render() {
  const body = byId('sessions-body');
  const wrap = byId('sessions-wrap');
  const empty = byId('sessions-empty');
  if (!body || !wrap || !empty) return;

  setText('sessions-count', sessions.length ? String(sessions.length) : '');
  wrap.hidden = sessions.length === 0;
  empty.hidden = sessions.length > 0;
  if (!sessions.length) {
    empty.textContent = 'No Claude Code sessions running right now.';
    for (const row of rows.values()) row.remove();
    rows.clear();
    return;
  }

  const ordered = [...sessions].sort(
    (a, b) =>
      (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
      a.project.name.localeCompare(b.project.name) ||
      a.startedAt - b.startedAt,
  );

  const seen = new Set();
  for (const session of ordered) {
    seen.add(session.id);
    let row = rows.get(session.id);
    if (!row) {
      row = createRow();
      rows.set(session.id, row);
    }
    fillRow(row, session);
    // appendChild moves an existing node, which keeps the DOM in sorted order.
    body.appendChild(row);
  }

  for (const [id, row] of rows) {
    if (seen.has(id)) continue;
    row.remove();
    rows.delete(id);
  }
}

function createRow() {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td class="project"><span class="project-name"></span><span class="project-path mono"></span></td>
    <td class="mono session-name"></td>
    <td><span class="badge"><span class="badge-dot"></span><span class="badge-text"></span></span><span class="waiting-for"></span></td>
    <td class="mono branch"></td>
    <td class="num uptime"></td>
    <td class="mono version"></td>
    <td class="num mono pid"></td>`;
  return row;
}

function fillRow(row, session) {
  const set = (selector, value) => {
    const node = row.querySelector(selector);
    if (node && node.textContent !== value) node.textContent = value;
  };

  set('.project-name', session.project.name);
  set('.project-path', session.project.path);
  row.querySelector('.project-path')?.setAttribute('title', session.project.path);

  set('.session-name', session.name ?? session.id.slice(0, 8));
  set('.badge-text', STATUS_LABELS[session.status] ?? session.status);
  row.querySelector('.badge')?.setAttribute('data-status', session.status);
  set('.waiting-for', session.waitingFor ?? '');
  set('.branch', session.project.gitBranch ?? '—');
  set('.uptime', formatUptime(session.startedAt));
  set('.version', session.version ?? '—');
  set('.pid', String(session.live?.pid ?? '—'));
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

pollHealth();
pollSessions();
setInterval(pollHealth, HEALTH_INTERVAL_MS);
setInterval(pollSessions, SESSIONS_INTERVAL_MS);
setInterval(() => {
  for (const session of sessions) {
    const cell = rows.get(session.id)?.querySelector('.uptime');
    if (cell) cell.textContent = formatUptime(session.startedAt);
  }
}, TICK_MS);
