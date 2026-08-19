import { readFileSync } from 'node:fs';

/** Version from package.json, which sits one level above both `src/` and `dist/`. */
export const VERSION: string = (() => {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
