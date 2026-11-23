import { spawn } from 'node:child_process';
import { PUP_GUARDIAN } from './ui-pup-guardian.js';
import type { DisplayQueryFailure } from './ui-display-protocol.js';
import { record } from '@openpane/contracts/decode';

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
    const start = () => spawn(process.execPath, ['-e', PUP_GUARDIAN, JSON.stringify({ executable, args, deadlineMs, stdoutBytes })], {
      stdio: ['pipe', 'pipe', 'pipe'], env: options.env ?? process.env,
    });
    let guardian: ReturnType<typeof start>;
    try { guardian = start(); } catch { resolve({ kind: 'failed', reason: 'pup-unavailable' }); return; }
    const abort = () => { failure ??= 'cancelled'; guardian.stdin.end(); };
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    guardian.stdin.on('error', () => {});
    guardian.stderr.resume();
    guardian.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > stdoutBytes) { failure = 'pup-output-limit'; guardian.stdin.end(); }
      else if (!failure) chunks.push(chunk);
    });
    guardian.stdout.on('error', () => { failure ??= 'pup-failed'; guardian.stdin.end(); });
    guardian.once('error', () => { failure ??= 'pup-unavailable'; });
    guardian.once('close', (code, killedBy) => {
      options.signal.removeEventListener('abort', abort);
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
  if (!version) throw new Error('Pup executable is unavailable or its version could not be qualified');
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
  throw new Error('Could not resolve the configured Datadog site. Set DD_SITE to its full hostname.');
}
