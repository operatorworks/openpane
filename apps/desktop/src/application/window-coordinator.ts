import { nativeEditorOrigin } from './native-editor-origin.js';
import { pruneDraftCarryHistory, bindDraftCarry, sourceCarries, keptDraft } from './draft-carry.js';
import { parseConversationOpenResult } from '@openpane/contracts';
import type { ConversationOpenResult, ConversationScope, EditorBinding, ExperienceV2 } from '@openpane/contracts';
import { sameScope } from '@openpane/contracts';
import { count, identifier, record } from '@openpane/contracts/decode';
import { BrowserViewStorage } from './browser-storage.js';
import { handoffRevision } from './editor-bindings.js';
import type { PlacementAcquisition, PlacementPort, PlacementPurpose } from './placement-port.js';
import { PlacementSuperseded, placementReason } from './placement-port.js';
import { DesktopWindowPort, parseNativeReservation, parseNativePlacementIntent, childPlacementResult, parseNativeWindowLookup } from './window-context.js';
import type { NativeReservation, NativePlacementIntent, NativeWindowLookup } from './window-context.js';

type Request = Parameters<PlacementPort['acquire']>[0];
type Owner = Parameters<PlacementPort['acquire']>[1];
const DEFAULT_WINDOW: ExperienceV2['presentation']['chatWindow'] = { width: 640, height: 720, titlebar: 'native', title: 'agent-and-conversation' };

function closedReadyEditor(native: NativeWindowLookup, binding: EditorBinding | null): boolean {
  return native.kind === 'closed' && native.reservation.phase === 'target-ready' && binding?.kind === 'editing'
    && binding.viewId === native.reservation.viewId && binding.revision === native.reservation.bindingRevision && binding.writerGeneration === native.reservation.writerGeneration;
}

/** Native intents allocate conversations; IndexedDB bindings decide where their drafts live. */
export class WindowCoordinator implements PlacementPort {
  private ready: (reservation: NativeReservation) => void = () => {};
  observeReady(handler: (reservation: NativeReservation) => void): void { this.ready = handler; }
  private diagnostic: (reason: string) => void = () => {};
  observeNotice(handler: (reason: string) => void): void { this.diagnostic = handler; }
  private readonly inFlightIntents = new Set<string>();
  isIntentInFlight(requestId: string): boolean { return this.inFlightIntents.has(requestId); }
  private readonly pendingReservations = new WeakMap<Extract<ConversationOpenResult, { readonly kind: 'pending' }>, NativeReservation>();
  pendingReservation(result: Extract<ConversationOpenResult, { readonly kind: 'pending' }>): NativeReservation | null { return this.pendingReservations.get(result) ?? null; }
  private rememberPending<T extends Exclude<ConversationOpenResult, { readonly kind: 'inline' }>>(result: T, reservation: NativeReservation): T {
    if (result.kind === 'pending') this.pendingReservations.set(result, reservation);
    return result;
  }
  private readonly placementGuards = new Map<string, () => boolean>();
  async withPlacementGuard<T>(scope: ConversationScope, current: () => boolean, operation: () => Promise<T>): Promise<T> {
    const key = JSON.stringify(scope);
    if (this.placementGuards.has(key)) throw new Error('This chat is already being placed.');
    this.placementGuards.set(key, current);
    try { return await operation(); } finally { this.placementGuards.delete(key); }
  }
  private readonly forced = new Map<string, 'inline' | 'separate'>();
  async placeExplicitly<T>(scope: ConversationScope, mode: 'inline' | 'separate', operation: () => Promise<T>): Promise<T> {
    const key = JSON.stringify(scope); if (this.forced.has(key)) throw new Error('A recovery of this chat is already in progress.');
    this.forced.set(key, mode); try { return await operation(); } finally { this.forced.delete(key); }
  }
  private presentationCurrent: () => boolean = () => true;
  private presentation: Pick<ExperienceV2['presentation'], 'chats' | 'chatWindow'> = { chats: 'inline', chatWindow: DEFAULT_WINDOW };
  private track: (reservation: NativeReservation, binding: Pick<EditorBinding, 'revision'>) => Promise<void> = async () => {};
  trackPlacement(handler: (reservation: NativeReservation, binding: Pick<EditorBinding, 'revision'>) => Promise<void>): void { this.track = handler; }
  private notice: (result: ConversationOpenResult, requestId: string) => void = () => {};
  observeIntent(handler: (result: ConversationOpenResult, requestId: string) => void): void { this.notice = handler; }
  private capture: (requestId: string, sourceScope?: ConversationScope, emptyOnly?: boolean) => Promise<{ readonly cancel: () => Promise<void> } | null> = async () => null;
  captureCarry(handler: (requestId: string, sourceScope?: ConversationScope, emptyOnly?: boolean) => Promise<{ readonly cancel: () => Promise<void> } | null>): void { this.capture = handler; }
  private readonly browserLabel: () => string;
  constructor(private readonly port: DesktopWindowPort | null, browserLabel?: () => string) {
    const id = crypto.randomUUID(); this.browserLabel = browserLabel ?? (() => `browser:${id}`);
  }
  setPresentation(value: Pick<ExperienceV2['presentation'], 'chats' | 'chatWindow'> | null, current: () => boolean = () => true): void {
    this.presentationCurrent = current;
    this.presentation = value ?? { chats: 'inline', chatWindow: DEFAULT_WINDOW };
  }
  canAutomaticallySend(): boolean { return this.port?.context.role !== 'main' || !this.port.context.liveRelay || this.presentation.chats === 'inline'; }
  async restoresInline(scope: ConversationScope, purpose: PlacementPurpose = 'passive'): Promise<boolean> {
    if (this.port?.context.role !== 'main' || !this.port.context.liveRelay) return true;
    if (this.presentation.chats === 'separate') return false;
    const native = await this.lookup(scope);
    if (native.kind === 'opening' || native.kind === 'ready') return false;
    const { binding } = await BrowserViewStorage.locateEditor(scope);
    if (purpose === 'passive' && (closedReadyEditor(native, binding) || binding && await nativeEditorOrigin(binding))) return false;
    return binding?.kind !== 'handoff-reserved' || binding.targetLabel === this.port.context.label;
  }
  delegateCreate = async (agentId: string, carry: boolean, initialDraft: string | null = null): Promise<ConversationOpenResult | null> => {
    if (this.port?.context.role !== 'chat') return null;
    if (initialDraft) return { kind: 'refused', reason: 'This message stays here. Start the new chat from main, then copy it to that chat.' };
    return this.intent({ kind: 'create', agentId, carry }, null);
  };
  private async intent(action: NativePlacementIntent['action'], scope: ConversationScope | null, emptyOnly?: boolean): Promise<Exclude<ConversationOpenResult, { readonly kind: 'inline' }>> {
    if (!this.port) return { kind: 'refused', reason: 'Native placement is unavailable.' };
    let submitted = false;
    let requestId: string = crypto.randomUUID(), captured: { readonly cancel: () => Promise<void> } | null = null;
    try {
      const carry = action.carry && (action.kind !== 'open' || this.port.context.role !== 'chat' || !await keptDraft(this.port.context.reservation.scope, action.scope));
      let context = record(await this.port.request({ kind: 'intent-context' }), ['epoch', 'pendingCarryRequests']), epoch = count(context.epoch);
      if (!epoch) throw new Error('Invalid native request epoch');
      const protectedRequests = () => {
        if (!Array.isArray(context.pendingCarryRequests) || context.pendingCarryRequests.length > 1024) throw new Error('Invalid native carry inventory');
        return context.pendingCarryRequests.map(value => identifier(value, 200));
      };
      if (carry && await pruneDraftCarryHistory(epoch, protectedRequests()) >= 1000) {
        context = record(await this.port.request({ kind: 'intent-context', retireAfter: epoch }), ['epoch', 'pendingCarryRequests']); epoch = count(context.epoch);
        await pruneDraftCarryHistory(epoch, protectedRequests());
      }
      requestId = `${epoch}:${requestId}`;
      this.inFlightIntents.add(requestId);
      captured = carry ? await this.capture(requestId, undefined, emptyOnly) : null;
      const canonical = { ...action, carry: captured !== null };
      submitted = true;
      let value: unknown;
      try { value = await this.port.request({ kind: 'placement-intent', requestId, action: canonical }); }
      catch (error) {
        value = await this.port.request({ kind: 'read-intent', requestId });
        if (value === null) { submitted = false; throw error; }
      }
      if (value === null) throw new Error('Native request admission is unconfirmed.');
      const intent = parseNativePlacementIntent(value);
      if (intent.requestId !== requestId || this.port.context.role !== 'chat' || !sameScope(intent.sourceScope, this.port.context.reservation.scope)) throw new Error('Native request identity mismatch');
      if (intent.result !== null && intent.result !== undefined) {
        const result = parseConversationOpenResult(intent.result);
        if (result.kind === 'refused') await captured?.cancel();
        return childPlacementResult(result);
      }
      const target = intent.target === null ? null : parseNativeReservation(intent.target);
      const pending = { kind: 'pending', scope: target?.scope ?? scope, reason: 'Main is coordinating the requested chat.' } as const; this.notice(pending, requestId); return pending;
    } catch (error) {
      let reason = placementReason(error);
      if (submitted) {
        const result = { kind: 'pending', scope, reason: placementReason(`${reason} Inspect this request before retrying; its draft remains recoverable.`) } as const;
        this.notice(result, requestId); return result;
      }
      try { await captured?.cancel(); } catch { reason += ' The draft remains pending in its source; recover local storage before retrying.'; }
      const result = { kind: 'refused', reason: placementReason(reason) } as const; this.notice(result, requestId); return result;
    } finally { this.inFlightIntents.delete(requestId); }
  }
  private async savedIntentResult(request: Request): Promise<Exclude<ConversationOpenResult, { readonly kind: 'inline' }> | null> {
    if (!request.intentRef || !this.port) return null;
    const saved = parseNativePlacementIntent(await this.port.request({ kind: 'read-intent', ...request.intentRef }));
    if (saved.requestId !== request.intentRef.requestId || !sameScope(saved.sourceScope, request.intentRef.sourceScope)
      || saved.sourceScope.hostId !== request.scope.hostId || saved.target && !sameScope(saved.target.scope, request.scope)) throw new Error('Native request identity mismatch');
    if (saved.target?.phase === 'target-ready') return { kind: 'detached', scope: saved.target.scope, label: saved.target.label };
    return saved.result ? childPlacementResult(saved.result) : null;
  }
  private geometry(request: Request): object {
    const policy = this.presentation.chatWindow;
    const title = policy.title === 'agent' ? request.agentLabel : policy.title === 'conversation' ? request.scope.conversationId : `${request.agentLabel} · ${request.scope.conversationId}`;
    let bounded = ''; for (const character of title) { if (bounded.length + character.length > 200) break; bounded += character; }
    return { width: policy.width, height: policy.height, titlebar: policy.titlebar, title: bounded };
  }
  private async lookup(scope: ConversationScope): Promise<NativeWindowLookup> {
    const native: NativeWindowLookup = this.port ? parseNativeWindowLookup(await this.port.request({ kind: 'lookup', scope }), scope) : { kind: 'absent' };
    if (native.kind === 'ready' || native.kind === 'closed' && native.reservation.phase === 'target-ready') this.ready(native.reservation);
    return native;
  }
  private async focus(request: Request, reservation: NativeReservation): Promise<Exclude<ConversationOpenResult, { readonly kind: 'inline' }> | null> {
    if (!this.port) return null;
    const value = await this.port.request({ kind: 'launch', scope: request.scope, geometry: this.geometry(request), existingOnly: true });
    if (value === null) return null;
    const result = parseConversationOpenResult(value);
    if (result.kind === 'inline') throw new Error('A native child cannot become an inline editor in main.');
    return this.rememberPending(result, reservation);
  }
  private launch(request: Request, reservation: NativeReservation): Promise<Exclude<ConversationOpenResult, { readonly kind: 'inline' }>> {
    if (!this.port) return Promise.resolve({ kind: 'refused', reason: 'Native placement is unavailable.' });
    return this.port.request({ kind: 'launch', scope: request.scope, geometry: this.geometry(request), ...(request.intentRef ? { intentRef: request.intentRef } : {}) }).then(value => {
      const result = parseConversationOpenResult(value);
      if (result.kind === 'inline') throw new Error('A native child cannot become an inline editor in main.');
      return this.rememberPending(result, reservation);
    });
  }
  private async phase(reservation: NativeReservation, phase: NativeReservation['phase']): Promise<void> {
    await this.port?.request({ kind: 'phase', scope: reservation.scope, transitionId: reservation.transitionId, phase });
  }
  private async transfer(request: Request, owner: Owner, binding: EditorBinding | null, sourceViewId: string, reservation: NativeReservation, assertCurrent?: () => void, onCommitted?: () => void): Promise<EditorBinding> {
    assertCurrent?.();
    if (owner.storage.viewId === sourceViewId) await owner.quiesce();
    assertCurrent?.();
    const plan = { scope: request.scope, sourceViewId, targetViewId: reservation.viewId,
      transitionId: reservation.transitionId, targetLabel: reservation.label, expectedBinding: binding, ...(request.purpose === 'passive' ? { purpose: request.purpose } : {}), ...(assertCurrent ? { assertCurrent } : {}) };
    if (owner.storage.viewId === sourceViewId && owner.storage instanceof BrowserViewStorage && owner.storage.editorBinding()) {
      const committed = await owner.storage.reserveHandoff(plan);
      onCommitted?.();
      await owner.release();
      return committed;
    }
    if (owner.storage.viewId === sourceViewId) await owner.release();
    else if (owner.holds(sourceViewId)) {
      if (!owner.releaseHeld) throw new Error('The saved source is still owned by another operation.');
      await owner.releaseHeld(sourceViewId);
    }
    const committed = await BrowserViewStorage.transferClosed(plan);
    onCommitted?.(); return committed;
  }
  private async carryToNative(request: Request, reservation: NativeReservation, onDependent?: () => void): Promise<void> {
    if (!request.carryFrom || sameScope(request.carryFrom, request.scope) || this.port?.context.role !== 'main') return;
    if (await keptDraft(request.carryFrom, request.scope)) return;
    const carries = await sourceCarries(request.carryFrom);
    const existing = carries.find(carry => (carry.kind === 'offered' || carry.kind === 'applied' || carry.kind === 'cancelled' || carry.kind === 'refused' && request.purpose === 'passive') && carry.target && sameScope(carry.target, request.scope));
    if (existing) { if (existing.kind === 'offered' || existing.kind === 'applied') onDependent?.(); return; }
    let context = record(await this.port.request({ kind: 'intent-context' }), ['epoch', 'pendingCarryRequests']), epoch = count(context.epoch);
    const pending = () => { if (!Array.isArray(context.pendingCarryRequests) || context.pendingCarryRequests.length > 1024) throw new Error('Invalid native carry inventory'); return context.pendingCarryRequests.map(value => identifier(value, 200)); };
    if (await pruneDraftCarryHistory(epoch, pending()) >= 1000) {
      context = record(await this.port.request({ kind: 'intent-context', retireAfter: epoch }), ['epoch', 'pendingCarryRequests']); epoch = count(context.epoch);
      await pruneDraftCarryHistory(epoch, pending());
    }
    const requestId = `${epoch}:main-${reservation.transitionId}`;
    const unbound = carries.find(carry => carry.kind === 'offered' && carry.target === null && carry.requestId.endsWith(`:main-${reservation.transitionId}`));
    if (unbound) { onDependent?.(); await bindDraftCarry(request.carryFrom, unbound.requestId, request.scope); return; }
    const captured = await this.capture(requestId, request.carryFrom, request.carryEmptyOnly);
    if (captured) {
      try { await bindDraftCarry(request.carryFrom, requestId, request.scope); }
      catch (error) {
        try { await captured.cancel(); }
        catch (cancelError) { onDependent?.(); throw cancelError; }
        throw error;
      }
      onDependent?.();
    }
  }
  async acquire(request: Request, owner: Owner): Promise<PlacementAcquisition> {
    const current = this.placementGuards.get(JSON.stringify(request.scope));
    let policyCurrent: (() => boolean) | null = null, committed = false;
    let attempted: NativeReservation | null = null, launchAttempted = false;
    let observedDetached: Extract<ConversationOpenResult, { readonly kind: 'detached' }> | null = null;
    let readyCarryWarning: string | null = null;
    let untouched: { readonly reservation: NativeReservation; readonly previous: NativeReservation | null } | null = null;
    const assertCurrent = () => { if (!committed && (current && !current() || policyCurrent && !policyCurrent())) throw new PlacementSuperseded(); };
    try {
      assertCurrent();
      if (request.purpose === 'passive' && this.port?.context.role === 'chat') {
        const { binding } = await BrowserViewStorage.locateEditor(request.scope);
        if (binding && !owner.holds(binding.viewId)) {
          const origin = await nativeEditorOrigin(binding).catch(error => { assertCurrent(); throw error; });
          assertCurrent();
          if (origin) return { kind: 'refused', reason: 'This saved native editor needs an explicit reopen.' };
        }
      }
      if (this.port?.context.role === 'chat') {
        if (!sameScope(this.port.context.reservation.scope, request.scope)) return this.intent({ kind: 'open', scope: request.scope, carry: request.carryFrom !== null, ...(request.purpose === 'passive' ? { passive: true } : {}) }, request.scope, request.carryEmptyOnly);
        if (owner.storage.viewId !== this.port.context.viewId) throw new Error('The child editor changed its assigned saved view.');
        return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
      }
      let native = await this.lookup(request.scope);
      if (native.kind === 'ready') observedDetached = { kind: 'detached', scope: request.scope, label: native.reservation.label };
      if (current && !current()) {
        if (native.kind === 'ready') return { kind: 'detached', scope: request.scope, label: native.reservation.label };
        if (native.kind === 'closed' && native.reservation.phase === 'target-ready') {
          let binding: EditorBinding | null;
          try { binding = (await BrowserViewStorage.locateEditor(request.scope, owner.storage.viewId)).binding; }
          catch (error) { assertCurrent(); throw error; }
          if (closedReadyEditor(native, binding)) return { kind: 'detached', scope: request.scope, label: native.reservation.label };
        }
      }
      assertCurrent();
      if (native.kind === 'opening' || native.kind === 'ready') {
        attempted = native.reservation;
        const observed = native;
        if (observed.kind === 'ready') await this.carryToNative(request, native.reservation).catch(error => { readyCarryWarning = placementReason(error); this.diagnostic(readyCarryWarning); });
        else await this.carryToNative(request, native.reservation);
        const { binding } = await BrowserViewStorage.locateEditor(request.scope);
        if (binding && binding.viewId === native.reservation.viewId && (binding.kind === 'editing' || binding.targetLabel === native.reservation.label && binding.transitionId === native.reservation.transitionId)) await this.track(native.reservation, binding);
        assertCurrent();
        launchAttempted = true;
        const focused = await this.focus(request, native.reservation);
        if (observed.kind === 'ready') return { kind: 'detached', scope: request.scope, label: observed.reservation.label };
        if (focused) return focused;
        native = await this.lookup(request.scope);
        if (native.kind === 'ready') observedDetached = { kind: 'detached', scope: request.scope, label: native.reservation.label };
        if (native.kind === 'closed' && native.reservation.phase === 'target-ready' && native.reservation.viewId === observed.reservation.viewId && native.reservation.label === observed.reservation.label && native.reservation.transitionId === observed.reservation.transitionId) return { kind: 'detached', scope: request.scope, label: native.reservation.label };
        assertCurrent();
        if (native.kind === 'opening' || native.kind === 'ready') return this.rememberPending({ kind: 'pending', scope: request.scope, reason: 'The recorded window is closing. Retry opening this chat after it finishes.' }, native.reservation);
      }
      const located = await BrowserViewStorage.locateEditor(request.scope, owner.storage.viewId);
      assertCurrent();
      let binding = located.binding;
      if (request.purpose === 'passive') {
        if (native.kind === 'closed' && closedReadyEditor(native, binding)) return { kind: 'detached', scope: request.scope, label: native.reservation.label };
        if (binding && !owner.holds(binding.viewId)) {
          const origin = await nativeEditorOrigin(binding).catch(error => { assertCurrent(); throw error; });
          assertCurrent();
          if (origin) return { kind: 'refused', reason: 'This saved native editor needs an explicit reopen.' };
        }
      }
      const selectedLegacy = located.legacyViewIds.includes(owner.storage.viewId) ? owner.storage.viewId : null;
      if (located.legacyViewIds.length > 1 && selectedLegacy === null) {
        return { kind: 'refused', reason: `Independent saved work exists in views ${located.legacyViewIds.join(', ')}. Open the saved view you want to recover before moving this chat. All records are preserved.` };
      }
      const sourceViewId = binding?.viewId ?? selectedLegacy ?? located.legacyViewIds[0] ?? null;
      const viewId = binding?.viewId ?? (native.kind === 'absent' ? null : native.reservation.viewId) ?? crypto.randomUUID();
      const separate = this.port?.context.role === 'main' && this.port.context.liveRelay && (this.forced.get(JSON.stringify(request.scope)) ?? this.presentation.chats) === 'separate';
      if (separate) {
        if (!this.forced.has(JSON.stringify(request.scope))) policyCurrent = this.presentationCurrent;
        assertCurrent();
        const reclaimed = binding?.kind === 'editing' && native.kind === 'closed' && native.reservation.phase === 'target-ready'
          && binding.viewId === native.reservation.viewId && native.reservation.bindingRevision !== null && native.reservation.writerGeneration !== null
          && binding.revision >= native.reservation.bindingRevision && binding.writerGeneration >= native.reservation.writerGeneration
          && (binding.revision > native.reservation.bindingRevision || binding.writerGeneration > native.reservation.writerGeneration);
        const recoveredInline = binding?.kind === 'editing' && native.kind === 'closed' && native.reservation.phase === 'inline-ready' && binding.viewId === native.reservation.viewId;
        const reservation = parseNativeReservation(await this.port.request({ kind: 'reserve', scope: request.scope, viewId, creationAgentId: request.creation ? request.agentId : null, newTransition: binding?.kind === 'editing' && (request.purpose !== 'passive' || reclaimed || recoveredInline), ...(request.intentRef ? { intentRef: request.intentRef } : {}) }));
        attempted = reservation;
        if (request.purpose === 'passive' && reservation.phase === 'target-ready') {
          if (binding?.kind === 'editing' && binding.viewId === reservation.viewId && binding.revision === reservation.bindingRevision && binding.writerGeneration === reservation.writerGeneration) return { kind: 'detached', scope: request.scope, label: reservation.label };
          return { kind: 'refused', reason: 'This saved native editor needs an explicit reopen.' };
        }
        if (native.kind === 'absent') untouched = { reservation, previous: null };
        else if (native.kind === 'closed' && binding?.kind === 'editing' && (native.reservation.phase === 'target-ready' || native.reservation.phase === 'inline-ready' || native.reservation.phase === 'failed') && reservation.transitionId !== native.reservation.transitionId) untouched = { reservation, previous: native.reservation };
        assertCurrent();
        // A reserved user request finishes; appearance-driven moves keep their explicit current guard.
        policyCurrent = null;
        await this.carryToNative(request, reservation, () => { untouched = null; });
        assertCurrent();
        if (request.creation && !binding && sourceViewId === null) {
          if (request.initialDraft !== null && request.initialDraft !== undefined) {
            await BrowserViewStorage.prepareCreationDraft({ scope: request.scope, viewId: reservation.viewId, label: reservation.label, transitionId: reservation.transitionId, agentId: request.agentId }, request.initialDraft, assertCurrent);
            committed = true;
          }
          assertCurrent(); untouched = null; launchAttempted = true; return await this.launch(request, reservation);
        }
        await this.track(reservation, { revision: handoffRevision(binding) });
        assertCurrent();
        if (binding?.kind === 'handoff-reserved') {
          if (binding.viewId !== reservation.viewId || binding.targetLabel !== reservation.label || binding.transitionId !== reservation.transitionId) throw new Error('The saved handoff and native reservation disagree. Recover the recorded target before retrying.');
        } else {
          await this.transfer(request, owner, binding, sourceViewId ?? viewId, reservation, assertCurrent, () => { committed = true; untouched = null; });
        }
        committed = true; untouched = null;
        if (binding?.kind !== 'handoff-reserved' || reservation.phase === 'requested' || reservation.phase === 'failed' || reservation.phase === 'target-ready' || reservation.phase === 'inline-ready') await this.phase(reservation, 'source-saved');
        if (binding?.kind !== 'handoff-reserved' || reservation.phase !== 'source-released') {
          await this.phase(reservation, 'transfer-committed'); await this.phase(reservation, 'source-released');
        }
        assertCurrent(); launchAttempted = true; return await this.launch(request, reservation);
      }
      const savedResult = await this.savedIntentResult(request);
      if (savedResult) return savedResult;
      assertCurrent();
      if (binding?.kind === 'editing' && owner.holds(binding.viewId)) return { kind: 'inline', view: { kind: 'owned', viewId: binding.viewId } };
      const label = this.port?.context.label ?? this.browserLabel();
      if (binding?.kind === 'handoff-reserved' && binding.targetLabel !== label) {
        if (!this.port && binding.targetLabel.startsWith('browser:')) binding = await BrowserViewStorage.recoverBrowserHandoff(binding, label);
        else return { kind: 'pending', scope: request.scope, reason: 'This chat is reserved for its recorded target. Retry that window or recover the failed handoff before opening another editor.' };
      }
      const transitionId = binding?.kind === 'handoff-reserved' ? binding.transitionId : crypto.randomUUID();
      if (sourceViewId !== null || !request.creation) {
        const reservation: NativeReservation = { scope: request.scope, viewId, label, transitionId, creationAgentId: request.creation ? request.agentId : null,
          phase: 'requested', bindingRevision: null, writerGeneration: null };
        await this.transfer(request, owner, binding, sourceViewId ?? viewId, reservation, assertCurrent, () => { committed = true; });
      }
      assertCurrent();
      const storage = await BrowserViewStorage.claimEditor({ scope: request.scope, viewId, label, transitionId,
        creation: request.creation ? { agentId: request.agentId } : null }, () => {});
      return { kind: 'inline', view: { kind: 'acquired', storage } };
    } catch (error) {
      if (observedDetached) {
        if (!(error instanceof PlacementSuperseded)) this.diagnostic(placementReason(readyCarryWarning ? `${readyCarryWarning} ${placementReason(error)}` : error));
        else if (readyCarryWarning) this.diagnostic(readyCarryWarning);
        return observedDetached;
      }
      try { const savedResult = await this.savedIntentResult(request); if (savedResult) return savedResult; }
      catch { /* Preserve the placement failure until durable intent authority is available. */ }
      if (attempted) {
        try {
          const verified = await this.lookup(request.scope);
          if (verified.kind !== 'absent' && sameScope(verified.reservation.scope, attempted.scope) && verified.reservation.viewId === attempted.viewId
            && verified.reservation.label === attempted.label && verified.reservation.transitionId === attempted.transitionId) {
            if ((verified.kind === 'ready' || verified.kind === 'closed') && verified.reservation.phase === 'target-ready') return { kind: 'detached', scope: attempted.scope, label: attempted.label };
            if (launchAttempted && verified.kind === 'opening' && verified.reservation.phase !== 'failed') return this.rememberPending({ kind: 'pending', scope: attempted.scope,
              reason: 'The assigned window is still opening. Its recorded result will update when it is ready.' }, verified.reservation);
          }
        } catch { /* The original launch failure remains authoritative without exact readiness evidence. */ }
      }
      if (untouched && this.port) {
        try {
          const { reservation, previous } = untouched;
          await this.port.request({ kind: 'cancel-reservation', scope: reservation.scope, transitionId: reservation.transitionId, ...(previous ? { previous } : {}) });
        }
        catch { return { kind: 'refused', reason: 'This placement changed before work moved, but its native reservation could not be confirmed cancelled. Inspect saved window recovery before retrying.' }; }
      }
      if (error instanceof PlacementSuperseded) throw error;
      return { kind: 'refused', reason: placementReason(error) };
    }
  }
}
