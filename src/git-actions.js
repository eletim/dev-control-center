import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
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

function parseNulWorktrees(output) {
  const worktrees = [];
  let current = null;
  const finishRecord = () => {
    if (current) worktrees.push(current);
    current = null;
  };

  for (const field of output.split('\0')) {
    if (!field) {
      finishRecord();
      continue;
    }
    const separator = field.indexOf(' ');
    const attribute = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? '' : field.slice(separator + 1);
    if (attribute === 'worktree') {
      finishRecord();
      current = { path: value, branch: null };
    } else if (attribute === 'branch' && current) {
      current.branch = value.startsWith('refs/heads/')
        ? value.slice('refs/heads/'.length)
        : null;
    } else if (attribute === 'locked' && current) {
      current.locked = true;
      current.lockReason = value;
    }
  }
  finishRecord();
  return worktrees;
}

function stripFinalNewline(value) {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

function branchFromHead(value) {
  const head = stripFinalNewline(value);
  const prefix = 'ref: refs/heads/';
  return head.startsWith(prefix) ? head.slice(prefix.length) : null;
}

async function mainWorktree(repositoryPath) {
  const commonDirectory = await repositoryIdentity(repositoryPath);
  const currentGitDirectory = await realpath(await git(repositoryPath, [
    'rev-parse', '--path-format=absolute', '--git-dir',
  ]));
  let mainPath;
  let mainBranch;
  if (currentGitDirectory === commonDirectory) {
    mainPath = await worktreeRoot(repositoryPath);
    mainBranch = branchFromHead(await readFile(path.join(commonDirectory, 'HEAD'), 'utf8'));
  } else {
    let configuredWorktree = null;
    try {
      configuredWorktree = await git(repositoryPath, [
        'config', '-z', '--path', '--get', 'core.worktree',
      ]);
      if (configuredWorktree.endsWith('\0')) configuredWorktree = configuredWorktree.slice(0, -1);
    } catch {
      // Ordinary repositories infer their main worktree from the .git directory.
    }
    const isBare = await git(repositoryPath, [
      `--git-dir=${commonDirectory}`, 'rev-parse', '--is-bare-repository',
    ]) === 'true';
    mainPath = configuredWorktree
      ? path.resolve(commonDirectory, configuredWorktree)
      : isBare ? commonDirectory : path.dirname(commonDirectory);
    mainBranch = isBare
      ? null
      : branchFromHead(await readFile(path.join(commonDirectory, 'HEAD'), 'utf8'));
  }

  return { commonDirectory, path: mainPath, branch: mainBranch };
}

async function metadataWorktrees(repositoryPath) {
  const { commonDirectory, ...main } = await mainWorktree(repositoryPath);
  const worktrees = [main];
  let entries;
  try {
    entries = await readdir(path.join(commonDirectory, 'worktrees'), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return worktrees;
    throw error;
  }

  for (const entry of entries.filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const administrationPath = path.join(commonDirectory, 'worktrees', entry.name);
    const gitFile = stripFinalNewline(await readFile(path.join(administrationPath, 'gitdir'), 'utf8'));
    const head = await readFile(path.join(administrationPath, 'HEAD'), 'utf8');
    const worktree = { path: path.dirname(gitFile), branch: branchFromHead(head) };
    try {
      worktree.lockReason = stripFinalNewline(await readFile(path.join(administrationPath, 'locked'), 'utf8'));
      worktree.locked = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    worktrees.push(worktree);
  }
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

export async function repositoryIdentity(repositoryPath) {
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
  try {
    const output = await git(repositoryPath, ['worktree', 'list', '--porcelain', '-z']);
    return parseNulWorktrees(output);
  } catch {
    // Newline-delimited porcelain cannot represent every valid path unambiguously.
    // Older Git versions are read through their per-worktree metadata instead.
    return metadataWorktrees(repositoryPath);
  }
}

function pathContains(rootPath, candidatePath) {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === '' || (relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

async function belongsToRepository(worktreePath, expectedIdentity) {
  try {
    return await repositoryIdentity(worktreePath) === expectedIdentity
      && await worktreeRoot(worktreePath) === await realpath(worktreePath);
  } catch {
    return false;
  }
}

export async function listProjectWorktrees(projectPath) {
  const worktrees = await listWorktrees(projectPath);
  const canonicalProjectPath = await realpath(projectPath);
  const identity = await repositoryIdentity(projectPath);
  return Promise.all(worktrees.map(async (worktree) => {
    let isProjectWorktree = false;
    try {
      isProjectWorktree = pathContains(await realpath(worktree.path), canonicalProjectPath);
    } catch {
      // Missing worktrees remain visible but cannot contain the project.
    }
    let clean = null;
    if (await belongsToRepository(worktree.path, identity)) {
      try {
        clean = (await git(worktree.path, ['status', '--porcelain'])) === '';
      } catch {
        // The worktree may have disappeared after identity was checked.
      }
    }
    return { ...worktree, isProjectWorktree, clean };
  }));
}

export async function openWorktree(repositoryPath, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath) {
    throw new ProjectError('invalid_worktree', 'An existing worktree path is required.');
  }
  const worktree = await findRegisteredWorktree(await listWorktrees(repositoryPath), requestedPath);
  if (!worktree || !await belongsToRepository(worktree.path, await repositoryIdentity(repositoryPath))) {
    throw new ProjectError('invalid_worktree', 'Worktree no longer belongs to this repository.');
  }
  return worktree.canonicalPath;
}

export async function createWorktree(repositoryPath, input) {
  await requireRepository(repositoryPath);
  const { path: worktreePath, branch, createBranch } = input ?? {};
  if (typeof worktreePath !== 'string' || !path.isAbsolute(worktreePath)) {
    throw new ProjectError('invalid_worktree', 'An absolute worktree path is required.');
  }
  const destination = path.resolve(worktreePath);
  if (typeof branch !== 'string' || branch.trim() !== branch || !branch || branch === '-'
    || !await isSuccessfulGit(repositoryPath, ['check-ref-format', '--branch', branch])) {
    throw new ProjectError('invalid_branch', 'A valid local branch name is required.');
  }
  if (typeof createBranch !== 'boolean') {
    throw new ProjectError('invalid_input', 'Choose whether to create a new branch.');
  }
  const exists = await isSuccessfulGit(repositoryPath, [
    'show-ref', '--verify', '--quiet', `refs/heads/${branch}`,
  ]);
  if (exists === createBranch) {
    throw new ProjectError('invalid_branch', createBranch
      ? 'That local branch already exists.' : 'That local branch does not exist.');
  }
  try {
    await lstat(destination);
    throw new ProjectError('worktree_path_exists', 'Worktree path already exists.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await git(repositoryPath, createBranch
      ? ['worktree', 'add', '-b', branch, destination]
      : ['worktree', 'add', destination, branch]);
  } catch {
    throw new ProjectError('worktree_create_failed', 'Could not create the Git worktree.');
  }
  return destination;
}

async function removableWorktree(repositoryPath, worktreePath, protectedPaths) {
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
  let mainPath;
  try {
    mainPath = await realpath((await mainWorktree(repositoryPath)).path);
  } catch {
    throw new ProjectError('git_state_changed', 'Git worktree state changed before removal.');
  }
  if (worktree.canonicalPath === mainPath) {
    throw new ProjectError('main_worktree', 'The repository main worktree cannot be removed.');
  }
  for (const protectedPath of protectedPaths) {
    let canonicalProtectedPath;
    try {
      canonicalProtectedPath = await realpath(protectedPath);
    } catch {
      canonicalProtectedPath = path.resolve(protectedPath);
    }
    if (pathContains(worktree.canonicalPath, canonicalProtectedPath)) {
      throw new ProjectError('registered_worktree', 'A registered project uses this Git worktree.');
    }
  }
  if (worktree.locked) {
    throw new ProjectError('locked_worktree', `Git worktree is locked${worktree.lockReason ? `: ${worktree.lockReason}` : '.'}`);
  }
  await requireClean(worktree.canonicalPath);

  return worktree;
}

export async function removeWorktree(repositoryPath, worktreePath, protectedPaths = []) {
  let worktree = await removableWorktree(repositoryPath, worktreePath, protectedPaths);
  const registeredPath = await worktreeRoot(repositoryPath);

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

export async function previewWorktreeRemoval(repositoryPath, protectedPaths = []) {
  const targets = [];
  const retained = [];
  for (const worktree of await listWorktrees(repositoryPath)) {
    try {
      await removableWorktree(repositoryPath, worktree.path, protectedPaths);
      targets.push(worktree);
    } catch (error) {
      retained.push({ ...worktree, reason: error instanceof ProjectError ? error.message : 'Could not safely inspect the Git worktree.' });
    }
  }
  return { targets, retained };
}

export async function removeAllWorktrees(repositoryPath, paths, protectedPaths = []) {
  if (!Array.isArray(paths) || paths.some((value) => typeof value !== 'string' || !value)) {
    throw new ProjectError('invalid_input', 'Confirmed worktree paths are required.');
  }
  const removed = [];
  const reasons = new Map();
  for (const worktreePath of new Set(paths)) {
    try {
      await removeWorktree(repositoryPath, worktreePath, protectedPaths);
      removed.push(worktreePath);
    } catch (error) {
      reasons.set(worktreePath, error instanceof ProjectError ? error.message : 'Could not safely remove the Git worktree.');
    }
  }
  const remaining = await previewWorktreeRemoval(repositoryPath, protectedPaths);
  const retained = [...remaining.retained, ...remaining.targets].map((worktree) => ({
    ...worktree,
    reason: reasons.get(worktree.path) || worktree.reason || 'Not included in the confirmed targets.',
  }));
  return { removed, retained };
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
