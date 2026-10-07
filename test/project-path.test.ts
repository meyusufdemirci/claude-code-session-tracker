import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

const { formatProjectPath } = await import(new URL('../src/web/format.js', import.meta.url).href);
const { buildReport } = await import(new URL('../src/web/export.js', import.meta.url).href);

describe('project path presentation', () => {
  it('labels guesses while keeping recorded and resolved paths unchanged', () => {
    strictEqual(formatProjectPath({ path: '/my/app', pathResolved: false }),
      'Unresolved path (estimate): /my/app');
    strictEqual(formatProjectPath({ path: '/my-app', pathResolved: true }), '/my-app');
    strictEqual(formatProjectPath({ path: '/my-app' }), '/my-app');
  });

  it('preserves the warning in the report shared by PDF and spreadsheet exports', () => {
    const report = buildReport({
      range: { since: 0, until: 86400000 },
      generatedAt: 86400000,
      projects: [{ slug: '-my-app', name: 'app', path: '/my/app', pathResolved: false }],
    }, new Map());
    strictEqual(report.projects[0].path, 'Unresolved path (estimate): /my/app');
  });
});
