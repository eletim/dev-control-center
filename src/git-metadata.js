import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repositoryIdentity } from './git-actions.js';

const execFileAsync = promisify(execFile);

async function git(path, args) {
  const { stdout } = await execFileAsync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  return stdout.trim();
}

export async function getGitMetadata(path) {
  try {
    if (await git(path, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
      return { isRepository: false };
    }
  } catch {
    return { isRepository: false };
  }

  const [branchResult, statusResult, upstreamResult, identityResult] = await Promise.allSettled([
    git(path, ['branch', '--show-current']),
    git(path, ['status', '--porcelain']),
    git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    repositoryIdentity(path),
  ]);

  const branch = branchResult.status === 'fulfilled' && branchResult.value
    ? branchResult.value
    : null;
  const clean = statusResult.status === 'fulfilled'
    ? statusResult.value.length === 0
    : null;
  const repositoryIdentityValue = identityResult.status === 'fulfilled'
    ? identityResult.value
    : null;
  const metadata = {
    isRepository: true,
    repositoryIdentity: repositoryIdentityValue,
    branch,
    clean,
  };

  if (upstreamResult.status !== 'fulfilled') {
    return { ...metadata, remote: null, ahead: null, behind: null };
  }

  const remote = upstreamResult.value;
  try {
    const counts = await git(path, ['rev-list', '--left-right', '--count', `HEAD...${remote}`]);
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    return { ...metadata, remote, ahead, behind };
  } catch {
    return { ...metadata, remote, ahead: null, behind: null };
  }
}
