import { ok, strictEqual } from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// The plugin is a manifest and two prompts, with no code of its own to test. What
// can go wrong is it drifting from the package it runs: a version left behind, a
// marketplace pointing at a folder that moved, a skill calling a command that was
// renamed.

const root = new URL('../', import.meta.url);
const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(path, root), 'utf8')) as Record<string, unknown>;

const pkg = json('package.json');
const plugin = json('plugin/.claude-plugin/plugin.json');
const marketplace = json('.claude-plugin/marketplace.json') as { plugins: { name: string; source: string }[] };

describe('the Claude Code plugin', () => {
  it('carries the version of the package it runs', () => {
    strictEqual(plugin['version'], pkg['version'], 'run `node scripts/plugin-version.mjs`');
  });

  it('is the one plugin the marketplace lists, at the folder it names', () => {
    strictEqual(marketplace.plugins.length, 1);
    const listed = marketplace.plugins[0];
    strictEqual(listed?.name, plugin['name']);
    ok(existsSync(new URL(`${listed?.source}/.claude-plugin/plugin.json`, root)));
  });

  it('has a skill for each command, and each runs that command', () => {
    const skills = readdirSync(new URL('plugin/skills/', root)).sort();
    const cli = readFileSync(new URL('src/cli.ts', root), 'utf8');

    strictEqual(skills.join(), 'open,status');
    for (const skill of skills) {
      const prompt = readFileSync(new URL(`plugin/skills/${skill}/SKILL.md`, root), 'utf8');
      ok(prompt.includes(`claude-code-session-tracker ${skill}`), `${skill} runs the installed copy`);
      ok(prompt.includes(`npx -y claude-code-session-tracker@${String(pkg['version'])} ${skill}`), `${skill} falls back to npx at this version, run \`node scripts/plugin-version.mjs\``);
      ok(cli.includes(`argv[0] === '${skill}'`), `the CLI has a ${skill} command`);
    }
  });
});
