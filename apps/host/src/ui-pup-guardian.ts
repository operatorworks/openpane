/** The independent process owns termination even if the publishing CLI is killed. */
export const PUP_GUARDIAN = String.raw`
const { spawn } = require('node:child_process');
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
process.stdin.resume(); process.stdin.on('end', () => stop('cancelled'));
process.stdin.on('error', () => stop('cancelled'));
process.on('SIGTERM', () => stop('cancelled')); process.on('SIGINT', () => stop('cancelled')); process.on('SIGHUP', () => stop('cancelled'));
if (Date.now() >= config.deadlineMs) { process.exit(failures['pup-timeout']); }
try { child = spawn(config.executable, config.args, { stdio: ['ignore', 'pipe', 'pipe'], detached: group }); }
catch { process.exit(failures['pup-unavailable']); }
const deadline = setTimeout(() => stop('pup-timeout'), Math.max(1, config.deadlineMs - Date.now()));
child.stdout.on('data', chunk => {
  stdoutBytes += chunk.length;
  if (stdoutBytes > config.stdoutBytes) stop('pup-output-limit');
  else if (!failure) process.stdout.write(chunk);
});
child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 16384) stop('pup-output-limit'); });
child.stdout.on('error', () => stop('pup-failed')); child.stderr.on('error', () => stop('pup-failed'));
child.once('error', () => { failure ??= 'pup-unavailable'; });
child.once('exit', () => { clearTimeout(deadline); signal('SIGKILL'); });
child.once('close', (code, killedBy) => {
  signal('SIGKILL');
  clearTimeout(deadline); clearTimeout(escalation); process.stdin.destroy();
  process.exitCode = failure ? failures[failure] : code === 0 && killedBy === null ? 0 : failures['pup-failed'];
});
`;
