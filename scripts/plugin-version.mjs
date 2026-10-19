// Gives the Claude Code plugin the version in package.json.
//
// Run by `npm version`, between the bump and the commit, so the tag that releases
// the package also carries a plugin of the same version. Claude Code reads the
// plugin's version to decide whether an installed copy is out of date, so one that
// stayed behind would leave people on the old skills.
//
// The skills fall back to `npx` when the CLI is not installed, and name this exact
// version there: the plugin directory refuses a launcher that runs `@latest`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const manifest = new URL('plugin/.claude-plugin/plugin.json', root);
const skills = new URL('plugin/skills/', root);

const { name, version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const plugin = JSON.parse(readFileSync(manifest, 'utf8'));

if (plugin.version !== version) {
  plugin.version = version;
  writeFileSync(manifest, `${JSON.stringify(plugin, null, 2)}\n`);
}

// The auto continue hook falls back to `npx` the same way, and is pinned the same way.
const pinnable = [...readdirSync(skills).map((skill) => new URL(`${skill}/SKILL.md`, skills)), new URL('plugin/hooks/hooks.json', root)];
for (const file of pinnable) {
  const text = readFileSync(file, 'utf8');
  const pinned = text.replaceAll(new RegExp(`${name}@[^\\s)]+`, 'g'), `${name}@${version}`);
  if (pinned !== text) writeFileSync(file, pinned);
}
console.log(`plugin  ${plugin.name} ${version}`);
