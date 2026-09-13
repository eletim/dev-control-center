import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApiError, describeGit, initDashboard, requestJson,
} from '../public/app.js';

class TestElement {
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

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  set innerHTML(value) {
    this.children = [];
    this.textContent = value;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  focus() {}

  reset() {}

  async dispatch(type) {
    const event = { preventDefault() {} };
    await Promise.all((this.listeners.get(type) ?? []).map((listener) => listener(event)));
  }
}

function createTestDocument() {
  const elements = new Map([
    ['projects', new TestElement()],
    ['project-form', new TestElement('form')],
    ['project-id', new TestElement('input')],
    ['path', new TestElement('input')],
    ['start-command', new TestElement('input')],
    ['message', new TestElement()],
    ['cancel', new TestElement('button')],
    ['save-project', new TestElement('button')],
    ['refresh', new TestElement('button')],
    ['form-title', new TestElement('h2')],
  ]);
  return {
    elements,
    createElement: (tagName) => new TestElement(tagName),
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

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('describes available and unavailable Git state explicitly', () => {
  assert.deepEqual(describeGit(null), {
    repository: false,
    summary: 'Git metadata unavailable.',
  });
  assert.deepEqual(describeGit({ isRepository: false }), {
    repository: false,
    summary: 'Not a Git repository.',
  });
  assert.deepEqual(describeGit({
    isRepository: true,
    branch: null,
    clean: null,
    remote: 'origin/main',
    ahead: null,
    behind: null,
  }), {
    repository: true,
    branch: 'Detached or unavailable',
    worktree: 'Unavailable',
    upstream: 'origin/main',
    divergence: 'Unavailable',
  });
});

test('requestJson preserves backend refusals and handles unavailable responses', async () => {
  await assert.rejects(
    requestJson('/action', {}, async () => ({
      ok: false,
      status: 409,
      json: async () => ({ message: 'Git working tree must be clean.' }),
    })),
    (error) => error instanceof ApiError
      && error.status === 409
      && error.message === 'Git working tree must be clean.',
  );

  await assert.rejects(
    requestJson('/action', {}, async () => { throw new Error('offline'); }),
    { message: 'Could not reach Dev Control Center.', status: 0 },
  );
});

test('a deferred full refresh blocks save, delete, lifecycle, and Git submissions', async () => {
  const document = createTestDocument();
  const refreshResponse = deferred();
  const project = {
    id: 'project-1',
    name: 'demo',
    path: '/projects/demo',
    startCommand: 'npm start',
    status: 'stopped',
    git: {
      isRepository: true,
      branch: 'main',
      clean: true,
      remote: 'origin/main',
      ahead: 0,
      behind: 0,
    },
  };
  const requests = [];
  let projectListRequests = 0;
  const fetchImpl = (url, options = {}) => {
    requests.push({ url, method: options.method ?? 'GET' });
    if (url === '/api/projects') {
      projectListRequests += 1;
      return projectListRequests === 1
        ? Promise.resolve(jsonResponse([project]))
        : refreshResponse.promise;
    }
    if (url.endsWith('/git/branches')) {
      return Promise.resolve(jsonResponse({ branches: ['main', 'topic'] }));
    }
    return Promise.resolve(jsonResponse(project));
  };
  let confirmations = 0;
  const dashboard = initDashboard(document, fetchImpl, () => {
    confirmations += 1;
    return true;
  });
  await dashboard.ready;

  const refreshRun = document.elements.get('refresh').dispatch('click');
  const projects = document.elements.get('projects');
  const save = document.elements.get('save-project');
  const start = findElement(projects, 'Start');
  const remove = findElement(projects, 'Delete');
  const fetchButton = findElement(projects, 'Fetch');

  assert.equal(save.disabled, true);
  assert.equal(start.disabled, true);
  assert.equal(remove.disabled, true);
  assert.equal(fetchButton.disabled, true);

  await Promise.all([
    document.elements.get('project-form').dispatch('submit'),
    start.dispatch('click'),
    remove.dispatch('click'),
    fetchButton.dispatch('click'),
  ]);
  assert.equal(confirmations, 0);
  assert.deepEqual(requests.map(({ url, method }) => `${method} ${url}`), [
    'GET /api/projects',
    'GET /api/projects/project-1/git/branches',
    'GET /api/projects',
  ]);

  refreshResponse.resolve(jsonResponse([{ ...project, status: 'running' }]));
  await refreshRun;
  assert.equal(findElement(projects, 'Running').textContent, 'Running');
});
