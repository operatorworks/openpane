import { pruneDraftCarryHistory } from './draft-carry.js';
import { parseConversationOpenResult } from '@openpane/contracts';
import type { ConversationOpenResult, ConversationScope, EditorBinding, ExperienceV1 } from '@openpane/contracts';
import { sameScope } from '@openpane/contracts';
import { count, record } from '@openpane/contracts/decode';
import { BrowserViewStorage } from './browser-storage.js';
import type { PlacementAcquisition, PlacementPort } from './placement-port.js';
import { DesktopWindowPort, parseNativeReservation } from './window-context.js';
import type { NativeReservation, NativePlacementIntent } from './window-context.js';

type Request = Parameters<PlacementPort['acquire']>[0];
type Owner = Parameters<PlacementPort['acquire']>[1];
const DEFAULT_WINDOW: ExperienceV1['presentation']['chatWindow'] = { width: 640, height: 720, titlebar: 'native', title: 'agent-and-conversation' };

/** Native intents allocate conversations; IndexedDB bindings decide where their drafts live. */
export class WindowCoordinator implements PlacementPort {
  private readonly forced = new Map<string, 'inline' | 'separate'>();
  async placeExplicitly<T>(scope: ConversationScope, mode: 'inline' | 'separate', operation: () => Promise<T>): Promise<T> {
    const key = JSON.stringify(scope); if (this.forced.has(key)) throw new Error('A recovery of this chat is already in progress.');
    this.forced.set(key, mode); try { return await operation(); } finally { this.forced.delete(key); }
  }
  private presentation: ExperienceV1['presentation'] = { navigation: 'rail', chats: 'inline', chatWindow: DEFAULT_WINDOW };
  private track: (reservation: NativeReservation, binding: EditorBinding) => Promise<void> = async () => {};
  trackPlacement(handler: (reservation: NativeReservation, binding: EditorBinding) => Promise<void>): void { this.track = handler; }
  private notice: (result: ConversationOpenResult, requestId: string) => void = () => {};
  observeIntent(handler: (result: ConversationOpenResult, requestId: string) => void): void { this.notice = handler; }
  private capture: (requestId: string) => Promise<{ readonly cancel: () => Promise<void> } | null> = async () => null;
  captureCarry(handler: (requestId: string) => Promise<{ readonly cancel: () => Promise<void> } | null>): void { this.capture = handler; }
  private readonly browserLabel: () => string;
  constructor(private readonly port: DesktopWindowPort | null, browserLabel?: () => string) {
    const id = crypto.randomUUID(); this.browserLabel = browserLabel ?? (() => `browser:${id}`);
  }
  setPresentation(value: ExperienceV1['presentation'] | null): void {
    this.presentation = value ?? { navigation: 'rail', chats: 'inline', chatWindow: DEFAULT_WINDOW };
  }
  async restoresInline(scope: ConversationScope): Promise<boolean> {
    if (this.port?.context.role !== 'main' || !this.port.context.liveRelay) return true;
    if (this.presentation.chats === 'separate' || (await this.lookup(scope)).live) return false;
    const { binding } = await BrowserViewStorage.locateEditor(scope);
    return binding?.kind !== 'handoff-reserved' || binding.targetLabel === this.port.context.label;
  }
  delegateCreate = async (agentId: string, carry: boolean, initialDraft: string | null = null): Promise<ConversationOpenResult | null> => {
    if (this.port?.context.role !== 'chat') return null;
    if (initialDraft) return { kind: 'refused', reason: 'This message stays here. Start the new chat from main, then copy it to that chat.' };
    return this.intent({ kind: 'create', agentId, carry }, null);
  };
  private async intent(action: NativePlacementIntent['action'], scope: ConversationScope | null): Promise<Exclude<ConversationOpenResult, { readonly kind: 'inline' }>> {
    if (!this.port) return { kind: 'refused', reason: 'Native placement is unavailable.' };
    let requestId: string = crypto.randomUUID(), captured: { readonly cancel: () => Promise<void> } | null = null;
    try {
      let context = record(await this.port.request({ kind: 'intent-context' }), ['epoch']), epoch = count(context.epoch);
      if (!epoch) throw new Error('Invalid native request epoch');
      if (action.carry && await pruneDraftCarryHistory(epoch) >= 1000) {
        context = record(await this.port.request({ kind: 'intent-context', retireAfter: epoch }), ['epoch']); epoch = count(context.epoch);
        await pruneDraftCarryHistory(epoch);
      }
      requestId = `${epoch}:${requestId}`;
      captured = action.carry ? await this.capture(requestId) : null;
      const canonical = { ...action, carry: captured !== null };
      const intent = record(await this.port.request({ kind: 'placement-intent', requestId, action: canonical }));
      if (intent.result !== null && intent.result !== undefined) {
        const result = parseConversationOpenResult(intent.result);
        return result.kind === 'inline' ? { kind: 'detached', scope: result.scope, label: 'main' } : result;
      }
      const target = intent.target === null ? null : parseNativeReservation(intent.target);
      const pending = { kind: 'pending', scope: target?.scope ?? scope, reason: 'Main is coordinating the requested chat.' } as const; this.notice(pending, requestId); return pending;
    } catch (error) {
      let reason = error instanceof Error ? error.message : String(error);
      try { await captured?.cancel(); } catch { reason += ' The draft remains pending in its source; recover local storage before retrying.'; }
      const result = { kind: 'refused', reason } as const; this.notice(result, requestId); return result;
    }
  }
  private geometry(request: Request): object {
    const policy = this.presentation.chatWindow;
    const title = policy.title === 'agent' ? request.agentLabel : policy.title === 'conversation' ? request.scope.conversationId : `${request.agentLabel} · ${request.scope.conversationId}`;
    let bounded = ''; for (const character of title) { if (bounded.length + character.length > 200) break; bounded += character; }
    return { width: policy.width, height: policy.height, titlebar: policy.titlebar, title: bounded };
  }
  private async lookup(scope: ConversationScope): Promise<{ readonly reservation: NativeReservation | null; readonly live: boolean }> {
    if (!this.port) return { reservation: null, live: false };
    const value = record(await this.port.request({ kind: 'lookup', scope }), ['reservation', 'live']);
    if (typeof value.live !== 'boolean') throw new Error('Invalid native reservation liveness');
    return { reservation: value.reservation === null ? null : parseNativeReservation(value.reservation), live: value.live };
  }
  private launch(request: Request): Promise<Exclude<ConversationOpenResult, { readonly kind: 'inline' }>> {
    if (!this.port) return Promise.resolve({ kind: 'refused', reason: 'Native placement is unavailable.' });
    return this.port.request({ kind: 'launch', scope: request.scope, geometry: this.geometry(request) }).then(value => {
      const result = parseConversationOpenResult(value);
      if (result.kind === 'inline') throw new Error('A native child cannot become an inline editor in main.');
      return result;
    });
  }
  private async phase(reservation: NativeReservation, phase: NativeReservation['phase']): Promise<void> {
    await this.port?.request({ kind: 'phase', scope: reservation.scope, transitionId: reservation.transitionId, phase });
  }
  private async transfer(request: Request, owner: Owner, binding: EditorBinding | null, sourceViewId: string, reservation: NativeReservation): Promise<EditorBinding> {
    if (owner.storage.viewId === sourceViewId) await owner.quiesce();
    const plan = { scope: request.scope, sourceViewId, targetViewId: reservation.viewId,
      transitionId: reservation.transitionId, targetLabel: reservation.label, expectedBinding: binding };
    if (owner.storage.viewId === sourceViewId && owner.storage instanceof BrowserViewStorage && owner.storage.editorBinding()) {
      const committed = await owner.storage.reserveHandoff(plan);
      await owner.release();
      return committed;
    }
    if (owner.storage.viewId === sourceViewId) await owner.release();
    return BrowserViewStorage.transferClosed(plan);
  }
  async acquire(request: Request, owner: Owner): Promise<PlacementAcquisition> {
    try {
      if (this.port?.context.role === 'chat') {
        if (!sameScope(this.port.context.reservation.scope, request.scope)) return this.intent({ kind: 'open', scope: request.scope, carry: request.carryFrom !== null }, request.scope);
        if (owner.storage.viewId !== this.port.context.viewId) throw new Error('The child editor changed its assigned saved view.');
        return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
      }
      const native = await this.lookup(request.scope);
      if (native.live) return this.launch(request);
      const located = await BrowserViewStorage.locateEditor(request.scope), binding = located.binding;
      const selectedLegacy = located.legacyViewIds.includes(owner.storage.viewId) ? owner.storage.viewId : null;
      if (located.legacyViewIds.length > 1 && selectedLegacy === null) {
        return { kind: 'refused', reason: `Independent saved work exists in views ${located.legacyViewIds.join(', ')}. Open the saved view you want to recover before moving this chat. All records are preserved.` };
      }
      const sourceViewId = binding?.viewId ?? selectedLegacy ?? located.legacyViewIds[0] ?? null;
      const viewId = binding?.viewId ?? native.reservation?.viewId ?? crypto.randomUUID();
      const separate = this.port?.context.role === 'main' && this.port.context.liveRelay && (this.forced.get(JSON.stringify(request.scope)) ?? this.presentation.chats) === 'separate';
      if (separate) {
        const reservation = parseNativeReservation(await this.port.request({ kind: 'reserve', scope: request.scope, viewId, creationAgentId: request.creation ? request.agentId : null, newTransition: binding?.kind === 'editing' }));
        if (request.creation && !binding && sourceViewId === null) {
          if (request.initialDraft !== null && request.initialDraft !== undefined) await BrowserViewStorage.prepareCreationDraft({ scope: request.scope, viewId: reservation.viewId, label: reservation.label, transitionId: reservation.transitionId, agentId: request.agentId }, request.initialDraft);
          return this.launch(request);
        }
        let committed: EditorBinding;
        if (binding?.kind === 'handoff-reserved') {
          if (binding.viewId !== reservation.viewId || binding.targetLabel !== reservation.label || binding.transitionId !== reservation.transitionId) throw new Error('The saved handoff and native reservation disagree. Recover the recorded target before retrying.');
          committed = binding;
        } else {
          await this.phase(reservation, 'source-saved');
          committed = await this.transfer(request, owner, binding, sourceViewId ?? viewId, reservation);
        }
        await this.track(reservation, committed);
        if (reservation.phase === 'requested' || reservation.phase === 'failed' || reservation.phase === 'target-ready') await this.phase(reservation, 'source-saved');
        if (reservation.phase !== 'source-released') {
          await this.phase(reservation, 'transfer-committed'); await this.phase(reservation, 'source-released');
        }
        return this.launch(request);
      }
      if (binding?.kind === 'editing' && owner.holds(binding.viewId)) return { kind: 'inline', view: { kind: 'owned', viewId: binding.viewId } };
      const label = this.port?.context.label ?? this.browserLabel();
      if (binding?.kind === 'handoff-reserved' && binding.targetLabel !== label) return { kind: 'pending', scope: request.scope, reason: 'This chat is reserved for its recorded target. Retry that window or recover the failed handoff before opening another editor.' };
      const transitionId = binding?.kind === 'handoff-reserved' ? binding.transitionId : crypto.randomUUID();
      if (sourceViewId !== null || !request.creation) {
        const reservation: NativeReservation = { scope: request.scope, viewId, label, transitionId, creationAgentId: request.creation ? request.agentId : null,
          phase: 'requested', bindingRevision: null, writerGeneration: null };
        await this.transfer(request, owner, binding, sourceViewId ?? viewId, reservation);
      }
      const storage = await BrowserViewStorage.claimEditor({ scope: request.scope, viewId, label, transitionId,
        creation: request.creation ? { agentId: request.agentId } : null }, () => {});
      return { kind: 'inline', view: { kind: 'acquired', storage } };
    } catch (error) { return { kind: 'refused', reason: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }; }
  }
}
