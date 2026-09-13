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

function findTag(root, tagName) {
  if (root.tagName === tagName.toUpperCase()) return root;
  for (const child of root.children) {
    const match = findTag(child, tagName);
    if (match) return match;
  }
  return null;
}

function findProject(document, name) {
  return document.elements.get('projects').children.find((card) => findElement(card, name));
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

test('multiple projects complete dashboard lifecycle and safe Git workflows over HTTP', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dcc-acceptance-'));
  const firstPath = path.join(directory, 'first-project');
  const secondPath = path.join(directory, 'second-project');
  const processManager = new ProjectProcessManager({ stopTimeout: 250, startupDelay: 30 });
  const server = createAppServer(
    new ProjectStore(path.join(directory, 'projects.json')),
    processManager,
  );

  try {
    await Promise.all([initializeRepository(firstPath), initializeRepository(secondPath)]);
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
  } finally {
    await processManager.stopAll();
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  }
});
