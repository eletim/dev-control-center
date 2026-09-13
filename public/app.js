const projectsElement = document.querySelector('#projects');
const form = document.querySelector('#project-form');
const idInput = document.querySelector('#project-id');
const pathInput = document.querySelector('#path');
const commandInput = document.querySelector('#start-command');
const message = document.querySelector('#message');
const cancelButton = document.querySelector('#cancel');

let projects = [];

function gitSummary(git) {
  if (!git.isRepository) return 'Not a Git repository';
  const state = git.clean === null ? 'status unavailable' : git.clean ? 'clean' : 'dirty';
  const branch = git.branch || 'detached HEAD';
  const tracking = git.remote ? ` · ${git.ahead ?? '?'} ahead / ${git.behind ?? '?'} behind ${git.remote}` : '';
  return `${branch} · ${state}${tracking}`;
}

function render() {
  if (!projects.length) {
    projectsElement.innerHTML = '<p class="empty">No projects registered yet.</p>';
    return;
  }
  projectsElement.replaceChildren(...projects.map((project) => {
    const article = document.createElement('article');
    article.className = 'project';
    const heading = document.createElement('h3');
    heading.textContent = project.name;
    const pathLine = document.createElement('div');
    const pathCode = document.createElement('code');
    pathCode.textContent = project.path;
    pathLine.append(pathCode);
    const command = document.createElement('p');
    command.className = 'meta';
    command.textContent = `Start: ${project.startCommand}`;
    const git = document.createElement('p');
    git.className = 'meta';
    git.textContent = gitSummary(project.git);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const edit = document.createElement('button');
    edit.className = 'secondary';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => editProject(project));
    const remove = document.createElement('button');
    remove.className = 'secondary';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => deleteProject(project));
    actions.append(edit, remove);
    article.append(heading, pathLine, command, git, actions);
    return article;
  }));
}

async function loadProjects() {
  message.textContent = '';
  try {
    const response = await fetch('/api/projects');
    if (!response.ok) throw new Error('Could not load projects.');
    projects = await response.json();
    render();
  } catch (error) {
    message.textContent = error.message;
  }
}

function editProject(project) {
  idInput.value = project.id;
  pathInput.value = project.path;
  commandInput.value = project.startCommand;
  document.querySelector('#form-title').textContent = 'Edit project';
  cancelButton.hidden = false;
  pathInput.focus();
}

function resetForm() {
  form.reset();
  idInput.value = '';
  document.querySelector('#form-title').textContent = 'Add project';
  cancelButton.hidden = true;
}

async function deleteProject(project) {
  if (!confirm(`Delete ${project.name}?`)) return;
  const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
  if (!response.ok) {
    const body = await response.json();
    message.textContent = body.message;
    return;
  }
  if (idInput.value === project.id) resetForm();
  await loadProjects();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  const id = idInput.value;
  const response = await fetch(id ? `/api/projects/${encodeURIComponent(id)}` : '/api/projects', {
    method: id ? 'PUT' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: pathInput.value, startCommand: commandInput.value }),
  });
  if (!response.ok) {
    const body = await response.json();
    message.textContent = body.message;
    return;
  }
  resetForm();
  await loadProjects();
});

cancelButton.addEventListener('click', resetForm);
document.querySelector('#refresh').addEventListener('click', loadProjects);
loadProjects();
