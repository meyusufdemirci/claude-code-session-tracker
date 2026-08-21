/**
 * Context window by model alias, for the models this tracker has actually seen.
 *
 * Anthropic's Models API is the live source of truth, but a transcript reader has
 * no request to make — it only ever sees the alias a past turn recorded. Missing an
 * entry here means the free-space math is skipped for that turn, not guessed at.
 *
 * Two readers share it: the detail panel, which measures how full the window is
 * right now, and the listing, which hands the window to the browser so the token
 * column can colour a session by the share of it that session burned.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-fable-5': 1_000_000,
  'claude-mythos-5': 1_000_000,
  'claude-mythos-preview': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'claude-opus-4-5': 200_000,
  'claude-opus-4-1': 200_000,
  'claude-opus-4-0': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-4-0': 200_000,
  'claude-3-haiku': 200_000,
  'claude-3-7-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-opus': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-sonnet': 200_000,
};

/** Strips a trailing `-YYYYMMDD` snapshot date, so a dated id matches its alias. */
export function contextWindowFor(model: string | undefined): number | undefined {
  if (!model) return undefined;
  return CONTEXT_WINDOWS[model] ?? CONTEXT_WINDOWS[model.replace(/-\d{8}$/, '')];
}
