// Installs the packed tarball the way a user would and checks what comes back.
//
// A published package is a different thing from a source tree: it has to resolve
// with four package managers, link an executable `bin`, load as ESM, and find its
// own web assets from wherever the installer put it. None of that is exercised by
// running `src/` — only by installing the tarball, which is what this does.
//
//   node scripts/smoke.mjs <tarball> [npm|pnpm|yarn|bun]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = 'claude-code-session-tracker';
const [tarballArg, manager = 'npm'] = process.argv.slice(2);

if (!tarballArg) {
  console.error('usage: node scripts/smoke.mjs <tarball> [npm|pnpm|yarn|bun]');
  process.exit(2);
}

const tarball = resolve(tarballArg);
if (!existsSync(tarball)) throw new Error(`No tarball at ${tarball}`);

const INSTALL = {
  npm: ['npm', ['install', tarball, '--no-audit', '--no-fund']],
  pnpm: ['pnpm', ['add', tarball]],
  yarn: ['yarn', ['add', tarball]],
  bun: ['bun', ['add', tarball]],
};

const install = INSTALL[manager];
if (!install) throw new Error(`Unknown package manager: ${manager}`);

const probe = mkdtempSync(join(tmpdir(), 'cst-smoke-'));
let failures = 0;

function check(name, run) {
  try {
    run();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : error}`);
  }
}

function equal(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

try {
  console.log(`\n  ${manager} · node ${process.version} · ${probe}\n`);

  // Written rather than `<manager> init` because each one writes a different file,
  // and only one field here matters: that this is not a package we publish.
  const probePkg = { name: 'cst-smoke', version: '0.0.0', private: true };
  // A bare temp project has no packageManager pin, so an unpinned `pnpm add` lets
  // Corepack fetch whatever is "latest" on the registry — which has outrun what
  // older Node majors in the CI matrix can run. Pin the same pnpm this repo pins.
  if (manager === 'pnpm') {
    const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const rootPkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
    probePkg.packageManager = rootPkg.packageManager;
  }
  writeFileSync(join(probe, 'package.json'), JSON.stringify(probePkg, null, 2));
  // Yarn 4 defaults to Plug'n'Play, which has no `node_modules/.bin` to run.
  // Yarn 1 ignores this file, so it is safe to write either way.
  writeFileSync(join(probe, '.yarnrc.yml'), 'nodeLinker: node-modules\n');

  const [command, args] = install;
  execFileSync(command, args, { cwd: probe, stdio: 'inherit', shell: process.platform === 'win32' });

  const installed = join(probe, 'node_modules', BIN);
  const meta = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));

  // Windows gets a `.cmd` shim; everywhere else the shebang and the executable bit
  // are what make the file runnable, and both come from the tarball.
  const shim = join(probe, 'node_modules', '.bin', process.platform === 'win32' ? `${BIN}.cmd` : BIN);
  const cli = (cliArgs) =>
    execFileSync(shim, cliArgs, { cwd: probe, encoding: 'utf8', shell: process.platform === 'win32' });

  check('bin is linked and executable', () => {
    if (!existsSync(shim)) throw new Error(`no shim at ${shim}`);
    if (process.platform !== 'win32') accessSync(shim, constants.X_OK);
  });

  check('no install scripts ran', () => {
    for (const field of ['postinstall', 'preinstall', 'install', 'prepare']) {
      if (meta.scripts?.[field]) throw new Error(`published package has a ${field} script`);
    }
  });

  check('has no runtime dependencies', () => {
    const deps = Object.keys(meta.dependencies ?? {});
    if (deps.length) throw new Error(`depends on ${deps.join(', ')}`);
  });

  check('--version prints the package version', () => {
    equal(cli(['--version']).trim(), meta.version, 'version');
  });

  check('--help lists the flags', () => {
    const help = cli(['--help']);
    for (const flag of ['--json', '--port', '--claude-dir', '--no-open']) {
      if (!help.includes(flag)) throw new Error(`help does not mention ${flag}`);
    }
  });

  // A transcript is the only thing the tool needs to have something to say. This
  // one carries a title, a prompt and a turn with usage — the three record shapes
  // the list endpoint reads.
  const claudeDir = join(probe, 'claude');
  const slug = '-tmp-smoke-project';
  const sessionId = '11111111-2222-3333-4444-555555555555';
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  mkdirSync(join(claudeDir, 'projects', slug), { recursive: true });
  const at = '2026-01-01T00:00:00.000Z';
  writeFileSync(
    join(claudeDir, 'projects', slug, `${sessionId}.jsonl`),
    [
      { type: 'user', sessionId, cwd: '/tmp/smoke-project', timestamp: at, message: { role: 'user', content: 'count the sessions' } },
      { type: 'ai-title', sessionId, timestamp: at, aiTitle: 'A smoke test session' },
      { type: 'assistant', sessionId, cwd: '/tmp/smoke-project', gitBranch: 'main', version: '2.1.235', timestamp: at,
        message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 11, output_tokens: 7 }, content: [{ type: 'text', text: 'four' }] } },
      'this line is not JSON and must be skipped',
    ].map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n',
  );

  check('--json reads a transcript', () => {
    const result = JSON.parse(cli(['--json', '--claude-dir', claudeDir]));
    equal(Array.isArray(result.sessions), true, 'sessions is an array');
    equal(result.sessions.length, 1, 'session count');
    equal(result.sessions[0].id, sessionId, 'session id');
    equal(result.sessions[0].title, 'A smoke test session', 'title');
    equal(result.sessions[0].project.name, 'smoke-project', 'project name');
    equal(result.sessions[0].project.gitBranch, 'main', 'branch');
    equal(result.sessions[0].model, 'claude-sonnet-5', 'model');
  });

  check('--json on a machine with no Claude data is empty, not an error', () => {
    const result = JSON.parse(cli(['--json', '--claude-dir', join(probe, 'nowhere')]));
    equal(result.sessions.length, 0, 'session count');
    equal(result.total, 0, 'total');
  });
} finally {
  rmSync(probe, { recursive: true, force: true });
}

console.log(failures ? `\n  ${failures} check(s) failed\n` : '\n  all checks passed\n');
process.exit(failures ? 1 : 0);
