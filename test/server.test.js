import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ProjectStore } from '../src/project-store.js';
import { createAppServer } from '../src/server.js';

const execFileAsync = promisify(execFile);

async function withServer(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dcc-server-'));
  const projectPath = path.join(directory, 'demo');
  await mkdir(projectPath);
  await execFileAsync('git', ['init', '-q', projectPath]);
  const server = createAppServer(new ProjectStore(path.join(directory, 'projects.json')));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`, projectPath);
  } finally {
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
