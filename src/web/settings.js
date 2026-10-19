/**
 * The settings page: the switches, their intervals, and the one sentence the browser
 * gets to add.
 *
 * Everything about what a notification is, when one is worth sending, and whether
 * this browser will allow it lives in `notify.js`. What is here is the page — which
 * control stands for which limit, what happens when one is changed, and how the
 * answer is reported back when the browser has an opinion of its own.
 */
import {
  QUIET_CHOICES,
  isOn,
  permission,
  quietLabel,
  quietMinutes,
  setQuietMinutes,
  setWanted,
} from './notify.js';
import { formatWhen, PLUGIN_NOTES, readAutoContinue, sessionCount, setAutoContinue } from './auto-continue.js';

/**
 * What the line under the switches says, keyed by what the browser answered.
 *
 * `granted` is absent on purpose: a page that is doing exactly what was asked of it
 * has nothing to add, and a green "working" banner under every working control is
 * noise the reader learns to skip. Silence is the good case.
 */
const STATES = {
  unsupported: {
    tone: 'bad',
    text:
      'Notifications need a secure context. Reach the dashboard at localhost rather ' +
      'than over the network, and these will work.',
  },
  blocked: {
    tone: 'bad',
    text:
      `Your browser is refusing notifications for ${location.host}. That is a setting ` +
      'it holds for this address, not something the page can undo: open site settings ' +
      'from the icon beside the address bar, put notifications back to Ask or Allow, ' +
      'then turn a switch on again.',
  },
  ask: {
    tone: 'ok',
    text: 'Your browser has not been asked yet. Turning a switch on asks it.',
  },
};

const switches = () => [...document.querySelectorAll('#alert-switches input[data-scope]')];
const intervals = () => [...document.querySelectorAll('#alert-switches select[data-quiet]')];

/**
 * Fill each interval menu from the list its scope actually honours.
 *
 * Once, on load, rather than on every render: the options for a scope do not change,
 * and rebuilding a `<select>` under a reader who has it open closes it.
 */
function fillIntervals() {
  for (const select of intervals()) {
    for (const minutes of QUIET_CHOICES[select.dataset.quiet] ?? []) {
      const option = document.createElement('option');
      option.value = String(minutes);
      option.textContent = quietLabel(minutes);
      select.append(option);
    }
  }
}

/**
 * Draw both switches and the line under them from what is actually true.
 *
 * `isOn` rather than `isWanted`, so a switch never sits in the on position while the
 * browser is refusing to send anything. The stored choice survives underneath — it
 * is what makes unblocking the page enough to get them back — but what the reader
 * sees is whether this limit will reach them, which is the question they came here
 * to answer.
 */
function render() {
  const state = permission();

  for (const input of switches()) {
    input.checked = isOn(input.dataset.scope);
    // Not disabled, even when blocked: turning a switch on is still how the reader
    // records what they want, and a dead control gives them nowhere to say it.
    input.setAttribute('aria-checked', String(input.checked));
  }

  for (const select of intervals()) {
    // From the stored value rather than left where the reader put it, so a choice the
    // module declined to honour is not left on screen as though it had been taken.
    select.value = String(quietMinutes(select.dataset.quiet));
  }

  const line = document.getElementById('alerts-state');
  if (!line) return;
  const note = STATES[state];
  line.hidden = !note;
  if (!note) return;
  line.textContent = note.text;
  line.dataset.tone = note.tone;
}

for (const input of switches()) {
  input.addEventListener('change', async () => {
    // The click that got us here is the gesture the permission prompt needs, so the
    // ask happens inside `setWanted` rather than a beat later.
    await setWanted(input.dataset.scope, input.checked);
    // Redrawn from the answer rather than left as the reader flipped it: a switch
    // turned on against a refusal has to come back, or the page is lying about what
    // it will do.
    render();
  });
}

for (const select of intervals()) {
  select.addEventListener('change', () => {
    setQuietMinutes(select.dataset.quiet, Number(select.value));
    render();
  });
}

/**
 * A permission changed in another tab, or in site settings while this page sat open.
 *
 * Coming back to this tab is exactly when a stale reading would be seen, and it costs
 * nothing to look again. The `permissions` watch below is the sharper instrument;
 * this is the one every browser has.
 */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) render();
});

// The controls follow the stored state rather than the other way round, so a reload
// opens with them saying what is actually in force.
fillIntervals();
render();

/* ----------------------------------------------------------- auto continue */

/** How often the queue is read again while the page is open: sessions stop and wake on their own. */
const AUTO_INTERVAL_MS = 15000;

const autoSwitch = document.getElementById('auto-continue');

/** What each waiting session is called: its title when it is running, else its folder. */
async function sessionLabels() {
  try {
    const response = await fetch('/api/sessions?limit=1', { headers: { accept: 'application/json' } });
    const { sessions } = response.ok ? await response.json() : { sessions: [] };
    return new Map(sessions.map((session) => [session.id, session.title ?? session.name ?? session.project?.name]));
  } catch {
    return new Map();
  }
}

/**
 * Draw the panel from what the server says, which is the only place it is true: the
 * switch, why it would do nothing, who is waiting, and who it woke last.
 */
async function renderAutoContinue(status) {
  const panel = document.getElementById('auto-continue-panel');
  if (!panel || !autoSwitch) return;
  panel.hidden = !status;
  if (!status) return;

  autoSwitch.checked = status.enabled;
  autoSwitch.setAttribute('aria-checked', String(status.enabled));

  const line = document.getElementById('auto-continue-state');
  const note = PLUGIN_NOTES[status.plugin];
  if (line) {
    line.hidden = !note;
    line.textContent = note ?? '';
  }

  const queue = document.getElementById('auto-continue-queue');
  const list = document.getElementById('auto-continue-list');
  if (queue && list) {
    queue.hidden = status.pending.length === 0;
    const labels = status.pending.length ? await sessionLabels() : new Map();
    const count = document.getElementById('auto-continue-count');
    if (count) {
      count.textContent = status.enabled
        ? `${sessionCount(status.pending.length)} will continue`
        : `${sessionCount(status.pending.length)} stopped at the limit · turn the switch on to continue ${status.pending.length === 1 ? 'it' : 'them'}`;
    }
    list.replaceChildren(
      ...status.pending.map((entry) => {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'auto-queue-name';
        name.textContent = labels.get(entry.sessionId) ?? entry.cwd?.split(/[\\/]/).pop() ?? entry.sessionId.slice(0, 8);
        const when = document.createElement('span');
        when.className = 'auto-queue-when mono';
        when.textContent = `${status.enabled ? 'continues' : 'limit resets'} ${formatWhen(status.enabled ? entry.continueAt : entry.resetsAt)}`;
        item.append(name, when);
        return item;
      }),
    );
  }

  const last = document.getElementById('auto-continue-last');
  const latest = status.continued[0];
  if (last) {
    last.hidden = !latest;
    if (latest) {
      const together = status.continued.filter((entry) => Math.abs(entry.at - latest.at) < 10 * 60 * 1000).length;
      last.textContent = `Last continued ${formatWhen(latest.at)} · ${sessionCount(together)}`;
    }
  }
}

async function refreshAutoContinue() {
  await renderAutoContinue(await readAutoContinue());
}

autoSwitch?.addEventListener('change', async () => {
  const wanted = autoSwitch.checked;
  try {
    await renderAutoContinue(await setAutoContinue(wanted));
  } catch (error) {
    // Put the switch back where the server has it, and say why.
    await refreshAutoContinue();
    const line = document.getElementById('auto-continue-state');
    if (line) {
      line.hidden = false;
      line.textContent = `Could not turn auto continue ${wanted ? 'on' : 'off'}: ${error.message}`;
    }
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshAutoContinue();
});
refreshAutoContinue();
setInterval(refreshAutoContinue, AUTO_INTERVAL_MS);

/**
 * The same question again the moment the browser changes its own answer.
 *
 * Allowing this page from the address bar never hides the tab, so the handler above
 * does not fire, and the line underneath would go on saying blocked to a reader who
 * has just this second fixed it — which is the one moment it most needs to be right.
 * `permissions` is the only place a browser volunteers the change. Not every browser
 * answers to this name; where none does, coming back to the tab is still a signal.
 */
try {
  const status = await navigator.permissions?.query({ name: 'notifications' });
  status?.addEventListener('change', render);
} catch {
  // Then `visibilitychange` is the whole of it, which is what it was before.
}
