import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ProjectStore } from '../src/project-store.js';
import { ProjectProcessManager } from '../src/project-process-manager.js';
import { createAppServer } from '../src/server.js';

const execFileAsync = promisify(execFile);

async function withServer(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dcc-server-'));
  const projectPath = path.join(directory, 'demo');
  await mkdir(projectPath);
  await execFileAsync('git', ['init', '-q', projectPath]);
  const processManager = new ProjectProcessManager({
    stopTimeout: 250,
    sessionName: `dcc-server-test-${process.pid}-${path.basename(directory)}`,
  });
  const server = createAppServer(new ProjectStore(path.join(directory, 'projects.json')), processManager);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`, projectPath, processManager);
  } finally {
    await processManager.stopAll();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('serves the web app and CRUD API with derived fields', async () => {
  await withServer(async (baseUrl, projectPath) => {
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Dev Control Center/);

    const createdResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: projectPath, startCommand: 'node app.js', name: 'ignored' }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.name, 'demo');
    assert.equal(created.git.isRepository, true);
    assert.equal(created.startCommand, 'node app.js');

    const duplicate = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: projectPath, startCommand: 'run' }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error, 'duplicate_path');

    const updatedResponse = await fetch(`${baseUrl}/api/projects/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: projectPath, startCommand: 'npm start' }),
    });
    assert.equal(updatedResponse.status, 200);
    assert.equal((await updatedResponse.json()).startCommand, 'npm start');

    const deleted = await fetch(`${baseUrl}/api/projects/${created.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.deepEqual(await fetch(`${baseUrl}/api/projects`).then((response) => response.json()), []);
  });
});

test('controls project lifecycle and blocks running project mutations', async () => {
  await withServer(async (baseUrl, projectPath, processManager) => {
    const pidFile = path.join(projectPath, 'server.pid');
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)}`;
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: projectPath, startCommand: command }),
    }).then((response) => response.json());
    assert.equal(created.status, 'stopped');

    const startedResponse = await fetch(`${baseUrl}/api/projects/${created.id}/start`, { method: 'POST' });
    assert.equal(startedResponse.status, 200);
    assert.equal((await startedResponse.json()).status, 'running');
    assert.equal((await fetch(`${baseUrl}/api/projects/${created.id}/start`, { method: 'POST' })).status, 409);
    assert.equal((await fetch(`${baseUrl}/api/projects/${created.id}`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/projects/${created.id}`).then((response) => response.json())).status, 'running');

    const update = await fetch(`${baseUrl}/api/projects/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: projectPath, startCommand: 'other' }),
    });
    assert.equal(update.status, 409);
    assert.equal((await update.json()).error, 'project_running');
    assert.equal((await fetch(`${baseUrl}/api/projects/${created.id}`, { method: 'DELETE' })).status, 409);

    const restarted = await fetch(`${baseUrl}/api/projects/${created.id}/restart`, { method: 'POST' });
    assert.equal(restarted.status, 200);
    assert.equal((await restarted.json()).status, 'running');
    const stopped = await fetch(`${baseUrl}/api/projects/${created.id}/stop`, { method: 'POST' });
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).status, 'stopped');
    assert.equal((await fetch(`${baseUrl}/api/projects/${created.id}/stop`, { method: 'POST' })).status, 409);

    await fetch(`${baseUrl}/api/projects/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: projectPath, startCommand: 'command-that-does-not-exist-dcc' }),
    });
    const failedStart = await fetch(`${baseUrl}/api/projects/${created.id}/start`, { method: 'POST' });
    assert.equal(failedStart.status, 400);
    assert.equal((await failedStart.json()).error, 'start_failed');
    assert.equal(processManager.processes.has(created.id), true);
    assert.equal((await fetch(`${baseUrl}/api/projects/${created.id}`, { method: 'DELETE' })).status, 204);
    assert.equal(processManager.processes.has(created.id), false);
  });
});

test('returns useful errors for invalid requests', async () => {
  await withServer(async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken',
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'invalid_input');

    assert.equal((await fetch(`${baseUrl}/api/projects/missing`)).status, 404);
  });
});

test('exposes constrained Git actions and rechecks cleanliness inside the project queue', async () => {
  await withServer(async (baseUrl, projectPath, processManager) => {
    await execFileAsync('git', ['-C', projectPath, 'config', 'user.name', 'Dev Control Center Test']);
    await execFileAsync('git', ['-C', projectPath, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(path.join(projectPath, 'README.md'), 'initial\n');
    await execFileAsync('git', ['-C', projectPath, 'add', 'README.md']);
    await execFileAsync('git', ['-C', projectPath, 'commit', '-qm', 'initial']);
    await execFileAsync('git', ['-C', projectPath, 'branch', '-M', 'main']);
    await execFileAsync('git', ['-C', projectPath, 'branch', 'topic']);
    const project = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: projectPath, startCommand: 'node app.js' }),
    }).then((response) => response.json());

    const branches = await fetch(`${baseUrl}/api/projects/${project.id}/git/branches`).then((response) => response.json());
    assert.deepEqual(branches.branches, ['main', 'topic']);

    let releaseLock;
    let lockStarted;
    const started = new Promise((resolve) => { lockStarted = resolve; });
    const heldLock = processManager.withProjectLock(project.id, async () => {
      lockStarted();
      await new Promise((resolve) => { releaseLock = resolve; });
    });
    await started;
    const switchRequest = fetch(`${baseUrl}/api/projects/${project.id}/git/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: 'topic' }),
    });
    await writeFile(path.join(projectPath, 'queued-change.txt'), 'local work\n');
    releaseLock();
    await heldLock;

    const refused = await switchRequest;
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error, 'dirty_worktree');
    assert.equal((await execFileAsync('git', ['-C', projectPath, 'branch', '--show-current'])).stdout.trim(), 'main');

    await unlink(path.join(projectPath, 'queued-change.txt'));
    const switched = await fetch(`${baseUrl}/api/projects/${project.id}/git/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: 'topic' }),
    });
    assert.equal(switched.status, 200);
    assert.equal((await switched.json()).git.branch, 'topic');

    const unknownAction = await fetch(`${baseUrl}/api/projects/${project.id}/git/reset`, { method: 'POST' });
    assert.equal(unknownAction.status, 404);
  });
});

test('lists and explicitly removes only unregistered worktrees under project serialization', async () => {
  await withServer(async (baseUrl, projectPath, processManager) => {
    await execFileAsync('git', ['-C', projectPath, 'config', 'user.name', 'Dev Control Center Test']);
    await execFileAsync('git', ['-C', projectPath, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(path.join(projectPath, 'README.md'), 'initial\n');
    await execFileAsync('git', ['-C', projectPath, 'add', 'README.md']);
    await execFileAsync('git', ['-C', projectPath, 'commit', '-qm', 'initial']);
    await execFileAsync('git', ['-C', projectPath, 'branch', '-M', 'main']);
    await execFileAsync('git', ['-C', projectPath, 'branch', 'topic']);
    const worktreePath = `${projectPath}-topic`;
    await execFileAsync('git', ['-C', projectPath, 'worktree', 'add', '-q', worktreePath, 'topic']);

    const project = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: projectPath, startCommand: 'node app.js' }),
    }).then((response) => response.json());
    const listed = await fetch(`${baseUrl}/api/projects/${project.id}/git/worktrees`);
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).worktrees, [
      { path: projectPath, branch: 'main', isProjectWorktree: true },
      { path: worktreePath, branch: 'topic', isProjectWorktree: false },
    ]);

    const unrelatedPath = await mkdtemp(path.join(os.tmpdir(), 'dcc-unrelated-worktree-'));
    const unrelatedRemoval = await fetch(`${baseUrl}/api/projects/${project.id}/git/worktrees`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: unrelatedPath }),
    });
    assert.equal(unrelatedRemoval.status, 400);
    assert.equal((await unrelatedRemoval.json()).error, 'invalid_worktree');

    const projectRemoval = await fetch(`${baseUrl}/api/projects/${project.id}/git/worktrees`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: projectPath }),
    });
    assert.equal(projectRemoval.status, 409);
    assert.equal((await projectRemoval.json()).error, 'registered_worktree');

    const switchConflict = await fetch(`${baseUrl}/api/projects/${project.id}/git/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: 'topic' }),
    });
    assert.equal(switchConflict.status, 409);
    const switchError = await switchConflict.json();
    assert.equal(switchError.error, 'branch_in_use');
    assert.match(switchError.message, new RegExp(worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    let releaseLock;
    let lockStarted;
    const started = new Promise((resolve) => { lockStarted = resolve; });
    const heldLock = processManager.withProjectLock(project.id, async () => {
      lockStarted();
      await new Promise((resolve) => { releaseLock = resolve; });
    });
    await started;
    const queuedRemoval = fetch(`${baseUrl}/api/projects/${project.id}/git/worktrees`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: worktreePath }),
    });
    await writeFile(path.join(worktreePath, 'local.txt'), 'local work\n');
    releaseLock();
    await heldLock;
    const dirtyRemoval = await queuedRemoval;
    assert.equal(dirtyRemoval.status, 409);
    assert.equal((await dirtyRemoval.json()).error, 'dirty_worktree');
    await unlink(path.join(worktreePath, 'local.txt'));

    const nestedProjectPath = path.join(worktreePath, 'packages', 'nested');
    await mkdir(nestedProjectPath, { recursive: true });
    const nestedProject = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: nestedProjectPath, startCommand: 'node app.js' }),
    }).then((response) => response.json());
    const nestedWorktrees = (await fetch(`${baseUrl}/api/projects/${nestedProject.id}/git/worktrees`)
      .then((response) => response.json())).worktrees;
    assert.equal(nestedWorktrees.find(({ path: entryPath }) => entryPath === worktreePath).isProjectWorktree, true);
    assert.equal(nestedWorktrees.find(({ path: entryPath }) => entryPath === projectPath).isProjectWorktree, false);
    const registeredRemoval = await fetch(`${baseUrl}/api/projects/${project.id}/git/worktrees`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: worktreePath }),
    });
    assert.equal(registeredRemoval.status, 409);
    assert.equal((await registeredRemoval.json()).error, 'registered_worktree');

    assert.equal((await fetch(`${baseUrl}/api/projects/${nestedProject.id}`, { method: 'DELETE' })).status, 204);
    const removed = await fetch(`${baseUrl}/api/projects/${project.id}/git/worktrees`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: worktreePath }),
    });
    assert.equal(removed.status, 204);
    assert.deepEqual(
      (await fetch(`${baseUrl}/api/projects/${project.id}`).then((response) => response.json())).path,
      projectPath,
    );
  });
});

test('identifies a registered worktree through a symlinked Git listing path', async () => {
  await withServer(async (baseUrl, projectPath) => {
    await execFileAsync('git', ['-C', projectPath, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-qm', 'initial']);
    await execFileAsync('git', ['-C', projectPath, 'branch', 'topic']);
    const listedPath = `${projectPath}-listed`;
    const registeredPath = `${projectPath}-registered`;
    await execFileAsync('git', ['-C', projectPath, 'worktree', 'add', '-q', listedPath, 'topic']);
    await rename(listedPath, registeredPath);
    await symlink(registeredPath, listedPath);

    const project = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: registeredPath, startCommand: 'node app.js' }),
    }).then((response) => response.json());
    const response = await fetch(`${baseUrl}/api/projects/${project.id}/git/worktrees`);
    assert.equal(response.status, 200);
    const listedWorktree = (await response.json()).worktrees.find(({ path: entryPath }) => entryPath === listedPath);
    assert.equal(listedWorktree.isProjectWorktree, true);

    const removal = await fetch(`${baseUrl}/api/projects/${project.id}/git/worktrees`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: listedPath }),
    });
    assert.equal(removal.status, 409);
    assert.equal((await removal.json()).error, 'registered_worktree');
  });
});

test('rejects bare and non-bare repository main entries from linked projects', async () => {
  await withServer(async (baseUrl, projectPath) => {
    await execFileAsync('git', ['-C', projectPath, 'config', 'user.name', 'Dev Control Center Test']);
    await execFileAsync('git', ['-C', projectPath, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(path.join(projectPath, 'README.md'), 'initial\n');
    await execFileAsync('git', ['-C', projectPath, 'add', 'README.md']);
    await execFileAsync('git', ['-C', projectPath, 'commit', '-qm', 'initial']);
    await execFileAsync('git', ['-C', projectPath, 'branch', '-M', 'main']);

    const linkedPath = `${projectPath}-linked`;
    await execFileAsync('git', ['-C', projectPath, 'branch', 'linked']);
    await execFileAsync('git', ['-C', projectPath, 'worktree', 'add', '-q', linkedPath, 'linked']);
    const linkedProject = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: linkedPath, startCommand: 'node app.js' }),
    }).then((response) => response.json());
    const nonBareRemoval = await fetch(`${baseUrl}/api/projects/${linkedProject.id}/git/worktrees`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: projectPath }),
    });
    assert.equal(nonBareRemoval.status, 409);
    assert.equal((await nonBareRemoval.json()).error, 'main_worktree');

    const bareRepository = `${projectPath}.git`;
    const bareLinkedPath = `${projectPath}-bare-linked`;
    await execFileAsync('git', ['clone', '-q', '--bare', projectPath, bareRepository]);
    await execFileAsync('git', ['--git-dir', bareRepository, 'branch', 'bare-linked']);
    await execFileAsync('git', [
      '--git-dir', bareRepository, 'worktree', 'add', '-q', bareLinkedPath, 'bare-linked',
    ]);
    const bareLinkedProject = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: bareLinkedPath, startCommand: 'node app.js' }),
    }).then((response) => response.json());
    const bareRemoval = await fetch(`${baseUrl}/api/projects/${bareLinkedProject.id}/git/worktrees`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: bareRepository }),
    });
    assert.equal(bareRemoval.status, 409);
    assert.equal((await bareRemoval.json()).error, 'main_worktree');
  });
});


test('bulk removal API previews protections and rechecks changes after confirmation', async () => {
  await withServer(async (baseUrl, projectPath) => {
    await execFileAsync('git', ['-C', projectPath, 'config', 'user.name', 'Test']);
    await execFileAsync('git', ['-C', projectPath, 'config', 'user.email', 'test@example.invalid']);
    await execFileAsync('git', ['-C', projectPath, 'commit', '--allow-empty', '-m', 'initial']);
    const linked = `${projectPath}-linked`;
    const clean = `${projectPath}-clean`;
    await execFileAsync('git', ['-C', projectPath, 'worktree', 'add', '-b', 'linked', linked]);
    await execFileAsync('git', ['-C', projectPath, 'worktree', 'add', '-b', 'clean', clean]);
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: projectPath, startCommand: 'node app.js' }),
    });
    const project = await created.json();
    const url = `${baseUrl}/api/projects/${project.id}/git/worktrees/removal`;
    const previewResponse = await fetch(url);
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.targets.length, 2);
    assert.equal(preview.retained[0].path, projectPath);
    await writeFile(path.join(linked, 'local.txt'), 'keep');
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: preview.targets.map(({ path }) => path) }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.removed, [clean]);
    assert.equal(result.retained.length, 2);
    assert.match(result.retained.find(({ path }) => path === linked).reason, /clean/);
    const invalid = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(invalid.status, 400);
  });
});
