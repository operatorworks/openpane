import { parseDelivery, parseUiClientSnapshot, parseWindowContext, parseDisplaySubscription, parseDisplayDelivery, sameScope } from '@openpane/contracts';
import type { ConversationScope, DisplaySubscription, DeliveryEnvelope, UiClientSnapshot, WindowContext } from '@openpane/contracts';
import { count, hex, identifier, record } from '@openpane/contracts/decode';
import type { NativeUiRelayPort, UiConnectionSnapshot, UiTransport } from './ui-connection.js';
import { DisplayClient, NO_DISPLAY } from './display-client.js';
import { DesktopWindowPort } from './window-context.js';

function nativeChildren(value: unknown, main: WindowContext): readonly { readonly context: WindowContext; readonly visible: boolean; readonly presenceSequence: number; readonly display: DisplaySubscription | null; readonly placement: { readonly nativeTransitionId: string; readonly bindingRevision: number } | null }[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid native child presence');
  return value.map(value => {
    const child = record(value, ['context', 'visible', 'presenceSequence', 'placement', 'display']), context = parseWindowContext(child.context);
    if (context.role !== 'chat' || context.brokerInstance !== main.brokerInstance || context.hostId !== main.hostId || context.profileId !== main.profileId || typeof child.visible !== 'boolean') throw new Error('Foreign native child presence');
    const placement = child.placement === null ? null : record(child.placement, ['nativeTransitionId', 'bindingRevision']);
    const bindingRevision = placement === null ? null : count(placement.bindingRevision);
    if (bindingRevision === 0) throw new Error('Invalid native placement revision');
    const display = child.display === null ? null : parseDisplaySubscription(child.display);
    if (display && !sameScope(display.scope, context.scope)) throw new Error('Foreign native card subscription');
    return { context, display, visible: child.visible, presenceSequence: count(child.presenceSequence), placement: placement === null || bindingRevision === null ? null : { nativeTransitionId: identifier(placement.nativeTransitionId, 200), bindingRevision } };
  });
}
function paintedReport(value: unknown): {
  readonly kind: 'rendered' | 'failed'; readonly deliveryGeneration: number; readonly selectionRevision: number; readonly digest: string | null;
  readonly envelope: DeliveryEnvelope | null; readonly reason: string | null;
} {
  const input = record(value, ['kind', 'deliveryGeneration', 'selectionRevision', 'digest', 'envelope', 'reason']);
  if (input.kind !== 'rendered' && input.kind !== 'failed') throw new Error('Invalid child appearance report');
  if (input.kind === 'rendered' && input.reason !== null) throw new Error('Unexpected child paint failure');
  const envelope = input.envelope === null ? null : parseDelivery(input.envelope);
  const deliveryGeneration = count(input.deliveryGeneration), selectionRevision = count(input.selectionRevision), digest = input.digest === null ? null : hex(input.digest, 64);
  if (envelope && (envelope.deliveryGeneration !== deliveryGeneration || envelope.selectionRevision !== selectionRevision || envelope.digest !== digest)) throw new Error('Child report envelope mismatch');
  return { kind: input.kind, deliveryGeneration, selectionRevision, digest, envelope, reason: input.reason === null ? null : identifier(input.reason, 500) };
}

export class NativeMainUiRelay implements NativeUiRelayPort {
  private previousChildren = new Set<string>();
  constructor(private readonly port: DesktopWindowPort) {}
  async publish(snapshot: UiClientSnapshot, main: WindowContext, post: (request: unknown) => Promise<unknown>): Promise<boolean> {
    const drained = record(await this.port.request({ kind: 'drain-ui' }), ['children', 'reports', 'localBuiltin']);
    const children = nativeChildren(drained.children, main);
    const live = new Set(children.map(child => child.context.documentIncarnation));
    const departed = [...this.previousChildren].filter(id => !live.has(id));
    const reply = record(await post({ op: 'relay', main, children, departed }), ['children']);
    if (!Array.isArray(reply.children) || reply.children.length !== children.length) throw new Error('Invalid scoped UI relay state');
    const scoped = reply.children.map(value => {
      const child = record(value, ['incarnation', 'envelope', 'display']), incarnation = identifier(child.incarnation, 200);
      if (!live.has(incarnation)) throw new Error('Unregistered scoped UI state');
      const display = child.display === null ? null : parseDisplayDelivery(child.display);
      const expected = children.find(child => child.context.documentIncarnation === incarnation)?.display;
      const identity = display?.kind === 'page' ? display.page : display;
      if (identity && (!expected || !sameScope(identity.scope, expected.scope) || identity.subscriptionId !== expected.subscriptionId)) throw new Error('Foreign native card delivery');
      return { incarnation, envelope: child.envelope === null ? null : parseDelivery(child.envelope), display };
    });
    await this.port.request({ kind: 'publish-ui', snapshot, children: scoped });
    this.previousChildren = live;
    if (!Array.isArray(drained.reports) || drained.reports.length > 64) throw new Error('Invalid child report queue');
    for (const value of drained.reports) {
      const entry = record(value, ['id', 'context', 'report']), id = identifier(entry.id, 200), context = parseWindowContext(entry.context);
      if (!live.has(context.documentIncarnation)) { await this.port.request({ kind: 'confirm-ui', ids: [id] }); continue; }
      if (!children.some(child => child.context.documentIncarnation === context.documentIncarnation && child.visible)) continue;
      const report = paintedReport(entry.report);
      // Old generations are explicitly retired, never counted as a paint of the current delivery.
      if (report.deliveryGeneration !== snapshot.selection.deliveryGeneration) { await this.port.request({ kind: 'confirm-ui', ids: [id] }); continue; }
      try {
      if (report.kind === 'rendered') await post({ op: 'paint', session: context.documentIncarnation,
        deliveryGeneration: report.deliveryGeneration, selectionRevision: report.selectionRevision, digest: report.digest });
      if (report.envelope) await post({ op: 'ack', session: context.documentIncarnation, envelope: report.envelope,
        result: report.kind === 'rendered' ? { kind: 'rendered' } : { kind: 'failed', reason: report.reason ?? 'Appearance failed' } });
      } catch (error) {
        // Compaction may retire a receipt without changing its delivery generation.
        if (!(error instanceof Error && 'code' in error && ['not-found', 'expired', 'conflict'].includes(String(error.code)))) throw error;
      }
      await this.port.request({ kind: 'confirm-ui', ids: [id] });
    }
    return children.some(child => {
      if (!child.visible || !child.display) return false;
      const delivery = scoped.find(value => value.incarnation === child.context.documentIncarnation)?.display;
      if (!delivery) return child.display.cursor?.kind !== 'live';
      if (delivery.kind === 'unavailable') return false;
      const page = delivery.page;
      return page.kind === 'reset' || page.kind === 'snapshot' && page.next.kind === 'snapshot' || page.kind === 'changes' && page.next.sequence < page.highWater;
    });
  }
  close(): void {}
}

/** A child reads only its caller-checked native cache. Conversation traffic remains on its normal service connection. */
export class ChildUiConnection implements UiTransport {
  private snapshot: UiConnectionSnapshot = { state: null, diagnostic: null, localBuiltin: false, cards: NO_DISPLAY };
  private readonly cards = new DisplayClient();
  private readonly listeners = new Set<() => void>();
  private readonly unlisten: (() => void)[] = [];
  private started = false;
  private closed = false;
  private reading = false;
  private requested = false;
  private confirmed: string | null = null;
  private painted: UiClientSnapshot | null = null;
  constructor(private readonly port: DesktopWindowPort) {
    if (port.context.role !== 'chat') throw new Error('A chat UI cache requires a registered child context');
  }
  getSnapshot = (): UiConnectionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<UiConnectionSnapshot>): void {
    if (this.closed) return;
    this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener();
  }
  start(): void {
    if (this.started) return; this.started = true;
    for (const event of ['openpane-ui-wakeup', 'openpane-ui-cache'] as const) void this.port.listen(event, this.refresh).then(unlisten => { if (this.closed) unlisten(); else { this.unlisten.push(unlisten); this.refresh(); } }, error => this.update({ diagnostic: error instanceof Error ? error.message : 'Native UI relay unavailable' }));
    document.addEventListener('visibilitychange', this.visibility);
  }
  private visibility = (): void => { void this.presence().then(this.refresh, () => this.update({ diagnostic: 'Native presence could not be confirmed' })); };
  private presence(): Promise<unknown> { return this.port.request({ kind: 'presence', visible: document.visibilityState === 'visible', display: this.cards.subscription() }); }
  selectScope(scope: ConversationScope | null): void {
    if (scope && (this.port.context.role !== 'chat' || !sameScope(scope, this.port.context.reservation.scope))) throw new Error('A child may only read its assigned cards');
    if (this.cards.select(scope)) { this.update({ cards: this.cards.getSnapshot() }); this.visibility(); }
  }
  refreshCards(): void { if (this.cards.refresh()) { this.update({ cards: this.cards.getSnapshot() }); this.visibility(); } }
  refresh = (): void => {
    this.requested = true;
    if (this.reading || this.closed) return;
    this.reading = true;
    void (async () => {
      while (this.requested && !this.closed) {
        this.requested = false;
        try {
          const value = record(await this.port.request({ kind: 'read-ui' }), ['state', 'localBuiltin', 'context']);
          if (typeof value.localBuiltin !== 'boolean') throw new Error('Invalid native recovery state');
          if (value.context !== null) {
            const context = parseWindowContext(value.context);
            if (this.cards.profile(context.profileId, context.hostId)) await this.presence();
            if (context.role !== 'chat' || context.documentIncarnation !== this.port.context.documentIncarnation || context.viewId !== this.port.context.viewId) throw new Error('Native relay changed window identity');
          }
          const state = value.state === null ? null : parseUiClientSnapshot(value.state);
          const advanced = this.cards.accept(state?.display ?? null);
          this.update({ state, cards: this.cards.getSnapshot(), localBuiltin: value.localBuiltin, diagnostic: state?.fault ?? null });
          if (advanced) await this.presence();
          if (state && this.painted?.selection.deliveryGeneration === state.selection.deliveryGeneration && document.visibilityState === 'visible') await this.rendered(state);
        } catch (error) { this.update({ diagnostic: error instanceof Error ? error.message : 'Native UI relay unavailable' }); }
      }
      this.reading = false;
    })();
  };
  private async report(state: UiClientSnapshot, reason: string | null): Promise<void> {
    if (this.snapshot.localBuiltin && state.selection.selected.kind !== 'builtin') return;
    await this.port.request({ kind: 'report-ui', report: { kind: reason === null ? 'rendered' : 'failed', deliveryGeneration: state.selection.deliveryGeneration,
      selectionRevision: state.selection.revision, digest: state.bundle?.digest ?? null, envelope: state.envelope, reason } });
  }
  async rendered(state: UiClientSnapshot): Promise<void> {
    this.painted = state;
    const key = `${state.selection.deliveryGeneration}:${state.envelope?.requestId ?? ''}`;
    if (this.confirmed === key) return;
    await this.report(state, null); this.confirmed = key;
  }
  failed(state: UiClientSnapshot, reason: string): Promise<void> { return this.report(state, reason.slice(0, 500)); }
  async restore(): Promise<void> {
    this.update({ localBuiltin: true, diagnostic: 'OpenPane appearance is active locally. Main will save builtin selection.' });
    await this.port.request({ kind: 'restore-builtin' });
  }
  close(): void {
    this.closed = true;
    for (const unlisten of this.unlisten) unlisten();
    document.removeEventListener('visibilitychange', this.visibility); this.listeners.clear();
  }
}
