import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { TrackerConfig } from '../../config.ts';
import { obj, parseUtilization, type ReportedUsage } from './quota.ts';

/** The endpoint Claude Code's own `/usage` reads. */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** The beta the OAuth endpoints are gated behind. */
const OAUTH_BETA = 'oauth-2025-04-20';

/**
 * How often the server is asked, at most.
 *
 * The page polls far more often than this, and the percentages move slowly — a
 * point of a five-hour window is minutes of heavy work. Asking every few minutes
 * keeps the bar honest without turning a dashboard into load on the account.
 */
const REFRESH_MS = 5 * 60 * 1000;

/** How long one request may take before the cards fall back to what they already had. */
const TIMEOUT_MS = 5_000;

/** Where Claude Code keeps its sign-in on macOS. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** The token Claude Code is signed in with, and when it stops working. */
interface AccessToken {
  value: string;
  expiresAt?: number;
}

export interface ServerUsageOptions {
  fetch?: typeof fetch;
  readToken?: () => Promise<AccessToken | undefined>;
  now?: () => number;
}

/**
 * The usage readout, asked of the server directly.
 *
 * Claude Code caches a readout in its account file, but only some versions do, and
 * only as often as something inside Claude Code asks — so on many machines there is
 * nothing on disk to read, and the cards fall back to a yardstick that is not the
 * quota. The server's endpoint answers what the yardstick cannot: how full each
 * window is, as a share of the ceiling actually enforced.
 *
 * It is asked with the token Claude Code is already signed in with, read and never
 * written: an expired token is skipped rather than refreshed, because refreshing it
 * here would rotate the refresh token out from under Claude Code and sign it out.
 * Claude Code refreshes it the next time it runs, and this picks the new one up.
 *
 * One request at a time, at most one per `REFRESH_MS`, and a failed one keeps the
 * last good answer — whose age the limits then judge like any other reading.
 */
export class ServerUsage {
  readonly #fetch: typeof fetch;
  readonly #readToken: () => Promise<AccessToken | undefined>;
  readonly #now: () => number;

  #last: ReportedUsage | undefined;
  #attemptedAt = Number.NEGATIVE_INFINITY;
  #inFlight: Promise<ReportedUsage | undefined> | undefined;

  constructor(config: TrackerConfig, options: ServerUsageOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#readToken = options.readToken ?? (() => readAccessToken(config));
    this.#now = options.now ?? Date.now;
  }

  async read(): Promise<ReportedUsage | undefined> {
    if (this.#inFlight) return this.#inFlight;
    if (this.#now() - this.#attemptedAt < REFRESH_MS) return this.#last;

    this.#attemptedAt = this.#now();
    this.#inFlight = this.#request().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #request(): Promise<ReportedUsage | undefined> {
    try {
      const token = await this.#readToken();
      if (!token || (token.expiresAt !== undefined && token.expiresAt <= this.#now())) return this.#last;

      const response = await this.#fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token.value}`,
          'anthropic-beta': OAUTH_BETA,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return this.#last;

      const body = obj(await response.json());
      if (!body) return this.#last;

      this.#last = parseUtilization(body, this.#now(), 'server');
      return this.#last;
    } catch {
      // Offline, a timeout, a body that is not JSON. None of it is the page's
      // problem: the cards keep the last reading, or the yardstick.
      return this.#last;
    }
  }
}

/**
 * The token Claude Code is signed in with.
 *
 * On macOS it lives in the login Keychain; everywhere else, and on macOS installs
 * that predate the Keychain, in `<claudeDir>/.credentials.json`. A `CLAUDE_CONFIG_DIR`
 * install keeps its own Keychain item, named after a hash of that directory.
 */
export async function readAccessToken(config: TrackerConfig): Promise<AccessToken | undefined> {
  const candidates: AccessToken[] = [];

  if (process.platform === 'darwin') {
    // Several items can share the service name — other macOS users, older installs —
    // and without an account `security` returns whichever comes first. Claude Code
    // files its own under the login name, so that one is asked for by name.
    const service = keychainService(config.claudeDir);
    for (const account of [keychainAccount(), undefined]) {
      const fromKeychain = parseCredentials(await readKeychain(service, account));
      if (fromKeychain) candidates.push(fromKeychain);
    }
  }

  try {
    const fromFile = parseCredentials(await readFile(join(config.claudeDir, '.credentials.json'), 'utf8'));
    if (fromFile) candidates.push(fromFile);
  } catch {
    // No file is the usual case on macOS.
  }

  // Whichever lasts longest: a stale file left behind by an older install must not
  // win over the Keychain item Claude Code has since been refreshing.
  return candidates.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0];
}

/**
 * The Keychain service Claude Code keeps the sign-in of `claudeDir` under: the bare
 * name for the default install, else suffixed with the first 8 hex digits of the
 * directory's sha256, as Claude Code 2.1 names it.
 */
export function keychainService(claudeDir: string): string {
  if (claudeDir === join(homedir(), '.claude')) return KEYCHAIN_SERVICE;
  const hash = createHash('sha256').update(claudeDir.normalize('NFC')).digest('hex').slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${hash}`;
}

/** The account Claude Code files its Keychain item under: the login name, as it reads it. */
export function keychainAccount(): string {
  let name: string;
  try {
    name = process.env['USER'] || userInfo().username;
  } catch {
    name = 'claude-code-user';
  }
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : 'claude-code-user';
}

function readKeychain(service: string, account?: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w'],
      { timeout: TIMEOUT_MS },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

function parseCredentials(text: string | undefined): AccessToken | undefined {
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  const oauth = obj(obj(parsed)?.['claudeAiOauth']);
  const value = oauth?.['accessToken'];
  if (typeof value !== 'string' || !value) return undefined;

  const expiresAt = oauth?.['expiresAt'];
  return { value, ...(typeof expiresAt === 'number' ? { expiresAt } : {}) };
}
