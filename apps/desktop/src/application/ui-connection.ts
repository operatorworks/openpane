import { parseUiClientSnapshot, parseUiContext, parseApplyReceipt } from '@openpane/contracts';
import type { ConversationScope, DeliveryEnvelope, NativePlacementTarget, PlacementTransition, UiClientSnapshot, UiContextV1, WindowContext } from '@openpane/contracts';
import { count, record } from '@openpane/contracts/decode';
import { parseUiRecovery, reserveRecovery, sameRecoveryOriginator, UI_RECOVERY_KEY } from './ui-recovery.js';
import type { UiRecovery, RecoveryOriginator } from './ui-recovery.js';
import { DisplayClient, NO_DISPLAY } from './display-client.js';
import type { DisplayView } from './display-client.js';

const sameDelivery = (a: UiClientSnapshot, b: UiClientSnapshot): boolean => a.selection.deliveryGeneration === b.selection.deliveryGeneration && a.selection.revision === b.selection.revision && a.bundle?.digest === b.bundle?.digest;

class UiServiceError extends Error { constructor(readonly code: string, message: string) { super(message); } }

export interface UiTransport {
  getSnapshot(): UiConnectionSnapshot;
  subscribe(listener: () => void): () => void;
  start(): void;
  rendered(state: UiClientSnapshot | null, localBuiltin?: boolean, context?: string | null): Promise<void>;
  failed(state: UiClientSnapshot, reason: string, context?: string | null): Promise<void>;
  restore(): Promise<void>;
  close(): void;
  selectScope(scope: ConversationScope | null): void;
  refreshCards(): void;
}
export interface NativeUiRelayPort {
  publish(snapshot: UiClientSnapshot, main: WindowContext, post: (request: unknown) => Promise<unknown>): Promise<boolean>;
  close(): void;
}
export const noChildUiRelay: NativeUiRelayPort = { async publish() { return false; }, close() {} };
export type ValidatedAppearance = { readonly kind: 'none' } | { readonly kind: 'local-builtin' }
  | { readonly kind: 'delivery'; readonly context: string | null; readonly generation: number; readonly revision: number; readonly digest: string | null };
export function validatedDelivery(state: UiClientSnapshot, context: string | null): ValidatedAppearance {
  return { kind: 'delivery', context, generation: state.selection.deliveryGeneration, revision: state.selection.revision, digest: state.bundle?.digest ?? null };
}
export function matchesValidatedDelivery(visual: ValidatedAppearance, state: UiClientSnapshot, context: string | null): boolean {
  return visual.kind === 'delivery' && visual.context === context && visual.generation === state.selection.deliveryGeneration && visual.revision === state.selection.revision && visual.digest === (state.bundle?.digest ?? null);
}
export interface UiConnectionSnapshot {
  readonly state: UiClientSnapshot | null;
  readonly diagnostic: string | null;
  readonly localBuiltin: boolean;
  readonly deliveryContext: string | null;
  readonly validatedVisual: ValidatedAppearance;
  readonly confirmedGeneration: number | null;
  readonly cards: DisplayView;
}
export class UiConnection {
  private snapshot: UiConnectionSnapshot = { state: null, diagnostic: null, localBuiltin: false, deliveryContext: null, validatedVisual: { kind: 'none' }, confirmedGeneration: null, cards: NO_DISPLAY };
  private readonly cards = new DisplayClient();
  private relayPaging = false;
  private readonly listeners = new Set<() => void>();
  private readonly abort = new AbortController();
  private context: UiContextV1 | null = null;
  private window: WindowContext | null = null;
  private sequence = 0;
  private started = false;
  private painted: UiClientSnapshot | null = null;
  private confirmed: string | null = null;
  private failure: { readonly state: UiClientSnapshot; readonly reason: string } | null = null;
  private recovery: UiRecovery | null = null;
  private lastContext: UiContextV1 | null = null;
  private recoveryFloor: number | null = null;
  private restorationRequests = 0;
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
  selectScope(scope: ConversationScope | null): void { if (this.cards.select(scope)) this.update({ cards: this.cards.getSnapshot() }); }
  refreshCards(): void { if (this.cards.refresh()) this.update({ cards: this.cards.getSnapshot() }); }
  protected async nextPresenceSequence(): Promise<number> {
    const context = this.window;
    if (!this.identify || !context?.brokerInstance.startsWith('browser:')) return ++this.sequence;
    const key = `openpane.uiPresence:${JSON.stringify([context.hostId, context.profileId, context.viewId])}`;
    return navigator.locks.request(key, () => {
      const prior = localStorage.getItem(key), sequence = prior === null ? 0 : count(Number(prior));
      if (sequence === Number.MAX_SAFE_INTEGER) throw new Error('Window presence sequence exhausted');
      localStorage.setItem(key, String(sequence + 1)); return sequence + 1;
    });
  }
  private async readLoop(): Promise<void> {
    let delay = 300;
    while (!this.abort.signal.aborted) {
      try {
        if (!this.context || !this.window) {
          this.context = parseUiContext(await this.post({ op: 'context' })); this.lastContext = this.context;
          if (this.cards.profile(this.context.profileId, this.context.hostId)) this.update({ cards: this.cards.getSnapshot() });
          if (!this.window || this.window.hostId !== this.context.hostId || this.window.profileId !== this.context.profileId) {
          this.window = this.identify ? await this.identify(this.context) : { role: 'main', profileId: this.context.profileId, hostId: this.context.hostId,
            brokerInstance: `browser:${crypto.randomUUID()}`, label: 'browser', documentIncarnation: crypto.randomUUID(), viewId: crypto.randomUUID() };
          this.sequence = 0; this.painted = null; this.confirmed = null; this.failure = null;
          this.update({ state: null, deliveryContext: JSON.stringify(this.window), validatedVisual: { kind: 'none' }, confirmedGeneration: null });
          }
        }
        if (this.recovery?.kind === 'reserved') await this.finishRecovery();
        const state = parseUiClientSnapshot(await this.post({ op: 'state', context: this.window, presenceSequence: await this.nextPresenceSequence(),
          visible: document.visibilityState === 'visible', nativePlacement: this.nativePlacement, display: this.cards.subscription(), after: this.snapshot.state?.change ?? null, waitMs: this.cards.needsPaging() || this.relayPaging ? 50 : 2000 }));
        if (this.context) this.lastContext = { ...this.context, revision: state.selection.revision, selection: state.selection };
        if (!this.recovery && this.restorationRequests === 0 && (state.selection.selected.kind === 'builtin' || this.recoveryFloor !== null && state.selection.deliveryGeneration >= this.recoveryFloor)) this.update({ localBuiltin: false });
        const recoveryNotice = this.recovery?.kind === 'conflicted' ? this.recovery.reason : this.recovery?.kind === 'needs-context' ? 'Builtin appearance is local. Retry restore when connected to save it.' : null;
        this.cards.accept(state.display);
        this.update({ state, cards: this.cards.getSnapshot(), diagnostic: state.fault ?? recoveryNotice });
        this.relayPaging = await this.relay.publish(state, this.window, request => this.post(request));
        if (this.failure && !sameDelivery(this.failure.state, state)) this.failure = null;
        if (this.failure && document.visibilityState === 'visible') await this.reportFailure().catch(() => {});
        if (this.painted && sameDelivery(this.painted, state) && document.visibilityState === 'visible' && !this.snapshot.localBuiltin) await this.reportPaint(state).catch(() => {});
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
    if (state && state.selection.deliveryGeneration === transition.envelope.deliveryGeneration && state.selection.revision === transition.envelope.selectionRevision && (state.bundle?.digest ?? null) === transition.envelope.digest) this.update({ state: { ...state, transitions: state.transitions.map(item => item.slot.transitionId === transition.slot.transitionId ? { ...item, slot: { ...item.slot, target } } : item) } });
  }
  async idlePlacement(transition: PlacementTransition): Promise<void> {
    if (!this.window) throw new Error('UI source is not registered');
    await this.post({ op: 'placement-idle', session: this.window.documentIncarnation, envelope: transition.envelope, transitionId: transition.slot.transitionId });
    const state = this.snapshot.state;
    if (state && state.selection.deliveryGeneration === transition.envelope.deliveryGeneration && state.selection.revision === transition.envelope.selectionRevision && (state.bundle?.digest ?? null) === transition.envelope.digest) this.update({ state: { ...state, transitions: state.transitions.filter(item => item.slot.transitionId !== transition.slot.transitionId) } });
  }
  async failPlacement(transition: PlacementTransition, reason: string): Promise<void> {
    if (!this.window) throw new Error('UI source is not registered');
    await this.post({ op: 'placement-failed', session: this.window.documentIncarnation, envelope: transition.envelope, transitionId: transition.slot.transitionId, reason: reason.slice(0, 500) || 'Appearance failed' });
    const state = this.snapshot.state;
    if (state && state.selection.deliveryGeneration === transition.envelope.deliveryGeneration && state.selection.revision === transition.envelope.selectionRevision && (state.bundle?.digest ?? null) === transition.envelope.digest) this.update({ state: { ...state, transitions: state.transitions.filter(item => item.slot.transitionId !== transition.slot.transitionId) } });
  }
  async rendered(state: UiClientSnapshot | null, localBuiltin = false, context = this.snapshot.deliveryContext): Promise<void> {
    if (context !== this.snapshot.deliveryContext || state && (!this.snapshot.state || !sameDelivery(state, this.snapshot.state))) return;
    if (localBuiltin) this.update({ validatedVisual: { kind: 'local-builtin' } });
    if (!state || !this.snapshot.state || !sameDelivery(state, this.snapshot.state) || !this.window || this.snapshot.localBuiltin && state.selection.selected.kind !== 'builtin') return;
    if (!localBuiltin && this.snapshot.localBuiltin) return;
    this.painted = state;
    if (!localBuiltin) this.update({ validatedVisual: validatedDelivery(state, this.snapshot.deliveryContext) });
    await this.reportPaint(state);
  }
  private async reportPaint(state: UiClientSnapshot): Promise<void> {
    if (!this.window) return;
    const owner = this.window;
    const key = JSON.stringify([owner, state.selection, state.bundle?.digest, state.envelope?.requestId]);
    if (this.confirmed === key) return;
    await this.post({ op: 'paint', session: this.window.documentIncarnation, deliveryGeneration: state.selection.deliveryGeneration,
      selectionRevision: state.selection.revision, digest: state.bundle?.digest ?? null });
    if (state.envelope) await this.ack(state.envelope, { kind: 'rendered' });
    if (this.window !== owner || !this.snapshot.state || !sameDelivery(this.snapshot.state, state)) return;
    this.confirmed = key; this.update({ confirmedGeneration: state.selection.deliveryGeneration });
  }
  async failed(state: UiClientSnapshot, reason: string, context = this.snapshot.deliveryContext): Promise<void> {
    if (context !== this.snapshot.deliveryContext || !this.snapshot.state || !sameDelivery(state, this.snapshot.state)) return;
    this.update({ diagnostic: reason });
    this.painted = null;
    this.failure = { state, reason: reason.slice(0, 500) || 'Appearance failed' };
    await this.reportFailure();
  }
  private async reportFailure(): Promise<void> {
    const failure = this.failure;
    if (!failure) return;
    if (failure.state.envelope) await this.ack(failure.state.envelope, { kind: 'failed', reason: failure.reason });
    if (this.failure === failure) this.failure = null;
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
  async restore(): Promise<void> { await this.requestRecovery({ kind: 'browser' }); }
  protected async requestRecovery(originator: RecoveryOriginator): Promise<boolean> {
    this.restorationRequests++;
    this.update({ localBuiltin: true, diagnostic: 'Saving builtin appearance selection…' });
    try {
      if (this.recovery?.kind === 'reserved' && !sameRecoveryOriginator(this.recovery.originator, originator)) await this.finishRecovery();
      if (originator.kind === 'native' && this.recovery?.kind === 'conflicted' && sameRecoveryOriginator(this.recovery.originator, originator)) return true;
      if (this.recovery?.kind !== 'reserved') {
        this.saveRecovery({ version: 1, kind: 'needs-context' });
        let context: UiContextV1;
        try { context = parseUiContext(await this.post({ op: 'context' })); this.lastContext = context; }
        catch (error) { if (!this.lastContext) throw error; context = this.lastContext; }
        this.saveRecovery(reserveRecovery(context, originator));
      }
      await this.finishRecovery();
      return true;
    } catch (error) {
      this.update({ diagnostic: `${error instanceof Error ? error.message : 'Host unavailable'}. Builtin appearance is local; retry restore to reconcile.` });
      return this.recovery !== null && this.recovery.kind !== 'needs-context' && sameRecoveryOriginator(this.recovery.originator, originator);
    } finally { this.restorationRequests--; }
  }
  protected async recovered(_originator: RecoveryOriginator): Promise<void> {}
  private async finishRecovery(): Promise<void> {
    const recovery = this.recovery;
    if (recovery?.kind !== 'reserved') return;
    try {
      if (this.context && (this.context.hostId !== recovery.hostId || this.context.profileId !== recovery.profileId)) throw new UiServiceError('conflict', 'Appearance recovery belongs to a previous host profile');
      const result = record(await this.post(recovery.request), ['receipt', 'outcome']), receipt = parseApplyReceipt(result.receipt);
      if (receipt.requestId !== recovery.request.requestId || receipt.digest !== null) throw new Error('Invalid builtin recovery receipt');
      if (this.recovery === recovery) { this.recoveryFloor = receipt.deliveryGeneration; await this.recovered(recovery.originator); if (this.recovery === recovery) this.saveRecovery(null); }
    } catch (error) {
      if (this.recovery === recovery && error instanceof UiServiceError && ['stale-revision', 'expired', 'conflict', 'invalid-input'].includes(error.code)) {
        this.saveRecovery({ ...recovery, kind: 'conflicted', reason: `${error.message.slice(0, 800)}. Retry restore to confirm the current generation.` });
      }
      throw error;
    }
  }
  close(): void { this.abort.abort(); this.relay.close(); this.listeners.clear(); }
}
