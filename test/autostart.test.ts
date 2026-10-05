import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import {
  buildLauncherScript,
  buildPlist,
  isInGuardedFolder,
  isOneOffCache,
  LABEL,
  launcherScriptPath,
  plistPath,
  resolveLauncher,
  runKeyCommand,
  windowsLogPath,
  windowsPidPath,
} from '../src/autostart.ts';
import { makeFile, tempDir } from './helpers/temp.ts';

describe('isOneOffCache', () => {
  it('recognises what npx, pnpm dlx, yarn dlx and bunx unpack', () => {
    ok(isOneOffCache('/Users/a/.npm/_npx/1a2b/node_modules/claude-code-session-tracker/dist/cli.js'));
    ok(isOneOffCache('/Users/a/Library/Caches/pnpm/dlx/abc/node_modules/claude-code-session-tracker/dist/cli.js'));
    ok(isOneOffCache('/private/var/folders/x/xfs-1234/dlx-5/node_modules/claude-code-session-tracker/dist/cli.js'));
    ok(isOneOffCache('/var/tmp/bunx-501-claude-code-session-tracker/node_modules/claude-code-session-tracker/dist/cli.js'));
    ok(isOneOffCache(join(tmpdir(), 'anything', 'cli.js')));
  });

  it('accepts an install that stays put', () => {
    strictEqual(isOneOffCache('/opt/homebrew/bin/claude-code-session-tracker'), false);
    strictEqual(isOneOffCache('/usr/local/lib/node_modules/claude-code-session-tracker/dist/cli.js'), false);
  });
});

describe('resolveLauncher', () => {
  it('keeps the paths as given, so a Homebrew link outlives an upgrade', () => {
    deepStrictEqual(resolveLauncher('/opt/homebrew/bin/node', '/opt/homebrew/bin/claude-code-session-tracker'), {
      node: '/opt/homebrew/bin/node',
      cli: '/opt/homebrew/bin/claude-code-session-tracker',
    });
  });

  it('refuses a copy npx fetched for one run', () => {
    const result = resolveLauncher('/usr/local/bin/node', '/Users/a/.npm/_npx/1a2b/node_modules/.bin/claude-code-session-tracker');
    ok('error' in result);
    match(result.error, /npm install -g/);
  });

  it('refuses when there is no script path', () => {
    ok('error' in resolveLauncher('/usr/local/bin/node', undefined));
  });
});

describe('the macOS login item', () => {
  const launcher = { node: '/opt/homebrew/bin/node', cli: '/opt/homebrew/bin/claude-code-session-tracker' };

  it('runs a script named after the project, so Login Items shows that name', () => {
    strictEqual(
      launcherScriptPath('/Users/a'),
      '/Users/a/Library/Application Support/claude-code-session-tracker/Claude Code Session Tracker',
    );
    match(buildPlist(launcher, '/Users/a'), /<array>\n\t\t<string>\/Users\/a\/Library\/Application Support\/claude-code-session-tracker\/Claude Code Session Tracker<\/string>\n\t<\/array>/);
  });

  it('finds node through PATH when the tracker can run on its own', () => {
    strictEqual(
      buildLauncherScript(launcher, true).split('\n')[2],
      "node=$(command -v node) || node='/opt/homebrew/bin/node'",
    );
  });

  it('uses the given node when the tracker cannot run on its own', () => {
    strictEqual(buildLauncherScript(launcher, false).split('\n')[2], "node='/opt/homebrew/bin/node'");
  });

  it('runs the tracker from a link to node named after it falling back to node', () => {
    const lines = buildLauncherScript(launcher, true).split('\n');
    strictEqual(lines.at(-3), `[ -x "$link" ] && exec "$link" '/opt/homebrew/bin/claude-code-session-tracker'`);
    strictEqual(lines.at(-2), `exec "$node" '/opt/homebrew/bin/claude-code-session-tracker'`);
    match(lines.join('\n'), /link="\$\(dirname "\$0"\)\/claude-code-session-tracker"/);
  });

  it('runs a copy in a guarded folder without the link', () => {
    const desktop = { node: '/opt/homebrew/bin/node', cli: '/Users/a/Desktop/tracker/dist/cli.js' };
    strictEqual(buildLauncherScript(desktop, true, false).split('\n').at(-2), "exec '/Users/a/Desktop/tracker/dist/cli.js'");
    strictEqual(buildLauncherScript(desktop, false, false).split('\n').at(-2), "exec '/opt/homebrew/bin/node' '/Users/a/Desktop/tracker/dist/cli.js'");
    strictEqual(buildLauncherScript(desktop, true, false).includes('link'), false);
  });

  it('knows the folders macOS guards', () => {
    ok(isInGuardedFolder('/Users/a/Desktop/tracker/dist/cli.js', '/Users/a'));
    ok(isInGuardedFolder('/Users/a/Documents/cli.js', '/Users/a'));
    ok(isInGuardedFolder('/Users/a/Library/Mobile Documents/com~apple~CloudDocs/cli.js', '/Users/a'));
    ok(isInGuardedFolder('/Volumes/Work/cli.js', '/Users/a'));
    strictEqual(isInGuardedFolder('/opt/homebrew/bin/claude-code-session-tracker', '/Users/a'), false);
    strictEqual(isInGuardedFolder('/Users/a/.npm-global/bin/claude-code-session-tracker', '/Users/a'), false);
  });

  it('quotes paths for the shell', () => {
    match(buildLauncherScript({ node: '/n', cli: "/it's here/cli.js" }, true), /exec "\$node" '\/it'\\''s here\/cli\.js'/);
  });

  it('never passes --no-open, so logging in opens the page', () => {
    strictEqual(buildLauncherScript(launcher, true).includes('--no-open'), false);
  });

  it('starts at login and logs to the user Logs folder', () => {
    const plist = buildPlist(launcher, '/Users/a');
    match(plist, new RegExp(`<string>${LABEL}</string>`));
    match(plist, /<key>RunAtLoad<\/key>\n\t<true\/>/);
    match(plist, /<string>\/Users\/a\/Library\/Logs\/claude-code-session-tracker\.log<\/string>/);
  });

  it('gives the shebang a PATH that finds node', () => {
    match(buildPlist(launcher, '/Users/a'), /<string>\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin<\/string>/);
  });

  it('restarts only after a crash', () => {
    match(buildPlist(launcher, '/Users/a'), /<key>SuccessfulExit<\/key>\n\t\t<false\/>/);
  });

  it('escapes paths for XML', () => {
    match(buildPlist({ node: '/n/node', cli: '/a & b/cli.js' }, '/Users/a'), /\/a &amp; b/);
  });

  it('lives in the user LaunchAgents folder', () => {
    strictEqual(plistPath('/Users/a'), `/Users/a/Library/LaunchAgents/${LABEL}.plist`);
  });
});

/**
 * The launcher run for real, by `sh`, against a stand-in for node: a script that
 * prints the name it was started as, so the output says whether the link ran.
 * Homebrew's layout is `bin/node` linked to a Cellar `bin/node` with `lib/libnode`
 * beside it; a node in one file has nothing there.
 */
describe('the macOS launcher, run', { skip: process.platform === 'win32' }, () => {
  async function run(t: TestContext, withLibnode: boolean) {
    const dir = await tempDir(t);
    const real = await makeFile(dir, 'Cellar/node/1.0.0/bin/node', '#!/bin/sh\necho "$0 $1"\n');
    chmodSync(real, 0o755);
    if (withLibnode) await makeFile(dir, 'Cellar/node/1.0.0/lib/libnode.147.dylib');
    const node = join(dir, 'bin', 'node');
    await makeFile(dir, 'bin/.keep');
    symlinkSync(real, node);

    const script = await makeFile(dir, 'Application Support/launcher', buildLauncherScript({ node, cli: '/cli.js' }, false, true));
    const link = join(dir, 'Application Support', 'claude-code-session-tracker');
    const output = execFileSync('sh', [script], { encoding: 'utf8' }).trim();
    return { output, link, node };
  }

  it('runs a node with libnode beside it directly, without a link', async (t) => {
    const { output, link, node } = await run(t, true);
    strictEqual(output, `${node} /cli.js`);
    strictEqual(existsSync(link), false);
  });

  it('runs a node in one file from the link named after the tracker', async (t) => {
    const { output, link } = await run(t, false);
    strictEqual(output, `${link} /cli.js`);
    ok(existsSync(link));
  });
});

describe('Windows', () => {
  it('starts through autostart launch, so no console stays open', () => {
    strictEqual(
      runKeyCommand({ node: 'C:\\Program Files\\nodejs\\node.exe', cli: 'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\claude-code-session-tracker\\dist\\cli.js' }),
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\claude-code-session-tracker\\dist\\cli.js" autostart launch',
    );
  });

  it('logs under LOCALAPPDATA', () => {
    strictEqual(windowsLogPath({ LOCALAPPDATA: '/L' }), join('/L', 'claude-code-session-tracker', 'tracker.log'));
  });

  it('keeps the pid it started beside the log, so off can stop it', () => {
    strictEqual(windowsPidPath({ LOCALAPPDATA: '/L' }), join('/L', 'claude-code-session-tracker', 'tracker.pid'));
  });
});
