import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from '@openpane/contracts';
import { record } from '@openpane/contracts/decode';
import { parseUiRequest, UI_FRAME_BYTES, UiRefusal } from './ui-protocol.js';
import type { UiRequest } from './ui-protocol.js';

function readFrame(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    socket.setTimeout(5000, () => socket.destroy(new Error('UI socket input timed out')));
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > UI_FRAME_BYTES) { socket.destroy(new Error('UI frame exceeds byte limit')); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      socket.off('data', data); socket.setTimeout(0);
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch (error) { reject(error); }
    };
    socket.on('data', data); socket.once('error', reject);
    socket.once('end', () => reject(new Error('Incomplete UI frame')));
  });
}
function frame(value: unknown): string {
  const output = canonicalJson(value) + '\n';
  if (Buffer.byteLength(output) > UI_FRAME_BYTES) throw new UiRefusal('capacity', 'UI response exceeds byte limit');
  return output;
}
export function uiFailure(error: unknown): { readonly ok: false; readonly code: string; readonly error: string } {
  return error instanceof UiRefusal ? { ok: false, code: error.code, error: error.message }
    : { ok: false, code: 'invalid-input', error: 'Invalid UI request or unavailable UI data' };
}
export async function startUiControl(path: string, execute: (request: UiRequest) => Promise<unknown>): Promise<{ close(): Promise<void> }> {
  try {
    const stat = lstatSync(path);
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('Foreign UI socket path');
    unlinkSync(path);
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  let closing = false;
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    void (async () => {
      try {
        const request = parseUiRequest(await readFrame(socket));
        if (closing) throw new UiRefusal('unavailable', 'UI service is shutting down');
        const value = await execute(request);
        socket.end(frame({ ok: true, value }));
      } catch (error) { if (!socket.destroyed) socket.end(frame(uiFailure(error))); }
    })();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); }); });
  chmodSync(path, 0o600);
  return { close() {
    closing = true;
    const deadline = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 6000);
    return new Promise<void>((resolve, reject) => server.close(error => {
      clearTimeout(deadline);
      try { unlinkSync(path); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) { reject(error); return; } }
      if (error) reject(error); else resolve();
    }));
  } };
}
export async function requestUi(path: string, request: unknown): Promise<unknown> {
  for (const [target, socketFile] of [[dirname(path), false], [path, true]] as const) {
    let stat;
    try { stat = lstatSync(target); } catch { throw new UiRefusal('unavailable', 'Host unavailable; start ./openpane with this profile'); }
    if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || (socketFile ? !stat.isSocket() : !stat.isDirectory())) throw new UiRefusal('unavailable', 'UI socket must be in an existing private directory owned by this user');
  }
  const input = frame(request);
  const socket = createConnection(path);
  const deadline = setTimeout(() => socket.destroy(new Error('UI reply timed out; inspect the original request ID')), 10000);
  try {
    socket.once('connect', () => socket.write(input));
    const response = record(await readFrame(socket));
    if (response.ok === false) {
      record(response, ['ok', 'code', 'error']);
      throw new Error(typeof response.error === 'string' ? response.error : 'UI operation refused');
    }
    record(response, ['ok', 'value']);
    if (response.ok !== true) throw new Error('Invalid UI response');
    return response.value;
  } finally { clearTimeout(deadline); socket.destroy(); }
}
