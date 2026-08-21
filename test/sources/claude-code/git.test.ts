import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readGitBranch } from '../../../src/sources/claude-code/git.ts';
import { makeDir, makeFile, tempDir } from '../../helpers/temp.ts';

const SHA = 'a'.repeat(40);

describe('readGitBranch', () => {
  it('reads the branch a repository is on right now', async (t) => {
    // Deliberately not from the transcript: that only knows the branch as of its
    // last message, and a running session should show where it is now.
    const dir = await tempDir(t);
    await makeFile(dir, '.git/HEAD', 'ref: refs/heads/development\n');

    strictEqual(await readGitBranch(dir), 'development');
  });

  it('keeps slashes in a branch name', async (t) => {
    const dir = await tempDir(t);
    await makeFile(dir, '.git/HEAD', 'ref: refs/heads/feature/token-column\n');

    strictEqual(await readGitBranch(dir), 'feature/token-column');
  });

  it('walks up from a directory nested inside the repository', async (t) => {
    // A session's cwd is often several levels below the root.
    const dir = await tempDir(t);
    await makeFile(dir, '.git/HEAD', 'ref: refs/heads/main\n');
    const deep = await makeDir(dir, 'packages/web/src');

    strictEqual(await readGitBranch(deep), 'main');
  });

  it('shows the commit when HEAD is detached', async (t) => {
    // Mid-rebase or on a tag. The raw commit beats an empty column.
    const dir = await tempDir(t);
    await makeFile(dir, '.git/HEAD', `${SHA}\n`);

    strictEqual(await readGitBranch(dir), `${SHA.slice(0, 7)} (detached)`);
  });

  it('follows the pointer a worktree leaves behind', async (t) => {
    // In a worktree or submodule `.git` is a file, not a directory.
    const dir = await tempDir(t);
    const real = await makeDir(dir, 'actual-git-dir');
    await makeFile(dir, 'actual-git-dir/HEAD', 'ref: refs/heads/worktree-branch\n');
    const work = await makeDir(dir, 'work');
    await makeFile(dir, 'work/.git', `gitdir: ${real}\n`);

    strictEqual(await readGitBranch(work), 'worktree-branch');
  });

  it('resolves a relative worktree pointer against the file that holds it', async (t) => {
    const dir = await tempDir(t);
    await makeFile(dir, 'store/HEAD', 'ref: refs/heads/relative\n');
    const work = await makeDir(dir, 'work');
    await makeFile(dir, 'work/.git', 'gitdir: ../store\n');

    strictEqual(await readGitBranch(work), 'relative');
  });

  it('gives up on a pointer that leads nowhere', async (t) => {
    const dir = await tempDir(t);
    const work = await makeDir(dir, 'work');
    await makeFile(dir, 'work/.git', 'not a gitdir line at all\n');

    strictEqual(await readGitBranch(work), undefined);
  });

  it('reports no branch rather than failing when there is no repository', async (t) => {
    // Sessions run in plenty of directories that are not repositories.
    const dir = await tempDir(t);

    strictEqual(await readGitBranch(dir), undefined);
  });

  it('reports no branch when the repository has no HEAD to read', async (t) => {
    // A `.git` directory mid-clone, or one we are not allowed to read into.
    const dir = await tempDir(t);
    await makeDir(dir, '.git/objects');

    strictEqual(await readGitBranch(dir), undefined);
  });

  it('reports no branch for a HEAD it cannot read', async (t) => {
    const dir = await tempDir(t);
    await makeFile(dir, '.git/HEAD', '');
    strictEqual(await readGitBranch(dir), undefined);

    const other = await tempDir(t);
    await makeFile(other, '.git/HEAD', 'something unexpected\n');
    strictEqual(await readGitBranch(other), undefined);
  });
});
