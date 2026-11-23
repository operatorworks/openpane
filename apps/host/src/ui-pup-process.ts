import { spawn } from 'node:child_process';
import type { DisplayQueryFailure } from './ui-display-protocol.js';
import { record } from '@openpane/contracts/decode';

export type PupProcessResult = { readonly kind: 'completed'; readonly stdout: string } | { readonly kind: 'failed'; readonly reason: DisplayQueryFailure };
export async function runPup(executable: string, args: readonly string[], options: {
  readonly signal: AbortSignal; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number; readonly stdoutBytes?: number;
}): Promise<PupProcessResult> {
  if (options.signal.aborted) return { kind: 'failed', reason: 'cancelled' };
  return new Promise(resolve => {
    let failure: DisplayQueryFailure | null = null, stdoutBytes = 0, stderrBytes = 0;
    const chunks: Buffer[] = [], group = process.platform !== 'win32';
    const start = () => spawn(executable, [...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: group, env: options.env ?? process.env });
    let child: ReturnType<typeof start>;
    try { child = start(); } catch { resolve({ kind: 'failed', reason: 'pup-unavailable' }); return; }
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const signal = (value: 'SIGTERM' | 'SIGKILL') => {
      if (child.pid === undefined) return;
      try { if (group) process.kill(-child.pid, value); else child.kill(value); } catch {}
    };
    const stop = (reason: DisplayQueryFailure) => {
      if (failure) return;
      failure = reason; signal('SIGTERM');
      escalation = setTimeout(() => { signal('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); }, 1500);
    };
    const abort = () => stop('cancelled');
    options.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => stop('pup-timeout'), options.timeoutMs ?? 30000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > (options.stdoutBytes ?? 2 * 1024 * 1024)) { stop('pup-output-limit'); return; }
      if (!failure) chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 16 * 1024) stop('pup-output-limit'); });
    child.stdout.on('error', () => stop('pup-failed')); child.stderr.on('error', () => stop('pup-failed'));
    child.once('error', () => { failure ??= 'pup-unavailable'; });
    child.once('close', (code, killedBy) => {
      if (failure) signal('SIGKILL');
      clearTimeout(timeout); clearTimeout(escalation); options.signal.removeEventListener('abort', abort);
      if (failure) { resolve({ kind: 'failed', reason: failure }); return; }
      if (code !== 0 || killedBy !== null) { resolve({ kind: 'failed', reason: 'pup-failed' }); return; }
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
