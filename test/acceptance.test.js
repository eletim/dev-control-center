import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { initDashboard } from '../public/app.js';
import { ProjectProcessManager } from '../src/project-process-manager.js';
import { ProjectStore } from '../src/project-store.js';
import { createAppServer } from '../src/server.js';

const execFileAsync = promisify(execFile);

class AcceptanceElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.disabled = false;
    this.hidden = false;
    this.value = '';
    this.textContent = '';
    this.className = '';
  }

  append(...children) { this.children.push(...children); }

  replaceChildren(...children) { this.children = children; }

  set innerHTML(value) {
    this.children = [];
    this.textContent = value;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name, value) { this[name] = value; }

  focus() {}

  reset() {}

  async dispatch(type) {
    const event = { preventDefault() {} };
    await Promise.all((this.listeners.get(type) ?? []).map((listener) => listener(event)));
  }
}

function createDocument() {
  const elements = new Map([
    ['projects', new AcceptanceElement()],
    ['project-form', new AcceptanceElement('form')],
    ['project-id', new AcceptanceElement('input')],
    ['path', new AcceptanceElement('input')],
    ['start-command', new AcceptanceElement('input')],
    ['message', new AcceptanceElement()],
    ['cancel', new AcceptanceElement('button')],
    ['save-project', new AcceptanceElement('button')],
    ['refresh', new AcceptanceElement('button')],
    ['form-title', new AcceptanceElement('h2')],
  ]);
  return {
    elements,
    createElement: (tagName) => new AcceptanceElement(tagName),
    querySelector: (selector) => elements.get(selector.slice(1)),
  };
}

function findElement(root, text) {
  if (root.textContent === text) return root;
  for (const child of root.children) {
    const match = findElement(child, text);
    if (match) return match;
  }
  return null;
}

function findElements(root, text) {
  const matches = root.textContent === text ? [root] : [];
  for (const child of root.children) matches.push(...findElements(child, text));
  return matches;
}

function findWorktreeRow(root, worktreePath) {
  if (root.className === 'worktree-row' && findElement(root, worktreePath)) return root;
  for (const child of root.children) {
    const match = findWorktreeRow(child, worktreePath);
    if (match) return match;
  }
  return null;
}

function findTag(root, tagName) {
  if (root.tagName === tagName.toUpperCase()) return root;
  for (const child of root.children) {
    const match = findTag(child, tagName);
    if (match) return match;
  }
  return null;
}

function findProject(document, name) {
  return document.elements.get('projects').children.find((card) => card.children[0]?.textContent === name);
}

async function waitFor(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for dashboard state.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function initializeRepository(repositoryPath) {
  await mkdir(repositoryPath);
  await execFileAsync('git', ['init', '-q', '-b', 'main', repositoryPath]);
  await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Acceptance Test']);
  await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.email', 'acceptance@example.invalid']);
  await writeFile(path.join(repositoryPath, 'README.md'), `${path.basename(repositoryPath)}\n`);
  await execFileAsync('git', ['-C', repositoryPath, 'add', 'README.md']);
  await execFileAsync('git', ['-C', repositoryPath, 'commit', '-qm', 'initial']);
  await execFileAsync('git', ['-C', repositoryPath, 'branch', 'topic']);
}

async function commitFile(repositoryPath, filename, contents, message) {
  await writeFile(path.join(repositoryPath, filename), contents);
  await execFileAsync('git', ['-C', repositoryPath, 'add', filename]);
  await execFileAsync('git', ['-C', repositoryPath, 'commit', '-qm', message]);
}

async function initializeRemoteRepository(directory, checkoutPath) {
  const remotePath = path.join(directory, 'remote.git');
  const sourcePath = path.join(directory, 'remote-source');
  await execFileAsync('git', ['init', '--bare', '-q', remotePath]);
  await initializeRepository(sourcePath);
  await execFileAsync('git', ['-C', sourcePath, 'remote', 'add', 'origin', remotePath]);
  await execFileAsync('git', ['-C', sourcePath, 'push', '-qu', 'origin', 'main']);
  await execFileAsync('git', ['-C', remotePath, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  await execFileAsync('git', ['clone', '-q', remotePath, checkoutPath]);
  await execFileAsync('git', ['-C', checkoutPath, 'config', 'user.name', 'Acceptance Test']);
  await execFileAsync('git', ['-C', checkoutPath, 'config', 'user.email', 'acceptance@example.invalid']);
  await execFileAsync('git', ['-C', checkoutPath, 'branch', 'topic']);
  return sourcePath;
}

test('shared-repository project cards refresh after Git actions and worktree removal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dcc-shared-repository-'));
  const mainPath = path.join(directory, 'main');
  const linkedPath = path.join(directory, 'linked');
  const removablePath = path.join(directory, 'removable');
  const processManager = new ProjectProcessManager({
    sessionName: `dcc-shared-repository-test-${process.pid}`,
  });
  const server = createAppServer(
    new ProjectStore(path.join(directory, 'projects.json')),
    processManager,
  );

  try {
    await initializeRepository(mainPath);
    await execFileAsync('git', ['-C', mainPath, 'branch', 'linked']);
    await execFileAsync('git', ['-C', mainPath, 'branch', 'removable']);
    await execFileAsync('git', ['-C', mainPath, 'worktree', 'add', '-q', linkedPath, 'linked']);
    await execFileAsync('git', ['-C', mainPath, 'worktree', 'add', '-q', removablePath, 'removable']);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const document = createDocument();
    const dashboard = initDashboard(
      document,
      (url, options) => fetch(new URL(url, baseUrl), options),
      () => true,
    );
    await dashboard.ready;

    for (const projectPath of [mainPath, linkedPath]) {
      document.elements.get('path').value = projectPath;
      document.elements.get('start-command').value = 'node app.js';
      await document.elements.get('project-form').dispatch('submit');
    }

    let mainCard = findProject(document, 'main');
    let linkedCard = findProject(document, 'linked');
    assert.ok(findElement(mainCard, removablePath));
    assert.ok(findElement(linkedCard, removablePath));

    await findElements(mainCard, 'Remove Worktree').at(-1).dispatch('click');
    mainCard = findProject(document, 'main');
    linkedCard = findProject(document, 'linked');
    assert.equal(findElement(mainCard, removablePath), null);
    assert.equal(findElement(linkedCard, removablePath), null);

    const branchSelect = findTag(mainCard, 'select');
    branchSelect.value = 'topic';
    await branchSelect.dispatch('change');
    await findElement(mainCard, 'Switch').dispatch('click');

    await waitFor(() => {
      mainCard = findProject(document, 'main');
      linkedCard = findProject(document, 'linked');
      return mainCard['aria-busy'] === 'false'
        && findElement(mainCard, 'Branch switch complete.')
        && findWorktreeRow(linkedCard, mainPath);
    });
    mainCard = findProject(document, 'main');
    linkedCard = findProject(document, 'linked');
    assert.ok(findElement(mainCard, 'Branch switch complete.'));
    const mainWorktreeRow = findWorktreeRow(linkedCard, mainPath);
    assert.ok(mainWorktreeRow);
    assert.ok(findElement(mainWorktreeRow, 'topic'));
    assert.equal((await execFileAsync('git', ['-C', mainPath, 'branch', '--show-current'])).stdout.trim(), 'topic');
  } finally {
    await processManager.stopAll();
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('multiple projects complete dashboard lifecycle and safe Git workflows over HTTP', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dcc-acceptance-'));
  const firstPath = path.join(directory, 'first-project');
  const secondPath = path.join(directory, 'second-project');
  const processManager = new ProjectProcessManager({
    stopTimeout: 250,
    startupDelay: 30,
    sessionName: `dcc-acceptance-test-${process.pid}`,
  });
  const server = createAppServer(
    new ProjectStore(path.join(directory, 'projects.json')),
    processManager,
  );

  try {
    const remoteSource = await initializeRemoteRepository(directory, firstPath);
    await initializeRepository(secondPath);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const document = createDocument();
    const fetchFromServer = (url, options) => fetch(new URL(url, baseUrl), options);
    const dashboard = initDashboard(document, fetchFromServer, () => true);
    await dashboard.ready;

    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(() => {}, 1000)')}`;
    for (const projectPath of [firstPath, secondPath]) {
      document.elements.get('path').value = projectPath;
      document.elements.get('start-command').value = command;
      await document.elements.get('project-form').dispatch('submit');
    }

    let projects = await fetch(`${baseUrl}/api/projects`).then((response) => response.json());
    assert.equal(projects.length, 2);
    assert.ok(findProject(document, 'first-project'));
    assert.ok(findProject(document, 'second-project'));

    await Promise.all(projects.map(({ id }) => (
      fetch(`${baseUrl}/api/projects/${id}/start`, { method: 'POST' })
    )));
    const tmuxWindows = await execFileAsync('tmux', [
      'list-windows', '-t', `=${processManager.sessionName}`, '-F', '#{window_name}',
    ]).then(({ stdout }) => stdout.trim().split('\n'));
    assert.equal(tmuxWindows.length, 2);
    assert.equal(new Set(tmuxWindows).size, 2);
    await document.elements.get('refresh').dispatch('click');
    assert.ok(findElement(findProject(document, 'first-project'), 'Running'));
    assert.ok(findElement(findProject(document, 'second-project'), 'Running'));

    const first = projects.find(({ name }) => name === 'first-project');
    await findElement(findProject(document, 'first-project'), 'Restart').dispatch('click');
    const restartedCard = findProject(document, 'first-project');
    assert.ok(findElement(restartedCard, 'Restart complete.'));
    assert.ok(findElement(restartedCard, 'Running'));
    assert.equal(await fetch(`${baseUrl}/api/projects/${first.id}`)
      .then((response) => response.json())
      .then(({ status }) => status), 'running');
    await findElement(findProject(document, 'first-project'), 'Stop').dispatch('click');
    await findElement(findProject(document, 'second-project'), 'Stop').dispatch('click');
    projects = await fetch(`${baseUrl}/api/projects`).then((response) => response.json());
    assert.deepEqual(projects.map(({ status }) => status), ['stopped', 'stopped']);

    await writeFile(path.join(secondPath, 'local-change.txt'), 'must be preserved\n');
    let secondCard = findProject(document, 'second-project');
    let branchSelect = findTag(secondCard, 'select');
    branchSelect.value = 'topic';
    await branchSelect.dispatch('change');
    await findElement(secondCard, 'Switch').dispatch('click');

    await waitFor(() => {
      secondCard = findProject(document, 'second-project');
      return secondCard['aria-busy'] === 'false'
        && findElement(secondCard, 'Branch switch refused: Git working tree must be clean.');
    });
    assert.ok(findElement(secondCard, 'Branch switch refused: Git working tree must be clean.'));
    assert.equal((await execFileAsync('git', ['-C', secondPath, 'branch', '--show-current'])).stdout.trim(), 'main');
    assert.equal(await execFileAsync('git', ['-C', secondPath, 'status', '--porcelain'])
      .then(({ stdout }) => stdout.trim()), '?? local-change.txt');

    await unlink(path.join(secondPath, 'local-change.txt'));
    const topicWorktree = `${secondPath}-topic-worktree`;
    await execFileAsync('git', ['-C', secondPath, 'worktree', 'add', '-q', topicWorktree, 'topic']);
    await findElement(secondCard, 'Refresh Git').dispatch('click');
    secondCard = findProject(document, 'second-project');
    assert.ok(findElement(secondCard, topicWorktree));
    assert.ok(findElement(secondCard, 'Remove Worktree'));

    branchSelect = findTag(secondCard, 'select');
    branchSelect.value = 'topic';
    await branchSelect.dispatch('change');
    await findElement(secondCard, 'Switch').dispatch('click');

    await waitFor(() => {
      secondCard = findProject(document, 'second-project');
      return findElement(
        secondCard,
        `Branch switch refused: Branch is checked out in another worktree: ${topicWorktree}`,
      ) && secondCard['aria-busy'] === 'false';
    });
    assert.ok(findElement(secondCard, topicWorktree));
    assert.equal((await execFileAsync('git', ['-C', secondPath, 'branch', '--show-current'])).stdout.trim(), 'main');

    await findElement(secondCard, 'Remove Worktree').dispatch('click');
    secondCard = findProject(document, 'second-project');
    assert.ok(findElement(secondCard, 'Remove worktree complete. Retry Branch Switch explicitly if needed.'));
    assert.equal(findElement(secondCard, topicWorktree), null);
    assert.ok(findElement(secondCard, secondPath));
    assert.equal((await fetch(`${baseUrl}/api/projects/${projects.find(({ name }) => name === 'second-project').id}`)
      .then((response) => response.json())).path, secondPath);
    assert.equal((await execFileAsync('git', ['-C', secondPath, 'branch', '--show-current'])).stdout.trim(), 'main');

    branchSelect = findTag(secondCard, 'select');
    branchSelect.value = 'topic';
    await branchSelect.dispatch('change');
    await findElement(secondCard, 'Switch').dispatch('click');

    await waitFor(() => {
      secondCard = findProject(document, 'second-project');
      return findElement(secondCard, 'Branch switch complete.');
    });
    assert.ok(findElement(secondCard, 'Branch switch complete.'));
    assert.ok(findElement(secondCard, 'topic'));
    assert.equal((await execFileAsync('git', ['-C', secondPath, 'branch', '--show-current'])).stdout.trim(), 'topic');

    const headBeforeFetch = (await execFileAsync('git', ['-C', firstPath, 'rev-parse', 'HEAD'])).stdout.trim();
    await commitFile(remoteSource, 'remote-one.txt', 'remote one\n', 'remote update one');
    await execFileAsync('git', ['-C', remoteSource, 'push', '-q']);
    let firstCard = findProject(document, 'first-project');
    await findElement(firstCard, 'Fetch').dispatch('click');
    firstCard = findProject(document, 'first-project');
    assert.ok(findElement(firstCard, 'Fetch complete.'));
    assert.ok(findElement(firstCard, '0 ahead / 1 behind'));
    assert.equal((await execFileAsync('git', ['-C', firstPath, 'rev-parse', 'HEAD'])).stdout.trim(), headBeforeFetch);

    await findElement(firstCard, 'Update (fast-forward)').dispatch('click');
    firstCard = findProject(document, 'first-project');
    assert.ok(findElement(firstCard, 'Fast-forward update complete.'));
    assert.ok(findElement(firstCard, '0 ahead / 0 behind'));
    const firstRemoteHead = (await execFileAsync('git', ['-C', remoteSource, 'rev-parse', 'HEAD'])).stdout.trim();
    assert.equal((await execFileAsync('git', ['-C', firstPath, 'rev-parse', 'HEAD'])).stdout.trim(), firstRemoteHead);

    await commitFile(remoteSource, 'remote-two.txt', 'remote two\n', 'remote update two');
    await execFileAsync('git', ['-C', remoteSource, 'push', '-q']);
    await writeFile(path.join(firstPath, 'dirty.txt'), 'keep this local change\n');
    const cleanHead = (await execFileAsync('git', ['-C', firstPath, 'rev-parse', 'HEAD'])).stdout.trim();
    await findElement(firstCard, 'Update (fast-forward)').dispatch('click');
    firstCard = findProject(document, 'first-project');
    assert.ok(findElement(firstCard, 'Fast-forward update refused: Git working tree must be clean.'));
    assert.equal((await execFileAsync('git', ['-C', firstPath, 'rev-parse', 'HEAD'])).stdout.trim(), cleanHead);
    assert.equal(await execFileAsync('git', ['-C', firstPath, 'status', '--porcelain'])
      .then(({ stdout }) => stdout.trim()), '?? dirty.txt');
    await unlink(path.join(firstPath, 'dirty.txt'));

    await findElement(firstCard, 'Update (fast-forward)').dispatch('click');
    await commitFile(firstPath, 'local-commit.txt', 'local commit\n', 'local update');
    await commitFile(remoteSource, 'remote-three.txt', 'remote three\n', 'remote update three');
    await execFileAsync('git', ['-C', remoteSource, 'push', '-q']);
    const divergentHead = (await execFileAsync('git', ['-C', firstPath, 'rev-parse', 'HEAD'])).stdout.trim();
    firstCard = findProject(document, 'first-project');
    await findElement(firstCard, 'Update (fast-forward)').dispatch('click');
    firstCard = findProject(document, 'first-project');
    assert.ok(findElement(firstCard, 'Fast-forward update refused: Current branch cannot be updated with a fast-forward.'));
    assert.ok(findElement(firstCard, '1 ahead / 1 behind'));
    assert.equal((await execFileAsync('git', ['-C', firstPath, 'rev-parse', 'HEAD'])).stdout.trim(), divergentHead);
    await assert.rejects(execFileAsync('git', ['-C', firstPath, 'cat-file', '-e', 'HEAD:remote-three.txt']));

    secondCard = findProject(document, 'second-project');
    await findElement(secondCard, 'Edit').dispatch('click');
    const editedCommand = `${command} --edited`;
    document.elements.get('start-command').value = editedCommand;
    await document.elements.get('project-form').dispatch('submit');
    const second = projects.find(({ name }) => name === 'second-project');
    assert.equal((await fetch(`${baseUrl}/api/projects/${second.id}`).then((response) => response.json())).startCommand, editedCommand);
    assert.ok(findElement(findProject(document, 'second-project'), `Start: ${editedCommand}`));

    await findElement(findProject(document, 'second-project'), 'Delete').dispatch('click');
    assert.equal(await fetch(`${baseUrl}/api/projects/${second.id}`).then((response) => response.status), 404);
    assert.equal(findProject(document, 'second-project'), undefined);
  } finally {
    await processManager.stopAll();
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  }
});
