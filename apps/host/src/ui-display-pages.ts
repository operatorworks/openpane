import { randomUUID } from 'node:crypto';
import { canonicalJson, DISPLAY_PAGE_LIMITS, parseDisplayPage } from '@openpane/contracts';
import type { ConversationScope, DisplayChange, DisplayCursor, DisplayPage, DisplayPublication, DisplaySubscription } from '@openpane/contracts';
import { count } from '@openpane/contracts/decode';
import { DisplayDatabase, displayScope, displayText } from './ui-display-db.js';

interface Snapshot {
  readonly scope: string; readonly subscriptionId: string; readonly epoch: number; readonly highWater: number;
  readonly afters: Set<number>; expires: number; complete: boolean;
}
interface Issued { readonly epoch: number; readonly sequences: Set<number>; expires: number }
const lifetime = 60_000, maxSubscriptions = 128;
const subscriptionKey = (subscription: DisplaySubscription) => canonicalJson([subscription.scope, subscription.subscriptionId]);
const bytes = (page: DisplayPage) => Buffer.byteLength(canonicalJson({ ok: true, value: page }));
export class DisplayPages {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly issued = new Map<string, Issued>();
  constructor(private readonly data: DisplayDatabase, private readonly epoch: () => number, private readonly checkScope: (scope: ConversationScope) => void) {}
  clear(): void { this.snapshots.clear(); this.issued.clear(); }
  invalidate(scope: ConversationScope): void {
    const key = displayScope(scope);
    for (const [id, snapshot] of this.snapshots) if (snapshot.scope === key) this.snapshots.delete(id);
  }
  private expire(): void {
    const now = Date.now();
    for (const [id, snapshot] of this.snapshots) if (snapshot.expires < now || snapshot.epoch !== this.epoch()) this.snapshots.delete(id);
    for (const [id, cursor] of this.issued) if (cursor.expires < now || cursor.epoch !== this.epoch()) this.issued.delete(id);
  }
  private issue(subscription: DisplaySubscription, sequence: number): Extract<DisplayCursor, { readonly kind: 'live' }> {
    const id = subscriptionKey(subscription), epoch = this.epoch();
    let issued = this.issued.get(id);
    if (!issued) {
      if (this.issued.size >= maxSubscriptions) {
        const oldest = [...this.issued].sort((a, b) => a[1].expires - b[1].expires)[0];
        if (oldest) this.issued.delete(oldest[0]);
      }
      issued = { epoch, sequences: new Set(), expires: Date.now() + lifetime }; this.issued.set(id, issued);
    }
    issued.expires = Date.now() + lifetime; issued.sequences.add(sequence);
    while (issued.sequences.size > 64) {
      const oldest = [...issued.sequences].find(value => subscription.cursor?.kind !== 'live' || value !== subscription.cursor.sequence);
      if (oldest === undefined) break;
      issued.sequences.delete(oldest);
    }
    return { kind: 'live', epoch, sequence };
  }
  read(subscription: DisplaySubscription, options: { readonly items?: number; readonly bytes?: number } = {}): DisplayPage | null {
    this.checkScope(subscription.scope); this.data.requireReadable(subscription.scope); this.expire();
    const maximumItems = Math.min(DISPLAY_PAGE_LIMITS.items, options.items ?? DISPLAY_PAGE_LIMITS.items);
    const maximumBytes = Math.min(DISPLAY_PAGE_LIMITS.bytes, options.bytes ?? DISPLAY_PAGE_LIMITS.bytes);
    if (maximumItems < 1 || maximumBytes < 256) return null;
    const cursor = subscription.cursor, scope = displayScope(subscription.scope);
    const identity = { scope: subscription.scope, subscriptionId: subscription.subscriptionId, from: cursor };
    const reset = (): DisplayPage | null => {
      const page: DisplayPage = { ...identity, kind: 'reset' }; return bytes(page) <= maximumBytes ? page : null;
    };
    if (cursor?.kind === 'live') {
      const issued = this.issued.get(subscriptionKey(subscription));
      if (cursor.epoch !== this.epoch() || !issued?.sequences.has(cursor.sequence)) return reset();
      const highWater = this.data.sequence();
      const rows = this.data.db.prepare('SELECT sequence,id,kind FROM ui_display_events WHERE scope=? AND sequence>? ORDER BY sequence LIMIT ?').all(scope, cursor.sequence, maximumItems + 1);
      const changes: DisplayChange[] = []; let next = highWater, more = rows.length > maximumItems;
      for (const row of rows.slice(0, maximumItems)) {
        const sequence = count(row.sequence), publicationId = displayText(row.id);
        let change: DisplayChange;
        if (row.kind === 'published') {
          const publication = this.data.publication(subscription.scope, publicationId);
          if (!publication || publication.sequence !== sequence) return reset();
          change = { kind: 'published', publication };
        } else if (row.kind === 'removed') change = { kind: 'removed', publicationId, sequence };
        else throw new Error('Invalid stored display change');
        const candidate: DisplayPage = { ...identity, kind: 'changes', highWater, changes: [...changes, change], next: { kind: 'live', epoch: this.epoch(), sequence: highWater } };
        if (bytes(candidate) > maximumBytes) { more = true; break; }
        changes.push(change);
      }
      if (more) {
        const last = changes.at(-1); if (!last) return null;
        next = last.kind === 'published' ? last.publication.sequence : last.sequence;
      }
      const page: DisplayPage = { ...identity, kind: 'changes', highWater, changes, next: { kind: 'live', epoch: this.epoch(), sequence: next } };
      if (bytes(page) > maximumBytes) return null;
      parseDisplayPage(page); this.issue(subscription, next); return page;
    }
    let id: string, snapshot: Snapshot | undefined, after = 0;
    if (cursor) {
      id = cursor.snapshotId; snapshot = this.snapshots.get(id); after = cursor.after;
      if (!snapshot || snapshot.scope !== scope || snapshot.subscriptionId !== subscription.subscriptionId || snapshot.highWater !== cursor.highWater || !snapshot.afters.has(after)) return reset();
    } else {
      for (const [id, snapshot] of this.snapshots) if (snapshot.complete && snapshot.scope === scope && snapshot.subscriptionId === subscription.subscriptionId) this.snapshots.delete(id);
      const initial = [...this.snapshots].find(([, value]) => value.scope === scope && value.subscriptionId === subscription.subscriptionId && !value.complete);
      if (initial) { id = initial[0]; snapshot = initial[1]; }
      else {
        if (this.snapshots.size >= maxSubscriptions) {
          const oldest = [...this.snapshots].sort((a, b) => a[1].expires - b[1].expires)[0];
          if (oldest) this.snapshots.delete(oldest[0]);
        }
        id = randomUUID(); snapshot = { scope, subscriptionId: subscription.subscriptionId, epoch: this.epoch(), highWater: this.data.sequence(), afters: new Set([0]), complete: false, expires: Date.now() + lifetime };
        this.snapshots.set(id, snapshot);
      }
    }
    snapshot.expires = Date.now() + lifetime;
    const highWater = snapshot.highWater;
    const rows = this.data.db.prepare('SELECT id FROM ui_display_cards WHERE scope=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(scope, after, highWater, maximumItems + 1);
    const publications: DisplayPublication[] = []; let more = rows.length > maximumItems;
    for (const row of rows.slice(0, maximumItems)) {
      const publication = this.data.publication(subscription.scope, displayText(row.id));
      if (!publication) return reset();
      const candidate: DisplayPage = { ...identity, kind: 'snapshot', snapshotId: id, highWater, publications: [...publications, publication], next: { kind: 'snapshot', snapshotId: id, highWater, after: publication.sequence } };
      if (bytes(candidate) > maximumBytes) { more = true; break; }
      publications.push(publication);
    }
    const last = publications.at(-1);
    if (more && !last) return null;
    const next: DisplayCursor = more && last ? { kind: 'snapshot', snapshotId: id, highWater, after: last.sequence } : { kind: 'live', epoch: this.epoch(), sequence: highWater };
    const page: DisplayPage = { ...identity, kind: 'snapshot', snapshotId: id, highWater, publications, next };
    if (bytes(page) > maximumBytes) return null;
    parseDisplayPage(page);
    if (next.kind === 'snapshot') snapshot.afters.add(next.after); else { this.issue(subscription, next.sequence); snapshot.complete = true; }
    return page;
  }
}
