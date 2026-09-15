import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function waitFor(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for project startup');
}

async function fixture(t, projects, listenerPort = '0') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dcc-environment-'));
  const socket = `dcc-environment-${process.pid}-${path.basename(directory)}`;
  const tmux = (await execFileAsync('sh', ['-c', 'command -v tmux'])).stdout.trim();
  await cp(path.join(root, 'src'), path.join(directory, 'src'), { recursive: true });
  for (const file of ['start.sh', 'package.json', 'sample_config.sh']) {
    await cp(path.join(root, file), path.join(directory, file));
  }
  await writeFile(path.join(directory, 'config.sh'), `export DCC_HOST=0.0.0.0\nexport DCC_PORT=${listenerPort}\n`);
  await writeFile(path.join(directory, 'projects.json'), JSON.stringify(projects(directory)));
  await writeFile(path.join(directory, 'tmux'), `#!/bin/sh\nexec ${quote(tmux)} -L ${quote(socket)} "$@"\n`);
  await chmod(path.join(directory, 'tmux'), 0o755);
  // Execute npm's start command directly so shutdown reaches the controller.
  await writeFile(path.join(directory, 'npm'), `#!/bin/sh\nexec ${quote(process.execPath)} src/index.js\n`);
  await chmod(path.join(directory, 'npm'), 0o755);
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, DCC_DATA_FILE: path.join(directory, 'projects.json') };
  // Start a fresh tmux server from DCC, rather than inheriting the user's server.
  for (const key of ['HOST', 'PORT', 'DCC_HOST', 'DCC_PORT', 'TMUX', 'TMUX_PANE', 'DCC_TMUX_SESSION', 'DCC_PROCESS_FILE']) delete env[key];
  const child = spawn(path.join(directory, 'start.sh'), { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await execFileAsync(tmux, ['-L', socket, 'kill-server']).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  const port = await waitFor(() => output.match(/0\.0\.0\.0:(\d+)/)?.[1]);
  return { directory, baseUrl: `http://127.0.0.1:${port}` };
}

test('configured DCC listener does not set generic project HOST or PORT in fresh tmux', async (t) => {
  const { directory, baseUrl } = await fixture(t, (directory) => [
    { id: 'default', path: directory, startCommand: `${quote(process.execPath)} project.cjs default.json` },
    { id: 'explicit', path: directory, startCommand: `HOST=127.0.0.9 PORT=9000 ${quote(process.execPath)} project.cjs explicit.json` },
  ]);
  // Small project fixture models PurpleMux's generic PORT/default selection.
  await writeFile(path.join(directory, 'project.cjs'), `
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({ host: process.env.HOST ?? null, port: process.env.PORT ?? null, selectedPort: Number(process.env.PORT || 8022) }));
setInterval(() => {}, 1000);
`);
  for (const id of ['default', 'explicit']) {
    const response = await fetch(`${baseUrl}/api/projects/${id}/start`, { method: 'POST' });
    assert.equal(response.status, 200, await response.text());
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'default.json'))), { host: null, port: null, selectedPort: 8022 });
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'explicit.json'))), { host: '127.0.0.9', port: '9000', selectedPort: 9000 });
});

const purplemuxDirectory = process.env.DCC_TEST_PURPLEMUX_DIR;
test('real PurpleMux starts on 8022 through DCC configured on 8023', {
  skip: !purplemuxDirectory && 'Set DCC_TEST_PURPLEMUX_DIR to a built PurpleMux checkout; ports 8022 and 8023 must be free',
  timeout: 60000,
}, async (t) => {
  const { directory, baseUrl } = await fixture(t, (directory) => [{
    id: 'purplemux', path: path.resolve(purplemuxDirectory),
    startCommand: `HOME=${quote(directory)} NODE_ENV=production ${quote(process.execPath)} dist/server.js > ${quote(path.join(directory, 'purplemux.log'))} 2>&1`,
  }], '8023');
  const response = await fetch(`${baseUrl}/api/projects/purplemux/start`, { method: 'POST' });
  assert.equal(response.status, 200, await response.text());
  await waitFor(async () => (await readFile(path.join(directory, '.purplemux', 'port'), 'utf8').catch(() => '')).trim() === '8022', 45000);
  assert.equal((await fetch('http://127.0.0.1:8022')).status, 200);
});
