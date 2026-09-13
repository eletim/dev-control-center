import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const command = process.argv[2];
// Stay available as the group's identity while command processes handle graceful shutdown.
process.on('SIGTERM', () => {});
const child = spawn(command, { shell: true, stdio: 'ignore' });

function hasLiveCommandProcess() {
  try {
    return readdirSync('/proc').some((entry) => {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) return false;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return fields[0] !== 'Z' && Number(fields[2]) === process.pid;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

child.once('error', () => process.exit(1));
child.once('exit', (code, signal) => {
  const monitor = setInterval(() => {
    if (hasLiveCommandProcess()) return;
    clearInterval(monitor);
    process.exit(code ?? (signal ? 1 : 0));
  }, 25);
});
