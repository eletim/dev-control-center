import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchRepository, listBranches, switchBranch, updateRepository } from './git-actions.js';
import { getGitMetadata } from './git-metadata.js';
import { ProjectProcessManager } from './project-process-manager.js';
import { ProjectError } from './project-store.js';

const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(body === undefined ? '' : JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new ProjectError('invalid_input', 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ProjectError('invalid_input', 'Request body must be valid JSON.');
  }
}

async function present(project, processManager) {
  return {
    ...project,
    name: path.basename(project.path),
    status: processManager.isRunning(project.id) ? 'running' : 'stopped',
    git: await getGitMetadata(project.path),
  };
}

export function createAppServer(store, processManager = new ProjectProcessManager()) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const match = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      const actionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/(start|stop|restart)$/);
      const gitActionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/git\/(branches|fetch|update|switch)$/);

      if (request.method === 'GET' && url.pathname === '/api/projects') {
        const projects = await store.list();
        sendJson(response, 200, await Promise.all(projects.map((project) => present(project, processManager))));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/projects') {
        sendJson(response, 201, await present(await store.create(await readJson(request)), processManager));
        return;
      }

      if (actionMatch && request.method === 'POST') {
        const id = decodeURIComponent(actionMatch[1]);
        const project = await processManager.perform(id, actionMatch[2], () => store.get(id));
        sendJson(response, 200, await present(project, processManager));
        return;
      }

      if (gitActionMatch) {
        const id = decodeURIComponent(gitActionMatch[1]);
        const action = gitActionMatch[2];
        if (action === 'branches' && request.method === 'GET') {
          const project = await store.get(id);
          if (!project) throw new ProjectError('not_found', 'Project not found.');
          sendJson(response, 200, { branches: await listBranches(project.path) });
          return;
        }
        if (action !== 'branches' && request.method === 'POST') {
          const input = action === 'switch' ? await readJson(request) : null;
          const project = await processManager.withProjectLock(id, async () => {
            const currentProject = await store.get(id);
            if (!currentProject) throw new ProjectError('not_found', 'Project not found.');
            if (action === 'fetch') await fetchRepository(currentProject.path);
            else if (action === 'update') await updateRepository(currentProject.path);
            else await switchBranch(currentProject.path, input?.branch);
            return currentProject;
          });
          sendJson(response, 200, await present(project, processManager));
          return;
        }
      }

      if (match && request.method === 'GET') {
        const project = await store.get(decodeURIComponent(match[1]));
        if (!project) throw new ProjectError('not_found', 'Project not found.');
        sendJson(response, 200, await present(project, processManager));
        return;
      }

      if (match && request.method === 'PUT') {
        const id = decodeURIComponent(match[1]);
        const input = await readJson(request);
        const project = await processManager.withProjectLock(id, async () => {
          if (processManager.isRunning(id)) {
            throw new ProjectError('project_running', 'Stop the project before changing its Path or Start Command.');
          }
          return store.update(id, input);
        });
        sendJson(response, 200, await present(project, processManager));
        return;
      }

      if (match && request.method === 'DELETE') {
        const id = decodeURIComponent(match[1]);
        await processManager.withProjectLock(id, async () => {
          if (processManager.isRunning(id)) {
            throw new ProjectError('project_running', 'Stop the project before deleting it.');
          }
          await store.delete(id);
        });
        response.writeHead(204);
        response.end();
        return;
      }

      const staticFile = staticFiles.get(url.pathname);
      if (request.method === 'GET' && staticFile) {
        const [filename, contentType] = staticFile;
        response.writeHead(200, { 'content-type': contentType });
        response.end(await readFile(path.join(publicDirectory, filename)));
        return;
      }

      sendJson(response, 404, { error: 'not_found', message: 'Not found.' });
    } catch (error) {
      if (error instanceof ProjectError) {
        const conflicts = [
          'duplicate_path', 'already_running', 'not_running', 'project_running',
          'dirty_worktree', 'git_state_changed', 'non_fast_forward',
        ];
        const status = error.code === 'not_found' ? 404
          : error.code === 'shutting_down' ? 503
            : conflicts.includes(error.code) ? 409 : 400;
        sendJson(response, status, {
          error: error.code,
          message: error.message,
        });
        return;
      }
      console.error(error);
      sendJson(response, 500, { error: 'internal_error', message: 'Internal server error.' });
    }
  });
}
