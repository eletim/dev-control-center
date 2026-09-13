import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectProcessManager } from '../src/project-process-manager.js';

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function waitFor(check, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await pause(20);
  }
  throw new Error('Timed out waiting for condition.');
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

test('starts one process group in the project path and stops its descendants', async (t) => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'dcc-process-'));
  await mkdir(path.join(projectPath, 'nested'));
  const parentPidFile = path.join(projectPath, 'parent.pid');
  const childPidFile = path.join(projectPath, 'child.pid');
  const cwdFile = path.join(projectPath, 'cwd.txt');
  const script = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    `writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid))`,
    "writeFileSync('cwd.txt', process.cwd())",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify("require('node:fs').writeFileSync(" + JSON.stringify(childPidFile) + ", String(process.pid)); setInterval(() => {}, 1000)")}], { stdio: 'ignore' })`,
    'child.unref()',
    'setInterval(() => {}, 1000)',
  ].join(';');
  const project = { id: 'demo', path: projectPath, startCommand: `${shellQuote(process.execPath)} -e ${shellQuote(script)}` };
  const manager = new ProjectProcessManager({ stopTimeout: 250 });
  t.after(async () => {
    if (manager.isRunning(project.id)) await manager.stop(project.id);
  });

  await manager.start(project);
  assert.equal(manager.isRunning(project.id), true);
  const parentPid = Number(await waitFor(async () => readFile(parentPidFile, 'utf8')));
  assert.equal(pidIsAlive(parentPid), true);
  assert.equal(await readFile(cwdFile, 'utf8'), projectPath);
  const childPid = Number(await waitFor(async () => readFile(childPidFile, 'utf8')));
  assert.equal(pidIsAlive(childPid), true);
  await assert.rejects(manager.start(project), { code: 'already_running' });

  await manager.stop(project.id);
  assert.equal(manager.isRunning(project.id), false);
  await waitFor(() => !pidIsAlive(childPid));
  await assert.rejects(manager.stop(project.id), { code: 'not_running' });
});

test('restart replaces the managed process group', async (t) => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'dcc-restart-'));
  const project = {
    id: 'demo',
    path: projectPath,
    startCommand: `${shellQuote(process.execPath)} -e ${shellQuote('setInterval(() => {}, 1000)')}`,
  };
  const manager = new ProjectProcessManager({ stopTimeout: 250 });
  t.after(async () => {
    if (manager.isRunning(project.id)) await manager.stop(project.id);
  });

  await manager.start(project);
  const firstProcessGroup = manager.processes.get(project.id).processGroupId;
  await manager.restart(project);
  assert.equal(manager.isRunning(project.id), true);
  assert.notEqual(manager.processes.get(project.id).processGroupId, firstProcessGroup);
});

test('tracks and stops a command that clears its environment', async (t) => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'dcc-empty-env-'));
  const pidFile = path.join(projectPath, 'process.pid');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const project = {
    id: 'empty-env',
    path: projectPath,
    startCommand: `exec env -i ${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
  };
  const manager = new ProjectProcessManager({ stopTimeout: 250 });
  let pid;
  t.after(async () => {
    if (manager.isRunning(project.id)) await manager.stopAll();
    if (pid && pidIsAlive(pid)) process.kill(pid, 'SIGKILL');
  });

  await manager.start(project);
  pid = Number(await waitFor(async () => readFile(pidFile, 'utf8')));
  assert.equal(manager.isRunning(project.id), true);
  await assert.rejects(manager.start(project), { code: 'already_running' });
  await manager.stop(project.id);
  await waitFor(() => !pidIsAlive(pid));
});

test('reports stopped when the managed command exits on its own', async () => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'dcc-exit-'));
  const project = {
    id: 'short-lived',
    path: projectPath,
    startCommand: `${shellQuote(process.execPath)} -e ${shellQuote('process.exit(0)')}`,
  };
  const manager = new ProjectProcessManager();

  await manager.start(project);
  await waitFor(() => !manager.isRunning(project.id));
  assert.equal(manager.isRunning(project.id), false);
});

test('rejects commands that fail immediately', async () => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'dcc-failed-start-'));
  const manager = new ProjectProcessManager({ startupDelay: 100 });

  for (const [id, startCommand] of [
    ['missing', 'command-that-does-not-exist-dcc'],
    ['nonzero', `${shellQuote(process.execPath)} -e ${shellQuote('process.exit(23)')}`],
  ]) {
    await assert.rejects(manager.start({ id, path: projectPath, startCommand }), { code: 'start_failed' });
    assert.equal(manager.isRunning(id), false);
  }
});

test('shutdown seals lifecycle work, drains a queued start, and stops it', async (t) => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'dcc-shutdown-'));
  const project = {
    id: 'queued-start',
    path: projectPath,
    startCommand: `${shellQuote(process.execPath)} -e ${shellQuote('setInterval(() => {}, 1000)')}`,
  };
  const manager = new ProjectProcessManager({ stopTimeout: 250 });
  let releaseMutation;
  const mutationGate = new Promise((resolve) => { releaseMutation = resolve; });
  const mutation = manager.withProjectLock(project.id, () => mutationGate);
  const starting = manager.start(project);
  t.after(async () => {
    if (manager.isRunning(project.id)) await manager.stopAll();
  });

  manager.beginShutdown();
  assert.throws(() => manager.start({ ...project, id: 'late-start' }), { code: 'shutting_down' });
  releaseMutation();
  await mutation;
  await manager.drain();
  await starting;
  assert.equal(manager.isRunning(project.id), true);

  await manager.stopAll();
  assert.equal(manager.isRunning(project.id), false);
});
