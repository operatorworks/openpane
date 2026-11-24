import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sameScope } from '@openpane/contracts';
import { UiFrames, uiFrame, uiResponse } from './ui-frames.js';
import { record } from '@openpane/contracts/decode';
import { parseUiRequest, UiRefusal, UiTimeout } from './ui-protocol.js';
import type { UiRequest } from './ui-protocol.js';

export function uiFailure(error: unknown): { readonly ok: false; readonly code: string; readonly error: string } {
  return error instanceof UiRefusal ? { ok: false, code: error.code, error: error.message.slice(0, 500) }
    : { ok: false, code: 'unavailable', error: 'UI operation failed. Restore UI storage or inspect host status before retrying.' };
}
export function uiInput<T>(parse: () => T): T {
  try { return parse(); } catch (error) {
    if (error instanceof UiRefusal) throw error;
    throw new UiRefusal('invalid-input', error instanceof Error ? error.message.slice(0, 500) : 'Invalid UI input');
  }
}
export interface UiControlSession { readonly owner: string; readonly signal: AbortSignal }
export async function startUiControl(path: string, execute: (request: UiRequest, session: UiControlSession) => Promise<unknown>, options: { readonly disconnected?: (owner: string) => void } = {}): Promise<{ close(): Promise<void> }> {
  try {
    const stat = lstatSync(path);
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('Foreign UI socket path');
    unlinkSync(path);
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  let closing = false, recoveryFault = false;
  const sockets = new Set<Socket>(), disconnected = new Set<Promise<void>>();
  const parse = (value: unknown): UiRequest => uiInput(() => parseUiRequest(value));
  const server = createServer(socket => {
    const reader = new UiFrames(socket), lifetime = new AbortController(), owner = randomUUID();
    const session = { owner, signal: lifetime.signal };
    const until = Date.now() + 45000;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let finishRecovery = () => {};
    const recovery = new Promise<void>(resolve => { finishRecovery = resolve; });
    disconnected.add(recovery);
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket); clearTimeout(deadline); lifetime.abort(); reader.close();
      try { options.disconnected?.(owner); } catch { recoveryFault = true; }
      finally { disconnected.delete(recovery); finishRecovery(); }
    });
    void (async () => {
      try {
        const request = parse(await reader.next());
        if (closing || !reader.alive) throw new UiRefusal('unavailable', 'UI service is shutting down');
        if (recoveryFault) throw new UiRefusal('unavailable', 'Query recovery could not be saved. Restore UI storage and restart the host.');
        const query = request.op === 'display-query-reserve' || request.op === 'display-query-retry';
        if (!query && reader.queued) throw new UiRefusal('invalid-input', 'UI operations accept one request frame');
        if (query) deadline = setTimeout(() => socket.destroy(), Math.max(1, until - Date.now()));
        const value = await execute(request, session);
        const granted = query && record(value).granted === true;
        if (!granted) { socket.end(uiFrame({ ok: true, value })); return; }
        if (!reader.alive || lifetime.signal.aborted) throw new UiRefusal('unavailable', 'Query owner disconnected');
        socket.write(uiFrame({ ok: true, value }));
        const final = parse(await reader.next(Math.max(1, until - Date.now())));
        if (closing || !reader.alive || lifetime.signal.aborted) throw new UiRefusal('unavailable', 'Query session ended');
        if ((final.op !== 'display-query-finalize' && final.op !== 'display-query-fail') || !sameScope(final.scope, request.scope) || final.publicationId !== request.publicationId || reader.queued) throw new UiRefusal('conflict', 'Query session accepts only its matching final result');
        const result = await execute(final, session);
        socket.end(uiFrame({ ok: true, value: result }));
      } catch (error) { if (!socket.destroyed) socket.end(uiFrame(uiFailure(error))); }
    })();
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); }); });
    chmodSync(path, 0o600);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => { server.close(() => resolve()); });
    throw error;
  }
  return { close() {
    closing = true;
    const deadline = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 6000);
    return new Promise<void>((resolve, reject) => server.close(error => {
      void Promise.all(disconnected).then(() => {
        clearTimeout(deadline);
        try { unlinkSync(path); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) { reject(error); return; } }
        if (error) reject(error); else if (recoveryFault) reject(new Error('Query recovery could not be saved')); else resolve();
      }, reject);
    }));
  } };
}
function checkSocket(path: string): void {
  for (const [target, socketFile] of [[dirname(path), false], [path, true]] as const) {
    let stat;
    try { stat = lstatSync(target); } catch { throw new UiRefusal('unavailable', 'Host unavailable; start ./openpane with this profile'); }
    if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || (socketFile ? !stat.isSocket() : !stat.isDirectory())) throw new UiRefusal('unavailable', 'UI socket must be in an existing private directory owned by this user');
  }
}
export interface UiQuerySession {
  readonly first: unknown;
  readonly ended: Promise<Error>;
  readonly alive: () => boolean;
  request(request: unknown): Promise<unknown>;
  close(): void;
}
export async function openUiQuerySession(path: string, request: unknown): Promise<UiQuerySession> {
  checkSocket(path);
  const input = uiFrame(request);
  const socket = createConnection(path), reader = new UiFrames(socket);
  const deadline = setTimeout(() => socket.destroy(), 45000);
  let busy = false, connected = false;
  const close = () => { clearTimeout(deadline); reader.close(); };
  void reader.ended.then(() => clearTimeout(deadline));
  try {
    socket.once('connect', () => { connected = true; socket.write(input); });
    const first = uiResponse(await reader.next(10000));
    return { first, ended: reader.ended, alive: () => reader.alive,
      async request(request) {
        if (busy || !reader.alive) throw new UiRefusal('unavailable', 'Query owner connection is unavailable');
        busy = true;
        try { socket.write(uiFrame(request)); return uiResponse(await reader.next(10000)); }
        finally { busy = false; }
      }, close };
  } catch (error) {
    close();
    const message = connected ? 'Query reservation is unconfirmed. Inspect display status before an explicit retry.' : 'UI host could not be reached. Check that this profile is running.';
    if (error instanceof UiTimeout) throw new UiTimeout(message);
    if (error instanceof UiRefusal) throw error;
    throw new UiRefusal('unavailable', message);
  }
}
export async function requestUi(path: string, request: unknown, timeoutMs = 10000): Promise<unknown> {
  checkSocket(path);
  const input = uiFrame(request);
  const socket = createConnection(path), reader = new UiFrames(socket);
  let connected = false;
  const deadline = setTimeout(() => socket.destroy(new UiTimeout('UI response timed out')), timeoutMs);
  try {
    socket.once('connect', () => { connected = true; socket.write(input); });
    return uiResponse(await reader.next(timeoutMs));
  } catch (error) {
    const message = connected ? 'UI response is unconfirmed. For a change, inspect its status and reuse the original request or publication ID.' : 'UI host could not be reached. Check that this profile is running, then retry the original request.';
    if (error instanceof UiTimeout) throw new UiTimeout(message);
    if (error instanceof UiRefusal) throw error;
    throw new UiRefusal('unavailable', message);
  } finally { clearTimeout(deadline); reader.close(); }
}
