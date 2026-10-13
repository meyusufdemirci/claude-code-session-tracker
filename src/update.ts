import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { isOneOffCache } from './autostart.ts';
import { FORMULA, PACKAGE } from './menubar.ts';
import { VERSION } from './version.ts';

/** The registry's record of the newest published version, and nothing else. */
const LATEST_URL = `https://registry.npmjs.org/${PACKAGE}/latest`;

/** The project's site, where what is new is told. */
export const SITE_URL = 'https://ccst.nefarius.co';

/**
 * How often the registry is asked, at most.
 *
 * Releases come days apart, and a tracker left running for a week should still
 * hear about one, so a few times a day is plenty.
 */
const REFRESH_MS = 6 * 60 * 60 * 1000;

/** A failed ask is tried again sooner, so a laptop that woke up offline is not left waiting six hours. */
const RETRY_MS = 15 * 60 * 1000;

const TIMEOUT_MS = 5_000;

/** How this copy got onto the machine, which decides the command that updates it. */
export type InstallMethod = 'brew' | 'npm' | 'pnpm' | 'bun' | 'runner' | 'unknown';

export interface UpdateStatus {
  current: string;
  /** The newest version on npm, or undefined until the registry has answered once. */
  latest?: string;
  available: boolean;
  method: InstallMethod;
  /** What to type to get `latest`. */
  command: string;
  /** Where to read what changed. */
  notesUrl: string;
  /** False under `--offline`, where nothing is asked and nothing is known. */
  checked: boolean;
}

export interface UpdateCheckOptions {
  offline?: boolean;
  current?: string;
  method?: InstallMethod;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Whether a newer version is out, asked of the npm registry.
 *
 * One request at a time, at most one per `REFRESH_MS`, and only once something
 * asks — a tracker nobody looks at asks nothing. A failed request keeps the last
 * answer. `--offline` turns it off along with every other network call.
 */
export class UpdateCheck {
  readonly #offline: boolean;
  readonly #current: string;
  readonly #method: InstallMethod;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  #latest: string | undefined;
  #nextAt = Number.NEGATIVE_INFINITY;
  #inFlight: Promise<void> | undefined;

  constructor(options: UpdateCheckOptions = {}) {
    this.#offline = options.offline ?? false;
    this.#current = options.current ?? VERSION;
    this.#method = options.method ?? installMethod(process.argv[1]);
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  get method(): InstallMethod {
    return this.#method;
  }

  async status(): Promise<UpdateStatus> {
    if (!this.#offline) {
      if (!this.#inFlight && this.#now() >= this.#nextAt) {
        this.#inFlight = this.#request().finally(() => {
          this.#inFlight = undefined;
        });
      }
      await this.#inFlight;
    }

    const latest = this.#latest;
    return {
      current: this.#current,
      ...(latest ? { latest } : {}),
      available: latest !== undefined && compareVersions(latest, this.#current) > 0,
      method: this.#method,
      command: updateCommand(this.#method),
      notesUrl: SITE_URL,
      checked: !this.#offline,
    };
  }

  async #request(): Promise<void> {
    this.#nextAt = this.#now() + RETRY_MS;
    try {
      const response = await this.#fetch(LATEST_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return;
      const version = ((await response.json()) as { version?: unknown }).version;
      if (typeof version !== 'string' || parseVersion(version) === undefined) return;
      this.#latest = version;
      this.#nextAt = this.#now() + REFRESH_MS;
    } catch {
      // Offline, a timeout, a body that is not JSON: no news, which is not bad news.
    }
  }
}

/**
 * Where the running file lives says how it was installed.
 *
 * Followed through symlinks first, since every package manager links `bin` into
 * PATH from somewhere else. A source checkout matches none of these.
 */
export function installMethod(cli: string | undefined): InstallMethod {
  if (cli === undefined) return 'unknown';
  let path = cli;
  try {
    path = realpathSync(cli);
  } catch {
    // Judged as given.
  }
  if (path.includes(`${sep}Cellar${sep}`)) return 'brew';
  if (isOneOffCache(path)) return 'runner';
  if (!path.includes(`${sep}node_modules${sep}${PACKAGE}${sep}`)) return 'unknown';
  if (path.includes(`${sep}pnpm${sep}`) || path.includes(`${sep}.pnpm${sep}`)) return 'pnpm';
  if (path.includes(`${sep}.bun${sep}`)) return 'bun';
  return 'npm';
}

export function updateCommand(method: InstallMethod): string {
  switch (method) {
    case 'brew':
      return `brew upgrade ${FORMULA}`;
    case 'npm':
      return `npm install -g ${PACKAGE}@latest`;
    case 'pnpm':
      return `pnpm add -g ${PACKAGE}@latest`;
    case 'bun':
      return `bun add -g ${PACKAGE}@latest`;
    case 'runner':
    case 'unknown':
      return `npx ${PACKAGE}@latest`;
  }
}

/** Below zero when `a` is older, above when newer. A prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    const diff = left.parts[i]! - right.parts[i]!;
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

function parseVersion(version: string): { parts: number[]; pre?: string } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?/.exec(version.trim());
  if (!match) return undefined;
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], ...(match[4] ? { pre: match[4] } : {}) };
}
