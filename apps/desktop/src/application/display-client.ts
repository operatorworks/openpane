import { canonicalJson, sameScope } from '@openpane/contracts';
import type { ConversationScope, DisplayDelivery, DisplayPublication, DisplaySubscription } from '@openpane/contracts';

export type DisplayView = { readonly kind: 'none' }
  | { readonly kind: 'loading' | 'ready'; readonly scope: ConversationScope; readonly publications: readonly DisplayPublication[] }
  | { readonly kind: 'unavailable'; readonly scope: ConversationScope; readonly publications: readonly DisplayPublication[]; readonly reason: string };
export const NO_DISPLAY: DisplayView = { kind: 'none' };
interface Stage { readonly id: string; readonly highWater: number; readonly publications: Map<string, DisplayPublication> }
/** One subscription belongs to one profile, scope and document-local generation. */
export class DisplayClient {
  private profileId: string | null = null;
  private hostId: string | null = null;
  private selected: ConversationScope | null = null;
  private current: DisplaySubscription | null = null;
  private view: DisplayView = NO_DISPLAY;
  private stage: Stage | null = null;
  private backlog = false;
  getSnapshot(): DisplayView { return this.view; }
  subscription(): DisplaySubscription | null { return this.current; }
  needsPaging(): boolean { return this.current !== null && this.view.kind !== 'unavailable' && (this.backlog || this.current.cursor === null || this.current.cursor.kind === 'snapshot'); }
  profile(profileId: string, hostId: string): boolean {
    if (this.profileId === profileId && this.hostId === hostId) return false;
    this.profileId = profileId; this.hostId = hostId; this.reset(this.selected, false); return true;
  }
  select(scope: ConversationScope | null): boolean {
    if (scope === null ? this.selected === null : this.selected !== null && sameScope(scope, this.selected)) return false;
    this.reset(scope, false); return true;
  }
  refresh(): boolean { if (!this.selected) return false; this.reset(this.selected, true); return true; }
  private reset(scope: ConversationScope | null, retain: boolean): void {
    const publications = retain && this.view.kind !== 'none' ? this.view.publications : [];
    scope = scope === null ? null : { hostId: scope.hostId, conversationId: scope.conversationId };
    this.selected = scope; this.stage = null; this.backlog = false;
    if (!scope) { this.current = null; this.view = NO_DISPLAY; return; }
    if (this.hostId !== null && scope.hostId !== this.hostId) {
      this.current = null; this.view = { kind: 'unavailable', scope, publications: [], reason: 'This chat belongs to another host. Reconnect before reading its cards.' }; return;
    }
    this.current = { scope, subscriptionId: crypto.randomUUID(), cursor: null };
    this.view = { kind: 'loading', scope, publications };
  }
  accept(delivery: DisplayDelivery | null): boolean {
    const current = this.current;
    if (!delivery || !current) return false;
    const identity = delivery.kind === 'page' ? delivery.page : delivery;
    if (!sameScope(identity.scope, current.scope) || identity.subscriptionId !== current.subscriptionId || canonicalJson(identity.from) !== canonicalJson(current.cursor)) return false;
    const previousCursor = current.cursor;
    const existing = this.view.kind === 'none' ? [] : this.view.publications;
    try {
      if (delivery.kind === 'unavailable') { this.view = { kind: 'unavailable', scope: current.scope, publications: existing, reason: delivery.reason }; return false; }
      const page = delivery.page;
      if (page.kind === 'reset') {
        this.current = { ...current, cursor: null }; this.stage = null; this.backlog = false; this.view = { kind: 'loading', scope: current.scope, publications: existing };
      } else if (page.kind === 'snapshot') {
        if (current.cursor === null) this.stage = { id: page.snapshotId, highWater: page.highWater, publications: new Map() };
        const stage = this.stage;
        if (!stage || stage.id !== page.snapshotId || stage.highWater !== page.highWater) throw new Error('Display snapshot identity changed');
        for (const publication of page.publications) {
          const old = stage.publications.get(publication.publicationId);
          if (old && (old.sequence !== publication.sequence || old.digest !== publication.digest)) throw new Error('Display snapshot publication changed');
          stage.publications.set(publication.publicationId, publication);
        }
        if (stage.publications.size > 32) throw new Error('Display snapshot exceeds card capacity');
        if (page.next.kind === 'live') {
          const previous = new Map(existing.map(publication => [publication.publicationId, publication]));
          const publications = [...stage.publications.values()].sort((a, b) => a.sequence - b.sequence).map(publication => {
            const old = previous.get(publication.publicationId);
            if (old && (old.sequence !== publication.sequence || old.digest !== publication.digest)) throw new Error('An immutable display publication changed');
            return old ?? publication;
          });
          this.view = { kind: 'ready', scope: current.scope, publications }; this.stage = null;
        } else this.view = { kind: 'loading', scope: current.scope, publications: existing };
        this.current = { ...current, cursor: page.next };
        this.backlog = false;
      } else {
        if (current.cursor?.kind !== 'live') throw new Error('Display changes arrived before a complete snapshot');
        const publications = new Map(existing.map(publication => [publication.publicationId, publication]));
        for (const change of page.changes) {
          if (change.kind === 'removed') publications.delete(change.publicationId);
          else {
            const publication = change.publication, old = publications.get(publication.publicationId);
            if (old && (old.sequence !== publication.sequence || old.digest !== publication.digest)) throw new Error('An immutable display publication changed');
            publications.set(publication.publicationId, old ?? publication);
          }
        }
        if (publications.size > 32) throw new Error('Display changes exceed card capacity');
        if (page.changes.length || this.view.kind !== 'ready') this.view = { kind: 'ready', scope: current.scope, publications: [...publications.values()].sort((a, b) => a.sequence - b.sequence) };
        this.current = { ...current, cursor: page.next };
        this.backlog = page.next.sequence < page.highWater;
      }
    } catch {
      this.stage = null; this.view = { kind: 'unavailable', scope: current.scope, publications: existing, reason: 'Saved card identity changed. Reconnect after repairing the affected UI data.' };
    }
    return canonicalJson(previousCursor) !== canonicalJson(this.current?.cursor ?? null);
  }
}
