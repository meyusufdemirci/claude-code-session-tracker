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
 * Four things it owns. Whether the reader asked for these, which is a stored
 * choice per limit and a browser permission shared by both, and the two can
 * disagree; what the settings page needs in order to draw and change that; how
 * rarely a limit is allowed to speak, which is the whole difference between a
 * warning and a page that beeps every second for five hours; and whether the
 * question has ever been put to this reader at all, since a switch nobody knows
 * about is a switch nobody has.
 *
 * Both the dashboard and the settings page load this. The dashboard is the only
 * one that sends anything and the only one that asks; the settings page is the
 * only one that changes anything. Neither has to know that about the other.
 */

/** The two windows that can be watched, and what each is called when asked about. */
export const SCOPES = [
  { key: 'session', label: 'Session limit', span: 'five-hour window' },
  { key: 'weekly', label: 'Weekly limit', span: 'week' },
];

const MINUTE = 60 * 1000;

/** Which limits the reader asked to hear about, as `{ session: true }`. */
const KEY = 'cst-alerts';

/** How long each limit stays quiet after speaking, in minutes. */
const QUIET_KEY = 'cst-alert-quiet';

/** That the offer below has been made and answered, so it is never made twice. */
const INVITE_KEY = 'cst-alerts-invited';

/**
 * When each scope last said something, so it can hold its tongue afterwards.
 *
 * On disk rather than in memory because a reload would otherwise be a way to hear
 * the same warning again, and this page is one people leave open for days and
 * refresh out of habit. Keyed by scope so it stays two entries wide forever.
 */
const SENT_KEY = 'cst-alerts-sent';

/**
 * How long a limit waits before it is allowed to speak again.
 *
 * A flat interval, deliberately, rather than one warning per window. The reader is
 * not being told a fact they can act on twice — the pace either settled or it did
 * not, and the card is there to be read whenever they want the detail. What the
 * interval is for is the other half of the day: a five-hour window that spends four
 * of them over the line has one thing to say and no reason to say it more than once
 * an hour, and a week has even less reason than that.
 *
 * The defaults are the two spans in miniature: an hour is roughly a fifth of a
 * session window, four hours roughly a fifth of a working week — often enough to be
 * a reminder, rare enough that the second one is still worth reading.
 */
export const QUIET_DEFAULT = { session: 60, weekly: 240 };

/**
 * What the settings page offers, per scope, in minutes.
 *
 * Each list ends at its own window's ceiling — five hours is one warning per session
 * window, a day is about one per weekday — so the quietest choice on offer is
 * genuinely the quietest thing the limit can do rather than an arbitrary big number.
 */
export const QUIET_CHOICES = {
  session: [30, 60, 120, 300],
  weekly: [60, 240, 720, 1440],
};

/** How an interval names itself on the settings page. Whole hours, so no fractions. */
export function quietLabel(minutes) {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

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

/** Whatever is under a per-scope key, as an object, whatever the browser handed back. */
function readScoped(key) {
  const stored = readStore(key, {});
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
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
 * How long `Not now` means, before the offer is made one last time.
 *
 * Not now says later, so it has to mean later or the button is a lie — but a page
 * that asks again next week is a page being argued with, and the reader would be
 * right. A fortnight is the distance at which the second ask is not the first one
 * repeated: long enough that the habits it is about are a different fortnight's,
 * short enough to still be the same person on the same project.
 *
 * There is no third. Two asks is the whole of it, which is what keeps this an offer
 * rather than a campaign.
 */
const DEFER_DAYS = 14;
const DEFER_MS = DEFER_DAYS * 24 * 60 * 60 * 1000;

/**
 * Whether the dashboard should put the question to this reader now.
 *
 * The question is worth putting at all because these switches are a page away behind
 * a word — Settings — that promises nothing in particular, and the reader they were
 * built for is precisely the one who never goes looking: the tab is behind an editor,
 * which is the whole reason a notification is the only thing that can reach them. A
 * feature nobody is told about is a feature nobody has.
 *
 * Three records can close it, and the first two close it for good. A dismissal that
 * was final is stored here as `true`; a choice under `KEY` — either way, on or off —
 * says the reader has been to the settings page and made up their mind, which is also
 * what spares everyone who set these up before the offer existed from being asked
 * about something they are already using. That second one is the whole of `if
 * notifications are still off`: still off through never having decided is a reader
 * who was never asked, while off because they went and turned it off is an answer,
 * and re-opening a settled question is what makes a page nag.
 *
 * The third is a stamp, which only holds until it is a fortnight old. A clock that
 * has moved backwards under it — an NTP correction, a laptop woken in another
 * timezone — reads as due rather than as a very long wait, the same way `isQuiet`
 * does and for the same reason: being wrong that way costs one more offer, being
 * wrong the other way costs the offer entirely.
 *
 * The two answers the browser will not move off are left out, on the same grounds the
 * settings page keeps them apart: reached over the LAN there is nothing here to turn
 * on, and a permission already refused cannot be re-asked by a page. Offering either
 * is not a nudge, it is a dead end with a button on it.
 */
export function isInviteDue(now = Date.now()) {
  const state = permission();
  if (state === 'unsupported' || state === 'blocked') return false;
  if (Object.keys(wanted()).length > 0) return false;

  const answered = readStore(INVITE_KEY, null);
  if (answered === true) return false;
  if (typeof answered === 'number' && Number.isFinite(answered)) {
    const since = now - answered;
    return since < 0 || since >= DEFER_MS;
  }
  return true;
}

/**
 * `Not now`, taken at its word: hold the offer back rather than drop it.
 *
 * The first one stamps the clock and the offer comes back in a fortnight. The second
 * one lands on a stamp that is already there, which is a reader who has now said no
 * twice, and there is nothing a third asking would find out that the second did not.
 * So it closes for good, and the button stays honest both times — the first `Not now`
 * really was not now, and the second really was the last of it.
 *
 * `now` is a parameter so the fortnight can be tested without waiting one.
 */
export function deferInvite(now = Date.now()) {
  writeStore(INVITE_KEY, readStore(INVITE_KEY, null) === null ? now : true);
}

/**
 * Close the question for good, on the one path that has earned it.
 *
 * The reader who clicks through to the settings page has been shown the switches
 * themselves, which is everything the offer was ever going to do for them. What is
 * recorded is that they got there, not what they decided once they had — deciding is
 * what the switches are for, and one of the honest answers over there is to leave
 * both of them off.
 */
export function dismissInvite() {
  writeStore(INVITE_KEY, true);
}

/**
 * Put this browser back to the state it was in before any of this was set up.
 *
 * Which is the only honest way to see the first run again: whether the offer is due
 * hangs on two records, not one — that it has never been made, and that the switches
 * have never been touched — and clearing half of them would leave a reader looking at
 * a page that still, correctly, refuses to ask. So everything this module has written
 * goes, the switches and their intervals along with the two, and what comes back is a
 * first run rather than an imitation of one.
 *
 * It cannot reach the browser's own permission, which is the one thing here a page is
 * not allowed to hand back. A `granted` still stands, and so does a `blocked` — and a
 * blocked one is why this can be called on a browser that then declines to ask, which
 * is the module being right rather than the reset failing.
 *
 * For the test page, and for a console. Nothing on the dashboard or the settings page
 * calls it: throwing away someone's preferences is not a thing a product page should
 * offer to do next to the switches that hold them.
 */
export function resetAll() {
  for (const key of [KEY, QUIET_KEY, INVITE_KEY, SENT_KEY]) writeStore(key, undefined);
}

/**
 * How long this limit waits between warnings.
 *
 * Anything not on the offered list is read as the default rather than honoured —
 * a stored value from a list that has since changed, or one typed into devtools,
 * should not be able to silence a limit for a month.
 */
export function quietMinutes(scope) {
  const stored = readScoped(QUIET_KEY)[scope];
  return QUIET_CHOICES[scope]?.includes(stored) ? stored : QUIET_DEFAULT[scope];
}

/**
 * Choose how long this limit waits, and let it speak now if the new interval says
 * it already could have.
 *
 * Nothing is cleared here — the timestamp stands, and shortening the interval is
 * simply measured against it. Someone who moves session alerts from five hours to
 * thirty minutes has said they want to hear more, and the next tick is when they
 * start to.
 */
export function setQuietMinutes(scope, minutes) {
  if (!QUIET_CHOICES[scope]?.includes(minutes)) return quietMinutes(scope);
  writeStore(QUIET_KEY, { ...readScoped(QUIET_KEY), [scope]: minutes });
  return minutes;
}

/** When this scope last spoke, or `0` for a scope that never has. */
function lastSentAt(scope) {
  const at = readScoped(SENT_KEY)[scope];
  return typeof at === 'number' && Number.isFinite(at) ? at : 0;
}

/**
 * Whether this scope is still inside its quiet interval.
 *
 * A stamp in the future — a clock pushed back by an NTP correction or a laptop that
 * woke up in another timezone's idea of now — reads as due rather than as a very
 * long wait. The cost of being wrong that way is one extra notification; the cost of
 * being wrong the other way is a limit that never speaks again.
 */
function isQuiet(scope, now) {
  const since = now - lastSentAt(scope);
  return since >= 0 && since < quietMinutes(scope) * MINUTE;
}

/**
 * How long until this scope could speak again, in ms, or `0` if it could now.
 *
 * For the settings page, which is the one place worth admitting that a switch which
 * is on and a limit which is over the line can still, correctly, be saying nothing.
 */
export function quietFor(scope, now = Date.now()) {
  const left = lastSentAt(scope) + quietMinutes(scope) * MINUTE - now;
  return left > 0 && left <= quietMinutes(scope) * MINUTE ? left : 0;
}

/**
 * Send one, unless this scope has spoken recently enough.
 *
 * `renderLimits` runs every second, and every one of those seconds a window over its
 * yardstick is still over it. What decides whether any of them becomes a notification
 * is the clock and nothing else: the first one through fires, and the rest of the
 * interval belongs to the reader. A window that drops back under the line and climbs
 * over it again inside that interval is the same interruption arriving twice, so it
 * waits its turn like everything else.
 *
 * Returns whether anything was sent, which is what the test page reports.
 */
export function sendAlert(scope, message, now = Date.now()) {
  if (!isOn(scope) || isQuiet(scope, now)) return false;

  // Stamped before it is sent, not after: a constructor that throws — a headless
  // browser, a platform with no notification centre — must not leave the page trying
  // again a second later, forever.
  writeStore(SENT_KEY, { ...readScoped(SENT_KEY), [scope]: now });

  try {
    const note = new Notification(message.title, {
      body: message.body,
      // Per scope, so the week never covers up the five hours — and so a new
      // warning replaces the last one rather than stacking a second card of the
      // same news beside it.
      tag: `cst-${scope}`,
    });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch {
    // Nothing to fall back to, and the card on the page already says this.
  }
  return true;
}
