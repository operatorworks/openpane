import { spawn } from 'node:child_process';
import { PUP_GUARDIAN, PUP_LAUNCHER } from './ui-pup-guardian.js';
import type { DisplayQueryFailure } from './ui-display-protocol.js';
import { UiRefusal } from './ui-protocol.js';
import { record } from '@openpane/contracts/decode';

const PUP_EXECUTION_ENVIRONMENT = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']);
function pupEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => PUP_EXECUTION_ENVIRONMENT.has(name) || /^(?:DD_|PUP_|LC_)/.test(name)));
}

export type PupProcessResult = { readonly kind: 'completed'; readonly stdout: string } | { readonly kind: 'failed'; readonly reason: DisplayQueryFailure };
export async function runPup(executable: string, args: readonly string[], options: {
  readonly signal: AbortSignal; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number; readonly stdoutBytes?: number; readonly deadlineMs?: number;
}): Promise<PupProcessResult> {
  if (options.signal.aborted) return { kind: 'failed', reason: 'cancelled' };
  const stdoutBytes = options.stdoutBytes ?? 2 * 1024 * 1024;
  const deadlineMs = Math.min(Date.now() + (options.timeoutMs ?? 30000), options.deadlineMs ?? Number.MAX_SAFE_INTEGER);
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let failure: DisplayQueryFailure | null = null, bytes = 0;
    const start = () => spawn(process.execPath, ['-e', PUP_GUARDIAN, JSON.stringify({ executable, args, deadlineMs, stdoutBytes, launcher: PUP_LAUNCHER })], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: pupEnvironment(options.env ?? process.env),
    });
    let guardian: ReturnType<typeof start>;
    try { guardian = start(); } catch { resolve({ kind: 'failed', reason: 'pup-unavailable' }); return; }
    const input = guardian.stdin, output = guardian.stdout, errorOutput = guardian.stderr;
    if (!input || !output || !errorOutput) { guardian.kill('SIGKILL'); resolve({ kind: 'failed', reason: 'pup-unavailable' }); return; }
    let processGroup: number | null = null, announcement = '';
    let cancellationDeadline: ReturnType<typeof setTimeout> | undefined, forced = false;
    const terminate = () => {
      forced = true; failure ??= 'pup-timeout';
      if (processGroup !== null) {
        try { process.kill(process.platform === 'win32' ? processGroup : -processGroup, 'SIGKILL'); } catch {}
      }
      guardian.kill('SIGKILL');
    };
    const executionDeadline = setTimeout(terminate, Math.max(1, deadlineMs - Date.now() + 1500));
    const stop = (reason: DisplayQueryFailure) => {
      failure ??= reason; input.end();
      cancellationDeadline ??= setTimeout(terminate, 1500);
    };
    const ownership = guardian.stdio[3];
    ownership?.on('error', () => stop('pup-unavailable'));
    ownership?.on('data', (chunk: Buffer) => {
      if (processGroup !== null) return;
      announcement += chunk.toString('ascii');
      if (announcement.length > 32) { stop('pup-unavailable'); return; }
      if (!announcement.endsWith('\n')) return;
      const pid = Number(announcement.trim());
      if (!/^\d+\n$/.test(announcement) || !Number.isSafeInteger(pid) || pid <= 0) { stop('pup-unavailable'); return; }
      processGroup = pid;
      if (!failure && !forced && !options.signal.aborted && process.platform !== 'win32') input.write('start');
    });
    const abort = () => stop('cancelled');
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    input.on('error', () => {});
    errorOutput.resume();
    output.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > stdoutBytes) { failure = 'pup-output-limit'; stop('pup-output-limit'); }
      else if (!failure) chunks.push(chunk);
    });
    output.on('error', () => stop('pup-failed'));
    guardian.once('error', () => { failure ??= 'pup-unavailable'; });
    guardian.once('close', (code, killedBy) => {
      options.signal.removeEventListener('abort', abort);
      clearTimeout(executionDeadline); clearTimeout(cancellationDeadline);
      if (processGroup !== null && (killedBy !== null || code === null || ![0, 10, 11, 12, 13, 14].includes(code))) {
        try { process.kill(process.platform === 'win32' ? processGroup : -processGroup, 'SIGKILL'); } catch {}
      }
      const failures: Readonly<Record<number, DisplayQueryFailure>> = { 10: 'pup-unavailable', 11: 'pup-failed', 12: 'pup-timeout', 13: 'pup-output-limit', 14: 'cancelled' };
      failure ??= code === 0 && killedBy === null ? null : code === null ? 'pup-failed' : failures[code] ?? 'pup-failed';
      if (failure) { resolve({ kind: 'failed', reason: failure }); return; }
      try { resolve({ kind: 'completed', stdout: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }); }
      catch { resolve({ kind: 'failed', reason: 'invalid-response' }); }
    });
  });
}

export async function pupVersion(executable: string, signal: AbortSignal): Promise<string> {
  const result = await runPup(executable, ['--version'], { signal, timeoutMs: 5000, stdoutBytes: 16 * 1024 });
  const version = result.kind === 'completed' ? /^pup (\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/.exec(result.stdout.trim())?.[1] : undefined;
  if (!version) throw new UiRefusal('unavailable', 'Pup executable is unavailable or its version could not be qualified');
  return version;
}
export async function pupSite(executable: string, signal: AbortSignal): Promise<string> {
  const explicit = process.env.DD_SITE;
  if (explicit && /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]+$/.test(explicit) && explicit.length <= 253) return explicit;
  const result = await runPup(executable, ['--no-agent', '--output=json', 'auth', 'status'], { signal, timeoutMs: 5000, stdoutBytes: 16 * 1024 });
  if (result.kind === 'completed') {
    try {
      const site = record(JSON.parse(result.stdout)).site;
      if (typeof site === 'string' && site.length <= 253 && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(site)) return site;
    } catch {}
  }
  throw new UiRefusal('unavailable', 'Could not resolve the configured Datadog site. Set DD_SITE to its full hostname.');
}
