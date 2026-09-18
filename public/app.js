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

export function initDashboard(documentObject = document, fetchImpl = fetch, confirmImpl = confirm,
  { setIntervalImpl = setInterval } = {}) {
  const projectsElement = documentObject.querySelector('#projects');
  const form = documentObject.querySelector('#project-form');
  const idInput = documentObject.querySelector('#project-id');
  const pathInput = documentObject.querySelector('#path');
  const commandInput = documentObject.querySelector('#start-command');
  const message = documentObject.querySelector('#message');
  const cancelButton = documentObject.querySelector('#cancel');
  const saveButton = documentObject.querySelector('#save-project');
  const refreshButton = documentObject.querySelector('#refresh');
  const searchInput = documentObject.querySelector('#project-search');
  const projectCount = documentObject.querySelector('#project-count');

  let projects = [];
  let loadingProjects = false;
  let savingProject = false;
  let savingProjectId = null;
  let projectsRefreshRequired = false;
  let visibilityRefreshRequired = false;
  const pendingProjects = new Set();
  const projectMessages = new Map();
  const branchStates = new Map();
  const selectedBranches = new Map();
  const worktreeStates = new Map();
  const outputStates = new Map();
  const collapsedProjects = new Set();
  const expandedWorktrees = new Set();
  let activeProjectId = null;
  const worktreePreviewLimit = 5;

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
    const selectedBranch = selectedBranches.get(project.id);
    select.value = selectedBranch && branches.includes(selectedBranch)
      ? selectedBranch : branches.includes(project.git.branch) ? project.git.branch : '';
    select.disabled = busy || !branchesReady || branches.length === 0;
    branchLabel.append(select);
    const switchButton = makeButton('Switch', 'secondary', true, () => {
      runGitAction(project, 'switch', select.value);
    });
    const updateSwitchState = () => {
      switchButton.disabled = busy || !select.value || select.value === project.git.branch;
    };
    select.addEventListener('change', () => {
      selectedBranches.set(project.id, select.value);
      updateSwitchState();
    });
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
      section.append(makeButton('Remove all worktrees', 'secondary compact', busy,
        () => removeAllProjectWorktrees(project)));
      const worktreeList = documentObject.createElement('div');
      worktreeList.className = 'worktree-list';
      const isProjectWorktree = (worktree) => worktree.isProjectWorktree || worktree.path === project.path;
      const worktrees = [...worktreeState.worktrees].sort((a, b) =>
        Number(isProjectWorktree(b)) - Number(isProjectWorktree(a)));
      const showAll = expandedWorktrees.has(project.id);
      const visibleWorktrees = showAll ? worktrees : worktrees.slice(0, worktreePreviewLimit);
      for (const worktree of visibleWorktrees) {
        const row = documentObject.createElement('div');
        row.className = `worktree-row${isProjectWorktree(worktree) ? ' current-worktree' : ''}`;
        const worktreeMetadata = documentObject.createElement('dl');
        worktreeMetadata.className = 'git-metadata worktree-metadata';
        addMetadataRow(worktreeMetadata, 'Path', worktree.path);
        addMetadataRow(worktreeMetadata, 'Branch', worktree.branch || 'Detached');
        if (isProjectWorktree(worktree)) addMetadataRow(worktreeMetadata, 'Role', 'Project worktree');
        row.append(worktreeMetadata);
        if (!isProjectWorktree(worktree)) {
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
      if (worktrees.length > worktreePreviewLimit) {
        section.append(makeButton(
          showAll ? 'Show fewer worktrees' : `Show all ${worktrees.length} worktrees`,
          'secondary compact worktree-toggle', false,
          () => {
            if (showAll) expandedWorktrees.delete(project.id);
            else expandedWorktrees.add(project.id);
            render();
          },
        ));
      }
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

  function renderProcess(project) {
    const section = documentObject.createElement('section');
    section.className = 'process-output';
    const heading = documentObject.createElement('h4');
    heading.textContent = 'Process output';
    section.append(heading);
    if (project.process?.state === 'exited') {
      const outcome = documentObject.createElement('p');
      const { exitCode, signal } = project.process;
      const normal = exitCode === 0 && !signal;
      outcome.className = `exit-result ${normal ? 'success' : 'error'}`;
      outcome.textContent = normal ? 'Exited normally (exit code 0).'
        : signal ? `Exited abnormally (signal ${signal}).`
          : exitCode === null ? 'Exited abnormally (reason unavailable).'
            : `Exited abnormally (exit code ${exitCode}).`;
      section.append(outcome);
    }
    const state = outputStates.get(project.id);
    section.append(makeButton(state?.open ? 'Hide output' : 'View output', 'secondary compact', false, () => {
      if (state?.open) {
        outputStates.set(project.id, { ...state, open: false });
        render();
      } else loadOutput(project.id);
    }));
    if (state?.open) {
      section.append(makeButton('Refresh output', 'secondary compact', state.loading, () => loadOutput(project.id)));
      const output = documentObject.createElement('pre');
      output.className = 'process-output-text';
      output.textContent = state.loading ? 'Loading output…'
        : state.error ? `Output unavailable: ${state.error}`
          : state.output === null ? 'No retained tmux output is available.'
            : state.output.trimEnd() || 'No output yet.';
      section.append(output);
    }
    return section;
  }

  async function loadOutput(id) {
    const loadingState = { open: true, loading: true };
    outputStates.set(id, loadingState);
    render();
    let nextState;
    try {
      const result = await requestJson(`/api/projects/${encodeURIComponent(id)}/output`, {}, fetchImpl);
      nextState = { open: true, loading: false, output: result.output };
    } catch (error) {
      nextState = { open: true, loading: false, error: error.message };
    }
    if (outputStates.get(id) !== loadingState) return;
    outputStates.set(id, nextState);
    render();
  }

  function render() {
    refreshButton.disabled = loadingProjects || savingProject || pendingProjects.size > 0;
    saveButton.disabled = loadingProjects || savingProject
      || Boolean(idInput.value && pendingProjects.has(idInput.value));
    cancelButton.disabled = savingProject;
    const query = searchInput.value.trim().toLocaleLowerCase();
    const visibleProjects = projects.filter((project) =>
      `${project.name} ${project.path}`.toLocaleLowerCase().includes(query));
    projectCount.textContent = `${visibleProjects.length} of ${projects.length} projects shown`;
    if (!projects.length) {
      projectsElement.innerHTML = '<p class="empty">No projects registered yet.</p>';
      return;
    }
    if (!visibleProjects.length) {
      projectsElement.innerHTML = '<p class="empty">No projects match your search.</p>';
      return;
    }
    projectsElement.replaceChildren(...visibleProjects.map((project) => {
      const busy = loadingProjects || pendingProjects.has(project.id)
        || savingProjectId === project.id;
      const article = documentObject.createElement('article');
      article.className = `project${activeProjectId === project.id ? ' active-project' : ''}`;
      article.setAttribute('aria-busy', String(busy));
      const header = documentObject.createElement('div');
      header.className = 'project-heading';
      const heading = documentObject.createElement('h3');
      heading.textContent = project.name;
      const toggle = makeButton(
        collapsedProjects.has(project.id) ? 'Expand project' : 'Collapse project',
        'secondary compact', false,
        () => {
          if (collapsedProjects.has(project.id)) collapsedProjects.delete(project.id);
          else collapsedProjects.add(project.id);
          render();
        },
      );
      toggle.setAttribute('aria-expanded', String(!collapsedProjects.has(project.id)));
      header.append(heading, toggle);
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
      article.append(header, status, pathLine);
      if (activeProjectId === project.id) {
        const active = documentObject.createElement('span');
        active.className = 'active-label';
        active.textContent = 'Current target';
        article.append(active);
      }
      if (!collapsedProjects.has(project.id)) article.append(command, actions, renderProcess(project), renderGit(project, busy));
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
      if (!body.branches.includes(selectedBranches.get(project.id))) selectedBranches.delete(project.id);
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
    return refreshed;
  }

  function projectsSharingRepository(project) {
    const identity = project.git?.repositoryIdentity;
    return identity
      ? projects.filter((candidate) => candidate.git?.repositoryIdentity === identity)
      : [project];
  }

  async function refreshRepositoryProjects(relatedProjects) {
    const results = await Promise.allSettled(relatedProjects
      .map((candidate) => refreshProject(candidate, true)));
    const failure = results.find(({ status }) => status === 'rejected');
    if (failure) throw failure.reason;
  }

  function projectsAreBusy(candidates) {
    return loadingProjects || candidates.some(({ id }) => (
      pendingProjects.has(id) || savingProjectId === id
    ));
  }

  async function performProjectAction(project, label, request, includeBranches) {
    const affectedProjects = includeBranches ? projectsSharingRepository(project) : [project];
    if (projectsAreBusy(affectedProjects)) return;
    activeProjectId = project.id;
    for (const { id } of affectedProjects) pendingProjects.add(id);
    projectMessages.set(project.id, { text: `${label} in progress…`, error: false });
    render();
    let actionSucceeded = false;
    try {
      const updated = await request();
      replaceProject(updated);
      actionSucceeded = true;
      projectMessages.set(project.id, { text: `${label} complete.`, error: false });
    } catch (error) {
      projectMessages.set(project.id, { text: actionError(label, error), error: true });
    }
    try {
      if (includeBranches) await refreshRepositoryProjects(affectedProjects);
      else {
        const refreshed = await refreshProject(project, false);
        if (actionSucceeded && (label === 'Start' || label === 'Restart') && refreshed.status === 'stopped') {
          projectMessages.set(project.id, {
            text: 'Start Command exited; no DCC-managed process is running.',
            error: false,
          });
        }
      }
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
    if (action !== 'stop') outputStates.delete(project.id);
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
    activeProjectId = project.id;
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

  async function removeAllProjectWorktrees(project) {
    const affectedProjects = projectsSharingRepository(project);
    if (projectsAreBusy(affectedProjects)) return;
    activeProjectId = project.id;
    for (const { id } of affectedProjects) pendingProjects.add(id);
    render();
    try {
      const url = `/api/projects/${encodeURIComponent(project.id)}/git/worktrees/removal`;
      const preview = await requestJson(url, {}, fetchImpl);
      const retainedText = preview.retained.map(({ path, reason }) => `${path}: ${reason}`).join('\n');
      if (!confirmImpl(`Remove ${preview.targets.length} worktrees?\n${preview.targets.map(({ path }) => path).join('\n')}\nRetained worktrees (${preview.retained.length}):\n${retainedText}`)) return;
      const result = await requestJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: preview.targets.map(({ path }) => path) }),
      }, fetchImpl);
      projectMessages.set(project.id, {
        text: `Removed ${result.removed.length} worktrees: ${result.removed.join('; ') || 'None'}. Retained ${result.retained.length} worktrees: ${result.retained.map(({ path, reason }) => `${path}: ${reason}`).join('; ') || 'None'}.`,
        error: false,
      });
      await refreshRepositoryProjects(affectedProjects);
    } catch (error) {
      const existing = projectMessages.get(project.id);
      projectMessages.set(project.id, {
        text: `${existing?.text || ''} ${actionError('Remove all worktrees', error)}`.trim(),
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
    activeProjectId = project.id;
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
      for (const project of projects) {
        const feedback = projectMessages.get(project.id);
        if (project.status === 'stopped'
          && (feedback?.text === 'Start complete.' || feedback?.text === 'Restart complete.')) {
          projectMessages.set(project.id, {
            text: 'Start Command exited; no DCC-managed process is running.',
            error: false,
          });
        }
      }
      const projectIds = new Set(projects.map(({ id }) => id));
      for (const id of branchStates.keys()) if (!projectIds.has(id)) branchStates.delete(id);
      for (const id of selectedBranches.keys()) if (!projectIds.has(id)) selectedBranches.delete(id);
      for (const id of worktreeStates.keys()) if (!projectIds.has(id)) worktreeStates.delete(id);
      for (const id of outputStates.keys()) if (!projectIds.has(id)) outputStates.delete(id);
      for (const id of projectMessages.keys()) if (!projectIds.has(id)) projectMessages.delete(id);
      for (const id of collapsedProjects) if (!projectIds.has(id)) collapsedProjects.delete(id);
      for (const id of expandedWorktrees) if (!projectIds.has(id)) expandedWorktrees.delete(id);
      if (activeProjectId && !projectIds.has(activeProjectId)) activeProjectId = null;
      render();
      await Promise.all(projects
        .filter((project) => project.git?.isRepository)
        .map((project) => loadGitDetails(project)));
    } catch (error) {
      message.textContent = `Project refresh failed: ${error.message}`;
    } finally {
      loadingProjects = false;
      render();
      await reconcileProjectsWhenIdle();
    }
  }

  async function reconcileProjectsWhenIdle() {
    if ((!projectsRefreshRequired && !visibilityRefreshRequired)
      || loadingProjects || savingProject || pendingProjects.size > 0) return;
    if (documentObject.hidden && !projectsRefreshRequired) return;
    projectsRefreshRequired = false;
    visibilityRefreshRequired = false;
    await loadProjects(false);
  }

  function refreshWhenVisible() {
    if (documentObject.hidden) return;
    if (loadingProjects || savingProject || pendingProjects.size > 0) {
      visibilityRefreshRequired = true;
      return;
    }
    visibilityRefreshRequired = false;
    loadProjects(false);
  }

  function editProject(project) {
    if (loadingProjects || pendingProjects.has(project.id) || savingProjectId === project.id) return;
    activeProjectId = project.id;
    idInput.value = project.id;
    pathInput.value = project.path;
    commandInput.value = project.startCommand;
    documentObject.querySelector('#form-title').textContent = `Edit project: ${project.name}`;
    cancelButton.hidden = false;
    pathInput.focus();
    render();
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
    activeProjectId = project.id;
    pendingProjects.add(project.id);
    projectMessages.set(project.id, { text: 'Delete in progress…', error: false });
    render();
    try {
      await requestJson(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' }, fetchImpl);
      if (idInput.value === project.id) resetForm();
      projects = projects.filter(({ id }) => id !== project.id);
      branchStates.delete(project.id);
      selectedBranches.delete(project.id);
      worktreeStates.delete(project.id);
      outputStates.delete(project.id);
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
  searchInput.addEventListener('input', render);
  refreshButton.addEventListener('click', () => loadProjects());
  documentObject.addEventListener?.('visibilitychange', () => {
    refreshWhenVisible();
  });
  const refreshTimer = setIntervalImpl(() => {
    if (!documentObject.hidden) loadProjects(false);
  }, 15_000);
  refreshTimer?.unref?.();
  const ready = loadProjects();
  return { ready };
}

if (typeof document !== 'undefined') initDashboard();
