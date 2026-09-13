import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectStore } from '../src/project-store.js';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dcc-store-'));
  const projectPath = path.join(directory, 'sample-project');
  await mkdir(projectPath);
  return { directory, projectPath, dataFile: path.join(directory, 'data', 'projects.json') };
}

test('creates, updates, persists, and deletes a project', async () => {
  const { projectPath, dataFile } = await fixture();
  const store = new ProjectStore(dataFile);
  const created = await store.create({ path: projectPath, startCommand: 'npm start' });

  assert.equal(created.path, await realpath(projectPath));
  assert.equal(created.startCommand, 'npm start');
  assert.deepEqual(Object.keys(created).sort(), ['id', 'path', 'startCommand'].sort());

  const updated = await store.update(created.id, { path: projectPath, startCommand: 'npm run dev' });
  assert.equal(updated.startCommand, 'npm run dev');
  assert.deepEqual(await new ProjectStore(dataFile).list(), [updated]);
  const persisted = await readFile(dataFile, 'utf8');
  assert.doesNotThrow(() => JSON.parse(persisted));

  await store.delete(created.id);
  assert.deepEqual(await store.list(), []);
});

test('rejects missing paths, blank commands, and canonical duplicates', async () => {
  const { directory, projectPath, dataFile } = await fixture();
  const store = new ProjectStore(dataFile);
  await assert.rejects(store.create({ path: path.join(directory, 'missing'), startCommand: 'run' }), { code: 'invalid_path' });
  await assert.rejects(store.create({ path: projectPath, startCommand: '  ' }), { code: 'invalid_start_command' });

  await store.create({ path: projectPath, startCommand: 'run' });
  const linkedPath = path.join(directory, 'linked-project');
  await symlink(projectPath, linkedPath);
  await assert.rejects(store.create({ path: linkedPath, startCommand: 'other' }), { code: 'duplicate_path' });
});
