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
      'Your browser is refusing notifications for this page. Allow them from the icon ' +
      'in the address bar, then turn a switch back on.',
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
 * `visibilitychange` is the closest thing to a signal the browser offers — there is
 * no event for a permission being granted elsewhere — and coming back to this tab is
 * exactly when a stale reading would be seen. Cheap enough to do on every return.
 */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) render();
});

// The controls follow the stored state rather than the other way round, so a reload
// opens with them saying what is actually in force.
fillIntervals();
render();
