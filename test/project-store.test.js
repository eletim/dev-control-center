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

test('serializes a concurrent update and delete without duplicating records', async () => {
  const { directory, projectPath, dataFile } = await fixture();
  const secondPath = path.join(directory, 'second-project');
  await mkdir(secondPath);
  const store = new ProjectStore(dataFile);
  const first = await store.create({ path: projectPath, startCommand: 'first' });
  const second = await store.create({ path: secondPath, startCommand: 'second' });

  await Promise.all([
    store.update(second.id, { path: secondPath, startCommand: 'updated' }),
    store.delete(first.id),
  ]);

  const expected = [{ ...second, startCommand: 'updated' }];
  assert.deepEqual(await store.list(), expected);
  assert.deepEqual(await new ProjectStore(dataFile).list(), expected);
});

test('holds mutations behind a stable project snapshot', async () => {
  const { directory, projectPath, dataFile } = await fixture();
  const secondPath = path.join(directory, 'second-project');
  await mkdir(secondPath);
  const store = new ProjectStore(dataFile);
  const first = await store.create({ path: projectPath, startCommand: 'first' });

  let releaseSnapshot;
  const snapshot = store.withProjectSnapshot(async (projects) => {
    assert.deepEqual(projects, [first]);
    projects[0].startCommand = 'changed snapshot';
    await new Promise((resolve) => { releaseSnapshot = resolve; });
  });
  const create = store.create({ path: secondPath, startCommand: 'second' });
  let createFinished = false;
  create.then(() => { createFinished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createFinished, false);

  releaseSnapshot();
  await Promise.all([snapshot, create]);
  assert.deepEqual((await store.list()).map(({ path: project }) => project), [projectPath, secondPath]);
  assert.equal((await store.get(first.id)).startCommand, 'first');
});

test('failed writes do not publish state and do not prevent later writes', async () => {
  const { directory, projectPath, dataFile } = await fixture();
  const store = new ProjectStore(dataFile);
  const workingFile = store.filePath;

  store.filePath = directory;
  await assert.rejects(store.create({ path: projectPath, startCommand: 'first' }));
  assert.deepEqual(await store.list(), []);

  store.filePath = workingFile;
  const created = await store.create({ path: projectPath, startCommand: 'first' });
  assert.deepEqual(await new ProjectStore(dataFile).list(), [created]);

  store.filePath = directory;
  await assert.rejects(store.update(created.id, { path: projectPath, startCommand: 'failed update' }));
  assert.deepEqual(await store.list(), [created]);
  assert.deepEqual(await new ProjectStore(dataFile).list(), [created]);

  store.filePath = workingFile;
  const updated = await store.update(created.id, { path: projectPath, startCommand: 'updated' });
  assert.deepEqual(await new ProjectStore(dataFile).list(), [updated]);

  store.filePath = directory;
  await assert.rejects(store.delete(created.id));
  assert.deepEqual(await store.list(), [updated]);
  assert.deepEqual(await new ProjectStore(dataFile).list(), [updated]);

  store.filePath = workingFile;
  await store.delete(created.id);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await new ProjectStore(dataFile).list(), []);
});
