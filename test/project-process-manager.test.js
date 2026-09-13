import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectWindowName, ProjectProcessManager } from '../src/project-process-manager.js';

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const processSupervisorPath = fileURLToPath(new URL('../src/process-supervisor.js', import.meta.url));
let managerNumber = 0;
const createManager = (options = {}) => new ProjectProcessManager({
  ...options,
  sessionName: `dcc-process-test-${process.pid}-${managerNumber += 1}`,
});

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

test('derives safe stable window names with collision-resistant project identities', () => {
  const first = { id: 'project-one', path: '/work/My Project!' };
  const second = { id: 'project-two', path: '/other/My Project!' };

  assert.match(projectWindowName(first), /^my-project-[a-f0-9]{12}$/);
  assert.equal(projectWindowName(first), projectWindowName({ ...first }));
  assert.notEqual(projectWindowName(first), projectWindowName(second));
  assert.match(projectWindowName({ id: 'unicode', path: '/work/日本語' }), /^project-[a-f0-9]{12}$/);
});

test('discards stale state when a restarted tmux server reuses window and pane IDs', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dcc-reused-tmux-id-'));
  const stateFile = path.join(directory, 'processes.json');
  const socketName = `dcc-reuse-test-${process.pid}`;
  const sessionName = `dcc-reuse-session-${process.pid}`;
  const project = {
    id: 'managed-project',
    path: directory,
    startCommand: 'sleep 20',
  };
  let recoveredManager;
  t.after(() => {
    recoveredManager?.releaseStateLock();
    try {
      execFileSync('tmux', ['-L', socketName, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // The isolated server may already be gone.
    }
  });

  const firstManager = new ProjectProcessManager({
    stateFile,
    sessionName,
    tmuxSocketName: socketName,
  });
  await firstManager.start(project);
  const original = { ...firstManager.processes.get(project.id) };
  firstManager.releaseStateLock();
  execFileSync('tmux', ['-L', socketName, 'kill-server']);

  const reused = execFileSync('tmux', [
    '-L', socketName, 'new-session', '-d', '-P', '-F', '#{session_id}\t#{window_id}\t#{pane_id}',
    '-s', sessionName, '-n', original.windowName, 'sleep 20',
  ], { encoding: 'utf8' }).trim().split('\t');
  assert.deepEqual(reused, [original.sessionId, original.windowId, original.paneId]);
  execFileSync('tmux', [
    '-L', socketName, 'set-option', '-p', '-t', original.paneId, '@dcc_owner_token', 'unrelated-owner',
  ]);
  const unrelatedPid = Number(execFileSync('tmux', [
    '-L', socketName, 'display-message', '-p', '-t', original.paneId, '#{pane_pid}',
  ], { encoding: 'utf8' }).trim());

  recoveredManager = new ProjectProcessManager({
    stateFile,
    sessionName,
    tmuxSocketName: socketName,
  });
  assert.equal(recoveredManager.processes.has(project.id), false);
  assert.equal(recoveredManager.isRunning(project.id), false);
  await recoveredManager.stopAll();
  assert.doesNotThrow(() => process.kill(unrelatedPid, 0));
});

test('recovers a command launched after only pending ownership was persisted', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dcc-pending-start-'));
  const stateFile = path.join(directory, 'processes.json');
  const socketName = `dcc-pending-test-${process.pid}`;
  const sessionName = `dcc-pending-session-${process.pid}`;
  const project = { id: 'pending-project', path: directory };
  const pending = {
    id: project.id,
    pending: true,
    sessionName,
    windowName: projectWindowName(project),
    token: 'c8f0b563-83a2-45c3-b9ae-6cc0ed6f79cb',
  };
  await writeFile(stateFile, `${JSON.stringify([pending], null, 2)}\n`);
  const [sessionId, windowId, paneId] = execFileSync('tmux', [
    '-L', socketName, 'new-session', '-d', '-P', '-F', '#{session_id}\t#{window_id}\t#{pane_id}',
    '-s', sessionName, '-n', pending.windowName,
  ], { encoding: 'utf8' }).trim().split('\t');
  execFileSync('tmux', ['-L', socketName, 'set-option', '-p', '-t', paneId, '@dcc_owner_token', pending.token]);
  execFileSync('tmux', ['-L', socketName, 'set-option', '-p', '-t', paneId, '@dcc_command_started', pending.token]);
  execFileSync('tmux', ['-L', socketName, 'respawn-pane', '-k', '-t', paneId, 'exec sleep 20']);

  const manager = new ProjectProcessManager({ stateFile, sessionName, tmuxSocketName: socketName });
  t.after(async () => {
    await manager.stopAll();
    manager.releaseStateLock();
    try {
      execFileSync('tmux', ['-L', socketName, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // stopAll normally removes the isolated server's last window.
    }
  });

  assert.equal(manager.isRunning(project.id), true);
  assert.deepEqual(manager.processes.get(project.id), {
    sessionName,
    sessionId,
    windowName: pending.windowName,
    windowId,
    paneId,
    token: pending.token,
  });
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8'))[0].pending, undefined);
});

test('removes a token-owned pending window when its command was not launched', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dcc-pending-setup-'));
  const stateFile = path.join(directory, 'processes.json');
  const socketName = `dcc-pending-setup-test-${process.pid}`;
  const sessionName = `dcc-pending-setup-session-${process.pid}`;
  const pending = {
    id: 'pending-setup-project',
    pending: true,
    sessionName,
    windowName: 'pending-setup-project-123456789abc',
    token: '956cf12b-3054-4793-9cb8-7613255b8cd3',
  };
  await writeFile(stateFile, `${JSON.stringify([pending], null, 2)}\n`);
  const paneId = execFileSync('tmux', [
    '-L', socketName, 'new-session', '-d', '-P', '-F', '#{pane_id}',
    '-s', sessionName, '-n', pending.windowName,
  ], { encoding: 'utf8' }).trim();
  execFileSync('tmux', ['-L', socketName, 'set-option', '-p', '-t', paneId, '@dcc_owner_token', pending.token]);

  const manager = new ProjectProcessManager({ stateFile, sessionName, tmuxSocketName: socketName });
  t.after(() => {
    manager.releaseStateLock();
    try {
      execFileSync('tmux', ['-L', socketName, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // Recovery normally removes the isolated server's only window.
    }
  });

  assert.equal(manager.processes.has(pending.id), false);
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), []);
  assert.throws(() => execFileSync('tmux', [
    '-L', socketName, 'display-message', '-p', '-t', paneId, '#{pane_id}',
  ], { stdio: 'ignore' }));
});

test('retains recovery state when tmux cannot be invoked', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dcc-query-recovery-'));
  const stateFile = path.join(directory, 'processes.json');
  const sessionName = `dcc-query-recovery-${process.pid}`;
  const project = { id: 'query-recovery', path: directory, startCommand: 'sleep 20' };
  const firstManager = new ProjectProcessManager({ stateFile, sessionName });
  let recoveredManager;
  t.after(async () => {
    if (recoveredManager) await recoveredManager.stopAll();
    else {
      try {
        execFileSync('tmux', ['kill-session', '-t', `=${sessionName}`], { stdio: 'ignore' });
      } catch {
        // The session may already be gone.
      }
    }
    recoveredManager?.releaseStateLock();
  });

  await firstManager.start(project);
  firstManager.releaseStateLock();
  const persisted = await readFile(stateFile, 'utf8');
  assert.throws(() => new ProjectProcessManager({
    stateFile,
    sessionName,
    tmuxPath: '/tmux-that-does-not-exist',
  }), /Could not query tmux.*not installed/);
  assert.equal(await readFile(stateFile, 'utf8'), persisted);

  recoveredManager = new ProjectProcessManager({ stateFile, sessionName });
  assert.equal(recoveredManager.isRunning(project.id), true);
});

test('retains ordinary status state when a tmux query fails', async (t) => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'dcc-query-status-'));
  const project = { id: 'query-status', path: projectPath, startCommand: 'sleep 20' };
  const manager = createManager();
  t.after(async () => {
    manager.tmuxPath = 'tmux';
    await manager.stopAll();
  });

  await manager.start(project);
  const managed = manager.processes.get(project.id);
  manager.tmuxPath = '/tmux-that-does-not-exist';
  assert.throws(() => manager.isRunning(project.id), /Could not query tmux.*not installed/);
  assert.equal(manager.processes.get(project.id), managed);
  manager.tmuxPath = 'tmux';
  assert.equal(manager.isRunning(project.id), true);
});

test('supervisor falls back to ps when procfs is unavailable', async (t) => {
  const startedAt = Date.now();
  const supervisor = spawn(process.execPath, [processSupervisorPath, 'sleep 0.25 &'], {
    detached: true,
    env: { ...process.env, DEV_CONTROL_CENTER_PROC_DIRECTORY: '/proc-that-does-not-exist' },
    stdio: 'ignore',
  });
  t.after(() => {
    if (supervisor.exitCode === null) process.kill(-supervisor.pid, 'SIGKILL');
  });

  const [exitCode, signal] = await once(supervisor, 'exit', { signal: AbortSignal.timeout(2000) });
  assert.equal(exitCode, 0);
  assert.equal(signal, null);
  assert.ok(Date.now() - startedAt >= 200);
});

test('accepts terminal input through the project tmux window', async (t) => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'dcc-interactive-'));
  const project = {
    id: 'interactive',
    path: projectPath,
    startCommand: 'read answer; printf "received:%s\\n" "$answer"; sleep 20',
  };
  const manager = createManager({ stopTimeout: 250 });
  t.after(() => manager.stopAll());

  await manager.start(project);
  const { paneId } = manager.processes.get(project.id);
  execFileSync('tmux', ['send-keys', '-t', paneId, 'hello-from-human', 'Enter']);
  const output = await waitFor(() => {
    const captured = execFileSync('tmux', ['capture-pane', '-p', '-S', '-', '-t', paneId], { encoding: 'utf8' });
    return captured.includes('received:hello-from-human') ? captured : null;
  });
  assert.match(output, /received:hello-from-human/);
});

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
  const manager = createManager({ stopTimeout: 250 });
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
  const manager = createManager({ stopTimeout: 250 });
  t.after(async () => {
    if (manager.isRunning(project.id)) await manager.stop(project.id);
  });

  await manager.start(project);
  const firstPane = manager.processes.get(project.id).paneId;
  await manager.restart(project);
  assert.equal(manager.isRunning(project.id), true);
  assert.notEqual(manager.processes.get(project.id).paneId, firstPane);
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
  const manager = createManager({ stopTimeout: 250 });
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

test('tracks and stops a server backgrounded by an exiting start command', async (t) => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'dcc-background-'));
  const pidFile = path.join(projectPath, 'server.pid');
  const project = {
    id: 'background-server',
    path: projectPath,
    startCommand: `sleep 20 & echo $! > ${shellQuote(pidFile)}`,
  };
  const manager = createManager({ stopTimeout: 250 });
  let pid;
  t.after(async () => {
    if (manager.isRunning(project.id)) await manager.stopAll();
    if (pid && pidIsAlive(pid)) process.kill(pid, 'SIGKILL');
  });

  await manager.start(project);
  pid = Number(await waitFor(async () => readFile(pidFile, 'utf8')));
  assert.equal(pidIsAlive(pid), true);
  assert.equal(manager.isRunning(project.id), true);
  await assert.rejects(manager.start(project), { code: 'already_running' });
  await manager.stop(project.id);
  await waitFor(() => !pidIsAlive(pid));
});

test('escalates to SIGKILL when a command process ignores SIGTERM', async (t) => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'dcc-term-resistant-'));
  const pidFile = path.join(projectPath, 'server.pid');
  const script = [
    "const { writeFileSync } = require('node:fs')",
    "process.on('SIGTERM', () => {})",
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
    'setInterval(() => {}, 1000)',
  ].join(';');
  const project = {
    id: 'term-resistant',
    path: projectPath,
    startCommand: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
  };
  const manager = createManager({ stopTimeout: 100, pollInterval: 10 });
  let pid;
  t.after(async () => {
    if (manager.isRunning(project.id)) await manager.stopAll();
    if (pid && pidIsAlive(pid)) process.kill(pid, 'SIGKILL');
  });

  await manager.start(project);
  pid = Number(await waitFor(async () => readFile(pidFile, 'utf8')));
  const stopStarted = Date.now();
  await manager.stop(project.id);
  assert.ok(Date.now() - stopStarted >= 80);
  await waitFor(() => !pidIsAlive(pid));
  assert.equal(manager.isRunning(project.id), false);
});

test('retains a completed command window and its output', async (t) => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'dcc-exit-'));
  const project = {
    id: 'short-lived',
    path: projectPath,
    startCommand: `${shellQuote(process.execPath)} -e ${shellQuote("console.log('retained output')")}`,
  };
  const manager = createManager();
  t.after(() => manager.stopAll());

  await manager.start(project);
  await waitFor(() => !manager.isRunning(project.id));
  assert.equal(manager.isRunning(project.id), false);
  const managed = manager.processes.get(project.id);
  assert.ok(managed);
  assert.match(execFileSync('tmux', ['capture-pane', '-p', '-S', '-', '-t', managed.paneId], { encoding: 'utf8' }), /retained output/);
  await manager.remove(project.id);
  assert.equal(manager.processes.has(project.id), false);
});

test('rejects commands that fail immediately and retains their windows', async (t) => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'dcc-failed-start-'));
  const manager = createManager({ startupDelay: 100 });
  t.after(() => manager.stopAll());

  for (const [id, startCommand] of [
    ['missing', 'command-that-does-not-exist-dcc'],
    ['nonzero', `${shellQuote(process.execPath)} -e ${shellQuote('process.exit(23)')}`],
  ]) {
    await assert.rejects(manager.start({ id, path: projectPath, startCommand }), { code: 'start_failed' });
    assert.equal(manager.isRunning(id), false);
    assert.ok(manager.processes.get(id));
  }
});

test('shutdown seals lifecycle work, drains a queued start, and stops it', async (t) => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'dcc-shutdown-'));
  const project = {
    id: 'queued-start',
    path: projectPath,
    startCommand: `${shellQuote(process.execPath)} -e ${shellQuote('setInterval(() => {}, 1000)')}`,
  };
  const manager = createManager({ stopTimeout: 250 });
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
