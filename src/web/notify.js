/**
 * Desktop notifications for a limit window headed somewhere the reader would
 * rather know about before it gets there.
 *
 * The page already says it — a red `Projected` figure on a card is the same
 * fact — but only to someone looking at the page, and the reader this is for is
 * the one three windows deep in a refactor with the dashboard in a tab behind
 * their editor. So this module is the part of the strip that can reach them
 * there, and nothing else: the wording of a limit stays in `app.js` beside every
 * other sentence about one, and what arrives here is a message already written.
 *
 * Three things it owns. Whether the reader asked for these at all, which is a
 * stored choice and a browser permission and the two can disagree; the control
 * that changes that choice; and firing each occasion exactly once, which is the
 * whole difference between a warning and a page that beeps every second for five
 * hours.
 */

/** The stored answer to "do you want these" — set only when the answer is yes. */
const KEY = 'cst-alerts';

/**
 * The last occasion each scope fired for.
 *
 * On disk rather than in memory because a reload would otherwise be a way to hear
 * about the same window again, and this page is one people leave open for days and
 * refresh out of habit. Keyed by scope so it stays two entries wide forever: a new
 * window replaces the one it followed rather than piling up beside it.
 */
const SEEN_KEY = 'cst-alerts-seen';

/**
 * Storage is wrapped because a browser is allowed to refuse it — a private window,
 * a blocked-cookies setting. Losing the preference is survivable; a page that fails
 * to boot over it is not. Same reasoning as `theme.js`, same shape.
 */
function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Then the choice lasts for this page view only.
  }
}

/**
 * Whether notifications exist here at all.
 *
 * They need a secure context. Loopback counts as one, which is where this page
 * normally lives — but a tracker started with `--host` and reached over the LAN by
 * IP does not, and there the API is simply absent rather than refusing.
 */
const supported = typeof Notification === 'function';

/**
 * What the control says, and what it means.
 *
 * `blocked` is a state rather than an error because it is the one the reader cannot
 * get out of from this page — a permission the browser has already been told to
 * refuse is not re-askable, and the button that keeps offering to try is a button
 * that lies. It says so instead, and points at the address bar.
 */
const LABELS = { off: 'Alerts off', on: 'Alerts on', blocked: 'Alerts blocked' };

const TITLES = {
  off: 'Notify me when a five-hour window or a week is projected past your heaviest one. Only while this page is open.',
  on: 'Notifying when a five-hour window or a week is projected past your heaviest one. Only while this page is open.',
  blocked: 'This browser is refusing notifications for this page. Allow them in the address bar to turn these on.',
};

/**
 * Whether alerts are on, resolved from both halves of the answer.
 *
 * The stored choice and the browser permission are separate facts and either can
 * change without the other — a permission reset in site settings leaves a `yes` here
 * that is no longer true. The permission wins, so the control never claims to be
 * sending anything it cannot send.
 */
function state() {
  if (!supported) return 'off';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'off';
  return readStore(KEY, false) === true ? 'on' : 'off';
}

function render() {
  const button = document.getElementById('alerts-toggle');
  if (!button) return;

  const current = state();
  button.textContent = LABELS[current];
  button.title = TITLES[current];
  button.setAttribute('aria-pressed', String(current === 'on'));
  button.disabled = current === 'blocked';
}

/**
 * Turning them on, which may be two steps or one.
 *
 * The permission prompt has to come from a click — browsers require it, and rightly:
 * a page that asks the moment it loads is a page nobody grants. So the ask lives
 * here and nowhere else, and the stored `yes` is only written once the browser has
 * agreed, which keeps the two halves of `state()` from disagreeing the moment they
 * are set.
 */
async function enable() {
  if (Notification.permission !== 'granted') {
    try {
      await Notification.requestPermission();
    } catch {
      // Safari's older callback form, or a browser that refused outright. Either way
      // the permission is whatever it was, and `render` will say so.
    }
  }
  if (Notification.permission === 'granted') writeStore(KEY, true);
  render();
}

/**
 * The occasion this scope last fired for, so it does not fire for it twice.
 *
 * `renderLimits` runs every second, and every one of those seconds a window over its
 * yardstick is still over it. What makes an alert worth sending is that the answer
 * changed, and the token is how that is recognised: the same window still past the
 * same line is the same occasion, however many times it is noticed.
 */
function alreadyFired(scope, token) {
  const seen = readStore(SEEN_KEY, {});
  return seen && typeof seen === 'object' ? seen[scope] === token : false;
}

function remember(scope, token) {
  const seen = readStore(SEEN_KEY, {});
  writeStore(SEEN_KEY, { ...(seen && typeof seen === 'object' ? seen : {}), [scope]: token });
}

/**
 * Let a scope raise the alarm again.
 *
 * Guarded rather than written unconditionally, because the quiet case is the common
 * one: a page with both windows behaving would otherwise write to storage twice a
 * second for as long as it is left open.
 */
function forget(scope) {
  const seen = readStore(SEEN_KEY, {});
  if (!seen || typeof seen !== 'object' || seen[scope] === undefined) return;
  const rest = { ...seen };
  delete rest[scope];
  writeStore(SEEN_KEY, rest);
}

/**
 * Send one, unless this scope has already said this.
 *
 * `token` names the occasion — a window and the threshold it crossed. Pass a fresh
 * one and it fires; pass the one it fired on and it stays quiet. Passing `undefined`
 * is how a scope says it has nothing to report, which also forgets what it last said:
 * a window that dropped back under its yardstick, or emptied and started again, is
 * free to raise the alarm the next time it earns one.
 */
export function alertOnce(scope, token, message) {
  if (token === undefined) {
    forget(scope);
    return;
  }

  if (state() !== 'on' || alreadyFired(scope, token)) return;
  // Remembered before it is sent, not after: a constructor that throws — a headless
  // browser, a platform with no notification centre — must not leave the page trying
  // again a second later, forever.
  remember(scope, token);

  try {
    const note = new Notification(message.title, {
      body: message.body,
      // Per scope, so the week never covers up the five hours — and so a new
      // window's warning replaces the last one's rather than stacking a second
      // card of the same news beside it.
      tag: `cst-${scope}`,
    });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch {
    // Nothing to fall back to, and the card on the page already says this.
  }
}

/**
 * Wire the control, once the markup it lives in exists.
 *
 * A browser with no notifications at all takes the control away rather than showing
 * a dead one: there is no choice to offer, and a disabled button in the masthead is
 * a question the reader cannot answer. Blocked is different — that one is a state
 * they can change, somewhere this page can point at but cannot reach.
 */
export function setupAlerts() {
  const group = document.getElementById('alerts');
  const button = document.getElementById('alerts-toggle');
  if (!group || !button) return;

  if (!supported) {
    group.hidden = true;
    return;
  }

  button.addEventListener('click', () => {
    if (state() === 'on') {
      writeStore(KEY, undefined);
      render();
      return;
    }
    void enable();
  });

  render();
}
