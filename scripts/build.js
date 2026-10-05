// Copies static web assets next to the compiled server and makes the CLI executable.
// Kept as a plain script so the package needs no build-time dependencies beyond tsc.
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
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

// A release builds the macOS menu bar app first and names its zip here, so the
// package carries the checksum of the app published beside it and can check what
// it later downloads. Any other build has no app to vouch for and writes nothing.
const appZip = process.env.MENUBAR_ZIP;
if (appZip) {
  const bytes = readFileSync(appZip);
  const asset = { asset: basename(appZip), sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  writeFileSync(fileURLToPath(new URL('dist/menubar.json', root)), `${JSON.stringify(asset, null, 2)}\n`);
}

console.log(`built  dist/cli.js  dist/web/${appZip ? '  dist/menubar.json' : ''}`);
