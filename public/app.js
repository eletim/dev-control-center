export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export async function requestJson(url, options = {}, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch {
    throw new ApiError('Could not reach Dev Control Center.');
  }

  let body = null;
  try {
    body = response.status === 204 ? null : await response.json();
  } catch {
    // A useful fallback below is clearer than exposing a response parsing error.
  }
  if (!response.ok) {
    throw new ApiError(body?.message || `Request failed (${response.status}).`, response.status);
  }
  return body;
}

export function describeGit(git) {
  if (!git) return { repository: false, summary: 'Git metadata unavailable.' };
  if (!git.isRepository) return { repository: false, summary: 'Not a Git repository.' };
  return {
    repository: true,
    branch: git.branch || 'Detached or unavailable',
    worktree: git.clean === null ? 'Unavailable' : git.clean ? 'Clean' : 'Uncommitted changes',
    upstream: git.remote || 'Not configured or unavailable',
    divergence: git.remote
      ? (git.ahead === null || git.behind === null
        ? 'Unavailable'
        : `${git.ahead} ahead / ${git.behind} behind`)
      : 'Unavailable',
  };
}

export function initDashboard(documentObject = document, fetchImpl = fetch, confirmImpl = confirm) {
  const projectsElement = documentObject.querySelector('#projects');
  const form = documentObject.querySelector('#project-form');
  const idInput = documentObject.querySelector('#project-id');
  const pathInput = documentObject.querySelector('#path');
  const commandInput = documentObject.querySelector('#start-command');
  const message = documentObject.querySelector('#message');
  const cancelButton = documentObject.querySelector('#cancel');
  const saveButton = documentObject.querySelector('#save-project');
  const refreshButton = documentObject.querySelector('#refresh');

  let projects = [];
  let loadingProjects = false;
  let savingProject = false;
  let savingProjectId = null;
  let projectsRefreshRequired = false;
  const pendingProjects = new Set();
  const projectMessages = new Map();
  const branchStates = new Map();
  const worktreeStates = new Map();

  function actionError(label, error) {
    const kind = error instanceof ApiError && error.status >= 400 && error.status < 500
      ? 'refused'
      : 'failed';
    return `${label} ${kind}: ${error.message}`;
  }

  function replaceProject(project) {
    const index = projects.findIndex(({ id }) => id === project.id);
    if (index === -1) projects.push(project);
    else projects[index] = project;
  }

  function addMetadataRow(list, termText, detailText) {
    const term = documentObject.createElement('dt');
    term.textContent = termText;
    const detail = documentObject.createElement('dd');
    detail.textContent = detailText;
    list.append(term, detail);
  }

  function makeButton(label, className, disabled, listener) {
    const button = documentObject.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener('click', listener);
    return button;
  }

  function renderGit(project, busy) {
    const section = documentObject.createElement('section');
    section.className = 'git-state';
    const heading = documentObject.createElement('div');
    heading.className = 'git-heading';
    const title = documentObject.createElement('h4');
    title.textContent = 'Git state';
    const refresh = makeButton('Refresh Git', 'secondary compact', busy, () => refreshGit(project));
    heading.append(title, refresh);
    section.append(heading);

    const details = describeGit(project.git);
    if (!details.repository) {
      const unavailable = documentObject.createElement('p');
      unavailable.className = 'meta unavailable';
      unavailable.textContent = `${details.summary} Git actions are unavailable.`;
      section.append(unavailable);
      return section;
    }

    const metadata = documentObject.createElement('dl');
    metadata.className = 'git-metadata';
    addMetadataRow(metadata, 'Branch', details.branch);
    addMetadataRow(metadata, 'Working tree', details.worktree);
    addMetadataRow(metadata, 'Upstream', details.upstream);
    addMetadataRow(metadata, 'Divergence', details.divergence);
    section.append(metadata);

    const branchControls = documentObject.createElement('div');
    branchControls.className = 'branch-controls';
    const branchLabel = documentObject.createElement('label');
    branchLabel.textContent = 'Local branch';
    const select = documentObject.createElement('select');
    select.setAttribute('aria-label', `Local branch for ${project.name}`);
    const branchState = branchStates.get(project.id);
    const branchesReady = branchState?.status === 'ready';
    const branches = branchesReady ? branchState.branches : [];
    const placeholder = documentObject.createElement('option');
    placeholder.value = '';
    placeholder.textContent = branchState?.status === 'error'
      ? 'Branches unavailable'
      : branchesReady ? 'Select a branch' : 'Loading branches…';
    select.append(placeholder);
    for (const branch of branches) {
      const option = documentObject.createElement('option');
      option.value = branch;
      option.textContent = branch;
      option.selected = branch === project.git.branch;
      select.append(option);
    }
    select.disabled = busy || !branchesReady || branches.length === 0;
    branchLabel.append(select);
    const switchButton = makeButton('Switch', 'secondary', true, () => {
      runGitAction(project, 'switch', select.value);
    });
    const updateSwitchState = () => {
      switchButton.disabled = busy || !select.value || select.value === project.git.branch;
    };
    select.addEventListener('change', updateSwitchState);
    updateSwitchState();
    branchControls.append(branchLabel, switchButton);
    section.append(branchControls);

    if (branchState?.status === 'error') {
      const branchError = documentObject.createElement('p');
      branchError.className = 'inline-message error';
      branchError.textContent = `Branch list failed: ${branchState.message}`;
      section.append(branchError);
    } else if (branchesReady && branches.length === 0) {
      const noBranches = documentObject.createElement('p');
      noBranches.className = 'inline-message unavailable';
      noBranches.textContent = 'No local branches are available.';
      section.append(noBranches);
    }

    const worktreeState = worktreeStates.get(project.id);
    const worktreeHeading = documentObject.createElement('h5');
    worktreeHeading.textContent = 'Worktrees';
    section.append(worktreeHeading);
    if (worktreeState?.status === 'ready') {
      const worktreeList = documentObject.createElement('div');
      worktreeList.className = 'worktree-list';
      for (const worktree of worktreeState.worktrees) {
        const row = documentObject.createElement('div');
        row.className = 'worktree-row';
        const worktreeMetadata = documentObject.createElement('dl');
        worktreeMetadata.className = 'git-metadata worktree-metadata';
        addMetadataRow(worktreeMetadata, 'Path', worktree.path);
        addMetadataRow(worktreeMetadata, 'Branch', worktree.branch || 'Detached');
        row.append(worktreeMetadata);
        if (worktree.path !== project.path) {
          row.append(makeButton(
            'Remove Worktree',
            'secondary compact',
            busy,
            () => removeProjectWorktree(project, worktree),
          ));
        }
        worktreeList.append(row);
      }
      section.append(worktreeList);
    } else {
      const worktreeMessage = documentObject.createElement('p');
      worktreeMessage.className = `inline-message ${worktreeState?.status === 'error' ? 'error' : 'unavailable'}`;
      worktreeMessage.textContent = worktreeState?.status === 'error'
        ? `Worktree list failed: ${worktreeState.message}`
        : 'Loading worktrees…';
      section.append(worktreeMessage);
    }

    const gitActions = documentObject.createElement('div');
    gitActions.className = 'actions';
    gitActions.append(
      makeButton('Fetch', 'secondary', busy, () => runGitAction(project, 'fetch')),
      makeButton('Update (fast-forward)', 'secondary', busy, () => runGitAction(project, 'update')),
    );
    section.append(gitActions);
    return section;
  }

  function render() {
    refreshButton.disabled = loadingProjects || savingProject || pendingProjects.size > 0;
    saveButton.disabled = loadingProjects || savingProject
      || Boolean(idInput.value && pendingProjects.has(idInput.value));
    cancelButton.disabled = savingProject;
    if (!projects.length) {
      projectsElement.innerHTML = '<p class="empty">No projects registered yet.</p>';
      return;
    }
    projectsElement.replaceChildren(...projects.map((project) => {
      const busy = loadingProjects || pendingProjects.has(project.id)
        || savingProjectId === project.id;
      const article = documentObject.createElement('article');
      article.className = 'project';
      article.setAttribute('aria-busy', String(busy));
      const heading = documentObject.createElement('h3');
      heading.textContent = project.name;
      const pathLine = documentObject.createElement('div');
      const pathCode = documentObject.createElement('code');
      pathCode.textContent = project.path;
      pathLine.append(pathCode);
      const command = documentObject.createElement('p');
      command.className = 'meta';
      command.textContent = `Start: ${project.startCommand}`;
      const status = documentObject.createElement('p');
      status.className = `status ${project.status}`;
      status.textContent = project.status === 'running' ? 'Running' : 'Stopped';
      const actions = documentObject.createElement('div');
      actions.className = 'actions';
      actions.append(
        makeButton('Start', '', busy || project.status === 'running', () => runLifecycleAction(project, 'start')),
        makeButton('Stop', 'secondary', busy || project.status !== 'running', () => runLifecycleAction(project, 'stop')),
        makeButton('Restart', 'secondary', busy || project.status !== 'running', () => runLifecycleAction(project, 'restart')),
        makeButton('Edit', 'secondary', busy || project.status === 'running', () => editProject(project)),
        makeButton('Delete', 'secondary', busy || project.status === 'running', () => deleteProject(project)),
      );
      article.append(heading, status, pathLine, command, actions, renderGit(project, busy));
      const projectMessage = projectMessages.get(project.id);
      if (projectMessage) {
        const feedback = documentObject.createElement('p');
        feedback.className = `project-message ${projectMessage.error ? 'error' : 'success'}`;
        feedback.setAttribute('role', 'status');
        feedback.textContent = projectMessage.text;
        article.append(feedback);
      }
      return article;
    }));
  }

  async function loadBranches(project) {
    branchStates.set(project.id, { status: 'loading' });
    render();
    try {
      const body = await requestJson(
        `/api/projects/${encodeURIComponent(project.id)}/git/branches`,
        {},
        fetchImpl,
      );
      branchStates.set(project.id, { status: 'ready', branches: body.branches });
    } catch (error) {
      branchStates.set(project.id, { status: 'error', message: error.message });
    }
    render();
  }

  async function loadWorktrees(project) {
    worktreeStates.set(project.id, { status: 'loading' });
    render();
    try {
      const body = await requestJson(
        `/api/projects/${encodeURIComponent(project.id)}/git/worktrees`,
        {},
        fetchImpl,
      );
      worktreeStates.set(project.id, { status: 'ready', worktrees: body.worktrees });
    } catch (error) {
      worktreeStates.set(project.id, { status: 'error', message: error.message });
    }
    render();
  }

  function loadGitDetails(project) {
    return Promise.all([loadBranches(project), loadWorktrees(project)]);
  }

  async function refreshProject(project, includeBranches) {
    const refreshed = await requestJson(
      `/api/projects/${encodeURIComponent(project.id)}`,
      {},
      fetchImpl,
    );
    replaceProject(refreshed);
    render();
    if (includeBranches && refreshed.git?.isRepository) await loadGitDetails(refreshed);
  }

  function projectsSharingRepository(project) {
    const identity = project.git?.repositoryIdentity;
    return identity
      ? projects.filter((candidate) => candidate.git?.repositoryIdentity === identity)
      : [project];
  }

  function refreshRepositoryProjects(relatedProjects) {
    return Promise.all(relatedProjects
      .map((candidate) => refreshProject(candidate, true)));
  }

  function projectsAreBusy(candidates) {
    return loadingProjects || candidates.some(({ id }) => (
      pendingProjects.has(id) || savingProjectId === id
    ));
  }

  async function performProjectAction(project, label, request, includeBranches) {
    const affectedProjects = includeBranches ? projectsSharingRepository(project) : [project];
    if (projectsAreBusy(affectedProjects)) return;
    for (const { id } of affectedProjects) pendingProjects.add(id);
    projectMessages.set(project.id, { text: `${label} in progress…`, error: false });
    render();
    try {
      const updated = await request();
      replaceProject(updated);
      projectMessages.set(project.id, { text: `${label} complete.`, error: false });
    } catch (error) {
      projectMessages.set(project.id, { text: actionError(label, error), error: true });
    }
    try {
      if (includeBranches) await refreshRepositoryProjects(affectedProjects);
      else await refreshProject(project, false);
    } catch (error) {
      const existing = projectMessages.get(project.id);
      projectMessages.set(project.id, {
        text: `${existing?.text || `${label} finished.`} State refresh failed: ${error.message}`,
        error: true,
      });
    } finally {
      for (const { id } of affectedProjects) pendingProjects.delete(id);
      render();
      await reconcileProjectsWhenIdle();
    }
  }

  function runLifecycleAction(project, action) {
    const labels = { start: 'Start', stop: 'Stop', restart: 'Restart' };
    return performProjectAction(
      project,
      labels[action],
      () => requestJson(`/api/projects/${encodeURIComponent(project.id)}/${action}`, { method: 'POST' }, fetchImpl),
      false,
    );
  }

  function runGitAction(project, action, branch) {
    const labels = { fetch: 'Fetch', update: 'Fast-forward update', switch: 'Branch switch' };
    const options = { method: 'POST' };
    if (action === 'switch') {
      options.headers = { 'content-type': 'application/json' };
      options.body = JSON.stringify({ branch });
    }
    return performProjectAction(
      project,
      labels[action],
      () => requestJson(
        `/api/projects/${encodeURIComponent(project.id)}/git/${action}`,
        options,
        fetchImpl,
      ),
      true,
    );
  }

  async function removeProjectWorktree(project, worktree) {
    const affectedProjects = projectsSharingRepository(project);
    if (projectsAreBusy(affectedProjects)
      || !confirmImpl(`Remove worktree at ${worktree.path} (${worktree.branch || 'Detached'})? Branch Switch will not run automatically.`)) return;
    for (const { id } of affectedProjects) pendingProjects.add(id);
    projectMessages.set(project.id, { text: 'Remove worktree in progress…', error: false });
    render();
    try {
      await requestJson(`/api/projects/${encodeURIComponent(project.id)}/git/worktrees`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: worktree.path }),
      }, fetchImpl);
      projectMessages.set(project.id, {
        text: 'Remove worktree complete. Retry Branch Switch explicitly if needed.',
        error: false,
      });
    } catch (error) {
      projectMessages.set(project.id, { text: actionError('Remove worktree', error), error: true });
    }
    try {
      await refreshRepositoryProjects(affectedProjects);
    } catch (error) {
      const existing = projectMessages.get(project.id);
      projectMessages.set(project.id, {
        text: `${existing?.text || 'Remove worktree finished.'} State refresh failed: ${error.message}`,
        error: true,
      });
    } finally {
      for (const { id } of affectedProjects) pendingProjects.delete(id);
      render();
      await reconcileProjectsWhenIdle();
    }
  }

  async function refreshGit(project) {
    const affectedProjects = projectsSharingRepository(project);
    if (projectsAreBusy(affectedProjects)) return;
    for (const { id } of affectedProjects) pendingProjects.add(id);
    projectMessages.set(project.id, { text: 'Refreshing Git state…', error: false });
    render();
    try {
      await refreshRepositoryProjects(affectedProjects);
      projectMessages.set(project.id, { text: 'Git state refreshed.', error: false });
    } catch (error) {
      projectMessages.set(project.id, { text: actionError('Git refresh', error), error: true });
    } finally {
      for (const { id } of affectedProjects) pendingProjects.delete(id);
      render();
      await reconcileProjectsWhenIdle();
    }
  }

  async function loadProjects(clearMessage = true) {
    if (loadingProjects || savingProject || pendingProjects.size > 0) return;
    loadingProjects = true;
    if (clearMessage) message.textContent = '';
    render();
    try {
      projects = await requestJson('/api/projects', {}, fetchImpl);
      const projectIds = new Set(projects.map(({ id }) => id));
      for (const id of branchStates.keys()) if (!projectIds.has(id)) branchStates.delete(id);
      for (const id of worktreeStates.keys()) if (!projectIds.has(id)) worktreeStates.delete(id);
      for (const id of projectMessages.keys()) if (!projectIds.has(id)) projectMessages.delete(id);
      render();
      await Promise.all(projects
        .filter((project) => project.git?.isRepository)
        .map((project) => loadGitDetails(project)));
    } catch (error) {
      message.textContent = `Project refresh failed: ${error.message}`;
    } finally {
      loadingProjects = false;
      render();
    }
  }

  async function reconcileProjectsWhenIdle() {
    if (!projectsRefreshRequired || loadingProjects || savingProject || pendingProjects.size > 0) return;
    projectsRefreshRequired = false;
    await loadProjects(false);
  }

  function editProject(project) {
    if (loadingProjects || pendingProjects.has(project.id) || savingProjectId === project.id) return;
    idInput.value = project.id;
    pathInput.value = project.path;
    commandInput.value = project.startCommand;
    documentObject.querySelector('#form-title').textContent = 'Edit project';
    cancelButton.hidden = false;
    pathInput.focus();
  }

  function resetForm() {
    form.reset();
    idInput.value = '';
    documentObject.querySelector('#form-title').textContent = 'Add project';
    cancelButton.hidden = true;
  }

  async function deleteProject(project) {
    if (loadingProjects || pendingProjects.has(project.id) || savingProjectId === project.id
      || !confirmImpl(`Delete ${project.name}?`)) return;
    pendingProjects.add(project.id);
    projectMessages.set(project.id, { text: 'Delete in progress…', error: false });
    render();
    try {
      await requestJson(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' }, fetchImpl);
      if (idInput.value === project.id) resetForm();
      projects = projects.filter(({ id }) => id !== project.id);
      branchStates.delete(project.id);
      worktreeStates.delete(project.id);
      projectMessages.delete(project.id);
      projectsRefreshRequired = true;
    } catch (error) {
      projectMessages.set(project.id, { text: actionError('Delete', error), error: true });
    } finally {
      pendingProjects.delete(project.id);
      render();
      await reconcileProjectsWhenIdle();
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = idInput.value;
    if (loadingProjects || savingProject || (id && pendingProjects.has(id))) return;
    savingProject = true;
    savingProjectId = id || null;
    message.textContent = 'Saving project…';
    render();
    try {
      const saved = await requestJson(id ? `/api/projects/${encodeURIComponent(id)}` : '/api/projects', {
        method: id ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: pathInput.value, startCommand: commandInput.value }),
      }, fetchImpl);
      replaceProject(saved);
      resetForm();
      message.textContent = 'Project saved.';
      projectsRefreshRequired = true;
    } catch (error) {
      message.textContent = actionError('Save', error);
    } finally {
      savingProject = false;
      savingProjectId = null;
      render();
      await reconcileProjectsWhenIdle();
    }
  });

  cancelButton.addEventListener('click', resetForm);
  refreshButton.addEventListener('click', () => loadProjects());
  const ready = loadProjects();
  return { ready };
}

if (typeof document !== 'undefined') initDashboard();
