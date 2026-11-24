import { PlacementSuperseded } from './placement-port.js';
import { parseUiClientSnapshot, parseUiContext, parseApplyReceipt } from '@openpane/contracts';
import type { ConversationScope, DeliveryEnvelope, NativePlacementTarget, PlacementTransition, UiClientSnapshot, UiContextV1, WindowContext } from '@openpane/contracts';
import { count, record } from '@openpane/contracts/decode';
import { parseUiRecovery, reserveRecovery, sameRecoveryOriginator, UI_RECOVERY_KEY } from './ui-recovery.js';
import type { UiRecovery, RecoveryOriginator, UiRecoveryHost } from './ui-recovery.js';
import { DisplayClient, NO_DISPLAY } from './display-client.js';
import type { DisplayView } from './display-client.js';

const recoveryStorageKey = (host: UiRecoveryHost): string => `${UI_RECOVERY_KEY}:${JSON.stringify([host.hostId, host.profileId])}`;

const sameDelivery = (a: UiClientSnapshot, b: UiClientSnapshot): boolean => a.selection.deliveryGeneration === b.selection.deliveryGeneration && a.selection.revision === b.selection.revision && a.bundle?.digest === b.bundle?.digest;

class UiServiceError extends Error { constructor(readonly code: string, message: string) { super(message); } }

export interface UiTransport {
  getSnapshot(): UiConnectionSnapshot;
  subscribe(listener: () => void): () => void;
  start(): void;
  rendered(state: UiClientSnapshot | null, localBuiltin?: boolean, context?: string | null): Promise<void>;
  failed(state: UiClientSnapshot, reason: string, context?: string | null): Promise<void>;
  restore(expectedHost?: UiRecoveryHost): Promise<void>;
  close(): void;
  selectScope(scope: ConversationScope | null): void;
  refreshCards(): void;
}
export interface NativeUiRelayPort {
  liveChildren?(main: WindowContext): Promise<readonly string[]>;
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
  private paintAttempt = 0;
  private confirmed: string | null = null;
  private failure: { readonly state: UiClientSnapshot; readonly reason: string } | null = null;
  private recovery: UiRecovery | null = null;
  private recoveryRaw: string | null = null;
  private lastContext: UiContextV1 | null = null;
  private recoveryFloor: (UiRecoveryHost & { readonly generation: number }) | null = null;
  private restorationRequests = 0;
  private recoveryRequest: { readonly originator: RecoveryOriginator; host: UiRecoveryHost | null; readonly promise: Promise<boolean> } | null = null;
  constructor(private readonly relay: NativeUiRelayPort = noChildUiRelay,
    private readonly identify?: (context: UiContextV1) => Promise<WindowContext>, private readonly nativePlacement = false) {
    try {
      const cached = localStorage.getItem(UI_RECOVERY_KEY);
      if (cached) {
        this.recovery = parseUiRecovery(JSON.parse(cached)); this.recoveryRaw = cached; this.snapshot = { ...this.snapshot, localBuiltin: true };
        try { this.archiveRecovery(this.recovery, cached); }
        catch { this.snapshot = { ...this.snapshot, diagnostic: 'Builtin appearance recovery could not be saved across reloads.' }; }
      }
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
  private recoveryBelongsTo(host: UiRecoveryHost): boolean {
    const recovery = this.recovery;
    return recovery === null || recovery.kind === 'needs-context' || recovery.hostId === host.hostId && recovery.profileId === host.profileId;
  }
  private async readLoop(): Promise<void> {
    let delay = 300;
    while (!this.abort.signal.aborted) {
      try {
        if (!this.context || !this.window) {
          const context = parseUiContext(await this.post({ op: 'context' })), previous = this.window ?? this.lastContext ?? this.recoveryFloor;
          const rebound = previous !== null && (previous.hostId !== context.hostId || previous.profileId !== context.profileId);
          this.context = context; this.lastContext = context; this.selectRecovery(context);
          if (this.cards.profile(this.context.profileId, this.context.hostId)) this.update({ cards: this.cards.getSnapshot() });
          if (!this.window || this.window.hostId !== this.context.hostId || this.window.profileId !== this.context.profileId) {
          this.window = this.identify ? await this.identify(this.context) : { role: 'main', profileId: this.context.profileId, hostId: this.context.hostId,
            brokerInstance: `browser:${crypto.randomUUID()}`, label: 'browser', documentIncarnation: crypto.randomUUID(), viewId: crypto.randomUUID() };
          this.sequence = 0; this.painted = null; this.confirmed = null; this.failure = null;
          if (rebound) this.recoveryFloor = null;
          const foreignRecovery = !this.recoveryBelongsTo(this.context);
          this.update({ state: null, deliveryContext: JSON.stringify(this.window), validatedVisual: { kind: 'none' }, confirmedGeneration: null, ...(foreignRecovery || rebound ? { localBuiltin: false } : {}) });
          }
        }
        if (this.recovery && this.recovery.kind !== 'needs-context' && this.recoveryBelongsTo(this.context) && !this.snapshot.localBuiltin) this.update({ localBuiltin: true });
        if (this.recovery?.kind === 'reserved' && this.recoveryBelongsTo(this.context)) await this.finishRecovery();
        const state = parseUiClientSnapshot(await this.post({ op: 'state', context: this.window, presenceSequence: await this.nextPresenceSequence(),
          ...(this.nativePlacement && this.relay.liveChildren ? { liveChildren: await this.relay.liveChildren(this.window) } : {}),
          visible: document.visibilityState === 'visible', nativePlacement: this.nativePlacement, display: this.cards.subscription(), after: this.snapshot.state?.change ?? null, waitMs: this.cards.needsPaging() || this.relayPaging ? 50 : 2000 }));
        if (this.context) this.lastContext = { ...this.context, revision: state.selection.revision, selection: state.selection };
        if (!this.recovery && this.restorationRequests === 0 && (state.selection.selected.kind === 'builtin' || this.recoveryFloor !== null && state.selection.deliveryGeneration >= this.recoveryFloor.generation)) this.update({ localBuiltin: false });
        const recoveryNotice = !this.recoveryBelongsTo(this.context) ? null : this.recovery?.kind === 'conflicted' ? this.recovery.reason : this.recovery?.kind === 'needs-context' ? 'Builtin appearance is local. Retry restore when connected to save it.' : null;
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
    const owner = this.window, context = this.snapshot.deliveryContext;
    const result = record(await this.post({ op: 'placement-reserve', session: owner.documentIncarnation, envelope: transition.envelope, transitionId: transition.slot.transitionId, target }), ['receipt', 'outcome']);
    const state = this.snapshot.state;
    const current = this.window === owner && this.snapshot.deliveryContext === context && state !== null && state.selection.deliveryGeneration === transition.envelope.deliveryGeneration && state.selection.revision === transition.envelope.selectionRevision && (state.bundle?.digest ?? null) === transition.envelope.digest;
    if (result.outcome === 'superseded') {
      if (current) { this.paintAttempt++; this.confirmed = null; this.update({ confirmedGeneration: null }); }
      throw new PlacementSuperseded();
    }
    if (current && state) this.update({ state: { ...state, transitions: state.transitions.map(item => item.slot.transitionId === transition.slot.transitionId ? { ...item, slot: { ...item.slot, target } } : item) } });
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
    this.paintAttempt++;
    this.painted = state;
    if (!localBuiltin) this.update({ validatedVisual: validatedDelivery(state, this.snapshot.deliveryContext) });
    await this.reportPaint(state);
  }
  private async reportPaint(state: UiClientSnapshot): Promise<void> {
    if (!this.window) return;
    const owner = this.window, attempt = this.paintAttempt;
    const key = JSON.stringify([owner, state.selection, state.bundle?.digest, state.envelope?.requestId]);
    if (this.confirmed === key) return;
    await this.post({ op: 'paint', session: this.window.documentIncarnation, deliveryGeneration: state.selection.deliveryGeneration,
      selectionRevision: state.selection.revision, digest: state.bundle?.digest ?? null });
    const current = () => this.painted !== null && this.paintAttempt === attempt && this.window === owner && this.snapshot.state !== null && sameDelivery(this.snapshot.state, state)
      && (matchesValidatedDelivery(this.snapshot.validatedVisual, state, this.snapshot.deliveryContext)
        || this.snapshot.localBuiltin && state.selection.selected.kind === 'builtin' && this.snapshot.validatedVisual.kind === 'local-builtin');
    if (!current()) return;
    if (state.envelope) await this.ack(state.envelope, { kind: 'rendered' });
    if (!current()) return;
    this.confirmed = key; this.update({ confirmedGeneration: state.selection.deliveryGeneration });
  }
  async failed(state: UiClientSnapshot, reason: string, context = this.snapshot.deliveryContext): Promise<void> {
    if (context !== this.snapshot.deliveryContext || !this.snapshot.state || !sameDelivery(state, this.snapshot.state)) return;
    this.paintAttempt++;
    this.confirmed = null;
    this.update({ diagnostic: reason, validatedVisual: { kind: 'none' }, confirmedGeneration: null });
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
  private archiveRecovery(value: UiRecovery | null, raw: string | null): void {
    if (value && value.kind !== 'needs-context' && raw !== null) localStorage.setItem(recoveryStorageKey(value), raw);
  }
  private selectRecovery(host: UiRecoveryHost): void {
    if (this.recovery && this.recovery.kind !== 'needs-context' && this.recoveryBelongsTo(host)) return;
    let raw: string, selected: UiRecovery;
    try {
      const cached = localStorage.getItem(recoveryStorageKey(host)); if (cached === null) return;
      selected = parseUiRecovery(JSON.parse(cached)); raw = cached;
      if (selected.kind === 'needs-context' || selected.hostId !== host.hostId || selected.profileId !== host.profileId) throw new Error('Foreign saved appearance recovery');
    } catch { this.update({ diagnostic: 'Saved appearance recovery could not be read for this host.' }); return; }
    const previous = this.recovery, previousRaw = this.recoveryRaw;
    this.recovery = selected; this.recoveryRaw = raw;
    try { this.archiveRecovery(previous, previousRaw); localStorage.setItem(UI_RECOVERY_KEY, raw); }
    catch { this.update({ diagnostic: 'Builtin appearance is active locally; recovery could not be saved across reloads.' }); }
  }
  private saveRecovery(value: UiRecovery | null): void {
    const previous = this.recovery, previousRaw = this.recoveryRaw, raw = value === null ? null : JSON.stringify(value);
    this.recovery = value; this.recoveryRaw = raw;
    try {
      if (value !== null) this.archiveRecovery(previous, previousRaw);
      this.archiveRecovery(value, raw);
      if (value === null && previous && previous.kind !== 'needs-context' && localStorage.getItem(recoveryStorageKey(previous)) === previousRaw) localStorage.removeItem(recoveryStorageKey(previous));
      if (raw !== null) localStorage.setItem(UI_RECOVERY_KEY, raw);
      else if (previousRaw !== null && localStorage.getItem(UI_RECOVERY_KEY) === previousRaw) localStorage.removeItem(UI_RECOVERY_KEY);
    } catch { this.update({ diagnostic: 'Builtin appearance is active locally; recovery could not be saved across reloads.' }); }
  }
  recoveryHost(expectedHostId: string): UiRecoveryHost {
    const host = this.context ?? this.window;
    if (!host || host.hostId !== expectedHostId || this.window?.hostId !== expectedHostId || this.window.profileId !== host.profileId) throw new Error('Appearance recovery belongs to a different host');
    return host;
  }
  async restore(expectedHost?: UiRecoveryHost): Promise<void> {
    if (expectedHost && this.recoveryHost(expectedHost.hostId).profileId !== expectedHost.profileId) throw new Error('Appearance recovery belongs to a different host profile');
    await this.requestRecovery({ kind: 'browser' }, expectedHost ?? this.window ?? this.context);
  }
  protected requestRecovery(originator: RecoveryOriginator, host: UiRecoveryHost | null = null): Promise<boolean> {
    const pending = this.recoveryRequest;
    if (pending) {
      const sameOrigin = sameRecoveryOriginator(pending.originator, originator);
      if (sameOrigin && host === null) return pending.promise;
      if (sameOrigin && pending.host === null) return pending.promise.then(recorded => pending.host?.hostId === host?.hostId && pending.host?.profileId === host?.profileId ? recorded : this.requestRecovery(originator, host));
      return sameOrigin && pending.host?.hostId === host?.hostId && pending.host?.profileId === host?.profileId ? pending.promise : pending.promise.then(() => this.requestRecovery(originator, host));
    }
    const promise = this.performRecovery(originator, host).finally(() => { if (this.recoveryRequest?.promise === promise) this.recoveryRequest = null; });
    this.recoveryRequest = { originator, host, promise };
    return promise;
  }
  private async performRecovery(originator: RecoveryOriginator, host: UiRecoveryHost | null): Promise<boolean> {
    const currentHost = () => { const bound = this.context ?? this.window; return !host || !bound || bound.hostId === host.hostId && bound.profileId === host.profileId; };
    if (!currentHost()) return false;
    this.restorationRequests++;
    const showBuiltin = () => {
      this.paintAttempt++; this.painted = null; this.confirmed = null;
      const validatedVisual: ValidatedAppearance = this.snapshot.localBuiltin && this.snapshot.validatedVisual.kind === 'local-builtin' ? this.snapshot.validatedVisual : { kind: 'none' };
      this.update({ localBuiltin: true, validatedVisual, confirmedGeneration: null, diagnostic: 'Saving builtin appearance selection…' });
    };
    const unbound = host !== null && !this.context && !this.window;
    if (!unbound) showBuiltin();
    const readContext = async () => {
      let context: UiContextV1 | null = null;
      try { context = parseUiContext(await this.post({ op: 'context' })); }
      catch (error) {
        if (this.lastContext) context = this.lastContext;
        else if (host === null && this.recovery?.kind === 'reserved') host = this.recovery;
        else throw error;
      }
      host ??= context;
      const pending = this.recoveryRequest;
      if (pending && pending.host === null && sameRecoveryOriginator(pending.originator, originator)) pending.host = host;
      if (!currentHost() || context && host && (context.hostId !== host.hostId || context.profileId !== host.profileId)) throw new UiServiceError('conflict', 'Appearance recovery belongs to a previous host profile');
      if (context) { this.selectRecovery(context); this.lastContext = context; }
      return context;
    };
    try {
      if (host === null && this.recovery === null) this.saveRecovery({ version: 1, kind: 'needs-context' });
      let verified = await readContext();
      if (!currentHost()) throw new UiServiceError('conflict', 'Appearance recovery belongs to a previous host profile');
      if (unbound) showBuiltin();
      const foreign = host !== null && !this.recoveryBelongsTo(host);
      if (!foreign && this.recovery?.kind === 'reserved' && !sameRecoveryOriginator(this.recovery.originator, originator)) {
        await this.finishRecovery(host);
        if (!currentHost()) throw new UiServiceError('conflict', 'Appearance recovery belongs to a previous host profile');
        const advanced = this.lastContext;
        if (advanced && host && advanced.hostId === host.hostId && advanced.profileId === host.profileId && (!verified || advanced.revision > verified.revision)) verified = advanced;
      }
      if (!foreign && originator.kind === 'native' && this.recovery?.kind === 'conflicted' && sameRecoveryOriginator(this.recovery.originator, originator)) return true;
      if (foreign || this.recovery?.kind !== 'reserved') {
        if (!foreign) this.saveRecovery({ version: 1, kind: 'needs-context' });
        const context = verified ?? await readContext();
        if (!currentHost()) throw new UiServiceError('conflict', 'Appearance recovery belongs to a previous host profile');
        if (!context) throw new Error('A connected context is required for a new appearance recovery');
        this.saveRecovery(reserveRecovery(context, originator));
      }
      await this.finishRecovery(host);
      if (!currentHost()) throw new UiServiceError('conflict', 'Appearance recovery belongs to a previous host profile');
      return true;
    } catch (error) {
      if (!currentHost()) {
        if (this.recovery?.kind === 'needs-context') this.saveRecovery(null);
        this.update({ localBuiltin: false });
        return false;
      }
      this.update({ diagnostic: `${error instanceof Error ? error.message : 'Host unavailable'}. Builtin appearance is local; retry restore to reconcile.` });
      return this.recovery !== null && this.recovery.kind !== 'needs-context' && sameRecoveryOriginator(this.recovery.originator, originator);
    } finally { this.restorationRequests--; }
  }
  protected async recovered(_originator: RecoveryOriginator): Promise<void> {}
  private async finishRecovery(host: UiRecoveryHost | null = null): Promise<void> {
    const recovery = this.recovery;
    if (recovery?.kind !== 'reserved') return;
    try {
      if (host && (host.hostId !== recovery.hostId || host.profileId !== recovery.profileId) || this.context && (this.context.hostId !== recovery.hostId || this.context.profileId !== recovery.profileId)) throw new UiServiceError('conflict', 'Appearance recovery belongs to a previous host profile');
      const result = record(await this.post({ ...recovery.request, expectedContext: { hostId: recovery.hostId, profileId: recovery.profileId } }), ['receipt', 'outcome']), receipt = parseApplyReceipt(result.receipt);
      if (receipt.requestId !== recovery.request.requestId || receipt.digest !== null) throw new Error('Invalid builtin recovery receipt');
      const advance = (context: UiContextV1 | null): UiContextV1 | null => context && context.hostId === recovery.hostId && context.profileId === recovery.profileId
        ? { ...context, recoveryGeneration: recovery.request.expectedRecoveryGeneration + 1, revision: receipt.selectionRevision,
          selection: { ...context.selection, revision: receipt.selectionRevision, deliveryGeneration: receipt.deliveryGeneration, selected: { kind: 'builtin' } } } : context;
      this.context = advance(this.context); this.lastContext = advance(this.lastContext);
      if (this.recovery === recovery) {
        const bound = this.context ?? this.window;
        if (!bound || bound.hostId === recovery.hostId && bound.profileId === recovery.profileId) this.recoveryFloor = { hostId: recovery.hostId, profileId: recovery.profileId, generation: receipt.deliveryGeneration };
        await this.recovered(recovery.originator);
        if (this.recovery === recovery) this.saveRecovery(null);
      }
    } catch (error) {
      if (this.recovery === recovery && error instanceof UiServiceError && ['stale-revision', 'expired', 'conflict', 'invalid-input'].includes(error.code)) {
        this.saveRecovery({ ...recovery, kind: 'conflicted', reason: `${error.message.slice(0, 800)}. Retry restore to confirm the current generation.` });
      }
      throw error;
    }
  }
  close(): void { this.abort.abort(); this.relay.close(); this.listeners.clear(); }
}
