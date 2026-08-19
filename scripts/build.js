// Copies static web assets next to the compiled server and makes the CLI executable.
// Kept as a plain script so the package needs no build-time dependencies beyond tsc.
import { chmodSync, cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const from = fileURLToPath(new URL('src/web/', root));
const to = fileURLToPath(new URL('dist/web/', root));
const cli = fileURLToPath(new URL('dist/cli.js', root));

cpSync(from, to, { recursive: true });

if (!existsSync(cli)) {
  console.error('dist/cli.js is missing — did tsc run?');
  process.exit(1);
}
chmodSync(cli, 0o755);

console.log('built  dist/cli.js  dist/web/');
