export const PUP_LAUNCHER = String.raw`
const { spawn } = require('node:child_process');
const { writeSync } = require('node:fs');
let started = false;
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {});
process.stdin.once('data', () => {
  started = true; process.stdin.destroy();
  if (Date.now() >= Number(process.argv[3])) { writeSync(3, 'T'); process.exitCode = 12; return; }
  const child = spawn(process.argv[1], JSON.parse(process.argv[2]), { stdio: ['ignore', 1, 2] });
  child.once('error', () => { writeSync(3, 'unavailable'); process.exitCode = 10; });
  child.once('exit', (code, signal) => { process.exitCode = code === 0 && signal === null ? 0 : 11; });
});
process.stdin.once('end', () => { if (!started) process.exitCode = 14; });
`;

/** The independent process owns termination even if the publishing CLI is killed. */
export const PUP_GUARDIAN = String.raw`
const { spawn } = require('node:child_process');
const { writeSync } = require('node:fs');
const config = JSON.parse(process.argv[1]);
const failures = { 'pup-unavailable': 10, 'pup-failed': 11, 'pup-timeout': 12, 'pup-output-limit': 13, cancelled: 14 };
let child, failure = null, escalation, stdoutBytes = 0, stderrBytes = 0;
const group = process.platform !== 'win32';
function signal(value) {
  if (!child || child.pid === undefined) return;
  try { if (group) process.kill(-child.pid, value); else child.kill(value); } catch {}
}
function stop(reason) {
  if (failure) return;
  failure = reason; signal('SIGTERM');
  escalation = setTimeout(() => { signal('SIGKILL'); child?.stdout.destroy(); child?.stderr.destroy(); }, 1500);
}
process.stdout.on('error', () => stop('cancelled'));
process.stdin.resume();
process.stdin.once('data', () => { if (group && !failure) child?.stdin.end('start'); });
process.stdin.on('end', () => stop('cancelled'));
process.stdin.on('error', () => stop('cancelled'));
process.on('SIGTERM', () => stop('cancelled')); process.on('SIGINT', () => stop('cancelled')); process.on('SIGHUP', () => stop('cancelled'));
if (Date.now() >= config.deadlineMs) { process.exit(failures['pup-timeout']); }
try {
  child = group
    ? spawn(process.execPath, ['-e', config.launcher, config.executable, JSON.stringify(config.args), String(config.deadlineMs)], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true })
    : spawn(config.executable, config.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (child.pid !== undefined) writeSync(3, String(child.pid) + '\n');
}
catch { process.exit(failures['pup-unavailable']); }
child.stdin?.on('error', () => stop('pup-unavailable'));
child.stdio[3]?.on('data', chunk => { failure ??= chunk.toString('ascii') === 'T' ? 'pup-timeout' : 'pup-unavailable'; });
const deadline = setTimeout(() => stop('pup-timeout'), Math.max(1, config.deadlineMs - Date.now()));
child.stdout.on('data', chunk => {
  stdoutBytes += chunk.length;
  if (stdoutBytes > config.stdoutBytes) stop('pup-output-limit');
  else if (!failure) process.stdout.write(chunk);
});
child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 16384) stop('pup-output-limit'); });
child.stdout.on('error', () => stop('pup-failed')); child.stderr.on('error', () => stop('pup-failed'));
child.once('error', () => { failure ??= 'pup-unavailable'; });
child.once('exit', () => { signal('SIGKILL'); });
child.once('close', (code, killedBy) => {
  signal('SIGKILL');
  clearTimeout(deadline); clearTimeout(escalation); process.stdin.destroy();
  process.exitCode = failure ? failures[failure] : code === 0 && killedBy === null ? 0 : failures['pup-failed'];
});
`;
