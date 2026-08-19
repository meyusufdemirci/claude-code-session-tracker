#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createConfig, DEFAULT_HOST, DEFAULT_PORT } from './config.ts';
import { SessionRegistry } from './core/registry.ts';
import { createServer, listen } from './server.ts';
import { VERSION } from './version.ts';

const HELP = `
  claude-code-session-tracker ${VERSION}

  Lists every Claude Code session on this machine at a local web page.

  Usage
    $ npx claude-code-session-tracker [options]

  Options
    -p, --port <number>   Port to listen on, stepping forward if taken (default ${DEFAULT_PORT})
        --host <address>  Address to bind (default ${DEFAULT_HOST})
        --no-open         Do not open a browser
        --json            Print the session list as JSON and exit
        --claude-dir <p>  Override the Claude data directory (default $CLAUDE_CONFIG_DIR or ~/.claude)
    -h, --help            Show this message
    -v, --version         Show the version

  The server binds to loopback only and never writes to the Claude directory.
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
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
        'claude-dir': { type: 'string' },
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

  const config = createConfig({
    port,
    host: values.host ?? DEFAULT_HOST,
    claudeDir: values['claude-dir'],
  });

  const registry = new SessionRegistry(config);

  if (values.json) {
    process.stdout.write(`${JSON.stringify(await registry.list(), null, 2)}\n`);
    return 0;
  }

  const statuses = await registry.statuses();
  if (!statuses.some((source) => source.available)) {
    process.stderr.write(
      `No Claude Code data found at ${config.claudeDir}.\n` +
        'Set CLAUDE_CONFIG_DIR or pass --claude-dir if it lives elsewhere.\n',
    );
    return 1;
  }

  const server = createServer({ config, registry });
  const boundPort = await listen(server, config);
  const url = `http://${config.host}:${boundPort}`;

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

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? (['open', [url]] as const)
      : process.platform === 'win32'
        ? (['cmd', ['/c', 'start', '', url]] as const)
        : (['xdg-open', [url]] as const);

  try {
    const child = spawn(command, [...args], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // A missing browser opener is never a reason to fail; the URL is already printed.
  }
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
