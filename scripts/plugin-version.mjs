// Gives the Claude Code plugin the version in package.json.
//
// Run by `npm version`, between the bump and the commit, so the tag that releases
// the package also carries a plugin of the same version. Claude Code reads the
// plugin's version to decide whether an installed copy is out of date, so one that
// stayed behind would leave people on the old skills.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const manifest = new URL('plugin/.claude-plugin/plugin.json', root);

const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const plugin = JSON.parse(readFileSync(manifest, 'utf8'));

if (plugin.version !== version) {
  plugin.version = version;
  writeFileSync(manifest, `${JSON.stringify(plugin, null, 2)}\n`);
}
console.log(`plugin  ${plugin.name} ${version}`);
