/**
 * The "a newer version is out" notice, on every page, and its Update button.
 *
 * The server asks the npm registry (see `src/update.ts`) and knows how this copy
 * was installed, so Update can do the whole thing: upgrade, restart as the new
 * version, and this page reloads onto it (see `src/self-update.ts`). Where the
 * server cannot do it itself, the notice names the command instead.
 *
 * Dismissed per version: hiding 0.12.0 does not hide 0.13.0. Settings is where
 * someone goes looking for it, so there it cannot be dismissed.
 */

/** The server asks the registry a few times a day; the page only needs to hear about it. */
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;

/** While an update runs, the page follows it closely. */
const PROGRESS_INTERVAL_MS = 1000;

/** How long a restart may take before the page says something went wrong. */
const RESTART_TIMEOUT_MS = 90 * 1000;

const DISMISSED_KEY = 'cst-update-dismissed';

const DISMISSABLE = location.pathname !== '/settings';

function dismissed() {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function dismiss(version) {
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // Private windows refuse storage; the notice then comes back on the next load.
  }
}

function build() {
  const notice = document.createElement('div');
  notice.className = 'banner update-banner';
  notice.id = 'update-banner';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.hidden = true;
  notice.innerHTML = `
    <span class="update-title" data-update="title"></span>
    <span class="hint" data-update="detail"></span>
    <button type="button" class="update-primary" data-update="install">Update</button>
    <span class="update-manual" data-update="manual">
      <code class="update-command" data-update="command"></code>
      <button type="button" data-update="copy">Copy</button>
    </span>
    <a data-update="notes" target="_blank" rel="noopener">What's new</a>
    <button type="button" class="update-dismiss" data-update="dismiss" aria-label="Dismiss until the next version">×</button>
  `;
  document.querySelector('.masthead')?.after(notice);
  return notice;
}

const notice = build();
const part = (name) => notice.querySelector(`[data-update="${name}"]`);

/** The last answer from `/api/update`. */
let last = null;
/** An update is under way, so the page polls closely and reloads when the new version answers. */
let following = false;
let restartingSince = 0;
let timer = 0;

function isBusy(install) {
  return install.state === 'installing' || install.state === 'restarting';
}

const METHODS = {
  brew: 'Homebrew',
  npm: 'npm',
  pnpm: 'pnpm',
  bun: 'bun',
  runner: 'npx (fetched for each run)',
  unknown: 'Not a package manager (a source checkout?)',
};

/** The version beside the title on every page, and the Version panel on Settings. */
function renderVersion(status) {
  for (const node of document.querySelectorAll('[data-version-current]')) {
    node.textContent = node.classList.contains('eyebrow-version') ? `v${status.current}` : status.current;
  }

  const latest = document.getElementById('version-latest');
  if (!latest) return;
  latest.textContent = !status.checked ? 'Not checked (--offline)' : status.latest ?? 'Checking…';
  document.getElementById('version-method').textContent = METHODS[status.method] ?? status.method;

  const state = document.getElementById('version-state');
  if (status.checked && status.latest) {
    state.hidden = false;
    state.dataset.tone = status.available ? 'warn' : 'ok';
    state.textContent = status.available
      ? `${status.latest} is out — update from the notice above.`
      : 'You are on the newest version.';
  }
}

function render(status) {
  last = status;
  renderVersion(status);
  const { install } = status;
  const busy = isBusy(install);

  if (!status.available && !busy) {
    notice.hidden = true;
    return;
  }
  if (!busy && install.state !== 'failed' && DISMISSABLE && status.latest === dismissed()) {
    notice.hidden = true;
    return;
  }

  notice.dataset.state = install.state;
  part('notes').href = status.notesUrl;
  part('command').textContent = status.command;
  part('dismiss').hidden = !DISMISSABLE || busy;

  const installButton = part('install');
  installButton.hidden = !status.canInstall;
  installButton.disabled = busy;

  if (install.state === 'installing') {
    part('title').textContent = `Updating to ${status.latest}…`;
    part('detail').textContent = install.step ?? '';
    installButton.textContent = 'Updating…';
    part('manual').hidden = true;
  } else if (install.state === 'restarting') {
    part('title').textContent = `Restarting as ${status.latest}…`;
    part('detail').textContent = 'The page reloads by itself.';
    installButton.textContent = 'Restarting…';
    part('manual').hidden = true;
  } else if (install.state === 'failed') {
    part('title').textContent = `Could not update to ${status.latest}`;
    part('detail').textContent = `${install.error ?? ''} You can run it yourself:`;
    installButton.textContent = 'Try again';
    part('manual').hidden = false;
  } else {
    part('title').textContent = `Version ${status.latest} is out`;
    part('detail').textContent = status.canInstall
      ? `· you have ${status.current}`
      : `· you have ${status.current}. ${status.installBlocked ?? ''} Update with:`;
    installButton.textContent = 'Update';
    part('manual').hidden = status.canInstall;
  }

  notice.dataset.version = status.latest ?? '';
  notice.hidden = false;
}

async function poll() {
  clearTimeout(timer);
  let status;
  try {
    const response = await fetch('/api/update', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    status = await response.json();
  } catch {
    // Gone mid-update is the restart; the new version answers shortly.
    if (following) restarting();
    schedule(following ? PROGRESS_INTERVAL_MS : UPDATE_INTERVAL_MS);
    return;
  }

  // A new version answering is the end of the update: load its page.
  if (following && last && status.current !== last.current) {
    location.reload();
    return;
  }

  render(status);
  if (isBusy(status.install)) following = true;
  if (status.install.state === 'restarting') restarting();
  if (status.install.state === 'failed') following = false;
  schedule(following ? PROGRESS_INTERVAL_MS : UPDATE_INTERVAL_MS);
}

/** Restarting, or gone and not yet back. Past the timeout, say so rather than spin forever. */
function restarting() {
  if (!restartingSince) restartingSince = Date.now();
  if (Date.now() - restartingSince < RESTART_TIMEOUT_MS || !last) return;
  following = false;
  render({
    ...last,
    install: { state: 'failed', error: 'The new version has not come back. Start the tracker again, or check its log.' },
  });
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(poll, ms);
}

part('install').addEventListener('click', async () => {
  following = true;
  restartingSince = 0;
  try {
    const response = await fetch('/api/update/install', { method: 'POST', headers: { accept: 'application/json' } });
    if (!response.ok && last) {
      const body = await response.json().catch(() => ({}));
      following = false;
      render({ ...last, install: { state: 'failed', error: body.error ?? `HTTP ${response.status}.` } });
      return;
    }
  } catch {
    // Already restarting, which is what the poll will find.
  }
  poll();
});

part('copy').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(part('command').textContent ?? '');
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Select and copy';
  }
  setTimeout(() => (button.textContent = 'Copy'), 2000);
});

part('dismiss').addEventListener('click', () => {
  if (notice.dataset.version) dismiss(notice.dataset.version);
  notice.hidden = true;
});

poll();
