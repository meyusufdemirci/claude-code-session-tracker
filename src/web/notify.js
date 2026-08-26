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
 * Three things it owns. Whether the reader asked for these, which is a stored
 * choice per limit and a browser permission shared by both, and the two can
 * disagree; what the settings page needs in order to draw and change that; and
 * firing each occasion exactly once, which is the whole difference between a
 * warning and a page that beeps every second for five hours.
 *
 * Both the dashboard and the settings page load this. The dashboard is the only
 * one that sends anything; the settings page is the only one that changes
 * anything. Neither has to know that about the other.
 */

/** The two windows that can be watched, and what each is called when asked about. */
export const SCOPES = [
  { key: 'session', label: 'Session limit', span: 'five-hour window' },
  { key: 'weekly', label: 'Weekly limit', span: 'week' },
];

/** Which limits the reader asked to hear about, as `{ session: true }`. */
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
 * What the browser has to say, in the four words the settings page can act on.
 *
 * `blocked` is separated from `ask` because it is the one the reader cannot get out
 * of from this page: a permission already refused is not re-askable, and a switch
 * that keeps offering to try is a switch that lies. The page says so instead, and
 * points at the address bar.
 */
export function permission() {
  if (!supported) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'blocked';
  return 'ask';
}

/**
 * The choices as stored, before the browser gets a say.
 *
 * A `true` here is the shape this key held when there was one switch for both
 * limits rather than one each. Anyone who turned that on meant both, so it is read
 * as both rather than dropped on the floor.
 */
function wanted() {
  const stored = readStore(KEY, {});
  if (stored === true) return { session: true, weekly: true };
  if (!stored || typeof stored !== 'object') return {};
  return stored;
}

/** What the switch for this limit should show: the reader's own answer, kept as given. */
export function isWanted(scope) {
  return wanted()[scope] === true;
}

/**
 * Whether this limit will actually send anything.
 *
 * Both halves have to agree. The stored choice and the browser permission can drift
 * apart — a permission reset in site settings leaves a `yes` here that is no longer
 * true — and the permission wins, so nothing ever claims to be sending what it
 * cannot send.
 */
export function isOn(scope) {
  return permission() === 'granted' && isWanted(scope);
}

/**
 * Turn one limit's alerts on or off, asking the browser the first time it matters.
 *
 * The prompt has to come from a click — browsers require it, and rightly: a page
 * that asks the moment it loads is a page nobody grants. So the ask lives here, on
 * the one path that a switch being turned on can take, and nowhere else. Turning a
 * switch off never asks; there is nothing to ask for.
 *
 * The choice is stored either way, including when permission is refused. What the
 * reader wanted is a separate fact from what the browser allowed, and losing it
 * would mean re-asking for it the day they unblock the page.
 */
export async function setWanted(scope, on) {
  writeStore(KEY, { ...wanted(), [scope]: on === true });

  if (on && permission() === 'ask') {
    try {
      await Notification.requestPermission();
    } catch {
      // Safari's older callback form, or a browser that refused outright. Either
      // way the permission is whatever it was, and the page will say so.
    }
  }
  return permission();
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
 * `token` names the occasion — the window that crossed the line. Pass a fresh one
 * and it fires; pass the one it fired on and it stays quiet. Passing `undefined` is
 * how a scope says it has nothing to report, which also forgets what it last said:
 * a window that dropped back under its yardstick, or emptied and started again, is
 * free to raise the alarm the next time it earns one.
 */
export function alertOnce(scope, token, message) {
  if (token === undefined) {
    forget(scope);
    return;
  }

  if (!isOn(scope) || alreadyFired(scope, token)) return;
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
