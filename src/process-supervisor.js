import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const command = process.argv[2];
const selfStat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
const processGroupId = Number(selfStat.slice(selfStat.lastIndexOf(')') + 2).split(' ')[2]);
// Stay available as the group's identity while command processes handle graceful shutdown.
process.on('SIGTERM', () => {});
const child = spawn(command, { shell: true, stdio: 'inherit' });

function finish(status) {
  if (process.env.TMUX_PANE) {
    spawnSync('tmux', ['set-option', '-p', '-t', process.env.TMUX_PANE, '@dcc_exit_status', String(status)]);
  }
  process.exit(status);
}

function hasLiveCommandProcess() {
  try {
    return readdirSync('/proc').some((entry) => {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) return false;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return fields[0] !== 'Z' && Number(fields[2]) === processGroupId;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

child.once('error', () => finish(1));
child.once('exit', (code, signal) => {
  const monitor = setInterval(() => {
    if (hasLiveCommandProcess()) return;
    clearInterval(monitor);
    finish(code ?? (signal ? 1 : 0));
  }, 25);
});
