import { matchesValidatedDelivery } from './ui-connection.js';
import { carriedDraftText, carryRequestEpoch } from './draft-carry-records.js';
import { createBrowserConnection } from '@openpane/client/service';
import { canonicalJson, parseWindowContext, sameScope } from '@openpane/contracts';
import type { ConversationOpenResult, ConversationScope, PlacementTransition, UiContextV1 } from '@openpane/contracts';
import type { AgentDescriptor } from '@openpane/contracts/service';
import { count, identifier, record } from '@openpane/contracts/decode';
import { BrowserViewStorage } from './browser-storage.js';
import { recordNativeEditorOrigin } from './native-editor-origin.js';
import { createApplicationController } from './application-controller.js';
import type { ApplicationController } from './application-controller.js';
import { IndependentDraftsError } from './view-state.js';
import type { ViewStorageFactory } from './view-state.js';
import { ChildUiConnection, NativeMainUiRelay } from './native-ui-relay.js';
import { UiConnection } from './ui-connection.js';
import type { UiTransport, RecoveryResult } from './ui-connection.js';
import type { RecoveryOriginator, UiRecoveryHost } from './ui-recovery.js';
import { sameNativeAttempt, childPlacementResult, DesktopWindowPort, parseNativePlacementIntent, parseNativeReservation, parseEditorRecoveryGrant, parseNativeWindowLookup } from './window-context.js';
import type { DesktopWindowContext, NativePlacementIntent, NativeReservation } from './window-context.js';
import type { DraftCarry } from './draft-carry.js';
import { bindDraftCarry, offerDraftCarry, sourceCarries, targetCarries, cancelDraftCarry, refuseDraftCarry, retryDraftCarry, hostCarries, removeRetainedCarry } from './draft-carry.js';
import { WindowCoordinator } from './window-coordinator.js';
import { PlacementSuperseded, placementReason } from './placement-port.js';

export type WindowRecovery =
  | { readonly kind: 'none' }
  | { readonly kind: 'main'; readonly windows: readonly NativeReservation[]; readonly carries: readonly DraftCarry[]; readonly carriesAfter: IDBValidKey | null; readonly carriesFirstPage: boolean; readonly carryNotice: string | null }
  | { readonly kind: 'chat'; readonly pending: readonly NativePlacementIntent[]; readonly history: readonly NativePlacementIntent[]; readonly after: string | null;
      readonly carries: readonly DraftCarry[] };
export interface WindowRuntimeSnapshot { readonly closing: boolean; readonly canRetryCreation: boolean; readonly recovery: WindowRecovery; readonly catalogOnly: boolean; readonly capabilityNotice: string | null; readonly placementNotice: string | null }
const namespace = (agent: AgentDescriptor): string | null => 'kind' in agent ? agent.namespace : null;
class HostSuperseded extends Error {}
function nativeRecoveryHost(value: Record<string, unknown>): UiRecoveryHost | null {
  if (value.hostId === null && value.profileId === null) return null;
  return { hostId: identifier(value.hostId), profileId: identifier(value.profileId, 200) };
}
type RecoveryObserver = { sequence: number | null; receipt: UiRecoveryHost | null } & (
  | { readonly kind: 'join' }
  | { readonly kind: 'initiating'; host: UiRecoveryHost | null }
);
export class MainUiConnection extends UiConnection {
  private restoration: { readonly sequence: number; readonly host: UiRecoveryHost | null; readonly promise: Promise<RecoveryResult> } | null = null;
  private recoveryAttempt: { readonly sequence: number; readonly host: UiRecoveryHost; readonly basis: Extract<RecoveryResult, { readonly recorded: true }>['basis'] } | null = null;
  private readonly receiptJoins = new Set<RecoveryObserver>();
  private readonly initiatingRestores = new Map<string, Extract<RecoveryObserver, { readonly kind: 'initiating' }>>();
  constructor(private readonly port: DesktopWindowPort) {
    super(new NativeMainUiRelay(port), async context => parseWindowContext(await port.request({ kind: 'bind-ui', hostId: context.hostId, profileId: context.profileId })), port.context.liveRelay);
  }
  protected override async nextPresenceSequence(): Promise<number> {
    const reply = record(await this.port.request({ kind: 'presence', visible: document.visibilityState === 'visible', display: null }), ['presenceSequence']);
    return count(reply.presenceSequence);
  }
  override async restore(expectedHost?: UiRecoveryHost): Promise<void> {
    if (expectedHost && this.recoveryHost(expectedHost.hostId).profileId !== expectedHost.profileId) throw new Error('Appearance recovery belongs to a different host profile');
    const requestId = crypto.randomUUID(), initiating: Extract<RecoveryObserver, { readonly kind: 'initiating' }> = { kind: 'initiating', sequence: null, host: expectedHost ?? null, receipt: null };
    this.initiatingRestores.set(requestId, initiating); this.receiptJoins.add(initiating);
    try {
      const allocation = await this.port.request({ kind: 'restore-builtin', requestId, ...(expectedHost ? { expectedContext: { hostId: expectedHost.hostId, profileId: expectedHost.profileId } } : {}) }).catch((error: unknown) => {
        if (initiating.sequence === null || initiating.receipt === null) throw error;
        return { sequence: initiating.sequence, hostId: initiating.receipt.hostId, profileId: initiating.receipt.profileId };
      });
      const reply = record(allocation, ['sequence', 'hostId', 'profileId']);
      const authority = nativeRecoveryHost(reply), sequence = count(reply.sequence);
      while (this.bindingInFlight) await this.bindingInFlight;
      const recorded = await this.restoreNative(sequence, authority, requestId);
      // Keep the final authority check here: another bind may start while the previous one settles.
      while (this.bindingInFlight) await this.bindingInFlight;
      if (!this.recoveryIsCurrent(initiating.host ?? authority)) throw new Error('Appearance recovery changed hosts. Retry in the current host.');
      if (!recorded) throw new Error(this.getSnapshot().diagnostic ?? 'Appearance recovery could not be recorded. Retry Restore.');
    } finally { this.initiatingRestores.delete(requestId); this.receiptJoins.delete(initiating); }
  }
  private recoveryIsCurrent(host: UiRecoveryHost | null): boolean {
    if (!this.recoveryBindingConfirmed()) return false;
    const delivery = this.getSnapshot().deliveryContext;
    if (host === null || delivery === null) return true;
    const bound = parseWindowContext(JSON.parse(delivery));
    if (bound.hostId !== host.hostId || bound.profileId !== host.profileId) return false;
    try { return this.recoveryHost(host.hostId).profileId === host.profileId; }
    catch { return false; }
  }
  private rememberAttempt(sequence: number, outcome: Extract<RecoveryResult, { readonly recorded: true }>): Extract<RecoveryResult, { readonly recorded: true }> {
    const previous = this.recoveryAttempt;
    const basis = previous?.sequence === sequence && previous.host.hostId === outcome.host.hostId && previous.host.profileId === outcome.host.profileId && previous.basis === 'receipt' ? 'receipt' : outcome.basis;
    for (const join of this.receiptJoins) if (join.sequence === sequence) { if (join.kind === 'initiating') join.host ??= outcome.host; if (basis === 'receipt') join.receipt ??= outcome.host; }
    if (!previous || sequence >= previous.sequence) this.recoveryAttempt = { sequence, host: outcome.host, basis };
    return { ...outcome, basis };
  }
  private async joinedRecoveryResult(sequence: number, result: Promise<RecoveryResult>, exact: boolean, initiating?: Extract<RecoveryObserver, { readonly kind: 'initiating' }>): Promise<boolean> {
    const previous = this.recoveryAttempt;
    const join: RecoveryObserver = { kind: 'join', sequence, receipt: exact && previous?.sequence === sequence && previous.basis === 'receipt' ? previous.host : null };
    if (exact) this.receiptJoins.add(join);
    try {
      const returned = await result;
      const outcome: RecoveryResult = returned.recorded ? returned : exact && join.receipt ? { recorded: true, host: join.receipt, basis: 'receipt' } : returned;
      if (!outcome.recorded) return false;
      if (initiating) initiating.host ??= outcome.host;
      const exactReceipt = () => exact && (outcome.basis === 'receipt' || join.receipt?.hostId === outcome.host.hostId && join.receipt.profileId === outcome.host.profileId);
      return await this.withStableBinding<boolean | { readonly error: unknown }, boolean>({
        read: async () => {
          if (exactReceipt()) return false;
          try {
            const reply = record(await this.port.request({ kind: 'read-recovery-cancellation', sequence }), ['cancelled']);
            if (typeof reply.cancelled !== 'boolean') throw new Error('Invalid native recovery cancellation reply');
            return reply.cancelled;
          } catch (error) { return { error }; }
        },
        terminal: cancelled => typeof cancelled !== 'boolean' || cancelled && !exactReceipt(),
        use: cancelled => {
          const current = this.recoveryIsCurrent(outcome.host);
          if (exactReceipt() && current) return true;
          if (typeof cancelled !== 'boolean') throw cancelled.error;
          return current && !cancelled;
        },
      });
    } finally { this.receiptJoins.delete(join); }
  }
  restoreNative(sequence: number, host: UiRecoveryHost | null, initiator: string | null = null): Promise<boolean> {
    const originator = { kind: 'native' as const, brokerInstance: this.port.context.brokerInstance, sequence };
    const initiating = initiator === null ? undefined : this.initiatingRestores.get(initiator);
    if (initiating) {
      if (initiating.sequence !== null && initiating.sequence !== sequence) return Promise.reject(new Error('Native Restore correlation changed sequence'));
      initiating.sequence = sequence; initiating.host ??= host;
      if (initiating.receipt) {
        const receipt = initiating.receipt;
        if (host && (host.hostId !== receipt.hostId || host.profileId !== receipt.profileId)) return Promise.resolve(false);
        const retainedReceipt = () => this.joinedRecoveryResult(sequence, Promise.resolve({ recorded: true, host: receipt, basis: 'receipt' }), true, initiating);
        const confirmation = this.confirmPendingRecovery(originator, receipt);
        return confirmation ? confirmation.then(recorded => recorded || retainedReceipt()) : retainedReceipt();
      }
    }
    if (!this.recoveryIsCurrent(host)) return Promise.resolve(false);
    const sameHost = (other: UiRecoveryHost | null) => other?.hostId === host?.hostId && other?.profileId === host?.profileId;
    const active = this.restoration, completed = this.recoveryAttempt;
    const agrees = (other: { readonly sequence: number; readonly host: UiRecoveryHost | null }) => sameHost(other.host) || sequence === other.sequence && (host === null || other.host === null);
    if (active && sequence <= active.sequence) {
      if (!agrees(active)) return Promise.resolve(false);
      return this.confirmPendingRecovery(originator, host) ?? this.joinedRecoveryResult(sequence, active.promise, sequence === active.sequence, initiating);
    }
    if (completed && sequence <= completed.sequence) {
      if (!(sameHost(completed.host) || sequence === completed.sequence && host === null) || !this.recoveryIsCurrent(completed.host)) return Promise.resolve(false);
      return this.confirmPendingRecovery(originator, host) ?? this.joinedRecoveryResult(sequence, Promise.resolve({ recorded: true, host: completed.host, basis: completed.basis }), sequence === completed.sequence, initiating);
    }
    const task = (active?.promise.catch(() => {}) ?? Promise.resolve()).then(async () => {
      if (!this.recoveryIsCurrent(host)) return { recorded: false } as const;
      const result = await this.requestRecovery(originator, host);
      if (result.recorded && !this.recoveryIsCurrent(result.host)) return { recorded: false } as const;
      return result.recorded ? this.rememberAttempt(sequence, result) : result;
    }).finally(() => { if (this.restoration?.sequence === sequence) this.restoration = null; });
    this.restoration = { sequence, host, promise: task };
    return this.joinedRecoveryResult(sequence, task, true, initiating);
  }
  private ownsNative(originator: RecoveryOriginator): originator is Extract<RecoveryOriginator, { readonly kind: 'native' }> {
    return originator.kind === 'native' && originator.brokerInstance === this.port.context.brokerInstance;
  }
  protected override async recovering(originator: RecoveryOriginator, host: UiRecoveryHost, submitted: boolean): Promise<'accepted' | 'superseded' | 'cancelled'> {
    if (!this.ownsNative(originator)) return 'accepted';
    let reply: unknown;
    try { reply = await this.port.request({ kind: 'scope-recovery', sequence: originator.sequence, expectedContext: host, submitted }); }
    catch (error) { if (!submitted && error === 'wrong-host') return 'cancelled'; throw error; }
    const result = record(reply, ['admission']);
    if (result.admission !== 'accepted' && result.admission !== 'superseded' && result.admission !== 'cancelled') throw new Error('Invalid native recovery scope reply');
    return result.admission;
  }
  protected override async recovered(originator: RecoveryOriginator, deliveryGeneration: number, host: UiRecoveryHost): Promise<void> {
    if (this.ownsNative(originator)) {
      this.rememberAttempt(originator.sequence, { recorded: true, host, basis: 'receipt' });
      await this.port.request({ kind: 'confirm-recovery', sequence: originator.sequence, deliveryGeneration, expectedContext: host });
    }
  }
}
/** One document owns one controller, and only main owns the host UI reader. */
export class WindowRuntime {
  readonly controller: ApplicationController;
  readonly ui: UiTransport;
  readonly coordinator: WindowCoordinator;
  readonly port: DesktopWindowPort | null;
  private childOwner: BrowserViewStorage | null = null;
  private diagnosticNotice: { readonly reason: string } | null = null;
  private snapshot: WindowRuntimeSnapshot = { closing: false, canRetryCreation: false, recovery: { kind: 'none' }, catalogOnly: false, capabilityNotice: null, placementNotice: null };
  private readonly listeners = new Set<() => void>();
  private readonly cleanups: (() => void)[] = [];
  private started = false;
  private closed = false;
  private processing = false;
  private childReady = false;
  private readonly handledCloseAttempts = new Set<string>();
  private readonly pendingCloseCancellations = new Set<string>();
  private closeWakePending = false;
  private childRefusalReported = false;
  private catalogDirty = false;
  private recoveryDirty = true;
  private readonly requestHistory = new Map<string, NativePlacementIntent>();
  private historyAfter: string | null = null;
  private historyEpoch: number | null = null;
  private historyExtended = false;
  private recoveryTask: Promise<void> | undefined;
  private nativeRecoverySeen: number | null = null;
  private nativeRecoveryTask: Promise<void> | null = null;
  private nativeRecoveryDirty = false;
  private separatePolicy = false;
  private policyDelivery: string | null = null;
  private policyAppliedScope: ConversationScope | null = null;
  private pendingPolicyFailure: { readonly delivery: string; readonly scope: ConversationScope; readonly result: Extract<ConversationOpenResult, { readonly kind: 'refused' }>; readonly transitions: readonly PlacementTransition[] } | null = null;
  private carryHostId: string | null = null;
  private carryRecoveryAfter: IDBValidKey | null = null;
  private carrySettlementAfter: IDBValidKey | null = null;
  private carrySettlementDirty = false;
  private policyScope: ConversationScope | null = null;
  private placingPolicy: { readonly scope: ConversationScope; readonly delivery: string; readonly transitions: readonly PlacementTransition[] } | null = null;
  private readonly pendingIntents = new Map<string, Extract<ConversationOpenResult, { readonly kind: 'pending' }>>();
  private pendingIntent: { readonly requestId: string; readonly result: Extract<ConversationOpenResult, { readonly kind: 'pending' }> } | null = null;
  private lastPlacement: ConversationOpenResult | null = null;
  constructor(readonly context: DesktopWindowContext) {
    this.port = context.role === 'browser' ? null : new DesktopWindowPort(context);
    let catalogViewId = context.role === 'browser' ? sessionStorage.getItem('openpane.catalogViewId') ?? undefined : context.viewId;
    let assigned: (viewId: string) => void = () => {};
    const assignedView = new Promise<string>(resolve => { assigned = resolve; });
    const factory: ViewStorageFactory = {
      ...(context.role !== 'chat' ? { readLegacyDraft: BrowserViewStorage.readLegacyDraft, recoverClosedView: async (viewId: string, onFailure: (error: unknown) => void) => {
        const binding = await BrowserViewStorage.bindingForView(viewId);
        if (binding && this.port) {
          const native = parseNativeWindowLookup(await this.port.request({ kind: 'lookup', scope: binding.scope }), binding.scope);
          if (native.kind === 'opening' || native.kind === 'ready') return null;
        }
        return BrowserViewStorage.reopenForRecovery(viewId, onFailure);
      } } : {}),
      locate: async scope => {
        const located = await BrowserViewStorage.locateEditor(scope);
        if (located.binding) return located.binding.viewId;
        if (located.legacyViewIds.length > 1) throw new IndependentDraftsError(located.legacyViewIds);
        return located.legacyViewIds[0] ?? null;
      },
      get catalogViewId() { return context.role === 'chat' ? undefined : catalogViewId; },
      open: async onFailure => {
        let owner: BrowserViewStorage;
        if (context.role === 'browser') owner = await BrowserViewStorage.open(onFailure, 'openpane.catalogViewId');
        else if (context.role === 'main') owner = await BrowserViewStorage.reopen(context.viewId, onFailure, { waitForPreviousDocument: true, catalog: true });
        else {
          const reserved = context.reservation;
          owner = await BrowserViewStorage.claimEditor({ scope: reserved.scope, viewId: reserved.viewId, label: reserved.label,
            transitionId: reserved.transitionId, creation: reserved.creationAgentId === null ? null : { agentId: reserved.creationAgentId } }, onFailure);
          this.childOwner = owner;
        }
        catalogViewId = owner.viewId; assigned(owner.viewId); return owner;
      },
      reopen: async (viewId, onFailure, options) => {
        if (context.role === 'chat') throw new Error('This window is fixed to its assigned conversation.');
        const binding = await BrowserViewStorage.bindingForView(viewId);
        if (!binding) return BrowserViewStorage.reopen(viewId, onFailure);
        if (this.port) {
          const native = parseNativeWindowLookup(await this.port.request({ kind: 'lookup', scope: binding.scope }), binding.scope);
          if (native.kind === 'opening' || native.kind === 'ready') {
            await this.port.request({ kind: 'launch', scope: binding.scope, existingOnly: true, geometry: { width: 640, height: 720, titlebar: 'native', title: 'Chat' } }).catch(() => {});
            throw new Error('This saved chat is already open in its native window. Continue editing there.');
          }
        }
        const label = context.role === 'main' ? context.label : browserLabel();
        if (binding.kind === 'handoff-reserved' && binding.targetLabel !== label) throw new Error('This saved view is reserved for its recorded chat window. Open that chat from the catalog.');
        return BrowserViewStorage.claimEditor({ scope: binding.scope, viewId, label,
          transitionId: binding.kind === 'handoff-reserved' ? binding.transitionId : null, creation: null, ...(options?.purpose ? { purpose: options.purpose } : {}) }, onFailure);
      },
    };
    const browserLabel = () => `browser:${catalogViewId ?? 'unassigned'}`;
    this.coordinator = new WindowCoordinator(this.port, browserLabel);
    this.controller = createApplicationController({ createConnection: createBrowserConnection, ownedViewStorage: factory,
      createId: () => crypto.randomUUID(), placement: this.coordinator, ...(context.role === 'chat' ? { fixedScope: context.reservation.scope } : {}) });
    if (this.port && context.role === 'chat') this.ui = new ChildUiConnection(this.port);
    else if (this.port) this.ui = new MainUiConnection(this.port);
    else {
      const incarnation = crypto.randomUUID();
      this.ui = new UiConnection(undefined, async (ui: UiContextV1) => {
        const viewId = await assignedView;
        return { role: 'main', profileId: ui.profileId, hostId: ui.hostId, viewId, brokerInstance: `browser:${viewId}`, label: browserLabel(), documentIncarnation: incarnation };
      });
    }
  }
  private configurePlacementTracking(): void {
    this.coordinator.observeNotice(reason => { this.diagnosticNotice = { reason }; this.update({ placementNotice: reason }); });
    this.coordinator.observeIntent((result, requestId) => { if (result.kind === 'pending') this.pendingIntents.set(requestId, result); this.pendingIntent = result.kind === 'pending' ? { requestId, result } : null; this.recoveryDirty = true; this.update({ placementNotice: result.kind === 'pending' || result.kind === 'refused' ? result.reason : null }); });
    this.coordinator.captureCarry(async (requestId, sourceScope, emptyOnly) => {
      if (this.context.role === 'main' && sourceScope) {
        const existing = (await sourceCarries(sourceScope)).find(carry => carry.requestId === requestId);
        if (existing?.kind === 'cancelled' || existing?.kind === 'settled') return null;
        const captured = await this.controller.capturePlacementDraft(sourceScope);
        if (!captured?.text) return null;
        const binding = await BrowserViewStorage.bindingForView(captured.viewId);
        if (!binding) { captured.recover(); return null; }
        if (binding.kind !== 'editing' || !sameScope(binding.scope, sourceScope)) throw new Error('The original draft editor changed. Reopen it before carrying its text.');
        if (existing?.kind === 'refused') await retryDraftCarry(sourceScope, requestId, binding.viewId, binding.writerGeneration);
        else await offerDraftCarry({ source: sourceScope, sourceViewId: binding.viewId, requestId, writerGeneration: binding.writerGeneration,
          ...((emptyOnly ?? true) ? { emptyOnly: true } : {}), expected: { text: captured.text, revision: captured.revision } });
        return { cancel: () => refuseDraftCarry((existing ?? { version: 1, kind: 'offered', source: sourceScope, sourceViewId: binding.viewId, requestId,
          expected: { text: captured.text, revision: captured.revision }, target: null })) };
      }
      const active = this.controller.getSnapshot().active, binding = this.childOwner?.editorBinding();
      if (this.context.role !== 'chat' || !active || !binding || active.viewId !== this.childOwner?.viewId || !sameScope(active.scope, this.context.reservation.scope)) throw new Error('The source editor is not ready to carry its draft.');
      const expected = await active.store.captureDraft();
      if (!expected.text) return null;
      await offerDraftCarry({ source: active.scope, sourceViewId: active.viewId, requestId, writerGeneration: binding.writerGeneration, ...(emptyOnly ? { emptyOnly } : {}), expected });
      return { cancel: () => this.refuseOfferedCarry(requestId, { unboundOnly: true }) };
    });
    this.coordinator.observeReady(reservation => this.settleReadyPlacements(reservation));
    this.coordinator.trackPlacement(async (reservation, binding) => {
      const attempt = this.placingPolicy;
      if (!(this.ui instanceof UiConnection) || !attempt || !sameScope(attempt.scope, reservation.scope)) return;
      for (const transition of attempt.transitions) {
        if (!this.policyIsCurrent(attempt.delivery, attempt.scope)) throw new PlacementSuperseded();
        await this.ui.reservePlacement(transition, {
        scope: reservation.scope, viewId: reservation.viewId, label: reservation.label,
        nativeTransitionId: reservation.transitionId, bindingRevision: binding.revision,
        });
      }
    });
  }
  getSnapshot = (): WindowRuntimeSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<WindowRuntimeSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    if (Object.keys(next).every(key => Reflect.get(next, key) === Reflect.get(this.snapshot, key))) return;
    this.snapshot = next; for (const listener of this.listeners) listener();
  }
  start(): void {
    if (this.started) return; this.started = true; this.configurePlacementTracking();
    this.cleanups.push(this.controller.subscribe(() => {
      this.uiChanged();
      if (!this.processing) void this.drive();
    }));
    this.cleanups.push(this.ui.subscribe(this.uiChanged)); this.uiChanged();
    if (this.port) for (const event of ['openpane-ui-wakeup', 'openpane-placement-intent', 'openpane-close-requested'] as const) {
      void this.port.listen(event, () => {
        if (event === 'openpane-close-requested') void this.closeWake();
        else { this.recoveryDirty = true; if (this.context.role === 'main') this.carrySettlementDirty = true; if (event === 'openpane-ui-wakeup') { this.catalogDirty = true; void this.recoveryWake(); } void this.drive(); }
      }).then(unlisten => {
        if (this.closed) { unlisten(); return; }
        this.cleanups.push(unlisten);
        if (event === 'openpane-ui-wakeup') void this.recoveryWake();
        if (event === 'openpane-close-requested') void this.closeWake();
      }, error => this.update({ placementNotice: String(error) }));
    }
    this.ui.start();
    const initialUi = this.context.role === 'main' ? new Promise<void>(resolve => {
      const ready = () => { const state = this.ui.getSnapshot(); if (state.state || state.diagnostic) { unsubscribe(); resolve(); } };
      const unsubscribe = this.ui.subscribe(ready); ready();
    }) : Promise.resolve();
    void initialUi.then(() => this.closed ? undefined : this.controller.start()).then(() => this.drive());
  }
  private hostIsCurrent(hostId: string): boolean {
    if (this.context.role === 'chat') return this.context.reservation.scope.hostId === hostId;
    const host = this.controller.getSnapshot().host;
    return ('metadata' in host ? host.metadata.hostId : this.carryHostId) === hostId;
  }
  private requireHost(hostId: string): void {
    if (!this.hostIsCurrent(hostId)) throw new HostSuperseded();
  }
  private async hostStep<T>(hostId: string, pending: Promise<T>): Promise<T> {
    try { const value = await pending; this.requireHost(hostId); return value; }
    catch (error) { this.requireHost(hostId); throw error; }
  }
  private updateForHost(hostId: string, patch: Partial<WindowRuntimeSnapshot>): void {
    if (this.hostIsCurrent(hostId)) this.update(patch);
  }
  private reportFailure(error: unknown, reason = String(error), hostId?: string): void {
    if (!(error instanceof HostSuperseded) && (hostId === undefined || this.hostIsCurrent(hostId))) this.update({ placementNotice: reason });
  }
  private policyBelongsToHost(context: string | null): boolean {
    const host = this.controller.getSnapshot().host;
    if (host.kind !== 'ready' || context === null) return false;
    try { return parseWindowContext(JSON.parse(context)).hostId === host.metadata.hostId; }
    catch { return false; }
  }
  private discardPolicy(): void {
    this.policyScope = null; this.policyAppliedScope = null; this.placingPolicy = null;
    this.policyDelivery = null; this.separatePolicy = false; this.pendingPolicyFailure = null;
    this.coordinator.setPresentation(null, () => false);
    this.update({ catalogOnly: false, capabilityNotice: null });
  }
  private confirmedPolicyDelivery(): string | null {
    const current = this.ui.getSnapshot();
    if (!this.policyBelongsToHost(current.deliveryContext) || !current.state || current.localBuiltin || current.confirmedGeneration !== current.state.selection.deliveryGeneration || !matchesValidatedDelivery(current.validatedVisual, current.state, current.deliveryContext)) return null;
    return JSON.stringify([current.deliveryContext, current.state.selection.deliveryGeneration, current.state.selection.revision, current.state.bundle?.digest]);
  }
  private policyIsCurrent(delivery: string | null, scope?: ConversationScope): boolean {
    return this.confirmedPolicyDelivery() === delivery && this.policyDelivery === delivery
      && (scope === undefined || this.policyScope !== null && sameScope(this.policyScope, scope));
  }
  private async retryPolicyFailure(hostId: string): Promise<void> {
    const failure = this.pendingPolicyFailure;
    if (!failure || !(this.ui instanceof UiConnection)) return;
    for (const transition of failure.transitions) {
      if (this.pendingPolicyFailure !== failure || !this.policyIsCurrent(failure.delivery)) return;
      try { await this.hostStep(hostId, this.ui.failPlacement(transition, failure.result.reason)); }
      catch (error) {
        if (this.pendingPolicyFailure === failure && this.policyIsCurrent(failure.delivery)) this.reportFailure(error, undefined, hostId);
        return;
      }
    }
    if (this.pendingPolicyFailure !== failure || !this.policyIsCurrent(failure.delivery)) return;
    this.pendingPolicyFailure = null;
    if (this.controller.getSnapshot().lastPlacement === failure.result) this.updateForHost(hostId, { placementNotice: failure.result.reason });
  }
  private uiChanged = (): void => {
    const current = this.controller.getSnapshot(), result = current.lastPlacement;
    if (this.context.role === 'main' && 'metadata' in current.host) this.retargetHost(current.host.metadata.hostId);
    if (result !== this.lastPlacement) {
      this.lastPlacement = result;
      if (!this.processing || result?.kind === 'refused' || result?.kind === 'detached') this.recoveryDirty = true;
      if (this.policyScope && result && result.kind !== 'refused' && result.scope && !sameScope(this.policyScope, result.scope)
        && (!current.active || !sameScope(current.active.scope, this.policyScope))) {
        this.policyAppliedScope = this.policyScope;
        this.policyScope = null;
      }
    }
    if (this.context.role === 'main') void this.recoveryWake();
    if (current.host.kind !== 'ready') return;
    const state = this.ui.getSnapshot();
    const builtin = state.validatedVisual.kind === 'local-builtin';
    if (!builtin && !this.policyBelongsToHost(state.deliveryContext)) { this.discardPolicy(); return; }
    if (!builtin && (!state.state || state.localBuiltin || !matchesValidatedDelivery(state.validatedVisual, state.state, state.deliveryContext))) return;
    const presentation = builtin ? null : state.state?.bundle?.manifest.presentation ?? null;
    const separate = presentation?.chats === 'separate';
    const supported = this.context.role === 'main' && this.context.liveRelay;
    const active = this.controller.getSnapshot().active;
    const catalogOnly = separate && supported && !active;
    const confirmed = this.confirmedPolicyDelivery();
    if (builtin || confirmed) this.coordinator.setPresentation(presentation, () => builtin || this.confirmedPolicyDelivery() === confirmed);
    const delivery = builtin || !state.state ? null : JSON.stringify([state.deliveryContext, state.state.selection.deliveryGeneration, state.state.selection.revision, state.state.bundle?.digest]);
    if (this.policyDelivery !== delivery) { this.policyDelivery = delivery; this.policyAppliedScope = null; this.pendingPolicyFailure = null; if (this.processing) this.recoveryDirty = true; }
    this.separatePolicy = separate && supported;
    if (!this.separatePolicy) { this.policyScope = null; this.policyAppliedScope = null; }
    else {
      const pending = this.controller.getSnapshot().lastPlacement;
      const hostId = current.host.kind === 'ready' ? current.host.metadata.hostId : null;
      const reserved = state.state?.transitions.find(transition => transition.slot.target?.scope.hostId === hostId)?.slot.target?.scope;
      const scope = [reserved, active?.scope, pending?.kind === 'pending' ? pending.scope : null].find(candidate => candidate?.hostId === hostId);
      if (scope && (!this.policyAppliedScope || !sameScope(this.policyAppliedScope, scope))) this.policyScope = scope;
    }
    this.update({ catalogOnly, capabilityNotice: separate && this.context.role !== 'chat' && !supported
      ? 'Separate chat windows require a supported desktop launcher. Chats stay inline here.' : null });
    if (!this.processing) void this.drive();
  };
  private recoveryWake(): Promise<void> {
    if (!this.port || this.context.role !== 'main' || !(this.ui instanceof MainUiConnection)) return Promise.resolve();
    const port = this.port, ui = this.ui;
    this.nativeRecoveryDirty = true;
    const attempt: { declined: { readonly sequence: number; readonly binding: string | null } | null } = { declined: null };
    return this.nativeRecoveryTask ??= (async () => {
      do {
        this.nativeRecoveryDirty = false;
        for (;;) {
          const state = record(await port.request({ kind: 'read-recovery' }), ['pending', 'sequence', 'hostId', 'profileId', 'initiator']);
          if (typeof state.pending !== 'boolean') throw new Error('Invalid native recovery state');
          const sequence = count(state.sequence);
          if (!state.pending) { this.nativeRecoverySeen = null; break; }
          const binding = ui.getSnapshot().deliveryContext;
          if (this.nativeRecoverySeen === sequence && (attempt.declined?.sequence !== sequence || attempt.declined.binding === binding)) break;
          this.nativeRecoverySeen = sequence;
          if (!await ui.restoreNative(sequence, nativeRecoveryHost(state), state.initiator == null ? null : identifier(state.initiator, 200))) { attempt.declined = { sequence, binding }; break; }
          attempt.declined = null;
        }
      } while (this.nativeRecoveryDirty);
    })().catch(error => { this.update({ placementNotice: String(error) }); }).finally(() => {
      if (this.nativeRecoverySeen === attempt.declined?.sequence) this.nativeRecoverySeen = null;
      this.nativeRecoveryTask = null;
      if (this.nativeRecoveryDirty && !this.closed) return this.recoveryWake();
    });
  }
  private async closeWake(): Promise<void> {
    if (!this.port || this.closed) return;
    try {
      const state = record(await this.port.request({ kind: 'read-close' }), ['pending', 'attemptId']);
      if (typeof state.pending !== 'boolean' || (state.pending ? typeof state.attemptId !== 'string' || !state.attemptId : state.attemptId !== null)) throw new Error('Invalid native close state');
      if (state.pending && typeof state.attemptId === 'string' && !this.closed) await this.closeWindow(state.attemptId);
    } catch (error) { this.reportFailure(error); }
  }
  private async closeWindow(attemptId: string): Promise<void> {
    if (!this.port || this.closed) return;
    if (this.snapshot.closing) { this.closeWakePending = true; return; }
    if (this.handledCloseAttempts.has(attemptId)) {
      if (this.pendingCloseCancellations.has(attemptId)) await this.cancelClose(attemptId);
      return;
    }
    this.handledCloseAttempts.add(attemptId);
    this.update({ closing: true });
    let saved = false;
    try { await this.controller.prepareClose(); saved = true; await this.controller.dispose(); await this.port.request({ kind: 'close-ready', attemptId }); }
    catch (error) {
      await this.cancelClose(attemptId);
      if (saved) {
        this.update({ placementNotice: `The saved editor is reopening after its window cleanup failed: ${String(error)}` });
        window.location.reload();
      } else this.update({ placementNotice: `Saving this window failed: ${String(error)}. Copy any unsaved text before using Close Chat Without Saving or Quit Without Saving in the Recovery menu.` });
    } finally {
      this.update({ closing: false });
      const reread = this.closeWakePending && !saved && !this.closed;
      this.closeWakePending = false;
      if (reread) queueMicrotask(() => { void this.closeWake(); });
    }
  }
  private async cancelClose(attemptId: string): Promise<void> {
    if (!this.port) return;
    this.pendingCloseCancellations.delete(attemptId);
    try { await this.port.request({ kind: 'close-cancelled', attemptId }); }
    catch { this.pendingCloseCancellations.add(attemptId); }
  }
  private retargetHost(hostId: string): void {
    if (this.carryHostId === hostId) return;
    const changed = (this.carryHostId ?? null) !== null;
    this.carryHostId = hostId;
    this.carryRecoveryAfter = null;
    this.carrySettlementAfter = null;
    this.carrySettlementDirty = false;
    if (changed) {
      this.recoveryDirty = true;
      this.discardPolicy();
      this.lastPlacement = null; this.pendingIntent = null; this.diagnosticNotice = null;
      this.update({ recovery: { kind: 'none' }, placementNotice: null });
    }
  }
  private async drive(): Promise<void> {
    if (this.processing || this.closed) return;
    const state = this.controller.getSnapshot();
    if (state.busy || state.host.kind !== 'ready' || state.storageFailure) return;
    const hostId = state.host.metadata.hostId;
    if (this.context.role === 'main') this.retargetHost(hostId);
    const settlementBefore = this.carrySettlementAfter ?? null;
    if (this.context.role === 'main' && settlementBefore === null) this.carrySettlementDirty = false;
    this.processing = true;
    try {
      if (this.recoveryDirty || this.context.role === 'main' && state.lastPlacement?.kind === 'pending') { this.recoveryDirty = false; await this.hostStep(hostId, this.refreshRecovery()); }
      if (this.context.role === 'chat') {
        if (state.saved.pendingCreation && !this.childReady) await this.hostStep(hostId, this.controller.recoverCreation());
        await this.hostStep(hostId, this.syncDraftCarries()).catch(error => { if (error instanceof HostSuperseded) throw error; this.reportFailure(error, undefined, hostId); });
        const current = this.controller.getSnapshot(), binding = this.childOwner?.editorBinding();
        if (!this.childReady && !this.childRefusalReported && !current.active && !current.saved.pendingCreation && current.error && this.context.reservation.creationAgentId) {
          await this.hostStep(hostId, this.port?.request({ kind: 'creation-refused' }) ?? Promise.resolve()); this.childRefusalReported = true; this.update({ canRetryCreation: true });
        }
        if (!this.childReady && current.host.kind === 'ready' && !current.storageFailure && !current.saved.pendingCreation && current.active && binding?.kind === 'editing' && sameScope(current.active.scope, this.context.reservation.scope)) {
          await this.hostStep(hostId, recordNativeEditorOrigin(binding, this.context.label));
          await this.hostStep(hostId, this.port?.request({ kind: 'ready', binding, visible: document.visibilityState === 'visible' }) ?? Promise.resolve());
          this.childReady = true; if (this.ui instanceof ChildUiConnection) this.ui.refresh();
        }
        return;
      }
      await this.hostStep(hostId, this.syncDraftCarries()).catch(error => { if (error instanceof HostSuperseded) throw error; this.reportFailure(error, undefined, hostId); });
      const delivery = this.confirmedPolicyDelivery();
      await this.retryPolicyFailure(hostId);
      if (this.policyScope && delivery && delivery === this.policyDelivery) {
        const current = this.controller.getSnapshot();
        if (current.busy || current.host.kind !== 'ready' || current.host.metadata.hostId !== hostId || current.storageFailure) return;
        const scope = this.policyScope;
        const attempt = { scope, delivery, transitions: (this.ui.getSnapshot().state?.transitions ?? []).filter(transition => !transition.slot.target || sameScope(transition.slot.target.scope, scope)) };
        this.policyAppliedScope = scope;
        this.placingPolicy = attempt;
        const diagnosticBeforePlacement = this.diagnosticNotice;
        let placed: ConversationOpenResult;
        try { placed = await this.hostStep(hostId, this.coordinator.withPlacementGuard(scope, () => this.policyIsCurrent(delivery, scope), () => this.controller.openReserved(scope, undefined, 'passive'))); } finally { this.placingPolicy = null; }
        if (this.policyIsCurrent(delivery, scope)) {
          if (placed.kind === 'detached' || placed.kind === 'pending') this.policyScope = null;
          else if (placed.kind === 'refused') {
            this.policyScope = null;
            this.pendingPolicyFailure = { delivery, scope, result: placed, transitions: attempt.transitions };
            await this.retryPolicyFailure(hostId);
          }
          if (placed.kind === 'pending') this.updateForHost(hostId, { placementNotice: placed.reason });
          else if (placed.kind !== 'refused' && this.diagnosticNotice === diagnosticBeforePlacement) this.updateForHost(hostId, { placementNotice: null });
        }
      }
      if (!this.port) return;
      if (delivery && this.policyIsCurrent(delivery) && !this.policyScope && !this.pendingPolicyFailure && !this.controller.getSnapshot().active && !this.controller.getSnapshot().saved.pendingCreation && this.ui instanceof UiConnection) {
        for (const transition of this.ui.getSnapshot().state?.transitions ?? []) {
          if (!this.policyIsCurrent(delivery)) break;
          if (!transition.slot.target) await this.hostStep(hostId, this.ui.idlePlacement(transition).catch(() => {}));
        }
      }
      if (this.catalogDirty) { this.catalogDirty = false; await this.hostStep(hostId, this.controller.refreshCatalog()); }
      const value = await this.hostStep(hostId, this.port.request({ kind: 'pending-intents' }));
      if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid native intent queue');
      for (const raw of value) await this.hostStep(hostId, this.processIntent(parseNativePlacementIntent(raw)));
    } catch (error) { if (!(error instanceof PlacementSuperseded)) this.reportFailure(error, error instanceof Error ? error.message : String(error), hostId); }
    finally { this.finishProcessing(settlementBefore); }
  }
  private finishProcessing(settlementBefore: IDBValidKey | null, catalogPending = false): void {
    this.processing = false;
    const settlementAfter = this.carrySettlementAfter ?? null;
    const moreCarries = this.context.role === 'main' && settlementAfter !== null && (settlementBefore === null || indexedDB.cmp(settlementAfter, settlementBefore) > 0);
    const rescanCarries = this.context.role === 'main' && settlementAfter === null && this.carrySettlementDirty;
    if ((catalogPending || this.recoveryDirty || moreCarries || rescanCarries) && !this.closed) queueMicrotask(() => { void this.drive(); });
  }
  private async readIntent(intent: NativePlacementIntent): Promise<NativePlacementIntent | null> {
    const value = await this.port?.request({ kind: 'read-intent', sourceScope: intent.sourceScope, requestId: intent.requestId });
    if (value === null) return null;
    const saved = parseNativePlacementIntent(value);
    if (saved.requestId !== intent.requestId || !sameScope(saved.sourceScope, intent.sourceScope)) throw new Error('Foreign native request result');
    return saved;
  }
  private async completeReadyIntent(intent: NativePlacementIntent, ready: NativeReservation): Promise<void> {
    if (!this.port || !this.hostIsCurrent(intent.sourceScope.hostId)) return;
    const hostId = intent.sourceScope.hostId;
    if (intent.action.carry) await this.hostStep(hostId, bindDraftCarry(intent.sourceScope, intent.requestId, ready.scope));
    await this.hostStep(hostId, this.port.request({ kind: 'launch', scope: ready.scope, existingOnly: true, geometry: { width: 640, height: 720, titlebar: 'native', title: 'Chat' } }).catch(() => {}));
    await this.hostStep(hostId, this.port.request({ kind: 'complete-intent', sourceScope: intent.sourceScope, requestId: intent.requestId, result: { kind: 'detached', scope: ready.scope, label: ready.label } }));
    this.updateForHost(hostId, { placementNotice: null });
    if (intent.action.carry) await this.hostStep(hostId, this.syncDraftCarries()).catch(error => this.reportFailure(error, placementReason(error), hostId));
  }
  private async processIntent(intent: NativePlacementIntent): Promise<void> {
    if (!this.port || !this.hostIsCurrent(intent.sourceScope.hostId)) return;
    const hostId = intent.sourceScope.hostId;
    const saved = await this.hostStep(hostId, this.readIntent(intent)).catch(error => { this.reportFailure(error, placementReason(error), hostId); return null; });
    if (!saved || saved.result || !this.hostIsCurrent(hostId)) return;
    intent = saved;
    if (saved.target?.phase === 'target-ready') { await this.completeReadyIntent(saved, saved.target).catch(error => this.reportFailure(error, placementReason(error), hostId)); return; }
    const intentRef = { sourceScope: intent.sourceScope, requestId: intent.requestId };
    const state = this.controller.getSnapshot(); if (state.host.kind !== 'ready' || state.busy) return;
    const diagnosticBeforePlacement = this.diagnosticNotice;
    let result: ConversationOpenResult;
    try {
      const source = await this.hostStep(hostId, this.controller.inspectConversation(intent.sourceScope));
      if (!source.agent) throw new Error('The source conversation is unavailable.');
      if (intent.action.kind === 'create') {
        const agentId = intent.action.agentId, targetAgent = state.host.metadata.agents.find(agent => agent.id === agentId);
        if (!targetAgent || namespace(targetAgent) !== namespace(source.agent)) throw new Error('The requested agent belongs to another namespace.');
      } else {
        let scope = intent.sourceScope, confirmed = sameScope(scope, intent.action.scope);
        for (let hop = 0; !confirmed && hop < 64; hop++) {
          const view = sameScope(scope, intent.sourceScope) ? source : await this.hostStep(hostId, this.controller.inspectConversation(scope));
          if (view.continuation.successor?.kind !== 'confirmed') break;
          scope = view.continuation.successor.scope; confirmed = sameScope(scope, intent.action.scope);
        }
        if (!confirmed) throw new Error('The requested chat is not a confirmed successor of this window.');
      }
      let target = intent.target;
      if (!target) {
        const scope = intent.action.kind === 'open' ? intent.action.scope : { hostId: intent.sourceScope.hostId, conversationId: crypto.randomUUID() };
        const located = await this.hostStep(hostId, BrowserViewStorage.locateEditor(scope)), viewId = located.binding?.viewId ?? null;
        let assigned: NativePlacementIntent;
        try {
          assigned = parseNativePlacementIntent(await this.hostStep(hostId, this.port.request({ kind: 'assign-intent', sourceScope: intent.sourceScope, requestId: intent.requestId,
            scope, viewId, creationAgentId: intent.action.kind === 'create' ? intent.action.agentId : null,
            currentBinding: located.binding?.kind === 'editing' ? located.binding : null })));
        } catch (error) {
          if (error instanceof HostSuperseded) return;
          const recorded = await this.hostStep(hostId, this.readIntent(intent).catch(() => null));
          if (!recorded || recorded.result) { this.reportFailure(error, placementReason(error), hostId); return; }
          if (!recorded.target) throw error;
          assigned = recorded;
        }
        target = assigned.target;
        if (!target) throw new Error('Main did not persist the target allocation.');
      }
      if (target.phase === 'target-ready') { await this.completeReadyIntent(intent, target).catch(error => this.reportFailure(error, placementReason(error), hostId)); return; }
      const currentTarget = parseNativeWindowLookup(await this.hostStep(hostId, this.port.request({ kind: 'lookup', scope: target.scope })), target.scope);
      const pending = this.controller.getSnapshot().saved.pendingCreation;
      const assigned = target, current = currentTarget.kind === 'ready' || currentTarget.kind === 'closed' ? currentTarget.reservation : null;
      const ready = [target, current].find(candidate => candidate?.phase === 'target-ready'
        && sameNativeAttempt(candidate, assigned));
      const failedCreation = intent.action.kind === 'create' && assigned.creationAgentId !== null;
      if (!ready && (currentTarget.kind === 'opening' || currentTarget.kind === 'closed' && failedCreation) && currentTarget.reservation.phase === 'failed' && sameNativeAttempt(currentTarget.reservation, assigned)) throw new Error(failedCreation
        ? 'Creation was refused in its assigned window. Open that window to review its saved text and retry the same creation.'
        : 'The assigned chat could not be opened. Retry its saved window; its unsent draft is preserved.');
      if (ready) { await this.completeReadyIntent(intent, ready).catch(error => this.reportFailure(error, placementReason(error), hostId)); return; }
      if (intent.action.carry) {
        try { await this.hostStep(hostId, bindDraftCarry(intent.sourceScope, intent.requestId, target.scope)); }
        catch (error) { this.reportFailure(error, placementReason(error), hostId); return; }
      }
      if (pending && sameScope(pending.scope, target.scope)) {
        const recovered = await this.hostStep(hostId, this.controller.recoverCreation(undefined, intentRef));
        const active = this.controller.getSnapshot().active;
        result = recovered ?? (active && sameScope(active.scope, target.scope) ? { kind: 'inline', scope: target.scope } : { kind: 'pending', scope: target.scope, reason: 'The saved creation still needs confirmation.' });
      } else if (intent.action.kind === 'create') {
        const existing = await this.hostStep(hostId, this.controller.inspectConversation(target.scope));
        if (existing.agent && existing.agent.id !== intent.action.agentId) throw new Error('The reserved scope belongs to a different agent.');
        result = existing.agent ? await this.hostStep(hostId, this.controller.openReserved(target.scope, intentRef)) : await this.hostStep(hostId, this.controller.createReserved(target.scope, intent.action.agentId, intentRef));
      } else result = await this.hostStep(hostId, this.controller.openReserved(target.scope, intentRef, intent.action.passive ? 'passive' : undefined));
    } catch (error) { if (error instanceof HostSuperseded) return; result = { kind: 'refused', reason: placementReason(error) }; }
    if (result.kind === 'refused') result = { ...result, reason: placementReason(result.reason) };
    if (result.kind === 'refused' && this.controller.getSnapshot().busy) return;
    if (result.kind === 'pending') { this.updateForHost(hostId, { placementNotice: result.reason }); return; }
    await this.hostStep(hostId, this.port.request({ kind: 'complete-intent', sourceScope: intent.sourceScope, requestId: intent.requestId, result }));
    if (result.kind === 'refused') this.updateForHost(hostId, { placementNotice: result.reason });
    else if (this.diagnosticNotice === diagnosticBeforePlacement) this.updateForHost(hostId, { placementNotice: null });
    if (result.kind === 'inline') await this.hostStep(hostId, this.syncDraftCarries()).catch(error => this.reportFailure(error, placementReason(error), hostId));
  }
  private settleReadyPlacements(reservation: NativeReservation): void {
    if (this.context.role !== 'main') return;
    const host = this.controller.getSnapshot().host;
    if (host.kind !== 'ready' || host.metadata.hostId !== reservation.scope.hostId) return;
    for (const pending of this.controller.pendingPlacements()) {
      const expected = this.coordinator.pendingReservation(pending);
      if (!expected || !sameNativeAttempt(expected, reservation)) continue;
      if (this.controller.settlePlacement(pending, { kind: 'detached', scope: reservation.scope, label: reservation.label })) {
        if (this.policyScope && sameScope(this.policyScope, reservation.scope)) this.policyScope = null;
        if (this.snapshot.placementNotice === pending.reason) this.update({ placementNotice: null });
      }
    }
  }
  private serializeRecovery<T>(operation: () => Promise<T>): Promise<T> {
    const task = (this.recoveryTask ?? Promise.resolve()).then(operation);
    this.recoveryTask = task.then(() => {}, () => {});
    return task;
  }
  private refreshRecovery(after: string | null = null, append = false): Promise<void> {
    return this.serializeRecovery(() => this.readRecovery(after, append));
  }
  private async readRecovery(after: string | null = null, append = false): Promise<void> {
    if (!this.port) return;
    if (this.context.role === 'main') {
      const state = this.controller.getSnapshot();
      if (state.host.kind !== 'ready') return;
      const hostId = state.host.metadata.hostId;
      this.retargetHost(hostId);
      const value = await this.hostStep(hostId, this.port.request({ kind: 'reservations' }));
      this.requireHost(hostId);
      if (!Array.isArray(value) || value.length > 512) throw new Error('Invalid native recovery inventory');
      let carries: readonly DraftCarry[] = [], carriesAfter: IDBValidKey | null = null, carryNotice: string | null = null;
      try { if (hostId) { const page = await this.hostStep(hostId, hostCarries(hostId, this.carryRecoveryAfter)); this.requireHost(hostId); carries = page.carries; carriesAfter = page.after; if (page.unreadable) carryNotice = 'Some saved transfer records cannot be read. Other chats remain available; original records are preserved.'; } }
      catch (error) { if (error instanceof HostSuperseded) return; carryNotice = 'Saved draft transfer history could not be read. Original drafts are preserved.'; }
      this.updateForHost(hostId, { recovery: { kind: 'main', windows: value.map(parseNativeReservation).filter(window => window.scope.hostId === hostId), carries, carriesAfter, carriesFirstPage: this.carryRecoveryAfter === null, carryNotice } });
      for (const pending of this.controller.pendingPlacements()) {
        if (pending.scope?.hostId !== hostId) continue;
        let native: ReturnType<typeof parseNativeWindowLookup>;
        try { native = parseNativeWindowLookup(await this.hostStep(hostId, this.port.request({ kind: 'lookup', scope: pending.scope })), pending.scope); }
        catch (error) { if (error instanceof HostSuperseded) return; this.reportFailure(error, placementReason(error), hostId); continue; }
        this.requireHost(hostId);
        const expected = this.coordinator.pendingReservation(pending);
        const matches = expected && native.kind !== 'absent' && sameNativeAttempt(expected, native.reservation);
        if (matches && (native.kind === 'opening' || native.kind === 'closed') && native.reservation.phase === 'failed') {
          const result = { kind: 'refused', reason: expected.creationAgentId === null ? 'The assigned chat could not be opened. Retry its saved window; its unsent draft is preserved.' : 'The assigned chat could not be created. Open its saved window to review the refusal; its unsent draft is preserved.' } as const;
          const delivery = this.confirmedPolicyDelivery();
          if (delivery && this.policyIsCurrent(delivery) && this.ui instanceof UiConnection) for (const transition of this.ui.getSnapshot().state?.transitions ?? []) {
            if (!this.policyIsCurrent(delivery)) break;
            if (transition.slot.target && sameScope(transition.slot.target.scope, pending.scope)) {
              try { await this.hostStep(hostId, this.ui.failPlacement(transition, result.reason)); }
              catch (error) { if (this.policyIsCurrent(delivery)) throw error; break; }
            }
          }
          this.requireHost(hostId);
          if (this.controller.settlePlacement(pending, result) && this.policyIsCurrent(delivery)) {
            if (this.policyScope && sameScope(this.policyScope, pending.scope)) this.policyScope = null;
            this.updateForHost(hostId, { placementNotice: result.reason });
          }
        }
        if (matches && (native.kind === 'ready' || native.kind === 'closed' && native.reservation.phase === 'target-ready')) this.settleReadyPlacements(native.reservation);
      }
      return;
    }
    if (this.context.role !== 'chat') return;
    const value = record(await this.port.request({ kind: 'own-intents', after }), ['epoch', 'pending', 'items', 'after']);
    const epoch = count(value.epoch);
    if (!epoch) throw new Error('Invalid native history epoch');
    if (this.historyEpoch !== epoch) {
      this.historyEpoch = epoch; this.requestHistory.clear(); this.historyAfter = null; this.historyExtended = false;
      if (after !== null) { await this.readRecovery(); return; }
    }
    if (!Array.isArray(value.pending) || value.pending.length > 32 || !Array.isArray(value.items) || value.items.length > 32 || value.after !== null && typeof value.after !== 'string') throw new Error('Invalid native request history');
    const pending = value.pending.map(parseNativePlacementIntent), items = value.items.map(parseNativePlacementIntent);
    if ([...pending, ...items].some(intent => !sameScope(intent.sourceScope, this.context.role === 'chat' ? this.context.reservation.scope : intent.sourceScope))) throw new Error('Foreign source in native request history');
    let carryNotice: string | null = null;
    const carryFailure = () => { carryNotice = 'Saved draft transfer history could not be read. Native request results are available; original drafts and transfer records are preserved.'; };
    const sourceScope = this.context.reservation.scope;
    const readCarries = () => sourceCarries(sourceScope).catch(() => { carryFailure(); return []; });
    const retireOffer = (requestId: string) => this.refuseOfferedCarry(requestId, { unboundOnly: true }).catch(carryFailure);
    const carriesBefore = await readCarries();
    const previous = this.snapshot.recovery.kind === 'chat' ? this.snapshot.recovery.pending : [];
    const recheck = new Set(previous.map(item => item.requestId));
    for (const item of this.requestHistory.values()) if (!item.result || item.result.kind === 'pending') recheck.add(item.requestId);
    for (const carry of carriesBefore) if (carry.kind === 'offered') recheck.add(carry.requestId);
    for (const requestId of this.pendingIntents.keys()) recheck.add(requestId);
    for (const requestId of recheck) if (!pending.some(item => item.requestId === requestId) && !items.some(item => item.requestId === requestId)) {
      const orphanChildOffer = /^[1-9][0-9]*:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
        && carriesBefore.some(carry => carry.requestId === requestId && carry.kind === 'offered' && carry.target === null);
      const inFlight = this.coordinator?.isIntentInFlight(requestId) ?? false;
      const saved = await this.port.request({ kind: 'read-intent', requestId });
      if (saved !== null) {
        const intent = parseNativePlacementIntent(saved);
        if (intent.requestId !== requestId || !sameScope(intent.sourceScope, this.context.reservation.scope)) throw new Error('Foreign native request result');
        if (!intent.result || intent.result.kind === 'pending') pending.push(intent);
        else items.push(intent);
      } else if ((!this.requestHistory.get(requestId)?.result || this.requestHistory.get(requestId)?.result?.kind === 'pending')
        && (carryRequestEpoch(requestId) < epoch || carryRequestEpoch(requestId) === epoch && !inFlight && !this.coordinator?.isIntentInFlight(requestId)
          && (this.pendingIntents.has(requestId) || orphanChildOffer))) {
        await retireOffer(requestId);
        const pending = this.pendingIntents.get(requestId);
        if (pending) {
          this.pendingIntents.delete(requestId);
          const result = { kind: 'refused', reason: carryRequestEpoch(requestId) < epoch ? 'This recorded result expired. Check main before starting another chat. Your unsent draft is preserved.' : 'Main has no recorded result for this request. Your unsent draft is preserved; you can try again.' } as const;
          this.controller.settlePlacement(pending, result);
          if (this.pendingIntent?.requestId === requestId) { this.pendingIntent = null; this.update({ placementNotice: result.reason }); }
        }
      }
    }
    for (const item of [...pending, ...items]) this.requestHistory.set(item.requestId, item);
    for (const [requestId, pending] of this.pendingIntents) {
      const intent = this.requestHistory.get(requestId);
      const recorded: ConversationOpenResult | null = intent?.result ?? (intent?.target?.phase === 'target-ready'
        ? { kind: 'detached', scope: intent.target.scope, label: intent.target.label } : null);
      if (!recorded || recorded.kind === 'pending') continue;
      const completed = childPlacementResult(recorded);
      this.controller.settlePlacement(pending, completed); this.pendingIntents.delete(requestId);
      if (completed.kind === 'refused') await retireOffer(requestId);
      if (this.pendingIntent?.requestId === requestId) { this.pendingIntent = null; this.update({ placementNotice: completed.kind === 'refused' ? completed.reason : null }); }
    }
    for (const item of [...pending, ...items]) if (item.result?.kind === 'refused') await retireOffer(item.requestId);
    if (append || !this.historyExtended) this.historyAfter = value.after;
    if (append) this.historyExtended = true;
    const carries = await readCarries();
    if (carryNotice) this.update({ placementNotice: carryNotice });
    this.update({ recovery: { kind: 'chat', pending, history: [...this.requestHistory.values()].filter(item => item.result && item.result.kind !== 'pending'), after: this.historyAfter, carries } });
  }
  async retryAssignedCreation(): Promise<void> {
    if (this.context.role !== 'chat' || !this.snapshot.canRetryCreation || !this.context.reservation.creationAgentId) return;
    this.update({ canRetryCreation: false }); this.childRefusalReported = false;
    await this.controller.createReserved(this.context.reservation.scope, this.context.reservation.creationAgentId);
    void this.drive();
  }
  async loadMoreRequests(): Promise<void> {
    if (!this.historyAfter) return;
    try { await this.refreshRecovery(this.historyAfter, true); } catch (error) { this.reportFailure(error); }
  }
  async retryIntent(intent: NativePlacementIntent): Promise<void> {
    try {
      await this.serializeRecovery(async () => {
        if (intent.action.carry) {
          const carry = (await sourceCarries(intent.sourceScope)).find(carry => carry.requestId === intent.requestId);
          if (carry?.kind === 'refused') {
            const binding = this.childOwner?.editorBinding();
            if (!binding || this.context.role !== 'chat' || !sameScope(intent.sourceScope, binding.scope)) throw new Error('The original source editor must retry this carry.');
            await retryDraftCarry(intent.sourceScope, intent.requestId, binding.viewId, binding.writerGeneration);
          }
        }
        if (!this.port) throw new Error('Native placement is unavailable.');
        this.requestHistory.set(intent.requestId, { ...intent, result: null });
        this.recoveryDirty = true;
        let reply: unknown;
        try { reply = await this.port.request({ kind: 'retry-intent', requestId: intent.requestId }); }
        catch (error) {
          const saved = await this.port.request({ kind: 'read-intent', requestId: intent.requestId }).catch(() => { throw error; });
          if (saved === null) throw error;
          const recovered = parseNativePlacementIntent(saved);
          if (recovered.requestId !== intent.requestId || !sameScope(recovered.sourceScope, intent.sourceScope)) throw new Error('Native retry identity mismatch');
          if (recovered.result?.kind === 'refused' && canonicalJson(recovered) === canonicalJson(intent)) {
            await this.refuseOfferedCarry(intent.requestId, { unboundOnly: true });
            throw new Error(`Retry could not be confirmed: ${error instanceof Error ? error.message : String(error)}`);
          }
          reply = recovered;
        }
        const retried = parseNativePlacementIntent(reply);
        if (retried.requestId !== intent.requestId || !sameScope(retried.sourceScope, intent.sourceScope)) throw new Error('Native retry identity mismatch');
        this.requestHistory.set(retried.requestId, retried);
        this.recoveryDirty = true; await this.readRecovery();
      });
    } catch (error) { this.reportFailure(error); }
  }
  private async refuseOfferedCarry(requestId: string, { unboundOnly = false }: { readonly unboundOnly?: boolean } = {}): Promise<void> {
    if (this.context.role !== 'chat') return;
    const carry = (await sourceCarries(this.context.reservation.scope)).find(carry => carry.requestId === requestId);
    if (carry?.kind === 'offered') await refuseDraftCarry(carry, { unboundOnly });
  }
  async keepDraft(requestId: string, source?: ConversationScope): Promise<void> {
    const scope = this.context.role === 'chat' ? this.context.reservation.scope : source; if (!scope || !this.hostIsCurrent(scope.hostId)) return;
    const hostId = scope.hostId;
    try {
      const kept = await this.hostStep(hostId, cancelDraftCarry({ source: scope, requestId }));
      await this.hostStep(hostId, this.refreshRecovery()); this.updateForHost(hostId, { placementNotice: kept ? 'The draft stays in this chat. No queued send or image was moved.' : 'This transfer changed. Refresh saved transfers to review its current status.' });
    } catch (error) { this.reportFailure(error, undefined, hostId); }
  }
  async moreSavedTransfers(): Promise<void> {
    if (this.context.role !== 'main') return;
    const host = this.controller.getSnapshot().host;
    if (host.kind !== 'ready') return;
    this.retargetHost(host.metadata.hostId);
    if (this.snapshot.recovery.kind !== 'main' || !this.snapshot.recovery.carriesAfter) return;
    this.carryRecoveryAfter = this.snapshot.recovery.carriesAfter; await this.refreshRecovery().catch(error => this.reportFailure(error, undefined, host.metadata.hostId));
  }
  async firstSavedTransfers(): Promise<void> {
    if (this.context.role !== 'main') return;
    const host = this.controller.getSnapshot().host;
    if (host.kind !== 'ready') return;
    this.retargetHost(host.metadata.hostId);
    this.carryRecoveryAfter = null; await this.refreshRecovery().catch(error => this.reportFailure(error, undefined, host.metadata.hostId));
  }
  async removeSavedCarry(carry: DraftCarry): Promise<void> {
    const hostId = carry.source.hostId;
    if (!this.hostIsCurrent(hostId)) return;
    try { await this.hostStep(hostId, removeRetainedCarry(carry)); await this.hostStep(hostId, this.refreshRecovery()); }
    catch (error) { this.reportFailure(error, undefined, hostId); }
  }
  async resumeWindow(reservation: NativeReservation, inline = false): Promise<void> {
    const hostId = reservation.scope.hostId;
    if (!this.hostIsCurrent(hostId)) return;
    if (!this.port || this.context.role !== 'main' || this.processing || this.controller.getSnapshot().busy) { this.updateForHost(hostId, { placementNotice: 'Finish the current operation, then retry this saved chat.' }); return; }
    this.retargetHost(hostId);
    const settlementBefore = this.carrySettlementAfter ?? null;
    if (settlementBefore === null) this.carrySettlementDirty = false;
    this.processing = true;
    try {
      let inlineTransition: string | null = null;
      if (inline) {
        const appearance = this.ui instanceof MainUiConnection ? this.ui.recoveryHost(hostId) : undefined;
        const grant = parseEditorRecoveryGrant(await this.hostStep(hostId, this.port.request({ kind: 'recover-inline', scope: reservation.scope, expectedTransitionId: reservation.transitionId, ...(appearance ? { expectedContext: { hostId: appearance.hostId, profileId: appearance.profileId } } : {}) })));
        await this.hostStep(hostId, this.ui.restore(appearance));
        inlineTransition = grant.transitionId;
        if (!this.controller.getSnapshot().active || !sameScope(this.controller.getSnapshot().active?.scope ?? reservation.scope, reservation.scope)) {
          await this.hostStep(hostId, BrowserViewStorage.recoverClosed(grant));
        }
      }
      const diagnosticBeforePlacement = this.diagnosticNotice;
      const result = await this.hostStep(hostId, this.coordinator.placeExplicitly(reservation.scope, inline ? 'inline' : 'separate', async () => {
        const found = await this.hostStep(hostId, this.controller.inspectConversation(reservation.scope));
        if (found.agent) {
          if (reservation.creationAgentId && found.agent.id !== reservation.creationAgentId) throw new Error('The saved scope belongs to another agent.');
          return this.controller.openReserved(reservation.scope);
        }
        if (!reservation.creationAgentId) throw new Error('The saved conversation is unavailable. Original local records are preserved.');
        return this.controller.createReserved(reservation.scope, reservation.creationAgentId);
      }));
      if (result.kind === 'inline' || result.kind === 'detached') {
        if (result.kind === 'inline' && inlineTransition) await this.hostStep(hostId, this.port.request({ kind: 'phase', scope: reservation.scope, transitionId: inlineTransition, phase: 'inline-ready' }));
        const queue = await this.hostStep(hostId, this.port.request({ kind: 'pending-intents' }));
        if (!Array.isArray(queue) || queue.length > 32) throw new Error('Invalid native intent queue');
        for (const raw of queue) {
          const intent = parseNativePlacementIntent(raw);
          if (!intent.target || !sameScope(intent.target.scope, reservation.scope)) continue;
          const target = intent.target;
          const completion = target.phase === 'target-ready' ? { kind: 'detached', scope: target.scope, label: target.label } as const : sameNativeAttempt(target, reservation) ? result : null;
          if (!completion) continue;
          if (intent.action.carry) {
            await this.hostStep(hostId, bindDraftCarry(intent.sourceScope, intent.requestId, reservation.scope));
            if (result.kind === 'detached') await this.hostStep(hostId, this.port.request({ kind: 'launch', scope: reservation.scope, existingOnly: true,
              geometry: { width: 640, height: 720, titlebar: 'native', title: 'Chat' } }).catch(() => {}));
          }
          await this.hostStep(hostId, this.port.request({ kind: 'complete-intent', sourceScope: intent.sourceScope, requestId: intent.requestId, result: completion }));
        }
      }
      if (result.kind === 'pending' || result.kind === 'refused') this.updateForHost(hostId, { placementNotice: result.reason });
      else if (this.diagnosticNotice === diagnosticBeforePlacement) this.updateForHost(hostId, { placementNotice: null });
      if (result.kind === 'inline' || result.kind === 'detached') await this.hostStep(hostId, this.syncDraftCarries()).catch(error => { if (error instanceof HostSuperseded) throw error; this.reportFailure(error, placementReason(error), hostId); });
      await this.hostStep(hostId, this.controller.refreshCatalog()); await this.hostStep(hostId, this.refreshRecovery());
    } catch (error) { this.reportFailure(error, error instanceof Error ? error.message : String(error), hostId); }
    finally { this.finishProcessing(settlementBefore, this.catalogDirty); }
  }
  private async syncDraftCarries(): Promise<void> {
    const state = this.controller.getSnapshot(), active = state.active;
    if (this.context.role === 'main' && state.host.kind === 'ready') {
      const hostId = state.host.metadata.hostId;
      this.retargetHost(hostId);
      try {
        const page = await this.hostStep(hostId, hostCarries(hostId, this.carrySettlementAfter));
        this.requireHost(hostId);
        this.carrySettlementAfter = page.after;
        for (const carry of page.carries) if (carry.kind === 'applied') {
          try { await this.hostStep(hostId, this.controller.settleCarriedDraft(carry)); } catch (error) { if (error instanceof HostSuperseded) return; this.updateForHost(hostId, { placementNotice: 'Some saved transfer text needs recovery. Its original records are preserved.' }); }
        }
      } catch (error) {
        if (error instanceof HostSuperseded) return;
        this.updateForHost(hostId, { placementNotice: 'Saved draft transfer history could not be read. Original drafts are preserved.' });
      }
    }
    if (!active) return;
    for (const carry of await targetCarries(active.scope)) {
      if (!carry.target) continue;
      if (carry.kind === 'applied') { await this.port?.request({ kind: 'carry-applied', sourceScope: carry.source, requestId: carry.requestId }).catch(() => {}); continue; }
      if (carry.kind !== 'offered') continue;
      let outcome: 'committed' | 'changed' | 'cancelled' = 'changed';
      for (let attempt = 0; attempt < 3 && outcome === 'changed'; attempt++) {
        const current = await active.store.captureDraft(), text = carry.expected.text;
        if (carry.emptyOnly && current.text) { await refuseDraftCarry(carry); outcome = 'cancelled'; break; }
        const merged = carriedDraftText(text, current.text);
        outcome = await active.store.transferDraft(current, merged, { kind: 'receive', source: carry.source, requestId: carry.requestId });
      }
      if (outcome === 'cancelled') continue;
      if (outcome !== 'committed') throw new Error('The destination draft is changing. Its carried text remains pending in the source.');
      if (this.context.role === 'main') {
        this.carrySettlementDirty = true; this.recoveryDirty = true;
        if (!this.processing) queueMicrotask(() => { void this.drive(); });
      }
      await this.port?.request({ kind: 'carry-applied', sourceScope: carry.source, requestId: carry.requestId }).catch(() => {});
    }
    for (const carry of await sourceCarries(active.scope)) {
      if (carry.kind !== 'applied') continue;
      await active.store.transferDraft(carry.expected, '', { kind: 'release', source: carry.source, requestId: carry.requestId });
    }
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const cleanup of this.cleanups) cleanup(); this.ui.close(); void this.controller.dispose(); this.listeners.clear();
  }
}
