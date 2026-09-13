import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fetchRepository, listBranches, switchBranch, updateRepository } from '../src/git-actions.js';

const execFileAsync = promisify(execFile);

async function git(repositoryPath, ...args) {
  const { stdout } = await execFileAsync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' });
  return stdout.trim();
}

async function commitFile(repositoryPath, filename, contents, message) {
  await writeFile(path.join(repositoryPath, filename), contents);
  await git(repositoryPath, 'add', filename);
  await git(repositoryPath, 'commit', '-m', message);
}

async function createRepository() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dcc-git-actions-'));
  await git(directory, 'init', '-q', '-b', 'main');
  await git(directory, 'config', 'user.name', 'Dev Control Center Test');
  await git(directory, 'config', 'user.email', 'test@example.invalid');
  await commitFile(directory, 'README.md', 'initial\n', 'initial');
  return directory;
}

async function createRemotePair() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dcc-git-remote-'));
  const remote = path.join(directory, 'remote.git');
  const source = path.join(directory, 'source');
  const checkout = path.join(directory, 'checkout');
  await execFileAsync('git', ['init', '-q', '--bare', remote]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await git(source, 'config', 'user.name', 'Dev Control Center Test');
  await git(source, 'config', 'user.email', 'test@example.invalid');
  await commitFile(source, 'README.md', 'initial\n', 'initial');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-u', 'origin', 'main');
  await execFileAsync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  await execFileAsync('git', ['clone', '-q', remote, checkout]);
  await git(checkout, 'config', 'user.name', 'Dev Control Center Test');
  await git(checkout, 'config', 'user.email', 'test@example.invalid');
  return { source, checkout };
}

test('discovers and switches only existing local branches from a clean worktree', async () => {
  const repository = await createRepository();
  await git(repository, 'branch', 'topic');

  assert.deepEqual(await listBranches(repository), ['main', 'topic']);
  await switchBranch(repository, 'topic');
  assert.equal(await git(repository, 'branch', '--show-current'), 'topic');

  await writeFile(path.join(repository, 'untracked.txt'), 'local work\n');
  await assert.rejects(switchBranch(repository, 'main'), { code: 'dirty_worktree' });
  assert.equal(await git(repository, 'branch', '--show-current'), 'topic');
  await unlink(path.join(repository, 'untracked.txt'));
  await assert.rejects(switchBranch(repository, '--detach'), { code: 'invalid_branch' });
  await assert.rejects(switchBranch(repository, 'missing'), { code: 'invalid_branch' });
});

test('fetches remotes and updates only by fast-forwarding the configured upstream', async () => {
  const { source, checkout } = await createRemotePair();
  const originalHead = await git(checkout, 'rev-parse', 'HEAD');
  await commitFile(source, 'remote.txt', 'remote\n', 'remote update');
  await git(source, 'push');

  await fetchRepository(checkout);
  assert.notEqual(await git(checkout, 'rev-parse', 'origin/main'), originalHead);
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), originalHead);

  await updateRepository(checkout);
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), await git(source, 'rev-parse', 'HEAD'));

  await commitFile(checkout, 'local.txt', 'local\n', 'local update');
  await updateRepository(checkout);
  const divergentHead = await git(checkout, 'rev-parse', 'HEAD');
  await commitFile(source, 'another-remote.txt', 'remote again\n', 'another remote update');
  await git(source, 'push');
  await assert.rejects(updateRepository(checkout), { code: 'non_fast_forward' });
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), divergentHead);
});

test('refuses updates with local changes and actions outside a worktree repository', async () => {
  const { checkout } = await createRemotePair();
  await writeFile(path.join(checkout, 'dirty.txt'), 'dirty\n');
  await assert.rejects(updateRepository(checkout), { code: 'dirty_worktree' });

  const directory = await mkdtemp(path.join(os.tmpdir(), 'dcc-not-git-'));
  await assert.rejects(listBranches(directory), { code: 'not_repository' });
  await assert.rejects(fetchRepository(directory), { code: 'not_repository' });
  await assert.rejects(updateRepository(directory), { code: 'not_repository' });
  await assert.rejects(switchBranch(directory, 'main'), { code: 'not_repository' });
});
