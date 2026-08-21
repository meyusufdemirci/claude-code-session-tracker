import { strictEqual } from 'node:assert/strict';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { createConfig, DEFAULT_HOST, DEFAULT_PORT, resolveClaudeDir } from '../src/config.ts';

describe('resolveClaudeDir', () => {
  it('defaults to ~/.claude', () => {
    strictEqual(resolveClaudeDir({}), join(homedir(), '.claude'));
  });

  it('lets CLAUDE_CONFIG_DIR win', () => {
    strictEqual(resolveClaudeDir({ CLAUDE_CONFIG_DIR: '/opt/claude' }), '/opt/claude');
  });

  it('takes the first of a comma-separated list', () => {
    // Some Claude Code versions accept several directories there; the first is the
    // one it actually writes to.
    strictEqual(resolveClaudeDir({ CLAUDE_CONFIG_DIR: '/opt/a,/opt/b' }), '/opt/a');
  });

  it('makes a relative override absolute', () => {
    const resolved = resolveClaudeDir({ CLAUDE_CONFIG_DIR: './claude' });
    strictEqual(isAbsolute(resolved), true);
    strictEqual(resolved, resolve('./claude'));
  });

  it('ignores an empty or blank setting', () => {
    strictEqual(resolveClaudeDir({ CLAUDE_CONFIG_DIR: '' }), join(homedir(), '.claude'));
    strictEqual(resolveClaudeDir({ CLAUDE_CONFIG_DIR: '   ' }), join(homedir(), '.claude'));
  });
});

describe('createConfig', () => {
  it('derives every path from the one directory', () => {
    const config = createConfig({ claudeDir: '/opt/claude' });

    strictEqual(config.claudeDir, '/opt/claude');
    strictEqual(config.sessionsDir, join('/opt/claude', 'sessions'));
    strictEqual(config.projectsDir, join('/opt/claude', 'projects'));
  });

  it('keeps the rollup file in the home directory, not the data directory', () => {
    // `~/.claude.json` is a sibling of `~/.claude`, and stays there even when the
    // data directory has been moved elsewhere.
    const config = createConfig({ claudeDir: '/opt/claude' });

    strictEqual(config.claudeJsonPath, join(homedir(), '.claude.json'));
  });

  it('serves loopback on a fixed port unless told otherwise', () => {
    const defaults = createConfig();
    strictEqual(defaults.host, DEFAULT_HOST);
    strictEqual(defaults.port, DEFAULT_PORT);

    const overridden = createConfig({ host: '0.0.0.0', port: 8080 });
    strictEqual(overridden.host, '0.0.0.0');
    strictEqual(overridden.port, 8080);
  });
});
