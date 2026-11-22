import { parseUiClientSnapshot, parseUiContext } from '@openpane/contracts';
import type { DeliveryEnvelope, UiClientSnapshot, UiContextV1, WindowContext } from '@openpane/contracts';
import { record } from '@openpane/contracts/decode';

export interface NativeUiRelayPort {
  contexts(): readonly WindowContext[];
  publish(snapshot: UiClientSnapshot): Promise<void>;
  close(): void;
}
export const noChildUiRelay: NativeUiRelayPort = { contexts: () => [], async publish() {}, close() {} };
export interface UiConnectionSnapshot {
  readonly state: UiClientSnapshot | null;
  readonly diagnostic: string | null;
  readonly localBuiltin: boolean;
}
export class UiConnection {
  private snapshot: UiConnectionSnapshot = { state: null, diagnostic: null, localBuiltin: false };
  private readonly listeners = new Set<() => void>();
  private readonly abort = new AbortController();
  private context: UiContextV1 | null = null;
  private window: WindowContext | null = null;
  private sequence = 0;
  private started = false;
  private painted: UiClientSnapshot | null = null;
  private confirmed: string | null = null;
  private pendingRecovery: object | null = null;
  constructor(private readonly relay: NativeUiRelayPort = noChildUiRelay) {}
  getSnapshot = (): UiConnectionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<UiConnectionSnapshot>): void {
    if (this.abort.signal.aborted) return;
    this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener();
  }
  private async post(request: unknown): Promise<unknown> {
    const response = await fetch('/api/ui/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: this.abort.signal });
    const input = record(await response.json());
    if (!response.ok || input.ok !== true) throw new Error(typeof input.error === 'string' ? input.error : 'UI service unavailable');
    record(input, ['ok', 'value']); return input.value;
  }
  start(): void {
    if (this.started) return; this.started = true;
    void this.readLoop();
  }
  private async readLoop(): Promise<void> {
    let delay = 300;
    while (!this.abort.signal.aborted) {
      try {
        if (!this.context || !this.window) {
          this.context = parseUiContext(await this.post({ op: 'context' }));
          if (!this.window || this.window.hostId !== this.context.hostId || this.window.profileId !== this.context.profileId) {
          this.window = { role: 'main', profileId: this.context.profileId, hostId: this.context.hostId,
            brokerInstance: `browser:${crypto.randomUUID()}`, label: 'browser', documentIncarnation: crypto.randomUUID(), viewId: crypto.randomUUID() };
          this.sequence = 0;
          }
        }
        if (this.pendingRecovery) await this.finishRecovery();
        const state = parseUiClientSnapshot(await this.post({ op: 'state', context: this.window, presenceSequence: ++this.sequence,
          visible: document.visibilityState === 'visible', after: this.snapshot.state?.change ?? null, waitMs: 2000 }));
        if (state.selection.selected.kind === 'builtin' && !this.pendingRecovery) this.update({ localBuiltin: false });
        this.update({ state, diagnostic: state.fault });
        await this.relay.publish(state);
        if (this.painted?.selection.deliveryGeneration === state.selection.deliveryGeneration && document.visibilityState === 'visible' && !this.snapshot.localBuiltin) await this.reportPaint(state).catch(() => {});
        delay = 300;
      } catch (error) {
        if (this.abort.signal.aborted) return;
        this.update({ diagnostic: error instanceof Error ? error.message : 'Live appearance disconnected; the last usable appearance remains active' });
        this.context = null;
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, delay); this.abort.signal.addEventListener('abort', done, { once: true });
        });
        delay = Math.min(delay * 2, 5000);
      }
    }
  }
  async rendered(state: UiClientSnapshot): Promise<void> {
    if (!this.window || this.snapshot.localBuiltin && state.selection.selected.kind !== 'builtin') return;
    this.painted = state;
    await this.reportPaint(state);
  }
  private async reportPaint(state: UiClientSnapshot): Promise<void> {
    if (!this.window) return;
    const key = `${this.window.documentIncarnation}:${state.selection.deliveryGeneration}`;
    if (this.confirmed === key) return;
    await this.post({ op: 'paint', session: this.window.documentIncarnation, deliveryGeneration: state.selection.deliveryGeneration,
      selectionRevision: state.selection.revision, digest: state.bundle?.digest ?? null });
    if (state.envelope) await this.ack(state.envelope, { kind: 'rendered' });
    this.confirmed = key;
  }
  async failed(state: UiClientSnapshot, reason: string): Promise<void> {
    this.update({ diagnostic: reason });
    if (state.envelope) await this.ack(state.envelope, { kind: 'failed', reason: reason.slice(0, 500) });
  }
  private async ack(envelope: DeliveryEnvelope, result: { readonly kind: 'rendered' } | { readonly kind: 'failed'; readonly reason: string }): Promise<void> {
    if (!this.window) return;
    await this.post({ op: 'ack', session: this.window.documentIncarnation, envelope, result });
  }
  async restore(): Promise<void> {
    this.update({ localBuiltin: true, diagnostic: 'OpenPane appearance is active locally. Saving builtin selection…' });
    try {
      const context = parseUiContext(await this.post({ op: 'context' }));
      this.pendingRecovery = { op: 'restore', requestId: `recovery:${context.recoveryGeneration}:${crypto.randomUUID()}`,
        expectedRecoveryGeneration: context.recoveryGeneration, expectedRevision: context.revision };
      await this.finishRecovery();
    } catch (error) { this.update({ diagnostic: `${error instanceof Error ? error.message : 'Host unavailable'}. Builtin appearance is local; retry restore to reconcile.` }); }
  }
  private async finishRecovery(): Promise<void> {
    if (!this.pendingRecovery) return;
    try { await this.post(this.pendingRecovery); this.pendingRecovery = null; }
    catch (error) {
      // Reconnect may replay this exact request, but never invents a newer generation.
      if (error instanceof Error && /revision|generation|expired|different input/.test(error.message)) this.pendingRecovery = null;
      throw error;
    }
  }
  close(): void { this.abort.abort(); this.relay.close(); this.listeners.clear(); }
}
