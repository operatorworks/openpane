import type { Socket } from 'node:net';
import { canonicalJson } from '@openpane/contracts';
import { record } from '@openpane/contracts/decode';
import { UI_FRAME_BYTES, UiRefusal, UiTimeout } from './ui-protocol.js';

export function uiFrame(value: unknown): string {
  const output = canonicalJson(value) + '\n';
  if (Buffer.byteLength(output) > UI_FRAME_BYTES) throw new UiRefusal('capacity', 'UI frame exceeds byte limit');
  return output;
}
export function uiResponse(value: unknown): unknown {
  const response = record(value);
  if (response.ok === false) {
    record(response, ['ok', 'code', 'error']);
    throw new UiRefusal(response.code === 'capacity' || response.code === 'conflict' || response.code === 'expired' || response.code === 'not-found' || response.code === 'stale-revision' || response.code === 'invalid-input' ? response.code : 'unavailable',
      typeof response.error === 'string' ? response.error.slice(0, 500) : 'UI operation refused');
  }
  record(response, ['ok', 'value']);
  if (response.ok !== true) throw new Error('Invalid UI response');
  return response.value;
}

/** One bounded reader retains frames that arrive together across a query session. */
export class UiFrames {
  readonly ended: Promise<Error>;
  private finish: (error: Error) => void = () => {};
  private buffer = Buffer.alloc(0);
  private readonly frames: unknown[] = [];
  private failure: Error | null = null;
  private pending: { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> } | null = null;
  constructor(private readonly socket: Socket) {
    this.ended = new Promise(resolve => { this.finish = resolve; });
    socket.on('data', this.data);
    socket.on('error', this.error);
    socket.once('end', this.end); socket.once('close', this.end);
  }
  get queued(): number { return this.frames.length; }
  get alive(): boolean { return this.failure === null && !this.socket.destroyed; }
  private settle(): void {
    if (!this.pending || !this.frames.length) return;
    const pending = this.pending; this.pending = null; clearTimeout(pending.timer); pending.resolve(this.frames.shift());
  }
  private data = (chunk: Buffer): void => {
    if (this.failure) return;
    try {
      if (this.buffer.length + chunk.length > UI_FRAME_BYTES * 2) throw new Error('UI frame buffer exceeds byte limit');
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const newline = this.buffer.indexOf(10);
        if (newline === -1) break;
        if (newline + 1 > UI_FRAME_BYTES || this.frames.length >= 2) throw new Error('UI frame or queue exceeds its limit');
        const bytes = this.buffer.subarray(0, newline); this.buffer = this.buffer.subarray(newline + 1);
        this.frames.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      }
      if (this.buffer.length >= UI_FRAME_BYTES) throw new Error('UI frame exceeds byte limit');
      this.settle();
    } catch (error) {
      this.error(error instanceof Error ? error : new Error('Invalid UI frame')); this.socket.destroy();
    }
  };
  private error = (error: Error): void => {
    if (this.failure) return;
    this.failure = error; this.finish(error);
    const pending = this.pending; this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
  };
  private end = (): void => { this.error(new Error(this.buffer.length ? 'Incomplete UI frame' : 'UI connection closed')); };
  next(timeoutMs = 5000): Promise<unknown> {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error('Overlapping UI frame reads'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.error(new UiTimeout('UI frame timed out')); this.socket.destroy(); }, Math.max(1, timeoutMs));
      this.pending = { resolve, reject, timer };
    });
  }
  close(): void {
    this.error(new Error('UI connection closed')); this.socket.off('data', this.data); this.socket.off('end', this.end); this.socket.off('close', this.end);
    this.frames.length = 0; this.buffer = Buffer.alloc(0); this.socket.destroy();
  }
}
