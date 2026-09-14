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

function decodePorcelainValue(value) {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;

  const bytes = [];
  const escapes = new Map([
    ['a', 0x07], ['b', 0x08], ['t', 0x09], ['n', 0x0a],
    ['v', 0x0b], ['f', 0x0c], ['r', 0x0d], ['"', 0x22], ['\\', 0x5c],
  ]);
  for (let index = 1; index < value.length - 1;) {
    if (value[index] !== '\\') {
      const character = String.fromCodePoint(value.codePointAt(index));
      bytes.push(...Buffer.from(character));
      index += character.length;
      continue;
    }

    const escaped = value[index + 1];
    if (escapes.has(escaped)) {
      bytes.push(escapes.get(escaped));
      index += 2;
      continue;
    }
    const octal = value.slice(index + 1).match(/^[0-7]{3}/)?.[0];
    if (!octal) throw new Error('Invalid quoted value in Git worktree output.');
    bytes.push(Number.parseInt(octal, 8));
    index += 4;
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseWorktrees(output) {
  const worktrees = [];
  let current = null;
  let hasMetadata = false;
  const finishRecord = () => {
    if (current) worktrees.push(current);
    current = null;
    hasMetadata = false;
  };

  const delimiter = output.includes('\0') ? '\0' : '\n';
  for (const line of output.split(delimiter)) {
    if (!line) {
      if (delimiter === '\0' || hasMetadata) finishRecord();
      else if (current) current.path += '\n';
      continue;
    }
    const separator = line.indexOf(' ');
    const attribute = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1);
    if (attribute === 'worktree') {
      if (current && !hasMetadata && delimiter === '\n') {
        current.path += `\n${line}`;
      } else {
        finishRecord();
        current = { path: decodePorcelainValue(value), branch: null };
      }
    } else if (attribute === 'HEAD' && current) {
      hasMetadata = true;
    } else if (attribute === 'branch' && current) {
      const reference = decodePorcelainValue(value);
      current.branch = reference.startsWith('refs/heads/')
        ? reference.slice('refs/heads/'.length)
        : null;
    } else if (current && !hasMetadata && delimiter === '\n') {
      current.path += `\n${line}`;
    } else if ((attribute === 'bare' || attribute === 'detached') && current) {
      hasMetadata = true;
    }
  }
  finishRecord();
  return worktrees;
}

async function worktreeRoot(repositoryPath) {
  return realpath(await git(repositoryPath, [
    'rev-parse', '--path-format=absolute', '--show-toplevel',
  ]));
}

async function findRegisteredWorktree(worktrees, requestedPath) {
  let canonicalPath;
  try {
    canonicalPath = await realpath(requestedPath);
  } catch {
    return null;
  }

  for (const worktree of worktrees) {
    try {
      if (await realpath(worktree.path) === canonicalPath) return { ...worktree, canonicalPath };
    } catch {
      // Missing, prunable worktrees cannot be safely removed through this operation.
    }
  }
  return null;
}

async function conflictingWorktree(repositoryPath, branch) {
  const currentPath = await worktreeRoot(repositoryPath);
  const worktrees = await listWorktrees(repositoryPath);
  for (const worktree of worktrees) {
    if (worktree.branch !== branch) continue;
    try {
      if (await realpath(worktree.path) === currentPath) continue;
    } catch {
      // A registered but inaccessible worktree still prevents a safe branch switch.
    }
    return worktree;
  }
  return null;
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

export async function listWorktrees(repositoryPath) {
  await requireRepository(repositoryPath);
  let output;
  try {
    output = await git(repositoryPath, ['worktree', 'list', '--porcelain', '-z']);
  } catch {
    // Git versions before NUL-delimited worktree output still have a stable
    // record-oriented porcelain format, but require handling path continuations.
    output = await git(repositoryPath, ['worktree', 'list', '--porcelain']);
  }
  return parseWorktrees(output);
}

export async function removeWorktree(repositoryPath, worktreePath) {
  await requireRepository(repositoryPath);
  if (typeof worktreePath !== 'string' || !worktreePath) {
    throw new ProjectError('invalid_worktree', 'An existing worktree path is required.');
  }

  const registeredPath = await worktreeRoot(repositoryPath);
  let worktree = await findRegisteredWorktree(await listWorktrees(repositoryPath), worktreePath);
  if (!worktree) {
    throw new ProjectError('invalid_worktree', 'An existing worktree path is required.');
  }
  if (worktree.canonicalPath === registeredPath) {
    throw new ProjectError('registered_worktree', 'The registered project worktree cannot be removed.');
  }
  await requireClean(worktree.canonicalPath);

  // Re-resolve the registration after checking cleanliness. Git performs its own
  // final dirty-worktree check, and removal is deliberately never forced.
  worktree = await findRegisteredWorktree(await listWorktrees(repositoryPath), worktree.canonicalPath);
  if (!worktree || worktree.canonicalPath === registeredPath) {
    throw new ProjectError('git_state_changed', 'Git worktree state changed before removal.');
  }
  try {
    await git(repositoryPath, ['worktree', 'remove', worktree.path]);
  } catch {
    throw new ProjectError('worktree_remove_failed', 'Could not safely remove the Git worktree.');
  }
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

  let conflict = await conflictingWorktree(repositoryPath, branch);
  if (conflict) {
    throw new ProjectError(
      'branch_in_use',
      `Branch is checked out in another worktree: ${conflict.path}`,
    );
  }

  // Branch validation can take time in a queued action; cleanliness is checked again
  // immediately before switching so local changes are never carried across branches.
  await requireRepository(repositoryPath);
  await requireClean(repositoryPath);
  conflict = await conflictingWorktree(repositoryPath, branch);
  if (conflict) {
    throw new ProjectError(
      'branch_in_use',
      `Branch is checked out in another worktree: ${conflict.path}`,
    );
  }
  try {
    await git(repositoryPath, ['switch', '--no-guess', branch]);
  } catch {
    conflict = await conflictingWorktree(repositoryPath, branch);
    if (conflict) {
      throw new ProjectError(
        'branch_in_use',
        `Branch is checked out in another worktree: ${conflict.path}`,
      );
    }
    throw new ProjectError('switch_failed', 'Could not switch Git branches.');
  }
}
