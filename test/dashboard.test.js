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
    ['project-search', new TestElement('input')],
    ['project-count', new TestElement()],
    ['form-title', new TestElement('h2')],
  ]);
  const listeners = new Map();
  return {
    elements,
    hidden: false,
    createElement: (tagName) => new TestElement(tagName),
    querySelector: (selector) => elements.get(selector.slice(1)),
    addEventListener: (type, listener) => { listeners.set(type, listener); },
    dispatch: (type) => listeners.get(type)?.(),
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

function findTag(root, tagName) {
  if (root.tagName === tagName.toUpperCase()) return root;
  for (const child of root.children) {
    const match = findTag(child, tagName);
    if (match) return match;
  }
  return null;
}

function findWorktreeRow(root, worktreePath) {
  if (root.className.split(' ').includes('worktree-row') && findElement(root, worktreePath)) return root;
  for (const child of root.children) {
    const match = findWorktreeRow(child, worktreePath);
    if (match) return match;
  }
  return null;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function waitFor(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for dashboard state.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('refreshes external Git and process changes on a timer and when the tab becomes visible', async () => {
  const document = createTestDocument();
  const project = {
    id: 'one', name: 'demo', path: '/demo', startCommand: 'npm start', status: 'stopped',
    git: { isRepository: true, branch: 'main', clean: true },
  };
  let current = project;
  let listRequests = 0;
  let tick;
  const fetchImpl = async (url) => {
    if (url === '/api/projects') {
      listRequests += 1;
      return jsonResponse([current]);
    }
    if (url.endsWith('/git/branches')) return jsonResponse({ branches: ['main', 'topic'] });
    return jsonResponse({ worktrees: [{ path: '/demo', branch: current.git.branch }] });
  };
  const dashboard = initDashboard(document, fetchImpl, () => true, {
    setIntervalImpl: (callback, delay) => {
      assert.equal(delay, 15_000);
      tick = callback;
    },
  });
  await dashboard.ready;
  current = { ...project, status: 'running', git: { ...project.git, branch: 'topic', clean: false } };
  await tick();
  await waitFor(() => findElement(document.elements.get('projects'), 'Running')
    && findElement(document.elements.get('projects'), 'topic'));
  assert.equal(listRequests, 2);

  document.hidden = true;
  tick();
  assert.equal(listRequests, 2);
  document.hidden = false;
  document.dispatch('visibilitychange');
  await waitFor(() => listRequests === 3);
});

test('keeps a selected branch available for Switch across automatic refreshes', async () => {
  const document = createTestDocument();
  const project = {
    id: 'one', name: 'demo', path: '/demo', startCommand: 'npm start', status: 'stopped',
    git: { isRepository: true, branch: 'main', clean: true },
  };
  let tick;
  let switchedBranch;
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/projects') return jsonResponse([project]);
    if (url.endsWith('/git/branches')) return jsonResponse({ branches: ['main', 'topic'] });
    if (url.endsWith('/git/worktrees')) return jsonResponse({ worktrees: [] });
    if (url.endsWith('/git/switch') && options.method === 'POST') {
      switchedBranch = JSON.parse(options.body).branch;
    }
    return jsonResponse(project);
  };
  const dashboard = initDashboard(document, fetchImpl, () => true, {
    setIntervalImpl: (callback) => { tick = callback; },
  });
  await dashboard.ready;
  let card = document.elements.get('projects').children[0];
  const select = findTag(card, 'select');
  select.value = 'topic';
  await select.dispatch('change');
  assert.equal(findElement(card, 'Switch').disabled, false);

  tick();
  await waitFor(() => document.elements.get('projects').children[0] !== card
    && !document.elements.get('refresh').disabled);
  card = document.elements.get('projects').children[0];
  assert.equal(findTag(card, 'select').value, 'topic');
  assert.equal(findElement(card, 'Switch').disabled, false);
  await findElement(card, 'Switch').dispatch('click');
  assert.equal(switchedBranch, 'topic');
});

test('runs a visibility refresh after an active project operation settles', async () => {
  const document = createTestDocument();
  const project = {
    id: 'one', name: 'demo', path: '/demo', startCommand: 'npm start', status: 'stopped',
    git: { isRepository: false },
  };
  const startResponse = deferred();
  let listRequests = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/projects') {
      listRequests += 1;
      return jsonResponse([{ ...project, name: listRequests === 1 ? 'demo' : 'updated' }]);
    }
    if (options.method === 'POST') return startResponse.promise;
    return jsonResponse({ ...project, status: 'running' });
  };
  const dashboard = initDashboard(document, fetchImpl, () => true, { setIntervalImpl: () => {} });
  await dashboard.ready;
  const action = findElement(document.elements.get('projects'), 'Start').dispatch('click');
  document.dispatch('visibilitychange');
  assert.equal(listRequests, 1);

  startResponse.resolve(jsonResponse({ ...project, status: 'running' }));
  await action;
  await waitFor(() => listRequests === 2);
  assert.ok(findElement(document.elements.get('projects'), 'updated'));
});

test('reports an already exited Start Command without claiming it is running', async () => {
  const document = createTestDocument();
  const project = {
    id: 'one', name: 'demo', path: '/demo', startCommand: 'true', status: 'stopped',
    git: { isRepository: false },
  };
  const fetchImpl = async (url) => jsonResponse(url === '/api/projects' ? [project] : project);
  const dashboard = initDashboard(document, fetchImpl, () => true, { setIntervalImpl: () => {} });
  await dashboard.ready;
  await findElement(document.elements.get('projects'), 'Start').dispatch('click');
  const card = document.elements.get('projects').children[0];
  assert.ok(findElement(card, 'Stopped'));
  assert.ok(findElement(card, 'Start Command exited; no DCC-managed process is running.'));
});

test('updates Start feedback when a command exits after the action response', async () => {
  const document = createTestDocument();
  const project = {
    id: 'one', name: 'demo', path: '/demo', startCommand: 'npm start', status: 'stopped',
    git: { isRepository: false },
  };
  let status = 'stopped';
  let tick;
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/projects') return jsonResponse([{ ...project, status }]);
    if (options.method === 'POST') status = 'running';
    return jsonResponse({ ...project, status });
  };
  const dashboard = initDashboard(document, fetchImpl, () => true, {
    setIntervalImpl: (callback) => { tick = callback; },
  });
  await dashboard.ready;
  await findElement(document.elements.get('projects'), 'Start').dispatch('click');
  assert.ok(findElement(document.elements.get('projects'), 'Start complete.'));
  status = 'stopped';
  tick();
  await waitFor(() => findElement(document.elements.get('projects'),
    'Start Command exited; no DCC-managed process is running.'));
  assert.ok(findElement(document.elements.get('projects'), 'Stopped'));
});

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
    if (url.endsWith('/git/worktrees')) {
      return Promise.resolve(jsonResponse({
        worktrees: [{ path: project.path, branch: 'main' }],
      }));
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
    'GET /api/projects/project-1/git/worktrees',
    'GET /api/projects',
  ]);

  refreshResponse.resolve(jsonResponse([{ ...project, status: 'running' }]));
  await refreshRun;
  assert.equal(findElement(projects, 'Running').textContent, 'Running');
});

test('pending actions block duplicates only for the affected project', async () => {
  const document = createTestDocument();
  const firstActionResponse = deferred();
  const makeProject = (id, name) => ({
    id,
    name,
    path: `/projects/${name}`,
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
  });
  const first = makeProject('project-1', 'first');
  const second = makeProject('project-2', 'second');
  const requests = [];
  const fetchImpl = (url, options = {}) => {
    const method = options.method ?? 'GET';
    requests.push(`${method} ${url}`);
    if (url === '/api/projects') return Promise.resolve(jsonResponse([first, second]));
    if (url.endsWith('/git/branches')) {
      return Promise.resolve(jsonResponse({ branches: ['main', 'topic'] }));
    }
    if (url.endsWith('/git/worktrees')) {
      const project = url.includes('/project-1') ? first : second;
      return Promise.resolve(jsonResponse({
        worktrees: [{ path: project.path, branch: 'main' }],
      }));
    }
    if (method === 'POST' && url === '/api/projects/project-1/start') {
      return firstActionResponse.promise;
    }
    if (url.includes('/project-1')) {
      return Promise.resolve(jsonResponse({ ...first, status: 'running' }));
    }
    return Promise.resolve(jsonResponse(second));
  };
  const dashboard = initDashboard(document, fetchImpl, () => true);
  await dashboard.ready;

  const projects = document.elements.get('projects');
  const firstStart = findElement(projects.children[0], 'Start');
  const firstAction = firstStart.dispatch('click');
  const firstCard = projects.children[0];
  const secondCard = projects.children[1];

  assert.equal(findElement(firstCard, 'Start').disabled, true);
  assert.equal(findElement(firstCard, 'Delete').disabled, true);
  assert.equal(findElement(firstCard, 'Fetch').disabled, true);
  assert.equal(findElement(secondCard, 'Start').disabled, false);
  assert.equal(findElement(secondCard, 'Edit').disabled, false);
  assert.equal(findElement(secondCard, 'Delete').disabled, false);
  assert.equal(findElement(secondCard, 'Fetch').disabled, false);
  assert.equal(document.elements.get('save-project').disabled, false);
  assert.equal(document.elements.get('refresh').disabled, true);

  await Promise.all([
    firstStart.dispatch('click'),
    findElement(firstCard, 'Fetch').dispatch('click'),
    findElement(secondCard, 'Fetch').dispatch('click'),
  ]);
  assert.equal(requests.filter((request) => request === 'POST /api/projects/project-1/start').length, 1);
  assert.equal(requests.includes('POST /api/projects/project-1/git/fetch'), false);
  assert.equal(requests.filter((request) => request === 'POST /api/projects/project-2/git/fetch').length, 1);
  assert.equal(findElement(projects.children[1], 'Fetch').disabled, false);

  firstActionResponse.resolve(jsonResponse({ ...first, status: 'running' }));
  await firstAction;
  assert.equal(findElement(projects.children[0], 'Running').textContent, 'Running');
  assert.equal(document.elements.get('refresh').disabled, false);
});

test('lists worktrees and removes one only after confirmation before refreshing Git state', async () => {
  const document = createTestDocument();
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
      remote: null,
      ahead: null,
      behind: null,
    },
  };
  const linkedPath = '/projects/demo-topic';
  let linkedExists = true;
  let confirmed = false;
  const confirmations = [];
  const requests = [];
  const fetchImpl = (url, options = {}) => {
    const method = options.method ?? 'GET';
    requests.push({ url, method, body: options.body });
    if (url === '/api/projects') return Promise.resolve(jsonResponse([project]));
    if (url.endsWith('/git/branches')) {
      return Promise.resolve(jsonResponse({ branches: ['main', 'topic'] }));
    }
    if (url.endsWith('/git/worktrees') && method === 'GET') {
      return Promise.resolve(jsonResponse({
        worktrees: [
          { path: project.path, branch: 'main' },
          ...(linkedExists ? [{ path: linkedPath, branch: 'topic' }] : []),
        ],
      }));
    }
    if (url.endsWith('/git/worktrees') && method === 'DELETE') {
      linkedExists = false;
      return Promise.resolve(jsonResponse(null, 204));
    }
    return Promise.resolve(jsonResponse(project));
  };
  const dashboard = initDashboard(document, fetchImpl, (prompt) => {
    confirmations.push(prompt);
    return confirmed;
  });
  await dashboard.ready;

  const projects = document.elements.get('projects');
  assert.ok(findElement(projects, project.path));
  assert.ok(findElement(projects, linkedPath));
  assert.equal(findElements(projects, 'Branch').length, 3);
  assert.ok(findElement(projects, 'main'));
  assert.ok(findElement(projects, 'topic'));
  assert.equal(findElements(projects, 'Remove Worktree').length, 1);

  await findElement(projects, 'Remove Worktree').dispatch('click');
  assert.equal(requests.filter(({ method }) => method === 'DELETE').length, 0);
  assert.deepEqual(confirmations, [
    `Remove worktree at ${linkedPath} (topic)? Branch Switch will not run automatically.`,
  ]);

  confirmed = true;
  await findElement(projects, 'Remove Worktree').dispatch('click');
  const removal = requests.find(({ method }) => method === 'DELETE');
  assert.equal(removal.url, '/api/projects/project-1/git/worktrees');
  assert.deepEqual(JSON.parse(removal.body), { path: linkedPath });
  assert.equal(findElement(projects, linkedPath), null);
  assert.ok(findElement(projects, project.path));
  assert.ok(findElement(projects, 'Remove worktree complete. Retry Branch Switch explicitly if needed.'));
  assert.equal(requests.filter(({ url }) => url.endsWith('/git/branches')).length, 2);
  assert.equal(requests.filter(({ url, method }) => method === 'GET' && url.endsWith('/git/worktrees')).length, 2);
  assert.equal(requests.some(({ url }) => url.includes('/git/switch')), false);
});

test('Git actions and worktree removal refresh every project from the same repository', async () => {
  const document = createTestDocument();
  const identity = '/projects/demo/.git';
  const mainPath = '/projects/demo';
  const linkedPath = '/projects/demo-linked';
  const removablePath = '/projects/demo-removable';
  let mainBranch = 'main';
  let removableExists = true;
  const makeProject = (id, name, projectPath, branch, repositoryIdentity = identity) => ({
    id,
    name,
    path: projectPath,
    startCommand: 'npm start',
    status: 'stopped',
    git: {
      isRepository: true,
      repositoryIdentity,
      branch,
      clean: true,
      remote: null,
      ahead: null,
      behind: null,
    },
  });
  const currentProjects = () => [
    makeProject('main', 'demo', mainPath, mainBranch),
    makeProject('linked', 'demo-linked', linkedPath, 'linked'),
    makeProject('unrelated', 'unrelated', '/projects/unrelated', 'main', '/projects/unrelated/.git'),
  ];
  const requests = [];
  const fetchImpl = (url, options = {}) => {
    const method = options.method ?? 'GET';
    requests.push(`${method} ${url}`);
    if (url === '/api/projects') return Promise.resolve(jsonResponse(currentProjects()));
    if (method === 'POST' && url === '/api/projects/main/git/switch') {
      mainBranch = 'topic';
      return Promise.resolve(jsonResponse(currentProjects()[0]));
    }
    if (method === 'DELETE' && url === '/api/projects/main/git/worktrees') {
      removableExists = false;
      return Promise.resolve(jsonResponse(null, 204));
    }
    if (url.endsWith('/git/branches')) {
      return Promise.resolve(jsonResponse({ branches: ['linked', 'main', 'topic'] }));
    }
    if (url.endsWith('/git/worktrees')) {
      return Promise.resolve(jsonResponse({
        worktrees: url.includes('/unrelated')
          ? [{ path: '/projects/unrelated', branch: 'main' }]
          : [
            { path: mainPath, branch: mainBranch },
            { path: linkedPath, branch: 'linked' },
            ...(removableExists ? [{ path: removablePath, branch: 'removable' }] : []),
          ],
      }));
    }
    const id = url.split('/').at(-1);
    return Promise.resolve(jsonResponse(currentProjects().find((project) => project.id === id)));
  };

  const dashboard = initDashboard(document, fetchImpl, () => true);
  await dashboard.ready;
  const projects = document.elements.get('projects');
  let mainCard = projects.children[0];
  let linkedCard = projects.children[1];
  const unrelatedRefreshesBefore = requests.filter((request) => request.includes('/unrelated')).length;

  const select = findTag(mainCard, 'select');
  select.value = 'topic';
  await select.dispatch('change');
  await findElement(mainCard, 'Switch').dispatch('click');

  await waitFor(() => {
    mainCard = projects.children[0];
    return findElement(mainCard, 'Branch switch complete.');
  });
  mainCard = projects.children[0];
  linkedCard = projects.children[1];
  assert.ok(findElement(mainCard, 'Branch switch complete.'));
  assert.ok(findElement(findWorktreeRow(linkedCard, mainPath), 'topic'));
  assert.equal(requests.filter((request) => request === 'GET /api/projects/main').length, 1);
  assert.equal(requests.filter((request) => request === 'GET /api/projects/linked').length, 1);
  assert.equal(requests.filter((request) => request.includes('/unrelated')).length, unrelatedRefreshesBefore);

  const removableButton = findElements(mainCard, 'Remove Worktree').at(-1);
  await removableButton.dispatch('click');

  mainCard = projects.children[0];
  linkedCard = projects.children[1];
  assert.equal(findElement(mainCard, removablePath), null);
  assert.equal(findElement(linkedCard, removablePath), null);
  assert.equal(requests.filter((request) => request === 'GET /api/projects/main').length, 2);
  assert.equal(requests.filter((request) => request === 'GET /api/projects/linked').length, 2);
  assert.equal(requests.filter((request) => request.includes('/unrelated')).length, unrelatedRefreshesBefore);
});

test('a deferred repository refresh blocks related actions that could supersede its responses', async () => {
  const document = createTestDocument();
  const identity = '/projects/shared/.git';
  const makeProject = (id, name) => ({
    id,
    name,
    path: `/projects/${name}`,
    startCommand: 'npm start',
    status: 'stopped',
    git: {
      isRepository: true,
      repositoryIdentity: identity,
      branch: name,
      clean: true,
      remote: null,
      ahead: null,
      behind: null,
    },
  });
  const first = makeProject('first', 'main');
  const second = makeProject('second', 'linked');
  const staleSecondRefresh = deferred();
  const requests = [];
  const fetchImpl = (url, options = {}) => {
    const method = options.method ?? 'GET';
    requests.push(`${method} ${url}`);
    if (url === '/api/projects') return Promise.resolve(jsonResponse([first, second]));
    if (url.endsWith('/git/branches')) {
      return Promise.resolve(jsonResponse({ branches: ['linked', 'main'] }));
    }
    if (url.endsWith('/git/worktrees')) {
      return Promise.resolve(jsonResponse({
        worktrees: [
          { path: first.path, branch: 'main' },
          { path: second.path, branch: 'linked' },
        ],
      }));
    }
    if (method === 'GET' && url === '/api/projects/first') {
      return Promise.resolve(jsonResponse(first));
    }
    if (method === 'GET' && url === '/api/projects/second') return staleSecondRefresh.promise;
    if (method === 'POST' && url === '/api/projects/second/start') {
      return Promise.resolve(jsonResponse({ ...second, status: 'running' }));
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const dashboard = initDashboard(document, fetchImpl, () => true);
  await dashboard.ready;
  const projects = document.elements.get('projects');
  const refreshRun = findElement(projects.children[0], 'Refresh Git').dispatch('click');
  await waitFor(() => requests.includes('GET /api/projects/second'));

  const relatedCard = projects.children[1];
  assert.equal(relatedCard['aria-busy'], 'true');
  assert.equal(findElement(relatedCard, 'Start').disabled, true);
  await findElement(relatedCard, 'Start').dispatch('click');
  assert.equal(requests.includes('POST /api/projects/second/start'), false);

  staleSecondRefresh.resolve(jsonResponse(second));
  await refreshRun;
  assert.equal(projects.children[1]['aria-busy'], 'false');
  assert.ok(findElement(projects.children[1], 'Stopped'));
});

test('a failed repository refresh stays busy until a deferred sibling settles', async () => {
  const document = createTestDocument();
  const identity = '/projects/shared/.git';
  const makeProject = (id, name) => ({
    id,
    name,
    path: `/projects/${name}`,
    startCommand: 'npm start',
    status: 'stopped',
    git: {
      isRepository: true,
      repositoryIdentity: identity,
      branch: name,
      clean: true,
      remote: null,
      ahead: null,
      behind: null,
    },
  });
  const first = makeProject('first', 'main');
  const second = makeProject('second', 'linked');
  const deferredSecondRefresh = deferred();
  const requests = [];
  const fetchImpl = (url, options = {}) => {
    const method = options.method ?? 'GET';
    requests.push(`${method} ${url}`);
    if (url === '/api/projects') return Promise.resolve(jsonResponse([first, second]));
    if (url.endsWith('/git/branches')) {
      return Promise.resolve(jsonResponse({ branches: ['linked', 'main'] }));
    }
    if (url.endsWith('/git/worktrees')) {
      return Promise.resolve(jsonResponse({
        worktrees: [
          { path: first.path, branch: 'main' },
          { path: second.path, branch: 'linked' },
        ],
      }));
    }
    if (method === 'GET' && url === '/api/projects/first') {
      return Promise.resolve(jsonResponse({ message: 'First refresh failed.' }, 500));
    }
    if (method === 'GET' && url === '/api/projects/second') return deferredSecondRefresh.promise;
    if (method === 'POST' && url === '/api/projects/second/start') {
      return Promise.resolve(jsonResponse({ ...second, status: 'running' }));
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const dashboard = initDashboard(document, fetchImpl, () => true);
  await dashboard.ready;
  const projects = document.elements.get('projects');
  const refreshRun = findElement(projects.children[0], 'Refresh Git').dispatch('click');
  await waitFor(() => requests.includes('GET /api/projects/second'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const relatedCard = projects.children[1];
  assert.equal(relatedCard['aria-busy'], 'true');
  await findElement(relatedCard, 'Start').dispatch('click');
  assert.equal(requests.includes('POST /api/projects/second/start'), false);

  deferredSecondRefresh.resolve(jsonResponse(second));
  await refreshRun;
  assert.equal(projects.children[1]['aria-busy'], 'false');
  assert.ok(findElement(projects.children[0], 'Git refresh failed: First refresh failed.'));
});


test('bulk worktree removal confirms the preview count and reports removed and retained paths', async () => {
  const document = createTestDocument();
  const project = { id: 'bulk', name: 'demo', path: '/demo', startCommand: 'npm start',
    status: 'stopped', git: { isRepository: true, branch: 'main', clean: true } };
  const requests = [];
  const prompts = [];
  let confirmed = false;
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, ...options });
    if (url === '/api/projects') return jsonResponse([project]);
    if (url.endsWith('/git/branches')) return jsonResponse({ branches: ['main'] });
    if (url.endsWith('/git/worktrees')) return jsonResponse({ worktrees: [{ path: '/demo', branch: 'main' }] });
    if (url.endsWith('/removal')) return jsonResponse(options.method === 'POST'
      ? { removed: ['/topic'], retained: [{ path: '/demo', reason: 'Registered project' }] }
      : { targets: [{ path: '/topic', branch: 'topic' }], retained: [{ path: '/demo', reason: 'Registered project' }] });
    return jsonResponse(project);
  };
  await initDashboard(document, fetchImpl, (prompt) => { prompts.push(prompt); return confirmed; }).ready;
  const projects = document.elements.get('projects');
  await findElement(projects, 'Remove all worktrees').dispatch('click');
  assert.equal(requests.some(({ method }) => method === 'POST'), false);
  assert.match(prompts[0], /Remove 1 worktrees\?/);
  assert.match(prompts[0], /Retained worktrees \(1\):\n\/demo: Registered project/);
  confirmed = true;
  await findElement(projects, 'Remove all worktrees').dispatch('click');
  const removal = requests.find(({ method }) => method === 'POST');
  assert.deepEqual(JSON.parse(removal.body), { paths: ['/topic'] });
  assert.ok(findElement(projects, 'Removed 1 worktrees: /topic. Retained 1 worktrees: /demo: Registered project.'));
  assert.equal(requests.filter(({ url }) => url.endsWith('/git/worktrees')).length, 2);
});

test('search filters projects by name or path and project collapse preserves the visible target', async () => {
  const document = createTestDocument();
  const projects = [
    { id: 'one', name: 'Alpha', path: '/code/alpha', startCommand: 'npm start', status: 'stopped' },
    { id: 'two', name: 'Beta', path: '/work/special', startCommand: 'npm start', status: 'stopped' },
  ];
  const fetchImpl = async (url) => jsonResponse(url === '/api/projects' ? projects : projects[0]);
  await initDashboard(document, fetchImpl, () => true).ready;
  const list = document.elements.get('projects');
  const search = document.elements.get('project-search');
  search.value = 'SPECIAL';
  await search.dispatch('input');
  assert.equal(list.children.length, 1);
  assert.ok(findElement(list, 'Beta'));
  assert.equal(document.elements.get('project-count').textContent, '1 of 2 projects shown');

  await findElement(list, 'Edit').dispatch('click');
  assert.ok(findElement(list, 'Current target'));
  assert.equal(document.elements.get('form-title').textContent, 'Edit project: Beta');
  search.value = 'alpha';
  await search.dispatch('input');
  assert.equal(findElement(list, 'Beta'), null);
  assert.equal(document.elements.get('form-title').textContent, 'Edit project: Beta');
  search.value = 'special';
  await search.dispatch('input');
  await findElement(list, 'Collapse project').dispatch('click');
  assert.ok(findElement(list, 'Beta'));
  assert.ok(findElement(list, '/work/special'));
  assert.ok(findElement(list, 'Current target'));
  assert.equal(findElement(list, 'Edit'), null);
  await findElement(list, 'Expand project').dispatch('click');
  assert.ok(findElement(list, 'Edit'));

  search.value = 'missing';
  await search.dispatch('input');
  assert.ok(findElement(list, '<p class="empty">No projects match your search.</p>'));
  search.value = 'alpha';
  await search.dispatch('input');
  assert.ok(findElement(list, 'Alpha'));
});

test('long worktree lists show the registered project path and expand on demand', async () => {
  const document = createTestDocument();
  const project = { id: 'one', name: 'Alpha', path: '/code/linked/packages/app',
    startCommand: 'npm start', status: 'stopped', git: { isRepository: true, branch: 'linked', clean: true } };
  const listedProjectPath = '/alias/linked';
  const worktrees = Array.from({ length: 8 }, (_, index) => ({
    path: index === 7 ? listedProjectPath : `/code/topic-${index}`,
    branch: index === 7 ? 'linked' : `topic-${index}`,
    isProjectWorktree: index === 7,
  }));
  const fetchImpl = async (url) => {
    if (url === '/api/projects') return jsonResponse([project]);
    if (url.endsWith('/git/branches')) return jsonResponse({ branches: ['linked'] });
    if (url.endsWith('/git/worktrees')) return jsonResponse({ worktrees });
    return jsonResponse(project);
  };
  await initDashboard(document, fetchImpl, () => true).ready;
  const list = document.elements.get('projects');
  const registeredRow = findWorktreeRow(list, listedProjectPath);
  assert.ok(registeredRow);
  assert.ok(findElement(list, 'Project worktree'));
  assert.equal(findElement(registeredRow, 'Remove Worktree'), null);
  assert.equal(findElements(list, 'Remove Worktree').length, 4);
  assert.equal(findWorktreeRow(list, '/code/topic-6'), null);
  await findElement(list, 'Show all 8 worktrees').dispatch('click');
  assert.equal(findElements(list, 'Remove Worktree').length, 7);
  await findElement(list, 'Show fewer worktrees').dispatch('click');
  assert.equal(findElements(list, 'Remove Worktree').length, 4);
});
