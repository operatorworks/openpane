import { matchesValidatedDelivery } from './ui-connection.js';
import { carriedDraftText, carryRequestEpoch } from './draft-carry-records.js';
import { createBrowserConnection } from '@openpane/client/service';
import { parseWindowContext, sameScope } from '@openpane/contracts';
import type { ConversationOpenResult, ConversationScope, PlacementTransition, UiContextV1 } from '@openpane/contracts';
import type { AgentDescriptor } from '@openpane/contracts/service';
import { count, record } from '@openpane/contracts/decode';
import { BrowserViewStorage } from './browser-storage.js';
import { createApplicationController } from './application-controller.js';
import type { ApplicationController } from './application-controller.js';
import { IndependentDraftsError } from './view-state.js';
import type { ViewStorageFactory } from './view-state.js';
import { ChildUiConnection, NativeMainUiRelay } from './native-ui-relay.js';
import { UiConnection } from './ui-connection.js';
import type { UiTransport } from './ui-connection.js';
import type { RecoveryOriginator } from './ui-recovery.js';
import { childPlacementResult, DesktopWindowPort, parseNativePlacementIntent, parseNativeReservation, parseEditorRecoveryGrant, parseNativeWindowLookup } from './window-context.js';
import type { DesktopWindowContext, NativePlacementIntent, NativeReservation } from './window-context.js';
import type { DraftCarry } from './draft-carry.js';
import { bindDraftCarry, offerDraftCarry, sourceCarries, targetCarries, cancelDraftCarry, refuseDraftCarry, retryDraftCarry, hostCarries, removeRetainedCarry } from './draft-carry.js';
import { WindowCoordinator } from './window-coordinator.js';
import { PlacementSuperseded } from './placement-port.js';

export type WindowRecovery =
  | { readonly kind: 'none' }
  | { readonly kind: 'main'; readonly windows: readonly NativeReservation[]; readonly carries: readonly DraftCarry[]; readonly carriesAfter: IDBValidKey | null; readonly carriesFirstPage: boolean; readonly carryNotice: string | null }
  | { readonly kind: 'chat'; readonly pending: readonly NativePlacementIntent[]; readonly history: readonly NativePlacementIntent[]; readonly after: string | null;
      readonly carries: readonly DraftCarry[] };
export interface WindowRuntimeSnapshot { readonly closing: boolean; readonly canRetryCreation: boolean; readonly recovery: WindowRecovery; readonly catalogOnly: boolean; readonly capabilityNotice: string | null; readonly placementNotice: string | null }
const namespace = (agent: AgentDescriptor): string | null => 'kind' in agent ? agent.namespace : null;
export class MainUiConnection extends UiConnection {
  private restoration: { readonly sequence: number; readonly promise: Promise<boolean> } | null = null;
  private recoveryAttempt = 0;
  constructor(private readonly port: DesktopWindowPort) {
    super(new NativeMainUiRelay(port), async context => parseWindowContext(await port.request({ kind: 'bind-ui', hostId: context.hostId, profileId: context.profileId })), port.context.liveRelay);
  }
  protected override async nextPresenceSequence(): Promise<number> {
    const reply = record(await this.port.request({ kind: 'presence', visible: document.visibilityState === 'visible', display: null }), ['presenceSequence']);
    return count(reply.presenceSequence);
  }
  override async restore(): Promise<void> {
    const reply = record(await this.port.request({ kind: 'restore-builtin' }), ['sequence']);
    await this.restoreNative(count(reply.sequence));
  }
  restoreNative(sequence: number): Promise<boolean> {
    const active = this.restoration;
    if (sequence <= this.recoveryAttempt || active && sequence <= active.sequence) return active?.promise ?? Promise.resolve(true);
    const task = (active?.promise.catch(() => {}) ?? Promise.resolve()).then(async () => {
      const recorded = await this.requestRecovery({ kind: 'native', brokerInstance: this.port.context.brokerInstance, sequence });
      if (recorded) this.recoveryAttempt = sequence;
      return recorded;
    }).finally(() => { if (this.restoration?.sequence === sequence) this.restoration = null; });
    this.restoration = { sequence, promise: task };
    return task;
  }
  protected override async recovered(originator: RecoveryOriginator): Promise<void> {
    if (originator.kind === 'native' && originator.brokerInstance === this.port.context.brokerInstance) await this.port.request({ kind: 'confirm-recovery', sequence: originator.sequence });
  }
}
/** One document owns one controller, and only main owns the host UI reader. */
export class WindowRuntime {
  readonly controller: ApplicationController;
  readonly ui: UiTransport;
  readonly coordinator: WindowCoordinator;
  readonly port: DesktopWindowPort | null;
  private childOwner: BrowserViewStorage | null = null;
  private snapshot: WindowRuntimeSnapshot = { closing: false, canRetryCreation: false, recovery: { kind: 'none' }, catalogOnly: false, capabilityNotice: null, placementNotice: null };
  private readonly listeners = new Set<() => void>();
  private readonly cleanups: (() => void)[] = [];
  private started = false;
  private closed = false;
  private processing = false;
  private childReady = false;
  private childRefusalReported = false;
  private catalogDirty = false;
  private recoveryDirty = true;
  private readonly requestHistory = new Map<string, NativePlacementIntent>();
  private historyAfter: string | null = null;
  private historyEpoch: number | null = null;
  private historyExtended = false;
  private nativeRecoverySeen: number | null = null;
  private nativeRecoveryTask: Promise<void> | null = null;
  private separatePolicy = false;
  private policyDelivery: string | null = null;
  private policyAppliedScope: ConversationScope | null = null;
  private carryRecoveryAfter: IDBValidKey | null = null;
  private carrySettlementAfter: IDBValidKey | null = null;
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
      ...(context.role !== 'chat' ? { readLegacyDraft: BrowserViewStorage.readLegacyDraft, openRemainingWork: BrowserViewStorage.openRemainingWork.bind(BrowserViewStorage), recoverClosedView: async (viewId: string, onFailure: (error: unknown) => void) => {
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
        else if (context.role === 'main') owner = await BrowserViewStorage.reopen(context.viewId, onFailure, true, true);
        else {
          const reserved = context.reservation;
          owner = await BrowserViewStorage.claimEditor({ scope: reserved.scope, viewId: reserved.viewId, label: reserved.label,
            transitionId: reserved.transitionId, creation: reserved.creationAgentId === null ? null : { agentId: reserved.creationAgentId } }, onFailure);
          this.childOwner = owner;
        }
        catalogViewId = owner.viewId; assigned(owner.viewId); return owner;
      },
      reopen: async (viewId, onFailure) => {
        if (context.role === 'chat') throw new Error('This window is fixed to its assigned conversation.');
        const binding = await BrowserViewStorage.bindingForView(viewId);
        if (!binding) return BrowserViewStorage.reopen(viewId, onFailure);
        const label = context.role === 'main' ? context.label : browserLabel();
        if (binding.kind === 'handoff-reserved' && binding.targetLabel !== label) throw new Error('This saved view is reserved for its recorded chat window. Open that chat from the catalog.');
        return BrowserViewStorage.claimEditor({ scope: binding.scope, viewId, label,
          transitionId: binding.kind === 'handoff-reserved' ? binding.transitionId : null, creation: null }, onFailure);
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
    this.coordinator.observeIntent((result, requestId) => { if (result.kind === 'pending') this.pendingIntents.set(requestId, result); this.pendingIntent = result.kind === 'pending' ? { requestId, result } : null; this.recoveryDirty = true; this.update({ placementNotice: result.kind === 'pending' || result.kind === 'refused' ? result.reason : null }); });
    this.coordinator.captureCarry(async (requestId, sourceScope) => {
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
          emptyOnly: true, expected: { text: captured.text, revision: captured.revision } });
        return { cancel: () => refuseDraftCarry((existing ?? { version: 1, kind: 'offered', source: sourceScope, sourceViewId: binding.viewId, requestId,
          expected: { text: captured.text, revision: captured.revision }, target: null })) };
      }
      const active = this.controller.getSnapshot().active, binding = this.childOwner?.editorBinding();
      if (this.context.role !== 'chat' || !active || !binding || active.viewId !== this.childOwner?.viewId || !sameScope(active.scope, this.context.reservation.scope)) throw new Error('The source editor is not ready to carry its draft.');
      const expected = await active.store.captureDraft();
      if (!expected.text) return null;
      await offerDraftCarry({ source: active.scope, sourceViewId: active.viewId, requestId, writerGeneration: binding.writerGeneration, expected });
      return { cancel: () => this.refuseOfferedCarry(requestId) };
    });
    this.coordinator.trackPlacement(async (reservation, binding) => {
      const attempt = this.placingPolicy;
      if (!(this.ui instanceof UiConnection) || !attempt || !sameScope(attempt.scope, reservation.scope)) return;
      for (const transition of attempt.transitions) {
        if (this.confirmedPolicyDelivery() !== attempt.delivery) throw new PlacementSuperseded();
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
      const result = this.controller.getSnapshot().lastPlacement;
      if (result !== this.lastPlacement) { this.lastPlacement = result; if (!this.processing || result?.kind === 'refused' || result?.kind === 'detached') this.recoveryDirty = true; }
      this.uiChanged();
      if (!this.processing) void this.drive();
    }));
    this.cleanups.push(this.ui.subscribe(this.uiChanged)); this.uiChanged();
    if (this.port) for (const event of ['openpane-ui-wakeup', 'openpane-placement-intent', 'openpane-close-requested'] as const) {
      void this.port.listen(event, () => {
        if (event === 'openpane-close-requested') void this.closeWindow();
        else { this.recoveryDirty = true; if (event === 'openpane-ui-wakeup') { this.catalogDirty = true; void this.recoveryWake(); } void this.drive(); }
      }).then(unlisten => {
        if (this.closed) { unlisten(); return; }
        this.cleanups.push(unlisten);
        if (event === 'openpane-ui-wakeup') void this.recoveryWake();
        if (event === 'openpane-close-requested') void this.port?.request({ kind: 'read-close' }).then(value => {
          const state = record(value, ['pending']);
          if (typeof state.pending !== 'boolean') throw new Error('Invalid native close state');
          if (state.pending && !this.closed) void this.closeWindow();
        }).catch(error => this.update({ placementNotice: String(error) }));
      }, error => this.update({ placementNotice: String(error) }));
    }
    this.ui.start();
    const initialUi = this.context.role === 'main' ? new Promise<void>(resolve => {
      const ready = () => { const state = this.ui.getSnapshot(); if (state.state || state.diagnostic) { unsubscribe(); resolve(); } };
      const unsubscribe = this.ui.subscribe(ready); ready();
    }) : Promise.resolve();
    void initialUi.then(() => this.closed ? undefined : this.controller.start()).then(() => this.drive());
  }
  private confirmedPolicyDelivery(): string | null {
    const current = this.ui.getSnapshot();
    if (!current.state || current.localBuiltin || current.confirmedGeneration !== current.state.selection.deliveryGeneration || !matchesValidatedDelivery(current.validatedVisual, current.state, current.deliveryContext)) return null;
    return JSON.stringify([current.deliveryContext, current.state.selection.deliveryGeneration, current.state.selection.revision, current.state.bundle?.digest]);
  }
  private uiChanged = (): void => {
    if (this.context.role === 'main') void this.recoveryWake();
    const state = this.ui.getSnapshot();
    const builtin = state.validatedVisual.kind === 'local-builtin';
    if (!builtin && (!state.state || state.localBuiltin || !matchesValidatedDelivery(state.validatedVisual, state.state, state.deliveryContext))) return;
    const presentation = builtin ? null : state.state?.bundle?.manifest.presentation ?? null;
    const separate = presentation?.chats === 'separate';
    const supported = this.context.role === 'main' && this.context.liveRelay;
    const active = this.controller.getSnapshot().active;
    const catalogOnly = separate && supported && !active;
    if (builtin || this.confirmedPolicyDelivery()) this.coordinator.setPresentation(presentation);
    const delivery = builtin || !state.state ? null : JSON.stringify([state.deliveryContext, state.state.selection.deliveryGeneration, state.state.selection.revision, state.state.bundle?.digest]);
    if (this.policyDelivery !== delivery) { this.policyDelivery = delivery; this.policyAppliedScope = null; if (this.processing) this.recoveryDirty = true; }
    this.separatePolicy = separate && supported;
    if (!this.separatePolicy) { this.policyScope = null; this.policyAppliedScope = null; }
    else {
      const pending = this.controller.getSnapshot().lastPlacement;
      const reserved = state.state?.transitions.find(transition => transition.slot.target)?.slot.target?.scope;
      const scope = reserved ?? active?.scope ?? (pending?.kind === 'pending' ? pending.scope : null);
      if (scope && (!this.policyAppliedScope || !sameScope(this.policyAppliedScope, scope))) this.policyScope = scope;
    }
    this.update({ catalogOnly, capabilityNotice: separate && this.context.role !== 'chat' && !supported
      ? 'Separate chat windows require a supported desktop launcher. Chats stay inline here.' : null });
    if (!this.processing) void this.drive();
  };
  private recoveryWake(): Promise<void> {
    if (!this.port || this.context.role !== 'main' || !(this.ui instanceof MainUiConnection)) return Promise.resolve();
    const port = this.port, ui = this.ui;
    return this.nativeRecoveryTask ??= (async () => {
      for (;;) {
        const state = record(await port.request({ kind: 'read-recovery' }), ['pending', 'sequence']);
        if (typeof state.pending !== 'boolean') throw new Error('Invalid native recovery state');
        const sequence = count(state.sequence);
        if (!state.pending) { this.nativeRecoverySeen = null; return; }
        if (this.nativeRecoverySeen === sequence) return;
        this.nativeRecoverySeen = sequence;
        if (!await ui.restoreNative(sequence)) { this.nativeRecoverySeen = null; return; }
      }
    })().catch(error => { this.update({ placementNotice: String(error) }); }).finally(() => { this.nativeRecoveryTask = null; });
  }
  private async closeWindow(): Promise<void> {
    if (!this.port || this.closed || this.snapshot.closing) return;
    this.update({ closing: true });
    let saved = false;
    try { await this.controller.prepareClose(); saved = true; await this.controller.dispose(); await this.port.request({ kind: 'close-ready' }); }
    catch (error) {
      await this.port.request({ kind: 'close-cancelled' }).catch(() => {});
      if (saved) {
        this.update({ placementNotice: `The saved editor is reopening after its window cleanup failed: ${String(error)}` });
        window.location.reload();
      } else this.update({ placementNotice: `Saving this window failed: ${String(error)}. Copy any unsaved text before using Close Chat Without Saving or Quit Without Saving in the Recovery menu.` });
    } finally { this.update({ closing: false }); }
  }
  private async drive(): Promise<void> {
    if (this.processing || this.closed) return;
    const state = this.controller.getSnapshot();
    if (state.busy || state.host.kind !== 'ready' || state.storageFailure) return;
    this.processing = true;
    try {
      if (this.recoveryDirty || this.context.role === 'main' && state.lastPlacement?.kind === 'pending') { this.recoveryDirty = false; await this.refreshRecovery(); }
      if (this.context.role === 'chat') {
        if (state.saved.pendingCreation && !this.childReady) await this.controller.recoverCreation();
        await this.syncDraftCarries().catch(error => this.update({ placementNotice: String(error) }));
        const current = this.controller.getSnapshot(), binding = this.childOwner?.editorBinding();
        if (!this.childReady && !this.childRefusalReported && !current.active && !current.saved.pendingCreation && current.error && this.context.reservation.creationAgentId) {
          await this.port?.request({ kind: 'creation-refused' }); this.childRefusalReported = true; this.update({ canRetryCreation: true });
        }
        if (!this.childReady && current.host.kind === 'ready' && !current.storageFailure && !current.saved.pendingCreation && current.active && binding && sameScope(current.active.scope, this.context.reservation.scope)) {
          await this.port?.request({ kind: 'ready', binding, visible: document.visibilityState === 'visible' });
          this.childReady = true; if (this.ui instanceof ChildUiConnection) this.ui.refresh();
        }
        return;
      }
      await this.syncDraftCarries().catch(error => this.update({ placementNotice: String(error) }));
      const delivery = this.confirmedPolicyDelivery();
      if (this.policyScope && delivery && delivery === this.policyDelivery) {
        const scope = this.policyScope;
        const attempt = { scope, delivery, transitions: (this.ui.getSnapshot().state?.transitions ?? []).filter(transition => !transition.slot.target || sameScope(transition.slot.target.scope, scope)) };
        this.policyAppliedScope = scope;
        this.placingPolicy = attempt;
        let placed: ConversationOpenResult;
        try { placed = await this.coordinator.withPlacementGuard(scope, () => this.confirmedPolicyDelivery() === delivery && this.policyDelivery === delivery, () => this.controller.openReserved(scope)); } finally { this.placingPolicy = null; }
        if (this.confirmedPolicyDelivery() === delivery && this.policyDelivery === delivery) {
          if (placed.kind === 'detached') this.policyScope = null;
          else if (placed.kind === 'refused') {
            if (this.ui instanceof UiConnection) for (const transition of attempt.transitions) {
              if (this.confirmedPolicyDelivery() !== delivery) break;
              await this.ui.failPlacement(transition, placed.reason);
            }
            this.policyScope = null;
          }
          this.update({ placementNotice: placed.kind === 'refused' || placed.kind === 'pending' ? placed.reason : null });
        }
      }
      if (!this.port) return;
      if (delivery && delivery === this.confirmedPolicyDelivery() && !this.policyScope && !this.controller.getSnapshot().active && !this.controller.getSnapshot().saved.pendingCreation && this.ui instanceof UiConnection) {
        for (const transition of this.ui.getSnapshot().state?.transitions ?? []) {
          if (this.confirmedPolicyDelivery() !== delivery) break;
          if (!transition.slot.target) await this.ui.idlePlacement(transition).catch(() => {});
        }
      }
      if (this.catalogDirty) { this.catalogDirty = false; await this.controller.refreshCatalog(); }
      const value = await this.port.request({ kind: 'pending-intents' });
      if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid native intent queue');
      for (const raw of value) await this.processIntent(parseNativePlacementIntent(raw));
    } catch (error) { if (!(error instanceof PlacementSuperseded)) this.update({ placementNotice: error instanceof Error ? error.message : String(error) }); }
    finally { this.processing = false; if (this.recoveryDirty && !this.closed) queueMicrotask(() => { void this.drive(); }); }
  }
  private async processIntent(intent: NativePlacementIntent): Promise<void> {
    if (!this.port) return;
    const state = this.controller.getSnapshot(); if (state.host.kind !== 'ready' || state.busy) return;
    let result: ConversationOpenResult;
    try {
      const source = await this.controller.inspectConversation(intent.sourceScope);
      if (!source.agent) throw new Error('The source conversation is unavailable.');
      if (intent.action.kind === 'create') {
        const agentId = intent.action.agentId, targetAgent = state.host.metadata.agents.find(agent => agent.id === agentId);
        if (!targetAgent || namespace(targetAgent) !== namespace(source.agent)) throw new Error('The requested agent belongs to another namespace.');
      } else {
        let scope = intent.sourceScope, confirmed = sameScope(scope, intent.action.scope);
        for (let hop = 0; !confirmed && hop < 64; hop++) {
          const view = sameScope(scope, intent.sourceScope) ? source : await this.controller.inspectConversation(scope);
          if (view.continuation.successor?.kind !== 'confirmed') break;
          scope = view.continuation.successor.scope; confirmed = sameScope(scope, intent.action.scope);
        }
        if (!confirmed) throw new Error('The requested chat is not a confirmed successor of this window.');
      }
      let target = intent.target;
      if (!target) {
        const scope = intent.action.kind === 'open' ? intent.action.scope : { hostId: intent.sourceScope.hostId, conversationId: crypto.randomUUID() };
        const located = await BrowserViewStorage.locateEditor(scope), cached = parseNativeWindowLookup(await this.port.request({ kind: 'lookup', scope }), scope);
        const previous = cached.kind === 'absent' ? null : cached.reservation;
        const viewId = located.binding?.viewId ?? previous?.viewId ?? crypto.randomUUID();
        const assigned = parseNativePlacementIntent(await this.port.request({ kind: 'assign-intent', sourceScope: intent.sourceScope, requestId: intent.requestId,
          scope, viewId, creationAgentId: intent.action.kind === 'create' ? intent.action.agentId : null }));
        target = assigned.target;
        if (!target) throw new Error('Main did not persist the target allocation.');
      }
      const currentTarget = parseNativeWindowLookup(await this.port.request({ kind: 'lookup', scope: target.scope }), target.scope);
      if (currentTarget.kind === 'opening' && currentTarget.reservation.phase === 'failed') throw new Error('Creation was refused in its assigned window. Open that window to review its saved text and retry the same creation.');
      if (intent.action.carry) await bindDraftCarry(intent.sourceScope, intent.requestId, target.scope);
      const pending = this.controller.getSnapshot().saved.pendingCreation;
      if (pending && sameScope(pending.scope, target.scope)) {
        await this.controller.recoverCreation();
        const active = this.controller.getSnapshot().active;
        result = active && sameScope(active.scope, target.scope) ? { kind: 'inline', scope: target.scope } : { kind: 'pending', scope: target.scope, reason: 'The saved creation still needs confirmation.' };
      } else if (intent.action.kind === 'create') {
        const existing = await this.controller.inspectConversation(target.scope);
        if (existing.agent && existing.agent.id !== intent.action.agentId) throw new Error('The reserved scope belongs to a different agent.');
        result = existing.agent ? await this.controller.openReserved(target.scope) : await this.controller.createReserved(target.scope, intent.action.agentId);
      } else result = await this.controller.openReserved(target.scope);
    } catch (error) { result = { kind: 'refused', reason: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }; }
    if (result.kind === 'inline') await this.syncDraftCarries();
    if (result.kind === 'refused' && this.controller.getSnapshot().busy) return;
    if (result.kind === 'pending') { this.update({ placementNotice: result.reason }); return; }
    await this.port.request({ kind: 'complete-intent', sourceScope: intent.sourceScope, requestId: intent.requestId, result });
    this.update({ placementNotice: result.kind === 'refused' ? result.reason : null });
  }
  private async refreshRecovery(after: string | null = null, append = false): Promise<void> {
    if (!this.port) return;
    if (this.context.role === 'main') {
      const value = await this.port.request({ kind: 'reservations' });
      if (!Array.isArray(value) || value.length > 512) throw new Error('Invalid native recovery inventory');
      const state = this.controller.getSnapshot(), hostId = state.host.kind === 'ready' ? state.host.metadata.hostId : null;
      let carries: readonly DraftCarry[] = [], carriesAfter: IDBValidKey | null = null, carryNotice: string | null = null;
      try { if (hostId) { const page = await hostCarries(hostId, this.carryRecoveryAfter); carries = page.carries; carriesAfter = page.after; if (page.unreadable) carryNotice = 'Some saved transfer records cannot be read. Other chats remain available; original records are preserved.'; } }
      catch { carryNotice = 'Saved draft transfer history could not be read. Original drafts are preserved.'; }
      this.update({ recovery: { kind: 'main', windows: value.map(parseNativeReservation).filter(window => window.scope.hostId === hostId), carries, carriesAfter, carriesFirstPage: this.carryRecoveryAfter === null, carryNotice } });
      const pending = state.lastPlacement;
      if (pending?.kind === 'pending' && pending.scope?.hostId === hostId) {
        const native = parseNativeWindowLookup(await this.port.request({ kind: 'lookup', scope: pending.scope }), pending.scope);
        if (native.kind === 'opening' && native.reservation.phase === 'failed') {
          const result = { kind: 'refused', reason: 'The assigned chat could not be created. Open its saved window to review the refusal; its unsent draft is preserved.' } as const;
          const delivery = this.confirmedPolicyDelivery();
          if (delivery && delivery === this.policyDelivery && this.ui instanceof UiConnection) for (const transition of this.ui.getSnapshot().state?.transitions ?? []) {
            if (this.confirmedPolicyDelivery() !== delivery) break;
            if (transition.slot.target && sameScope(transition.slot.target.scope, pending.scope)) await this.ui.failPlacement(transition, result.reason);
          }
          if (this.controller.settlePlacement(pending, result)) { this.policyScope = null; this.update({ placementNotice: result.reason }); }
        }
        if (native.kind === 'ready' && this.controller.settlePlacement(pending, { kind: 'detached', scope: pending.scope, label: native.reservation.label })) {
          if (this.policyScope && sameScope(this.policyScope, pending.scope)) this.policyScope = null;
          if (this.snapshot.placementNotice === pending.reason) this.update({ placementNotice: null });
        }
      }
      return;
    }
    if (this.context.role !== 'chat') return;
    const value = record(await this.port.request({ kind: 'own-intents', after }), ['epoch', 'pending', 'items', 'after']);
    const epoch = count(value.epoch);
    if (!epoch) throw new Error('Invalid native history epoch');
    if (this.historyEpoch !== epoch) {
      this.historyEpoch = epoch; this.requestHistory.clear(); this.historyAfter = null; this.historyExtended = false;
      if (after !== null) { await this.refreshRecovery(); return; }
    }
    if (!Array.isArray(value.pending) || value.pending.length > 32 || !Array.isArray(value.items) || value.items.length > 32 || value.after !== null && typeof value.after !== 'string') throw new Error('Invalid native request history');
    const pending = value.pending.map(parseNativePlacementIntent), items = value.items.map(parseNativePlacementIntent);
    if ([...pending, ...items].some(intent => !sameScope(intent.sourceScope, this.context.role === 'chat' ? this.context.reservation.scope : intent.sourceScope))) throw new Error('Foreign source in native request history');
    const previous = this.snapshot.recovery.kind === 'chat' ? this.snapshot.recovery.pending : [];
    const recheck = new Set(previous.map(item => item.requestId));
    for (const carry of await sourceCarries(this.context.reservation.scope)) if (carry.kind === 'offered') recheck.add(carry.requestId);
    for (const requestId of this.pendingIntents.keys()) recheck.add(requestId);
    for (const requestId of recheck) if (!pending.some(item => item.requestId === requestId) && !items.some(item => item.requestId === requestId)) {
      const saved = await this.port.request({ kind: 'read-intent', requestId });
      if (saved !== null) {
        const intent = parseNativePlacementIntent(saved);
        if (intent.requestId !== requestId || !sameScope(intent.sourceScope, this.context.reservation.scope)) throw new Error('Foreign native request result');
        items.push(intent);
      } else if (carryRequestEpoch(requestId) < epoch) {
        await this.refuseOfferedCarry(requestId);
        const pending = this.pendingIntents.get(requestId);
        if (pending) {
          this.pendingIntents.delete(requestId);
          const result = { kind: 'refused', reason: 'This recorded result expired. Check main before starting another chat. Your unsent draft is preserved.' } as const;
          this.controller.settlePlacement(pending, result);
          await this.refuseOfferedCarry(requestId);
          if (this.pendingIntent?.requestId === requestId) { this.pendingIntent = null; this.update({ placementNotice: result.reason }); }
        }
      }
    }
    for (const item of items) { this.requestHistory.set(item.requestId, item); if (item.result?.kind === 'refused') await this.refuseOfferedCarry(item.requestId); }
    for (const [requestId, pending] of this.pendingIntents) {
      const recorded = this.requestHistory.get(requestId)?.result;
      if (!recorded || recorded.kind === 'pending') continue;
      const completed = childPlacementResult(recorded);
      this.controller.settlePlacement(pending, completed); this.pendingIntents.delete(requestId);
      if (completed.kind === 'refused') await this.refuseOfferedCarry(requestId);
      if (this.pendingIntent?.requestId === requestId) { this.pendingIntent = null; this.update({ placementNotice: completed.kind === 'refused' ? completed.reason : null }); }
    }
    if (append || !this.historyExtended) this.historyAfter = value.after;
    if (append) this.historyExtended = true;
    const carries = await sourceCarries(this.context.reservation.scope);
    this.update({ recovery: { kind: 'chat', pending, history: [...this.requestHistory.values()], after: this.historyAfter, carries } });
  }
  async retryAssignedCreation(): Promise<void> {
    if (this.context.role !== 'chat' || !this.snapshot.canRetryCreation || !this.context.reservation.creationAgentId) return;
    this.update({ canRetryCreation: false }); this.childRefusalReported = false;
    await this.controller.createReserved(this.context.reservation.scope, this.context.reservation.creationAgentId);
    void this.drive();
  }
  async loadMoreRequests(): Promise<void> {
    if (!this.historyAfter) return;
    try { await this.refreshRecovery(this.historyAfter, true); } catch (error) { this.update({ placementNotice: String(error) }); }
  }
  async retryIntent(intent: NativePlacementIntent): Promise<void> {
    try {
      if (intent.action.carry) {
        const carry = (await sourceCarries(intent.sourceScope)).find(carry => carry.requestId === intent.requestId);
        if (carry?.kind === 'refused') {
          const binding = this.childOwner?.editorBinding();
          if (!binding || this.context.role !== 'chat' || !sameScope(intent.sourceScope, binding.scope)) throw new Error('The original source editor must retry this carry.');
          await retryDraftCarry(intent.sourceScope, intent.requestId, binding.viewId, binding.writerGeneration);
        }
      }
      await this.port?.request({ kind: 'retry-intent', requestId: intent.requestId }); this.recoveryDirty = true; await this.refreshRecovery();
    }
    catch (error) { this.update({ placementNotice: String(error) }); }
  }
  private async refuseOfferedCarry(requestId: string): Promise<void> {
    if (this.context.role !== 'chat') return;
    const carry = (await sourceCarries(this.context.reservation.scope)).find(carry => carry.requestId === requestId);
    if (carry?.kind === 'offered') await refuseDraftCarry(carry);
  }
  async keepDraft(requestId: string, source?: ConversationScope): Promise<void> {
    const scope = this.context.role === 'chat' ? this.context.reservation.scope : source; if (!scope) return;
    try {
      const carry = (await sourceCarries(scope)).find(carry => carry.requestId === requestId);
      const kept = carry ? await cancelDraftCarry(carry) : false;
      await this.refreshRecovery(); this.update({ placementNotice: kept ? 'The draft stays in this chat. No queued send or image was moved.' : 'The draft transfer already completed. Its text is available in the destination chat.' });
    } catch (error) { this.update({ placementNotice: String(error) }); }
  }
  async moreSavedTransfers(): Promise<void> {
    if (this.snapshot.recovery.kind !== 'main' || !this.snapshot.recovery.carriesAfter) return;
    this.carryRecoveryAfter = this.snapshot.recovery.carriesAfter; await this.refreshRecovery();
  }
  async firstSavedTransfers(): Promise<void> {
    if (this.context.role !== 'main') return;
    this.carryRecoveryAfter = null; await this.refreshRecovery();
  }
  async removeSavedCarry(carry: DraftCarry): Promise<void> {
    try { await removeRetainedCarry(carry); await this.refreshRecovery(); }
    catch (error) { this.update({ placementNotice: String(error) }); }
  }
  async resumeWindow(reservation: NativeReservation, inline = false): Promise<void> {
    if (!this.port || this.context.role !== 'main' || this.processing || this.controller.getSnapshot().busy) { this.update({ placementNotice: 'Finish the current operation, then retry this saved chat.' }); return; }
    this.processing = true;
    try {
      let inlineTransition: string | null = null;
      if (inline) {
        await this.ui.restore();
        const grant = parseEditorRecoveryGrant(await this.port.request({ kind: 'recover-inline', scope: reservation.scope, expectedTransitionId: reservation.transitionId }));
        inlineTransition = grant.transitionId;
        if (!this.controller.getSnapshot().active || !sameScope(this.controller.getSnapshot().active?.scope ?? reservation.scope, reservation.scope)) {
          await BrowserViewStorage.recoverClosed(grant);
        }
      }
      const result = await this.coordinator.placeExplicitly(reservation.scope, inline ? 'inline' : 'separate', async () => {
        const found = await this.controller.inspectConversation(reservation.scope);
        if (found.agent) {
          if (reservation.creationAgentId && found.agent.id !== reservation.creationAgentId) throw new Error('The saved scope belongs to another agent.');
          return this.controller.openReserved(reservation.scope);
        }
        if (!reservation.creationAgentId) throw new Error('The saved conversation is unavailable. Original local records are preserved.');
        return this.controller.createReserved(reservation.scope, reservation.creationAgentId);
      });
      if (result.kind === 'inline' || result.kind === 'detached') {
        if (result.kind === 'inline' && inlineTransition) await this.port.request({ kind: 'phase', scope: reservation.scope, transitionId: inlineTransition, phase: 'target-ready' });
        await this.syncDraftCarries();
        const queue = await this.port.request({ kind: 'pending-intents' });
        if (!Array.isArray(queue) || queue.length > 32) throw new Error('Invalid native intent queue');
        for (const raw of queue) { const intent = parseNativePlacementIntent(raw); if (intent.target && sameScope(intent.target.scope, reservation.scope)) await this.port.request({ kind: 'complete-intent', sourceScope: intent.sourceScope, requestId: intent.requestId, result }); }
      }
      this.update({ placementNotice: result.kind === 'pending' || result.kind === 'refused' ? result.reason : null });
      await this.controller.refreshCatalog(); await this.refreshRecovery();
    } catch (error) { this.update({ placementNotice: error instanceof Error ? error.message : String(error) }); }
    finally { this.processing = false; if (this.catalogDirty || this.recoveryDirty) queueMicrotask(() => { void this.drive(); }); }
  }
  private async syncDraftCarries(): Promise<void> {
    const state = this.controller.getSnapshot(), active = state.active;
    if (this.context.role === 'main' && state.host.kind === 'ready') {
      try {
        const page = await hostCarries(state.host.metadata.hostId, this.carrySettlementAfter); this.carrySettlementAfter = page.after;
        for (const carry of page.carries) if (carry.kind === 'applied') {
          try { await this.controller.settleCarriedDraft(carry); } catch { this.update({ placementNotice: 'Some saved transfer text needs recovery. Its original records are preserved.' }); }
        }
      } catch { this.update({ placementNotice: 'Saved draft transfer history could not be read. Original drafts are preserved.' }); }
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
      await this.port?.request({ kind: 'carry-applied', sourceScope: carry.source, requestId: carry.requestId }).catch(() => {});
    }
    for (const carry of await sourceCarries(active.scope)) {
      if (carry.kind !== 'applied' || carry.sourceViewId !== active.viewId) continue;
      await active.store.transferDraft(carry.expected, '', { kind: 'release', source: carry.source, requestId: carry.requestId });
    }
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const cleanup of this.cleanups) cleanup(); this.ui.close(); void this.controller.dispose(); this.listeners.clear();
  }
}
