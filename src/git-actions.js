import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { ProjectError } from './project-store.js';

const execFileAsync = promisify(execFile);

async function git(repositoryPath, args) {
  const { stdout } = await execFileAsync('git', ['-C', repositoryPath, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  return stdout.trim();
}

async function isSuccessfulGit(repositoryPath, args) {
  try {
    await git(repositoryPath, args);
    return true;
  } catch {
    return false;
  }
}

async function requireRepository(repositoryPath) {
  let isRepository = false;
  try {
    isRepository = await git(repositoryPath, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    // The controlled error below deliberately avoids leaking Git command output.
  }
  if (!isRepository) {
    throw new ProjectError('not_repository', 'Project path is not a Git repository.');
  }
}

async function requireClean(repositoryPath) {
  if (await git(repositoryPath, ['status', '--porcelain'])) {
    throw new ProjectError('dirty_worktree', 'Git working tree must be clean.');
  }
}

async function repositoryIdentity(repositoryPath) {
  await requireRepository(repositoryPath);
  try {
    const commonDirectory = await git(repositoryPath, [
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ]);
    return await realpath(commonDirectory);
  } catch {
    throw new ProjectError('not_repository', 'Project path is not a Git repository.');
  }
}

export class GitActionManager {
  constructor() {
    this.queues = new Map();
  }

  async withRepositoryLock(repositoryPath, operation) {
    const identity = await repositoryIdentity(repositoryPath);
    const previous = this.queues.get(identity) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const tail = result.catch(() => {});
    this.queues.set(identity, tail);
    try {
      return await result;
    } finally {
      if (this.queues.get(identity) === tail) this.queues.delete(identity);
    }
  }
}

export async function listBranches(repositoryPath) {
  await requireRepository(repositoryPath);
  const output = await git(repositoryPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    '--sort=refname',
    'refs/heads',
  ]);
  return output ? output.split('\n') : [];
}

export async function fetchRepository(repositoryPath) {
  await requireRepository(repositoryPath);
  try {
    await git(repositoryPath, ['fetch', '--all', '--prune']);
  } catch {
    throw new ProjectError('fetch_failed', 'Could not fetch the Git remotes.');
  }
}

export async function updateRepository(repositoryPath) {
  await requireRepository(repositoryPath);
  await requireClean(repositoryPath);

  let branch;
  let upstream;
  try {
    branch = await git(repositoryPath, ['symbolic-ref', '--quiet', 'HEAD']);
    upstream = await git(repositoryPath, ['rev-parse', '--symbolic-full-name', '@{upstream}']);
  } catch {
    throw new ProjectError('no_upstream', 'Current branch has no configured upstream.');
  }

  try {
    await git(repositoryPath, ['fetch']);
  } catch {
    throw new ProjectError('fetch_failed', 'Could not fetch the Git remote.');
  }

  // Fetch can take time, so verify mutable preconditions again before updating HEAD.
  await requireRepository(repositoryPath);
  await requireClean(repositoryPath);
  let currentBranch;
  let currentUpstream;
  try {
    currentBranch = await git(repositoryPath, ['symbolic-ref', '--quiet', 'HEAD']);
    currentUpstream = await git(repositoryPath, ['rev-parse', '--symbolic-full-name', '@{upstream}']);
  } catch {
    throw new ProjectError('no_upstream', 'Current branch has no configured upstream.');
  }
  if (currentBranch !== branch || currentUpstream !== upstream) {
    throw new ProjectError('git_state_changed', 'Git branch or upstream changed while updating.');
  }

  if (await isSuccessfulGit(repositoryPath, ['merge-base', '--is-ancestor', 'HEAD', upstream])) {
    try {
      await git(repositoryPath, ['merge', '--ff-only', upstream]);
    } catch {
      throw new ProjectError('update_failed', 'Could not fast-forward the current branch.');
    }
    return;
  }

  if (await isSuccessfulGit(repositoryPath, ['merge-base', '--is-ancestor', upstream, 'HEAD'])) return;
  throw new ProjectError('non_fast_forward', 'Current branch cannot be updated with a fast-forward.');
}

export async function switchBranch(repositoryPath, branch) {
  await requireRepository(repositoryPath);
  await requireClean(repositoryPath);
  if (typeof branch !== 'string' || branch.trim() !== branch || !branch || branch === '-') {
    throw new ProjectError('invalid_branch', 'An existing local branch is required.');
  }

  const reference = `refs/heads/${branch}`;
  if (!await isSuccessfulGit(repositoryPath, ['check-ref-format', '--branch', branch])
    || !await isSuccessfulGit(repositoryPath, ['show-ref', '--verify', '--quiet', reference])) {
    throw new ProjectError('invalid_branch', 'An existing local branch is required.');
  }

  // Branch validation can take time in a queued action; cleanliness is checked again
  // immediately before switching so local changes are never carried across branches.
  await requireRepository(repositoryPath);
  await requireClean(repositoryPath);
  try {
    await git(repositoryPath, ['switch', '--no-guess', branch]);
  } catch {
    throw new ProjectError('switch_failed', 'Could not switch Git branches.');
  }
}
