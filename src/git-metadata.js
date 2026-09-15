import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

  const [branchResult, statusResult, upstreamResult] = await Promise.allSettled([
    git(path, ['branch', '--show-current']),
    git(path, ['status', '--porcelain']),
    git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
  ]);

  const branch = branchResult.status === 'fulfilled' && branchResult.value
    ? branchResult.value
    : null;
  const clean = statusResult.status === 'fulfilled'
    ? statusResult.value.length === 0
    : null;

  if (upstreamResult.status !== 'fulfilled') {
    return { isRepository: true, branch, clean, remote: null, ahead: null, behind: null };
  }

  const remote = upstreamResult.value;
  try {
    const counts = await git(path, ['rev-list', '--left-right', '--count', `HEAD...${remote}`]);
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    return { isRepository: true, branch, clean, remote, ahead, behind };
  } catch {
    return { isRepository: true, branch, clean, remote, ahead: null, behind: null };
  }
}
