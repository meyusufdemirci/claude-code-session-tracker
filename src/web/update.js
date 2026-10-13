/**
 * The "a newer version is out" notice, on every page.
 *
 * The server asks the npm registry (see `src/update.ts`) and knows how this copy
 * was installed, so the notice can name the one command that updates it. Dismissed
 * per version: hiding 0.12.0 does not hide 0.13.0.
 */

/** The server asks the registry a few times a day; the page only needs to hear about it. */
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;

const DISMISSED_KEY = 'cst-update-dismissed';

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
  const notice = document.createElement('p');
  notice.className = 'banner update-banner';
  notice.id = 'update-banner';
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  notice.innerHTML = `
    <span><strong>Version <span data-update="latest"></span> is out</strong>
      <span class="hint">· you have <span data-update="current"></span></span></span>
    <code class="update-command" data-update="command"></code>
    <button type="button" class="update-copy" data-update="copy">Copy</button>
    <span class="hint">then restart the tracker.</span>
    <a data-update="notes" target="_blank" rel="noopener">What's new</a>
    <button type="button" class="update-dismiss" data-update="dismiss" aria-label="Dismiss until the next version">×</button>
  `;
  document.querySelector('.masthead')?.after(notice);
  return notice;
}

function part(notice, name) {
  return notice.querySelector(`[data-update="${name}"]`);
}

async function poll(notice) {
  let status;
  try {
    const response = await fetch('/api/update', { headers: { accept: 'application/json' } });
    if (!response.ok) return;
    status = await response.json();
  } catch {
    return;
  }

  if (!status.available || status.latest === dismissed()) {
    notice.hidden = true;
    return;
  }

  part(notice, 'latest').textContent = status.latest;
  part(notice, 'current').textContent = status.current;
  part(notice, 'command').textContent = status.command;
  const notes = part(notice, 'notes');
  notes.hidden = !status.releaseUrl;
  if (status.releaseUrl) notes.href = status.releaseUrl;
  notice.dataset.version = status.latest;
  notice.hidden = false;
}

const notice = build();

part(notice, 'copy').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(part(notice, 'command').textContent ?? '');
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Select and copy';
  }
  setTimeout(() => (button.textContent = 'Copy'), 2000);
});

part(notice, 'dismiss').addEventListener('click', () => {
  if (notice.dataset.version) dismiss(notice.dataset.version);
  notice.hidden = true;
});

poll(notice);
setInterval(() => poll(notice), UPDATE_INTERVAL_MS);
