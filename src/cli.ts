#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { autostart } from './autostart.ts';
import { createConfig, DEFAULT_HOST, DEFAULT_PORT } from './config.ts';
import { SessionRegistry } from './core/registry.ts';
import { openBrowser } from './desktop.ts';
import { menubar } from './menubar.ts';
import { createServer, listen } from './server.ts';
import { VERSION } from './version.ts';

/** Anything else means the dashboard is reachable from off this machine. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const HELP = `
  claude-code-session-tracker ${VERSION}

  Lists every Claude Code session on this machine at a local web page.

  Usage
    $ npx claude-code-session-tracker [options]
    $ claude-code-session-tracker autostart on|off|status
    $ claude-code-session-tracker menubar install|uninstall|status

  Commands
    autostart on          Start at login and open the page (macOS and Windows)
    autostart off         Stop starting at login
    autostart status      Say whether it starts at login
    menubar install       Install the macOS menu bar app and widget, or update them
    menubar uninstall     Remove them
    menubar status        Say whether they are installed

  Options
    -p, --port <number>   Port to listen on, stepping forward if taken (default ${DEFAULT_PORT})
        --host <address>  Address to bind (default ${DEFAULT_HOST})
        --no-open         Do not open a browser
        --json            Print the session list as JSON and exit
    -n, --limit <number>  How many sessions to list (default 50, running ones are always shown)
        --claude-dir <p>  Override the Claude data directory (default $CLAUDE_CONFIG_DIR or ~/.claude)
        --offline         Never ask Anthropic's server for the usage limits
    -h, --help            Show this message
    -v, --version         Show the version

  The tracker's only network call is Claude Code's own usage endpoint at
  api.anthropic.com, asked with the token Claude Code is signed in with; --offline
  turns it off. \`menubar install\` is the one command that downloads anything: the
  app this version was published with, from this project's GitHub releases.
  Never writes to the Claude directory. Binds to loopback unless --host says
  otherwise, and refuses requests not addressed to a loopback host.
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] === 'autostart') return autostart(argv.slice(1));
  if (argv[0] === 'menubar') return menubar(argv.slice(1));

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        open: { type: 'boolean', default: true },
        'no-open': { type: 'boolean' },
        json: { type: 'boolean', default: false },
        limit: { type: 'string', short: 'n' },
        'claude-dir': { type: 'string' },
        offline: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write('Run with --help to see the available options.\n');
    return 1;
  }

  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    port = Number.parseInt(values.port, 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      process.stderr.write(`Invalid port: ${values.port}\n`);
      return 1;
    }
  }

  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number.parseInt(values.limit, 10);
    if (!Number.isInteger(limit) || limit < 1) {
      process.stderr.write(`Invalid limit: ${values.limit}\n`);
      return 1;
    }
  }

  const config = createConfig({
    port,
    host: values.host ?? DEFAULT_HOST,
    claudeDir: values['claude-dir'],
    offline: values.offline,
  });

  const registry = new SessionRegistry(config);

  if (values.json) {
    process.stdout.write(`${JSON.stringify(await registry.list({ limit }), null, 2)}\n`);
    return 0;
  }

  // Both of these are said and then carried on from. Starting anyway is the point:
  // the page polls, so a machine that has never run Claude Code fills in by itself
  // the moment the first session starts.
  const statuses = await registry.statuses();
  if (!statuses.some((source) => source.available)) {
    process.stderr.write(
      `\n  Warning  No Claude Code data at ${config.claudeDir}.\n` +
        '           Set CLAUDE_CONFIG_DIR or pass --claude-dir if it lives elsewhere.\n',
    );
  }

  // The loopback guard in the server is skipped once we are not on loopback, and
  // transcripts hold prompts, paths, and sometimes secrets. Nobody should reach that
  // point without being told.
  if (!LOOPBACK_HOSTS.has(config.host)) {
    process.stderr.write(
      `\n  Warning  Binding ${config.host}, not loopback.\n` +
        '           Anyone who can reach this port can read your transcripts.\n',
    );
  }

  // Otherwise `ps`, Activity Monitor and Task Manager's details list it as `node`.
  process.title = 'claude-code-session-tracker';

  const server = createServer({ config, registry });
  const boundPort = await listen(server, config);
  // The page reads its own limit from the query string, so `--limit` carries through.
  const url = `http://${config.host}:${boundPort}${limit === undefined ? '' : `/?limit=${limit}`}`;

  process.stdout.write(`\n  Claude Code sessions  ${url}\n  Reading  ${config.claudeDir}\n\n  Press Ctrl+C to stop.\n\n`);

  const shouldOpen = values['no-open'] ? false : values.open;
  if (shouldOpen) openBrowser(url);

  await new Promise<void>((resolveClose) => {
    const shutdown = (): void => {
      server.close(() => resolveClose());
      // Nothing long-lived is in flight yet; do not make Ctrl+C wait on keep-alives.
      server.closeAllConnections?.();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  return 0;
}

/** True when run as a binary, false when imported. npm links `bin` as a symlink, so resolve it. */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
