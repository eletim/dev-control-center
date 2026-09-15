import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');

function runWithInput(file, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${file} exited with ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

async function launcherFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dcc-start-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await copyFile(path.join(repositoryRoot, 'start.sh'), path.join(root, 'start.sh'));
  await copyFile(path.join(repositoryRoot, 'sample_config.sh'), path.join(root, 'sample_config.sh'));
  await writeFile(path.join(bin, 'npm'), `#!/bin/sh
printf '%s\\n' "npm:$*" "cwd:$PWD" "host:\${HOST-unset}" "port:\${PORT-unset}"
`);
  await chmod(path.join(root, 'start.sh'), 0o755);
  await chmod(path.join(bin, 'npm'), 0o755);
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  return { root, env: { PATH: `${bin}:${process.env.PATH}` } };
}

test('starts with application defaults when config.sh is absent', async (t) => {
  const fixture = await launcherFixture(t);
  const { stdout } = await execFileAsync(path.join(fixture.root, 'start.sh'), {
    cwd: tmpdir(),
    env: fixture.env,
  });

  assert.equal(stdout, `npm:start\ncwd:${fixture.root}\nhost:unset\nport:unset\n`);
  await assert.rejects(readFile(path.join(fixture.root, 'config.sh')), { code: 'ENOENT' });
});

test('loads config.sh while preserving environment overrides', async (t) => {
  const fixture = await launcherFixture(t);
  await writeFile(path.join(fixture.root, 'config.sh'), `export HOST="\${HOST:-192.0.2.1}"
export PORT="\${PORT:-4100}"
`);

  const { stdout } = await execFileAsync(path.join(fixture.root, 'start.sh'), {
    env: { ...fixture.env, HOST: '127.0.0.9' },
  });

  assert.match(stdout, /host:127\.0\.0\.9/);
  assert.match(stdout, /port:4100/);
});

test('--configure creates a config from interactive answers before starting', async (t) => {
  const fixture = await launcherFixture(t);
  const { stdout } = await runWithInput(path.join(fixture.root, 'start.sh'), ['--configure'], {
    env: fixture.env,
  }, 'localhost\n4200\n');

  const config = await readFile(path.join(fixture.root, 'config.sh'), 'utf8');
  assert.match(config, /HOST="\$\{HOST:-localhost\}"/);
  assert.match(config, /PORT="\$\{PORT:-4200\}"/);
  assert.match(stdout, /host:localhost/);
  assert.match(stdout, /port:4200/);
});

test('--configure uses the public listen address and port 8023 by default', async (t) => {
  const fixture = await launcherFixture(t);
  const { stdout } = await runWithInput(path.join(fixture.root, 'start.sh'), ['--configure'], {
    env: fixture.env,
  }, '\n\n');

  const config = await readFile(path.join(fixture.root, 'config.sh'), 'utf8');
  assert.match(config, /HOST="\$\{HOST:-0\.0\.0\.0\}"/);
  assert.match(config, /PORT="\$\{PORT:-8023\}"/);
  assert.match(stdout, /host:0\.0\.0\.0/);
  assert.match(stdout, /port:8023/);
});
