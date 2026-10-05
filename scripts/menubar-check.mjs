// Installs a freshly built menu bar app the way `menubar install` does and checks
// that it runs.
//
// The unit tests stand in for ditto, open and the rest, so they prove the order
// things happen in and nothing about macOS. This is the other half: the real zip,
// the real programs, and an app that has to start. Only the download is replaced,
// by the zip on disk, since a build under test has no release to fetch from.
//
//   node scripts/menubar-check.mjs <zip> [applications-dir]
//
// With no folder given it installs to /Applications, as a user's run would, and
// removes it again at the end. macOS only.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { APP_NAME, menubar } from '../src/menubar.ts';

const [zipArg, appsArg = '/Applications'] = process.argv.slice(2);
if (!zipArg) {
  console.error('usage: node scripts/menubar-check.mjs <zip> [applications-dir]');
  process.exit(2);
}
if (process.platform !== 'darwin') {
  console.error('The menu bar app only runs on macOS.');
  process.exit(2);
}

const zip = readFileSync(resolve(zipArg));
const apps = resolve(appsArg);
const app = join(apps, APP_NAME);
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const asset = { asset: basename(zipArg), sha256: createHash('sha256').update(zip).digest('hex'), size: zip.length };

let said = '';
const io = { out: (text) => (said += text), err: (text) => (said += text) };
const env = (body) => ({ systemApps: apps, home: homedir(), version, asset, fetch: async () => new Response(body) });
const command = async (action, body = zip) => {
  said = '';
  return menubar([action], io, env(body));
};

const succeeds = (program, args) => {
  try {
    execFileSync(program, args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};
const running = () => succeeds('pgrep', ['-f', `${app}/Contents/MacOS/`]);
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

let failures = 0;
async function check(name, run) {
  try {
    await run();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : error}`);
  }
}
function expect(condition, what) {
  if (!condition) throw new Error(`${what}${said ? `\n${said}` : ''}`);
}

console.log(`\n  ${basename(zipArg)} · ${version} · ${app}\n`);

try {
  await check('install puts the app in place', async () => {
    expect((await command('install')) === 0, 'install failed');
    expect(existsSync(app), `nothing at ${app}`);
  });

  await check('its signature survived the zip and the copy', () => {
    expect(succeeds('codesign', ['--verify', '--deep', '--strict', app]), 'codesign does not verify it');
  });

  // The whole reason an app without a Developer ID opens without a prompt.
  await check('nothing marked it as downloaded', () => {
    expect(!succeeds('xattr', ['-p', 'com.apple.quarantine', app]), 'it carries com.apple.quarantine');
  });

  await check('it carries the version it was installed as', () => {
    const built = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
    expect(built === version, `the app says ${built}, package.json says ${version}`);
  });

  // Long enough for an app that cannot start to have gone.
  await check('it started, and is still running ten seconds on', async () => {
    await sleep(10_000);
    expect(running(), 'no process is running from the installed app');
  });

  await check('status finds it', async () => {
    expect((await command('status')) === 0 && said.includes(app), 'status did not name the installed app');
  });

  await check('a tampered download is refused and the app left alone', async () => {
    const tampered = Buffer.from(zip);
    tampered[100] ^= 0xff;
    expect((await command('install', tampered)) === 1, 'the tampered zip was installed');
    expect(running(), 'the running app was stopped');
    expect(succeeds('codesign', ['--verify', '--deep', '--strict', app]), 'the installed app was changed');
  });

  await check('installing again replaces it and starts it again', async () => {
    expect((await command('install')) === 0 && said.includes('Updated'), 'the second install did not update');
    await sleep(3_000);
    expect(running(), 'no process is running after the update');
  });
} finally {
  await check('uninstall stops it and removes it', async () => {
    expect((await command('uninstall')) === 0, 'uninstall failed');
    expect(!existsSync(app), `${app} is still there`);
    expect(!running(), 'the app is still running');
  });
}

console.log(failures ? `\n  ${failures} check(s) failed\n` : '\n  all checks passed\n');
process.exit(failures ? 1 : 0);
