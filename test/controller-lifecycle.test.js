import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const repositoryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function waitFor(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await pause(25);
  }
  throw new Error('Timed out waiting for condition.');
}

function spawnController(dataFile, processFile) {
  return spawn(process.execPath, ['src/index.js'], {
    cwd: repositoryPath,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DCC_DATA_FILE: dataFile, DCC_PROCESS_FILE: processFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function startController(dataFile, processFile) {
  const child = spawnController(dataFile, processFile);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const port = await waitFor(() => output.match(/127\.0\.0\.1:(\d+)/)?.[1]);
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

function groupIsAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

test('reconciles survivors after controller restart and stops groups on graceful shutdown', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dcc-controller-'));
  const projectPath = path.join(directory, 'project');
  const dataFile = path.join(directory, 'projects.json');
  const processFile = path.join(directory, 'processes.json');
  await mkdir(projectPath);
  const command = `exec env -i ${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(() => {}, 1000)')}`;
  const project = { id: 'managed-project', path: projectPath, startCommand: command };
  await writeFile(dataFile, `${JSON.stringify([project])}\n`);

  const controllers = [];
  let lastProcessGroup = null;
  t.after(async () => {
    for (const controller of controllers) {
      if (controller.exitCode === null) controller.kill('SIGKILL');
    }
    if (lastProcessGroup && groupIsAlive(lastProcessGroup)) process.kill(-lastProcessGroup, 'SIGKILL');
  });

  const first = await startController(dataFile, processFile);
  controllers.push(first.child);
  const started = await fetch(`${first.baseUrl}/api/projects/${project.id}/start`, { method: 'POST' });
  assert.equal(started.status, 200);
  lastProcessGroup = await waitFor(async () => JSON.parse(await readFile(processFile, 'utf8'))[0]?.processGroupId);

  const competingController = spawnController(dataFile, processFile);
  controllers.push(competingController);
  const [competingExitCode] = await once(competingController, 'exit');
  assert.notEqual(competingExitCode, 0);
  assert.equal(JSON.parse(await readFile(processFile, 'utf8')).length, 1);
  assert.equal((await fetch(`${first.baseUrl}/api/projects/${project.id}`).then((response) => response.json())).status, 'running');

  first.child.kill('SIGKILL');
  await once(first.child, 'exit');
  assert.equal(groupIsAlive(lastProcessGroup), true);

  const second = await startController(dataFile, processFile);
  controllers.push(second.child);
  const reconciled = await fetch(`${second.baseUrl}/api/projects/${project.id}`).then((response) => response.json());
  assert.equal(reconciled.status, 'running');
  assert.equal((await fetch(`${second.baseUrl}/api/projects/${project.id}/start`, { method: 'POST' })).status, 409);
  assert.equal((await fetch(`${second.baseUrl}/api/projects/${project.id}`, { method: 'DELETE' })).status, 409);

  assert.equal((await fetch(`${second.baseUrl}/api/projects/${project.id}/stop`, { method: 'POST' })).status, 200);
  assert.equal(groupIsAlive(lastProcessGroup), false);
  assert.equal((await fetch(`${second.baseUrl}/api/projects/${project.id}/start`, { method: 'POST' })).status, 200);
  lastProcessGroup = await waitFor(async () => JSON.parse(await readFile(processFile, 'utf8'))[0]?.processGroupId);

  second.child.kill('SIGTERM');
  const [exitCode, signal] = await once(second.child, 'exit');
  assert.equal(exitCode, 0);
  assert.equal(signal, null);
  assert.equal(groupIsAlive(lastProcessGroup), false);

  const third = await startController(dataFile, processFile);
  controllers.push(third.child);
  const afterGracefulRestart = await fetch(`${third.baseUrl}/api/projects/${project.id}`).then((response) => response.json());
  assert.equal(afterGracefulRestart.status, 'stopped');
  third.child.kill('SIGTERM');
  await once(third.child, 'exit');
  lastProcessGroup = null;
});
