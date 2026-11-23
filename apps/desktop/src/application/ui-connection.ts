import { parseUiClientSnapshot, parseUiContext, parseApplyReceipt } from '@openpane/contracts';
import type { DeliveryEnvelope, NativePlacementTarget, PlacementTransition, UiClientSnapshot, UiContextV1, WindowContext } from '@openpane/contracts';
import { record } from '@openpane/contracts/decode';
import { parseUiRecovery, reserveRecovery, UI_RECOVERY_KEY } from './ui-recovery.js';
import type { UiRecovery } from './ui-recovery.js';

class UiServiceError extends Error { constructor(readonly code: string, message: string) { super(message); } }

export interface UiTransport {
  getSnapshot(): UiConnectionSnapshot;
  subscribe(listener: () => void): () => void;
  start(): void;
  rendered(state: UiClientSnapshot): Promise<void>;
  failed(state: UiClientSnapshot, reason: string): Promise<void>;
  restore(): Promise<void>;
  close(): void;
}
export interface NativeUiRelayPort {
  publish(snapshot: UiClientSnapshot, main: WindowContext, post: (request: unknown) => Promise<unknown>): Promise<void>;
  close(): void;
}
export const noChildUiRelay: NativeUiRelayPort = { async publish() {}, close() {} };
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
  private recovery: UiRecovery | null = null;
  private lastContext: UiContextV1 | null = null;
  private recoveryFloor: number | null = null;
  constructor(private readonly relay: NativeUiRelayPort = noChildUiRelay,
    private readonly identify?: (context: UiContextV1) => Promise<WindowContext>, private readonly nativePlacement = false) {
    try {
      const cached = localStorage.getItem(UI_RECOVERY_KEY);
      if (cached) { this.recovery = parseUiRecovery(JSON.parse(cached)); this.snapshot = { ...this.snapshot, localBuiltin: true }; }
    } catch { this.recovery = { version: 1, kind: 'needs-context' }; this.snapshot = { ...this.snapshot, localBuiltin: true, diagnostic: 'Local appearance recovery needs confirmation. Retry restore when connected.' }; }
  }
  getSnapshot = (): UiConnectionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<UiConnectionSnapshot>): void {
    if (this.abort.signal.aborted) return;
    this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener();
  }
  private async post(request: unknown): Promise<unknown> {
    const response = await fetch('/api/ui/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: this.abort.signal });
    const input = record(await response.json());
    if (!response.ok || input.ok !== true) throw new UiServiceError(typeof input.code === 'string' ? input.code : 'unavailable', typeof input.error === 'string' ? input.error : 'UI service unavailable');
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
          this.context = parseUiContext(await this.post({ op: 'context' })); this.lastContext = this.context;
          if (!this.window || this.window.hostId !== this.context.hostId || this.window.profileId !== this.context.profileId) {
          this.window = this.identify ? await this.identify(this.context) : { role: 'main', profileId: this.context.profileId, hostId: this.context.hostId,
            brokerInstance: `browser:${crypto.randomUUID()}`, label: 'browser', documentIncarnation: crypto.randomUUID(), viewId: crypto.randomUUID() };
          this.sequence = 0;
          }
        }
        if (this.recovery?.kind === 'reserved') await this.finishRecovery();
        const state = parseUiClientSnapshot(await this.post({ op: 'state', context: this.window, presenceSequence: ++this.sequence,
          visible: document.visibilityState === 'visible', nativePlacement: this.nativePlacement, after: this.snapshot.state?.change ?? null, waitMs: 2000 }));
        if (this.context) this.lastContext = { ...this.context, revision: state.selection.revision, selection: state.selection };
        if (!this.recovery && (state.selection.selected.kind === 'builtin' || this.recoveryFloor !== null && state.selection.deliveryGeneration >= this.recoveryFloor)) this.update({ localBuiltin: false });
        const recoveryNotice = this.recovery?.kind === 'conflicted' ? this.recovery.reason : this.recovery?.kind === 'needs-context' ? 'Builtin appearance is local. Retry restore when connected to save it.' : null;
        this.update({ state, diagnostic: state.fault ?? recoveryNotice });
        await this.relay.publish(state, this.window, request => this.post(request));
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
  async reservePlacement(transition: PlacementTransition, target: NativePlacementTarget): Promise<void> {
    if (!this.window) throw new Error('UI source is not registered');
    await this.post({ op: 'placement-reserve', session: this.window.documentIncarnation, envelope: transition.envelope, transitionId: transition.slot.transitionId, target });
    const state = this.snapshot.state;
    if (state?.selection.deliveryGeneration === transition.envelope.deliveryGeneration) this.update({ state: { ...state, transitions: state.transitions.map(item => item.slot.transitionId === transition.slot.transitionId ? { ...item, slot: { ...item.slot, target } } : item) } });
  }
  async idlePlacement(transition: PlacementTransition): Promise<void> {
    if (!this.window) throw new Error('UI source is not registered');
    await this.post({ op: 'placement-idle', session: this.window.documentIncarnation, envelope: transition.envelope, transitionId: transition.slot.transitionId });
    const state = this.snapshot.state;
    if (state?.selection.deliveryGeneration === transition.envelope.deliveryGeneration) this.update({ state: { ...state, transitions: state.transitions.filter(item => item.slot.transitionId !== transition.slot.transitionId) } });
  }
  async failPlacement(transition: PlacementTransition, reason: string): Promise<void> {
    if (!this.window) throw new Error('UI source is not registered');
    await this.post({ op: 'placement-failed', session: this.window.documentIncarnation, envelope: transition.envelope, transitionId: transition.slot.transitionId, reason: reason.slice(0, 500) });
    const state = this.snapshot.state;
    if (state?.selection.deliveryGeneration === transition.envelope.deliveryGeneration) this.update({ state: { ...state, transitions: state.transitions.filter(item => item.slot.transitionId !== transition.slot.transitionId) } });
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
  private saveRecovery(value: UiRecovery | null): void {
    this.recovery = value;
    try { if (value) localStorage.setItem(UI_RECOVERY_KEY, JSON.stringify(value)); else localStorage.removeItem(UI_RECOVERY_KEY); }
    catch { this.update({ diagnostic: 'Builtin appearance is active locally; recovery could not be saved across reloads.' }); }
  }
  async restore(): Promise<void> {
    this.update({ localBuiltin: true, diagnostic: 'OpenPane appearance is active locally. Saving builtin selection…' });
    try {
      if (this.recovery?.kind !== 'reserved') {
        this.saveRecovery({ version: 1, kind: 'needs-context' });
        let context: UiContextV1;
        try { context = parseUiContext(await this.post({ op: 'context' })); this.lastContext = context; }
        catch (error) { if (!this.lastContext) throw error; context = this.lastContext; }
        this.saveRecovery(reserveRecovery(context));
      }
      await this.finishRecovery();
    } catch (error) { this.update({ diagnostic: `${error instanceof Error ? error.message : 'Host unavailable'}. Builtin appearance is local; retry restore to reconcile.` }); }
  }
  private async finishRecovery(): Promise<void> {
    const recovery = this.recovery;
    if (recovery?.kind !== 'reserved') return;
    try {
      if (this.context && (this.context.hostId !== recovery.hostId || this.context.profileId !== recovery.profileId)) throw new UiServiceError('conflict', 'Appearance recovery belongs to a previous host profile');
      const result = record(await this.post(recovery.request), ['receipt', 'outcome']), receipt = parseApplyReceipt(result.receipt);
      if (receipt.requestId !== recovery.request.requestId || receipt.digest !== null) throw new Error('Invalid builtin recovery receipt');
      if (this.recovery === recovery) { this.recoveryFloor = receipt.deliveryGeneration; this.saveRecovery(null); }
    } catch (error) {
      if (this.recovery === recovery && error instanceof UiServiceError && ['stale-revision', 'expired', 'conflict', 'invalid-input'].includes(error.code)) {
        this.saveRecovery({ ...recovery, kind: 'conflicted', reason: `${error.message.slice(0, 800)}. Retry restore to confirm the current generation.` });
      }
      throw error;
    }
  }
  close(): void { this.abort.abort(); this.relay.close(); this.listeners.clear(); }
}
