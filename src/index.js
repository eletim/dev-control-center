import path from 'node:path';
import { ProjectProcessManager } from './project-process-manager.js';
import { createAppServer } from './server.js';
import { ProjectStore } from './project-store.js';

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 8023);
const dataFile = path.resolve(process.env.DCC_DATA_FILE || '.data/projects.json');
const processFile = path.resolve(process.env.DCC_PROCESS_FILE || `${dataFile}.processes`);
const processManager = new ProjectProcessManager({
  stateFile: processFile,
  sessionName: process.env.DCC_TMUX_SESSION || 'dev-control-center',
});
const server = createAppServer(new ProjectStore(dataFile), processManager);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  processManager.beginShutdown();
  try {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await processManager.drain();
    await processManager.stopAll();
    process.exitCode = 0;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    processManager.releaseStateLock();
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(port, host, () => {
  const address = server.address();
  console.log(`Dev Control Center listening at http://${host}:${address.port}`);
});
