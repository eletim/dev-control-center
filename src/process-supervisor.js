import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const command = process.argv[2];
const tmuxPath = process.argv[3];
const tmuxSocketName = process.argv[4];
const procDirectory = process.env.DEV_CONTROL_CENTER_PROC_DIRECTORY || '/proc';

function processGroupFromPs(pid) {
  const result = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  const processGroupId = Number(result.stdout.trim());
  return result.status === 0 && Number.isInteger(processGroupId) ? processGroupId : null;
}

function ownProcessGroup() {
  try {
    const stat = readFileSync(`${procDirectory}/${process.pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  } catch {
    return processGroupFromPs(process.pid);
  }
}

const processGroupId = ownProcessGroup();
// Stay available as the group's identity while command processes handle graceful shutdown.
const holdProcessGroup = () => {};
process.on('SIGTERM', holdProcessGroup);
const child = spawn(command, { shell: true, stdio: 'inherit' });

function finish(status, signal) {
  if (signal) {
    if (tmuxPath && process.env.TMUX_PANE) {
      const socket = tmuxSocketName ? ['-L', tmuxSocketName] : [];
      spawnSync(tmuxPath, [...socket, 'set-option', '-p', '-t', process.env.TMUX_PANE,
        '@dcc_command_signal', signal], { stdio: 'ignore' });
    }
    process.off('SIGTERM', holdProcessGroup);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(status ?? 0);
}

function hasLiveCommandProcess() {
  try {
    return readdirSync(procDirectory).some((entry) => {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) return false;
      try {
        const stat = readFileSync(`${procDirectory}/${entry}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return fields[0] !== 'Z' && Number(fields[2]) === processGroupId;
      } catch {
        return false;
      }
    });
  } catch {
    // Keep the observer out of the command's process group so it cannot count itself.
    const result = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat='], {
      detached: true,
      encoding: 'utf8',
    });
    if (result.status !== 0 || !Number.isInteger(processGroupId)) return false;
    return result.stdout.split('\n').some((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)/);
      return match && Number(match[1]) !== process.pid && Number(match[2]) === processGroupId
        && !match[3].startsWith('Z');
    });
  }
}

child.once('error', () => finish(1));
child.once('exit', (code, signal) => {
  const monitor = setInterval(() => {
    if (hasLiveCommandProcess()) return;
    clearInterval(monitor);
    finish(code, signal);
  }, 25);
});
