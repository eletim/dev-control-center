import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGitMetadata } from './git-metadata.js';
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

async function present(project) {
  return {
    ...project,
    name: path.basename(project.path),
    git: await getGitMetadata(project.path),
  };
}

export function createAppServer(store) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const match = url.pathname.match(/^\/api\/projects\/([^/]+)$/);

      if (request.method === 'GET' && url.pathname === '/api/projects') {
        const projects = await store.list();
        sendJson(response, 200, await Promise.all(projects.map(present)));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/projects') {
        sendJson(response, 201, await present(await store.create(await readJson(request))));
        return;
      }

      if (match && request.method === 'GET') {
        const project = await store.get(decodeURIComponent(match[1]));
        if (!project) throw new ProjectError('not_found', 'Project not found.');
        sendJson(response, 200, await present(project));
        return;
      }

      if (match && request.method === 'PUT') {
        const project = await store.update(decodeURIComponent(match[1]), await readJson(request));
        sendJson(response, 200, await present(project));
        return;
      }

      if (match && request.method === 'DELETE') {
        await store.delete(decodeURIComponent(match[1]));
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
        sendJson(response, error.code === 'not_found' ? 404 : error.code === 'duplicate_path' ? 409 : 400, {
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
