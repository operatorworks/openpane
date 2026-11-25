import { PlacementSuperseded } from './placement-port.js';
import { parseUiClientSnapshot, parseUiContext, parseApplyReceipt, canonicalJson } from '@openpane/contracts';
import type { ConversationScope, DeliveryEnvelope, NativePlacementTarget, PlacementTransition, UiClientSnapshot, UiContextV1, WindowContext } from '@openpane/contracts';
import { count, record } from '@openpane/contracts/decode';
import { parseUiRecovery, tryParseUiRecovery, reserveRecovery, scopedSupersedes, sameRecoveryOriginator, UI_RECOVERY_KEY, NATIVE_BINDING_REFUSED } from './ui-recovery.js';
import type { UiRecovery, RecoveryOriginator, UiRecoveryHost } from './ui-recovery.js';
import { DisplayClient, NO_DISPLAY } from './display-client.js';
import type { DisplayView } from './display-client.js';

const recoveryStorageKey = (host: UiRecoveryHost): string => `${UI_RECOVERY_KEY}:${JSON.stringify([host.hostId, host.profileId])}`;

export const sameDelivery = (a: UiClientSnapshot, b: UiClientSnapshot): boolean => a.selection.deliveryGeneration === b.selection.deliveryGeneration && a.selection.revision === b.selection.revision && a.bundle?.digest === b.bundle?.digest;

class UiServiceError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const definitiveRecoveryConflict = (error: unknown): error is UiServiceError => error instanceof UiServiceError && ['stale-revision', 'expired', 'conflict', 'invalid-input'].includes(error.code);

const wrongHost = () => new UiServiceError('wrong-host', 'Appearance recovery belongs to a previous host profile');
const recoveryRetryNotice = (error: unknown, builtin: boolean): string => (error instanceof Error ? error.message : 'Host unavailable') + (builtin ? '. Builtin appearance is local; retry restore to reconcile.' : '. Retry Restore to reconcile the current appearance.');

type RecoveryAction = {
  readonly originator: RecoveryOriginator;
  host: UiRecoveryHost | null;
  notice: string | null;
  request: { readonly kind: 'context' } | { readonly kind: 'reserved'; readonly requestId: string };
};
export type RecoveryResult = { readonly recorded: false } | { readonly recorded: true; readonly host: UiRecoveryHost; readonly basis: 'receipt' | 'superseded' | 'pending' };
type RecoveryReceipt = { readonly recovery: Extract<UiRecovery, { readonly kind: 'reserved' }>; readonly receipt: ReturnType<typeof parseApplyReceipt> };
type RecoveryCompletion =
  | { readonly kind: 'receipt' | 'retired-receipt'; readonly originator: RecoveryOriginator }
  | { readonly kind: 'retired' | 'cancelled' | 'superseded' };

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
  private bindingSettled: Promise<void> | null = null;
  private bindingEpoch = Symbol();
  private bindingUnconfirmed = false;
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
  private recoveryContextRevision = 0;
  private readonly recoveryContextInvalidations = new Map<string, number>();
  private readonly recoveryContextRevisions = new WeakMap<UiContextV1, number>();
  private recoveryFloor: (UiRecoveryHost & { readonly generation: number; readonly recoveryGeneration: number }) | null = null;
  private restorationRequests = 0;
  private pendingReceipt: RecoveryReceipt | null = null;
  private nativeFallback: RecoveryAction | null = null;
  private recoveryRequest: { readonly action: RecoveryAction; readonly promise: Promise<RecoveryResult> } | null = null;
  private recoveryCompletion: { readonly recovery: Extract<UiRecovery, { readonly kind: 'reserved' }>; readonly promise: Promise<RecoveryCompletion> } | null = null;
  constructor(private readonly relay: NativeUiRelayPort = noChildUiRelay,
    private readonly identify?: (context: UiContextV1) => Promise<WindowContext>, private readonly nativePlacement = false) {
    try {
      const cached = localStorage.getItem(UI_RECOVERY_KEY);
      if (cached) {
        this.recovery = parseUiRecovery(JSON.parse(cached)); this.recoveryRaw = cached; this.snapshot = { ...this.snapshot, localBuiltin: true };
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
  private invalidateRecoveryContext(host: UiRecoveryHost): void {
    this.recoveryContextInvalidations.set(recoveryStorageKey(host), ++this.recoveryContextRevision);
  }
  private rememberRecoveryContext(context: UiContextV1, revision: number): UiContextV1 {
    this.recoveryContextRevisions.set(context, revision); return context;
  }
  private cacheRecoveryContext(context: UiContextV1): UiContextV1 {
    const saved = this.lastContext;
    const retained = saved && saved.hostId === context.hostId && saved.profileId === context.profileId && this.recoveryContextIsCurrent(saved)
      && saved.revision >= context.revision && saved.selection.deliveryGeneration >= context.selection.deliveryGeneration && saved.recoveryGeneration >= context.recoveryGeneration ? saved : context;
    this.lastContext = retained; return retained;
  }
  private recoveryContextIsCurrent(context: UiContextV1): boolean {
    const revision = this.recoveryContextRevisions.get(context);
    return revision !== undefined && revision >= (this.recoveryContextInvalidations.get(recoveryStorageKey(context)) ?? 0);
  }
  protected recoveryBindingConfirmed(): boolean { return !this.bindingUnconfirmed; }
  protected get bindingInFlight(): Promise<void> | null { return this.bindingSettled; }
  private boundTo(host: UiRecoveryHost | null): boolean {
    const bound = this.context ?? this.window;
    return !host || !bound || bound.hostId === host.hostId && bound.profileId === host.profileId;
  }
  private requireRecoveryAuthority(host: UiRecoveryHost): void {
    if (!this.boundTo(host)) throw wrongHost();
  }
  private async readHostContext(): Promise<UiContextV1> {
    const revision = this.recoveryContextRevision;
    return this.rememberRecoveryContext(parseUiContext(await this.post({ op: 'context' })), revision);
  }
  private async readLoop(): Promise<void> {
    let delay = 300;
    while (!this.abort.signal.aborted) {
      try {
        if (!this.context || !this.window) {
          const context = await this.readHostContext(), previous = this.window ?? this.lastContext ?? this.recoveryFloor;
          const rebound = previous !== null && (previous.hostId !== context.hostId || previous.profileId !== context.profileId);
          this.bindingEpoch = Symbol();
          const binding = (async () => {
            let window: WindowContext;
            if (this.identify) {
              try { window = await this.identify(context); }
              catch (error) { if (error !== NATIVE_BINDING_REFUSED) this.bindingUnconfirmed = true; throw error; }
            } else window = !this.window || this.window.hostId !== context.hostId || this.window.profileId !== context.profileId
              ? { role: 'main', profileId: context.profileId, hostId: context.hostId, brokerInstance: `browser:${crypto.randomUUID()}`, label: 'browser', documentIncarnation: crypto.randomUUID(), viewId: crypto.randomUUID() }
              : this.window;
            const needsBinding = !this.window || canonicalJson(window) !== canonicalJson(this.window);
            this.context = context; this.cacheRecoveryContext(context); this.window = needsBinding ? window : this.window; this.bindingUnconfirmed = false;
            if (rebound) this.recoveryFloor = null;
            if (this.nativeFallback?.host && (this.nativeFallback.host.hostId !== context.hostId || this.nativeFallback.host.profileId !== context.profileId)) this.nativeFallback = null;
            if (this.pendingReceipt && (this.pendingReceipt.recovery.hostId !== context.hostId || this.pendingReceipt.recovery.profileId !== context.profileId)) this.pendingReceipt = null;
            const recovery = this.recovery;
            if (recovery?.kind === 'reserved' && !recovery.submitted && (recovery.hostId !== context.hostId || recovery.profileId !== context.profileId)) this.saveRecovery(null);
            this.selectRecovery(context);
            if (this.cards.profile(context.profileId, context.hostId)) this.update({ cards: this.cards.getSnapshot() });
            if (needsBinding) {
              this.sequence = 0; this.painted = null; this.confirmed = null; this.failure = null;
              const foreignRecovery = !this.recoveryBelongsTo(context);
              this.update({ state: null, deliveryContext: JSON.stringify(window), validatedVisual: { kind: 'none' }, confirmedGeneration: null, ...(foreignRecovery || rebound ? { localBuiltin: false } : {}) });
            }
          })();
          const settled = binding.then(() => {}, () => {});
          this.bindingSettled = settled;
          try { await binding; } finally { if (this.bindingSettled === settled) this.bindingSettled = null; }
        }
        if (!this.context || !this.window) throw new Error('UI registration did not complete');
        this.selectRecovery(this.context);
        if (this.recovery && this.recovery.kind !== 'needs-context' && this.recoveryBelongsTo(this.context) && !this.snapshot.localBuiltin) this.update({ localBuiltin: true });
        if (this.pendingReceiptFor(this.context) || this.recovery?.kind === 'reserved' && this.recoveryBelongsTo(this.context)) await this.finishRecovery(this.context);
        const state = parseUiClientSnapshot(await this.post({ op: 'state', context: this.window, presenceSequence: await this.nextPresenceSequence(),
          ...(this.nativePlacement && this.relay.liveChildren ? { liveChildren: await this.relay.liveChildren(this.window) } : {}),
          visible: document.visibilityState === 'visible', nativePlacement: this.nativePlacement, display: this.cards.subscription(), after: this.snapshot.state?.change ?? null, waitMs: this.cards.needsPaging() || this.relayPaging ? 50 : 2000 }));
        if (this.context) {
          const saved = this.lastContext;
          const previous = saved && saved.hostId === this.context.hostId && saved.profileId === this.context.profileId
            && saved.revision >= this.context.revision && saved.selection.deliveryGeneration >= this.context.selection.deliveryGeneration ? saved : this.context;
          if (state.selection.revision >= previous.revision && state.selection.deliveryGeneration >= previous.selection.deliveryGeneration) {
            const latest = { ...previous, recoveryGeneration: Math.max(previous.recoveryGeneration, this.context.recoveryGeneration), revision: state.selection.revision, selection: state.selection };
            const revision = this.recoveryContextRevisions.get(previous);
            if (revision === undefined) throw new Error('UI context has no recovery provenance');
            this.lastContext = this.rememberRecoveryContext(latest, revision);
          }
        }
        if (!this.recovery && !this.nativeFallback && this.restorationRequests === 0 && (state.selection.selected.kind === 'builtin' || this.recoveryFloor !== null && state.selection.deliveryGeneration >= this.recoveryFloor.generation)) this.update({ localBuiltin: false });
        const recoveryNotice = this.nativeFallback ? this.nativeFallback.notice ?? 'Saving builtin appearance selection…' : !this.recoveryBelongsTo(this.context) ? null : this.recovery?.kind === 'conflicted' ? this.recovery.reason : this.recovery?.kind === 'needs-context' ? 'Builtin appearance is local. Retry restore when connected to save it.' : null;
        this.cards.accept(state.display);
        this.update({ state, cards: this.cards.getSnapshot(), diagnostic: state.fault ?? recoveryNotice });
        this.relayPaging = await this.relay.publish(state, this.window, request => this.post(request));
        if (this.failure && (!sameDelivery(this.failure.state, state) || this.failure.state.envelope && this.failure.state.envelope.requestId !== state.envelope?.requestId)) this.failure = null;
        if (this.failure && document.visibilityState === 'visible') await this.reportFailure().catch(() => {});
        if (this.painted && sameDelivery(this.painted, state) && document.visibilityState === 'visible' && !this.snapshot.localBuiltin) await this.reportPaint(state).catch(() => {});
        delay = 300;
      } catch (error) {
        if (this.abort.signal.aborted) return;
        this.update({ diagnostic: error === NATIVE_BINDING_REFUSED ? 'Close chat windows and restart OpenPane after the host identity changes.' : error instanceof Error ? error.message : 'Live appearance disconnected; the last usable appearance remains active' });
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
  private writeActiveRecovery(value: UiRecovery, raw: string): void {
    const previous = localStorage.getItem(UI_RECOVERY_KEY);
    if (previous !== null && previous !== raw) {
      const saved = tryParseUiRecovery(previous);
      if (saved && saved.kind !== 'needs-context' && (value.kind === 'needs-context' || saved.hostId !== value.hostId || saved.profileId !== value.profileId)) {
        const scopedRaw = localStorage.getItem(recoveryStorageKey(saved));
        const scoped = tryParseUiRecovery(scopedRaw);
        const preserve = scopedSupersedes(scoped, saved);
        if (!preserve) this.archiveRecovery(saved, previous);
      }
    }
    localStorage.setItem(UI_RECOVERY_KEY, raw);
  }
  private selectRecovery(host: UiRecoveryHost): boolean {
    let raw: string | null;
    try { raw = localStorage.getItem(recoveryStorageKey(host)); }
    catch { this.update({ diagnostic: 'Saved appearance recovery could not be read for this host.' }); return false; }
    let selected = tryParseUiRecovery(raw);
    if (selected && (selected.kind === 'needs-context' || selected.hostId !== host.hostId || selected.profileId !== host.profileId)) selected = null;
    const completed = (value: UiRecovery) => value.kind !== 'needs-context' && this.recoveryFloor !== null
      && value.hostId === this.recoveryFloor.hostId && value.profileId === this.recoveryFloor.profileId
      && value.request.expectedRecoveryGeneration < this.recoveryFloor.recoveryGeneration;
    if (selected && completed(selected)) {
      try { this.retireRecovery(selected, raw); } catch { /* A validated receipt remains completed even when cleanup is unavailable. */ }
      selected = null;
    }
    const cached = this.recovery, cachedRaw = this.recoveryRaw;
    if (cached && this.recoveryBelongsTo(host)) {
      if (!completed(cached)) {
        if (cachedRaw === null) {
          if (!scopedSupersedes(selected, cached) && (cached.kind !== 'needs-context' || selected === null)) return true;
        } else if (selected && raw === cachedRaw) return true;
        else if (!scopedSupersedes(selected, cached)) {
          try { if (localStorage.getItem(UI_RECOVERY_KEY) === cachedRaw) return true; }
          catch { this.update({ diagnostic: 'Saved appearance recovery could not be checked for this host.' }); return false; }
        }
      }
      this.invalidateRecoveryContext(host);
      this.recovery = null; this.recoveryRaw = null;
      if (!selected && !this.nativeFallback && this.restorationRequests === 0) this.update({ localBuiltin: false });
    }
    if (selected === null || raw === null) return true;
    this.invalidateRecoveryContext(host);
    this.recovery = selected; this.recoveryRaw = raw;
    try { this.writeActiveRecovery(selected, raw); }
    catch { this.update({ diagnostic: 'Builtin appearance is active locally; recovery could not be saved across reloads.' }); }
    return true;
  }
  private retireRecovery(previous: UiRecovery | null, raw: string | null): void {
    if (raw === null) return;
    const scoped = previous && previous.kind !== 'needs-context' ? recoveryStorageKey(previous) : null;
    const ownsScoped = scoped !== null && localStorage.getItem(scoped) === raw;
    const activeRaw = localStorage.getItem(UI_RECOVERY_KEY), active = tryParseUiRecovery(activeRaw);
    const retireActive = activeRaw === raw || ownsScoped && previous !== null && activeRaw !== null
      && (active === null || active.kind !== 'needs-context' && scopedSupersedes(previous, active));
    if (retireActive) localStorage.removeItem(UI_RECOVERY_KEY);
    if (ownsScoped && scoped !== null) localStorage.removeItem(scoped);
  }
  private saveRecovery(value: UiRecovery | null): void {
    const previous = this.recovery, previousRaw = this.recoveryRaw;
    const raw = value === null || value.kind === 'reserved' && !value.submitted ? null : JSON.stringify(value);
    this.recovery = value; this.recoveryRaw = raw;
    // Persist only admitted submissions so a cancelled startup wake cannot become replayable.
    if (value?.kind === 'reserved' && !value.submitted) {
      try {
        if (previous?.kind === 'needs-context' && localStorage.getItem(UI_RECOVERY_KEY) === previousRaw) localStorage.removeItem(UI_RECOVERY_KEY);
        return;
      } catch { this.update({ diagnostic: 'Builtin appearance is active locally; recovery could not be saved across reloads.' }); return; }
    }
    try {
      this.archiveRecovery(value, raw);
      if (value !== null && raw !== null) this.writeActiveRecovery(value, raw);
      else this.retireRecovery(previous, previousRaw);
    } catch {
      if (value && value.kind !== 'needs-context' && raw !== null) {
        try { if (localStorage.getItem(UI_RECOVERY_KEY) !== raw && localStorage.getItem(recoveryStorageKey(value)) !== raw) this.recoveryRaw = null; }
        catch { this.recoveryRaw = null; }
      }
      this.update({ diagnostic: 'Builtin appearance is active locally; recovery could not be saved across reloads.' });
    }
  }
  recoveryHost(expectedHostId: string): UiRecoveryHost {
    if (!this.recoveryBindingConfirmed()) throw wrongHost();
    const host = this.context ?? this.window;
    if (!host || host.hostId !== expectedHostId || this.window?.hostId !== expectedHostId || this.window.profileId !== host.profileId) throw new Error('Appearance recovery belongs to a different host');
    return host;
  }
  async restore(expectedHost?: UiRecoveryHost): Promise<void> {
    if (expectedHost && this.recoveryHost(expectedHost.hostId).profileId !== expectedHost.profileId) throw new Error('Appearance recovery belongs to a different host profile');
    await this.requestRecovery({ kind: 'browser' }, expectedHost ?? this.window ?? this.context);
  }
  protected requestRecovery(originator: RecoveryOriginator, host: UiRecoveryHost | null = null): Promise<RecoveryResult> {
    const pending = this.recoveryRequest;
    if (pending) {
      const active = pending.action, sameOrigin = sameRecoveryOriginator(active.originator, originator);
      if (sameOrigin && host === null) return pending.promise;
      if (sameOrigin && active.host === null) return pending.promise.then(recorded => active.host?.hostId === host?.hostId && active.host?.profileId === host?.profileId ? recorded : this.requestRecovery(originator, host));
      return sameOrigin && active.host?.hostId === host?.hostId && active.host?.profileId === host?.profileId ? pending.promise : pending.promise.then(() => this.requestRecovery(originator, host));
    }
    const action: RecoveryAction = { originator, host, notice: null, request: { kind: 'context' } };
    const promise = this.performRecovery(action).finally(() => { if (this.recoveryRequest?.promise === promise) this.recoveryRequest = null; });
    this.recoveryRequest = { action, promise };
    return promise;
  }
  private async performRecovery(action: RecoveryAction): Promise<RecoveryResult> {
    const originator = action.originator;
    const currentHost = () => this.boundTo(action.host);
    if (!currentHost()) return { recorded: false };
    const recorded = (basis: 'receipt' | 'superseded' | 'pending'): RecoveryResult => {
      if (!action.host) throw new Error('Recorded appearance recovery has no resolved authority');
      return { recorded: true, host: { hostId: action.host.hostId, profileId: action.host.profileId }, basis };
    };
    this.restorationRequests++;
    if (originator.kind === 'native') this.nativeFallback = action;
    const showBuiltin = () => {
      this.paintAttempt++; this.painted = null; this.confirmed = null;
      const validatedVisual: ValidatedAppearance = this.snapshot.localBuiltin && this.snapshot.validatedVisual.kind === 'local-builtin' ? this.snapshot.validatedVisual : { kind: 'none' };
      this.update({ localBuiltin: true, validatedVisual, confirmedGeneration: null, diagnostic: 'Saving builtin appearance selection…' });
    };
    const unbound = action.host !== null && !this.context && !this.window;
    if (!unbound) showBuiltin();
    const readContext = async (fresh = false) => {
      let context: UiContextV1 | null = null;
      try { context = await this.readHostContext(); }
      catch (error) {
        if (fresh) throw error;
        if (this.lastContext) context = this.lastContext;
        else if (action.host === null && this.recovery?.kind === 'reserved') action.host = this.recovery;
        else throw error;
      }
      action.host ??= context;
      if (!currentHost() || context && action.host && (context.hostId !== action.host.hostId || context.profileId !== action.host.profileId)) throw wrongHost();
      if (context) { this.selectRecovery(context); context = this.cacheRecoveryContext(context); }
      return context;
    };
    try {
      if (action.host === null && this.recovery === null) this.saveRecovery({ version: 1, kind: 'needs-context' });
      let verified = await readContext();
      if (!currentHost()) throw wrongHost();
      if (unbound) showBuiltin();
      for (;;) {
        if (this.bindingSettled) await this.bindingSettled;
        if (!currentHost()) throw wrongHost();
        const selected = this.pendingReceiptFor(action.host)?.recovery ?? this.recovery;
        const foreign = action.host !== null && selected !== null && selected.kind !== 'needs-context' && (selected.hostId !== action.host.hostId || selected.profileId !== action.host.profileId);
        if (!foreign && selected?.kind === 'reserved' && !sameRecoveryOriginator(selected.originator, originator)) {
          let completion: RecoveryCompletion;
          try { completion = await this.finishRecovery(action.host); }
          catch (error) {
            if (!definitiveRecoveryConflict(error) || !this.recoveryConflicted(selected.request.requestId)) throw error;
            verified = await readContext(true);
            continue;
          }
          if (!currentHost()) throw wrongHost();
          const advanced = this.lastContext;
          if (completion.kind === 'receipt' && advanced && action.host && advanced.hostId === action.host.hostId && advanced.profileId === action.host.profileId) verified = advanced;
          else verified = await readContext(true);
          continue;
        }
        if (!foreign && originator.kind === 'native' && selected?.kind === 'conflicted' && sameRecoveryOriginator(selected.originator, originator)) return recorded('pending');
        if (foreign || selected?.kind !== 'reserved') {
          if (!verified || !this.recoveryContextIsCurrent(verified)) {
            verified = await readContext(true);
            continue;
          }
          if (!foreign) this.saveRecovery({ version: 1, kind: 'needs-context' });
          const context = verified;
          if (!currentHost()) throw wrongHost();
          if (!context) throw new Error('A connected context is required for a new appearance recovery');
          this.saveRecovery(reserveRecovery(context, originator));
        }
        const owned = this.pendingReceiptFor(action.host)?.recovery ?? this.recovery;
        if (owned?.kind !== 'reserved' || !sameRecoveryOriginator(owned.originator, originator)) throw new Error('Appearance recovery reservation lost its owner');
        action.request = { kind: 'reserved', requestId: owned.request.requestId };
        const completion = await this.finishRecovery(action.host);
        if (!currentHost()) throw wrongHost();
        if (completion.kind === 'cancelled') { if (this.nativeFallback === action) this.nativeFallback = null; return { recorded: false }; }
        if (completion.kind === 'superseded') return recorded('superseded');
        if ((completion.kind === 'receipt' || completion.kind === 'retired-receipt') && sameRecoveryOriginator(completion.originator, originator)) return recorded('receipt');
        if (originator.kind === 'browser' && completion.kind === 'retired') return recorded('pending');
        verified = await readContext(true);
      }
    } catch (error) {
      if (!currentHost()) {
        if (this.recovery?.kind === 'needs-context') this.saveRecovery(null);
        if (this.nativeFallback === action) this.nativeFallback = null;
        this.update({ localBuiltin: false });
        return { recorded: false };
      }
      const diagnostic = recoveryRetryNotice(error, this.snapshot.localBuiltin);
      action.notice = diagnostic;
      this.update({ diagnostic });
      if (this.confirmationPending(originator)) return recorded('receipt');
      return this.recovery !== null && this.recovery.kind !== 'needs-context' && sameRecoveryOriginator(this.recovery.originator, originator) ? recorded('pending') : { recorded: false };
    } finally { this.restorationRequests--; }
  }
  protected async withStableBinding<T, R>(operation: { readonly read: () => Promise<T>; readonly terminal: (result: T) => boolean; readonly use: (result: T) => R | Promise<R> }): Promise<R> {
    for (;;) {
      if (this.bindingSettled) await this.bindingSettled;
      const epoch = this.bindingEpoch;
      const result = await operation.read();
      if (this.bindingSettled) await this.bindingSettled;
      if (operation.terminal(result) || epoch === this.bindingEpoch) return operation.use(result);
    }
  }
  protected async recovering(_originator: RecoveryOriginator, _host: UiRecoveryHost, _submitted: boolean): Promise<'accepted' | 'superseded' | 'cancelled'> { return 'accepted'; }
  protected async recovered(_originator: RecoveryOriginator, _deliveryGeneration: number, _host: UiRecoveryHost): Promise<void> {}
  private recoveryConflicted(requestId: string): boolean {
    return this.recovery?.kind === 'conflicted' && this.recovery.request.requestId === requestId;
  }
  protected confirmPendingRecovery(originator: RecoveryOriginator, host: UiRecoveryHost | null): Promise<boolean> | null {
    const pending = this.pendingReceiptFor(host);
    if (!pending || !sameRecoveryOriginator(pending.recovery.originator, originator)) return null;
    return this.finishRecovery(pending.recovery).then(async completion => {
      if (this.bindingSettled) await this.bindingSettled;
      return this.recoveryBindingConfirmed() && this.boundTo(pending.recovery) && (completion.kind === 'receipt' || completion.kind === 'retired-receipt') && sameRecoveryOriginator(completion.originator, originator);
    }, async error => {
      if (this.bindingSettled) await this.bindingSettled;
      if (this.pendingReceipt !== pending || !this.recoveryBindingConfirmed() || !this.boundTo(pending.recovery)) return false;
      const diagnostic = recoveryRetryNotice(error, this.snapshot.localBuiltin);
      if (this.nativeFallback && sameRecoveryOriginator(this.nativeFallback.originator, originator)) this.nativeFallback.notice = diagnostic;
      this.update({ diagnostic }); return true;
    });
  }
  private confirmationPending(originator: RecoveryOriginator): boolean {
    return this.pendingReceipt !== null && sameRecoveryOriginator(this.pendingReceipt.recovery.originator, originator);
  }
  private pendingReceiptFor(host: UiRecoveryHost | null): RecoveryReceipt | null {
    const pending = this.pendingReceipt;
    return pending && (!host || pending.recovery.hostId === host.hostId && pending.recovery.profileId === host.profileId) ? pending : null;
  }
  private finishRecovery(host: UiRecoveryHost | null = null): Promise<RecoveryCompletion> {
    const recovery = this.pendingReceiptFor(host)?.recovery ?? this.recovery;
    if (recovery?.kind !== 'reserved') return Promise.resolve({ kind: 'retired' });
    if (host && (host.hostId !== recovery.hostId || host.profileId !== recovery.profileId)) return Promise.reject(wrongHost());
    const completing = this.recoveryCompletion;
    if (completing && completing.recovery.request.requestId === recovery.request.requestId && completing.recovery.hostId === recovery.hostId && completing.recovery.profileId === recovery.profileId) return completing.promise;
    const promise = this.completeRecovery(recovery).finally(() => { if (this.recoveryCompletion?.promise === promise) this.recoveryCompletion = null; });
    this.recoveryCompletion = { recovery, promise };
    return promise;
  }
  private retiredRecovery(recovery: Extract<UiRecovery, { readonly kind: 'reserved' }>): RecoveryCompletion {
    const action = this.recoveryRequest?.action;
    if (this.recovery === null && !this.nativeFallback && (this.restorationRequests === 0 || action?.originator.kind === 'browser' && action.request.kind === 'reserved' && action.request.requestId === recovery.request.requestId)) {
      this.update({ localBuiltin: false, diagnostic: 'Appearance recovery was completed or replaced in another window.' });
    }
    return { kind: 'retired' };
  }
  private async completeRecovery(recovery: Extract<UiRecovery, { readonly kind: 'reserved' }>): Promise<RecoveryCompletion> {
    let committed = this.pendingReceiptFor(recovery);
    if (committed?.recovery.request.requestId !== recovery.request.requestId) committed = null;
    try {
      if (!committed) {
        const admitted = await this.withStableBinding<'accepted' | 'superseded' | 'cancelled', RecoveryCompletion | RecoveryReceipt>({
          read: async () => { this.requireRecoveryAuthority(recovery); return this.recovering(recovery.originator, { hostId: recovery.hostId, profileId: recovery.profileId }, recovery.submitted); },
          terminal: result => recovery.submitted || result === 'cancelled',
          use: (admission): RecoveryCompletion | Promise<RecoveryReceipt> => {
            if (admission !== 'accepted') {
              if (this.recovery === recovery) {
                this.saveRecovery(null);
                if (admission === 'cancelled') {
                  if (this.nativeFallback && sameRecoveryOriginator(this.nativeFallback.originator, recovery.originator)) this.nativeFallback = null;
                  this.update({ localBuiltin: false, diagnostic: 'Native appearance recovery was cancelled. Retry Restore in the current profile.' });
                }
              }
              return { kind: admission === 'superseded' ? 'superseded' : 'cancelled' };
            }
            if (this.recovery !== recovery) return this.retiredRecovery(recovery);
            this.requireRecoveryAuthority(recovery);
            if (!recovery.submitted) { recovery = { ...recovery, submitted: true }; this.saveRecovery(recovery); }
            return this.post({ ...recovery.request, expectedContext: { hostId: recovery.hostId, profileId: recovery.profileId } }).then(value => {
              const result = record(value, ['receipt', 'outcome']), receipt = parseApplyReceipt(result.receipt);
              if (receipt.requestId !== recovery.request.requestId || receipt.digest !== null) throw new Error('Invalid builtin recovery receipt');
              const received = { recovery, receipt }; this.pendingReceipt = received; return received;
            });
          },
        });
        if ('kind' in admitted) return admitted;
        committed = admitted;
      }
      const { receipt } = committed;
      await this.recovered(recovery.originator, receipt.deliveryGeneration, { hostId: recovery.hostId, profileId: recovery.profileId });
      const checked = this.selectRecovery(recovery), ownsRecovery = checked && this.recovery === recovery;
      const advance = (context: UiContextV1 | null): UiContextV1 | null => context && context.hostId === recovery.hostId && context.profileId === recovery.profileId
        ? this.rememberRecoveryContext({ ...context, recoveryGeneration: Math.max(context.recoveryGeneration, recovery.request.expectedRecoveryGeneration + 1),
          ...(context.revision > receipt.selectionRevision || context.selection.deliveryGeneration > receipt.deliveryGeneration ? {} : { revision: receipt.selectionRevision,
            selection: { ...context.selection, revision: receipt.selectionRevision, deliveryGeneration: receipt.deliveryGeneration, selected: { kind: 'builtin' } as const } }) }, this.recoveryContextRevision) : context;
      if (ownsRecovery) {
        this.context = advance(this.context); this.lastContext = advance(this.lastContext);
      } else this.invalidateRecoveryContext(recovery);
      if (this.boundTo(recovery)) {
        const previous = this.recoveryFloor?.hostId === recovery.hostId && this.recoveryFloor.profileId === recovery.profileId ? this.recoveryFloor : null;
        this.recoveryFloor = { hostId: recovery.hostId, profileId: recovery.profileId, generation: Math.max(previous?.generation ?? 0, receipt.deliveryGeneration),
          recoveryGeneration: Math.max(previous?.recoveryGeneration ?? 0, recovery.request.expectedRecoveryGeneration + 1) };
      }
      if (this.pendingReceipt === committed) this.pendingReceipt = null;
      if (this.nativeFallback && sameRecoveryOriginator(this.nativeFallback.originator, recovery.originator)) this.nativeFallback = null;
      if (this.recovery === recovery) {
        if (checked) this.saveRecovery(null);
        else { this.recovery = null; this.recoveryRaw = null; }
      }
      return { kind: ownsRecovery ? 'receipt' : 'retired-receipt', originator: recovery.originator };
    } catch (error) {
      if (committed) throw error;
      if (this.recovery !== recovery) return this.retiredRecovery(recovery);
      if (!this.selectRecovery(recovery)) throw error;
      if (this.recovery !== recovery) return this.retiredRecovery(recovery);
      if (error instanceof UiServiceError) {
        if (!recovery.submitted && (error.code === 'wrong-host' || definitiveRecoveryConflict(error))) this.saveRecovery(null);
        else if (recovery.submitted && definitiveRecoveryConflict(error)) this.saveRecovery({ ...recovery, kind: 'conflicted', reason: `${error.message.slice(0, 800)}. Retry restore to confirm the current generation.` });
      }
      throw error;
    }
  }
  close(): void { this.abort.abort(); this.relay.close(); this.listeners.clear(); }
}
