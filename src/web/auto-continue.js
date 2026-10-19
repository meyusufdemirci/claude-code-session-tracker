/**
 * Auto continue, as the pages see it: the switch, whether the plugin is there to do
 * the waiting, and the sessions waiting on it.
 *
 * The switch is the tracker's, not this browser's — the hook that wakes a session
 * reads it, and so does the menu bar — so it is asked of the server every time and
 * never kept here.
 */
import { formatClock } from './format.js';

/** Why nothing will continue, by what the server says of the plugin. `ready` has nothing to add. */
export const PLUGIN_NOTES = {
  missing:
    'Needs the session-tracker plugin, which does the waiting inside each session. In Claude Code, run ' +
    '/plugin marketplace add meyusufdemirci/claude-code-session-tracker, then ' +
    '/plugin install session-tracker@claude-code-session-tracker.',
  outdated: 'The session-tracker plugin is installed, but from before it could continue sessions. Run /plugin update session-tracker in Claude Code.',
  disabled: 'The session-tracker plugin is installed but switched off. Turn it back on with /plugin in Claude Code.',
};

/** Where it stands, or null when this tracker is too old to have auto continue at all. */
export async function readAutoContinue() {
  try {
    const response = await fetch('/api/auto-continue', { headers: { accept: 'application/json' } });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** Flip the switch. Answers with where it stands afterwards; throws with the server's reason. */
export async function setAutoContinue(enabled) {
  const response = await fetch('/api/auto-continue', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

/** `5:31 PM`, or with the day when it is not today — a weekly reset can be days away. */
export function formatWhen(at) {
  const date = new Date(at);
  if (date.toDateString() === new Date().toDateString()) return formatClock(at);
  return date.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** `2 sessions`, `1 session`. */
export function sessionCount(count) {
  return `${count} ${count === 1 ? 'session' : 'sessions'}`;
}

/** The soonest of the waiting sessions' wake times, as one phrase: `at 5:31 PM`, or `from 5:31 PM` when they differ. */
export function whenTheyContinue(pending) {
  if (pending.length === 0) return '';
  const first = Math.min(...pending.map((entry) => entry.continueAt));
  const same = pending.every((entry) => formatWhen(entry.continueAt) === formatWhen(first));
  return `${same ? 'at' : 'from'} ${formatWhen(first)}`;
}
