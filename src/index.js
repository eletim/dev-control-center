import path from 'node:path';
import { createAppServer } from './server.js';
import { ProjectStore } from './project-store.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const dataFile = path.resolve(process.env.DCC_DATA_FILE || '.data/projects.json');
const server = createAppServer(new ProjectStore(dataFile));

server.listen(port, host, () => {
  const address = server.address();
  console.log(`Dev Control Center listening at http://${host}:${address.port}`);
});
