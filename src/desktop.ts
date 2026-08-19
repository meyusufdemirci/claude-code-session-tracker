import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

/**
 * Asking the desktop to do something on the user's behalf.
 *
 * The two things in the tool that reach outside the process, kept together because
 * they share the same rules: spawn detached so nothing is waited on, pass arguments
 * as an array so there is no shell to inject into, and treat every failure as
 * nothing happening — a missing file manager is never a reason to fail a request.
 */

/** Open a URL in whatever the user's default browser is. */
export function openBrowser(url: string): void {
  run(
    process.platform === 'darwin'
      ? { command: 'open', args: [url] }
      : process.platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'start', '', url] }
        : { command: 'xdg-open', args: [url] },
  );
}

/**
 * Show a file in the platform's file manager, selected rather than opened.
 *
 * Linux has no portable "reveal", so it gets the containing folder — the nearest
 * honest equivalent.
 */
export function revealInFileManager(path: string): void {
  run(
    process.platform === 'darwin'
      ? { command: 'open', args: ['-R', path] }
      : process.platform === 'win32'
        ? // Explorer parses its own command line, so Node must not re-quote it:
          // `/select,` and the path have to arrive as one already-quoted argument.
          { command: 'explorer.exe', args: [`/select,"${path}"`], verbatimOnWindows: true }
        : { command: 'xdg-open', args: [dirname(path)] },
  );
}

function run({
  command,
  args,
  verbatimOnWindows = false,
}: {
  command: string;
  args: string[];
  verbatimOnWindows?: boolean;
}): void {
  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      ...(verbatimOnWindows ? { windowsVerbatimArguments: true } : {}),
    });
    // Explorer exits non-zero even when it worked, and a missing opener raises
    // `error` asynchronously. Neither is something the caller can act on.
    child.on('error', () => {});
    child.unref();
  } catch {
    // Spawning is best-effort by design.
  }
}
