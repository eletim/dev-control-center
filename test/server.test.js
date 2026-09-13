import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
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
  const processManager = new ProjectProcessManager({ stopTimeout: 250 });
  const server = createAppServer(new ProjectStore(path.join(directory, 'projects.json')), processManager);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`, projectPath, processManager);
  } finally {
    for (const id of processManager.processes.keys()) {
      if (processManager.isRunning(id)) await processManager.stop(id);
    }
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
  await withServer(async (baseUrl, projectPath) => {
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
