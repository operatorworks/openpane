import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, metricsEventSchema, parseScope } from '@openpane/contracts';
import type { ConversationScope, DisplayPage, DisplayReceipt, DisplaySubscription } from '@openpane/contracts';
import { count } from '@openpane/contracts/decode';
import { DisplayDatabase, displayDigest, displayEventReservation, displayMetadataReservation, displayPayloadReservation, displayRemovalReservation, DISPLAY_REMOVAL_ENTRIES, displayScope, displayText, publicationReceipt } from './ui-display-db.js';
import { DisplayPages } from './ui-display-pages.js';
import { queryReservation } from './ui-display-records.js';
import type { DisplayKey } from './ui-display-records.js';
import type { DisplayRequest } from './ui-display-protocol.js';
import { resolvePupRange } from './ui-pup.js';
import { UiRefusal } from './ui-protocol.js';

interface Owner { readonly scope: ConversationScope; readonly publicationId: string; readonly attempt: number; readonly connection: string }
interface Options {
  readonly db: DatabaseSync; readonly hostId: string; readonly epoch: () => number;
  readonly checkScope: (scope: ConversationScope) => boolean;
  readonly transaction: <T>(run: () => T) => T;
  readonly capacity: (bytes: number, entries: number) => void;
  readonly notify: () => void;
}
const operationKey = (scope: ConversationScope, publicationId: string): string => canonicalJson([scope, publicationId]);
const queryKey = (key: DisplayKey | null): Extract<DisplayKey, { readonly mode: 'query' }> => {
  if (!key) throw new UiRefusal('not-found', 'Display query not found');
  if (key.mode !== 'query') throw new UiRefusal('conflict', 'Publication ID belongs to a raw display event');
  return key;
};
function publishedReceipt(key: DisplayKey): DisplayReceipt | null {
  if (key.mode === 'raw') return key.receipt;
  if (key.outcome.kind === 'published' || key.outcome.kind === 'removed') return key.outcome.receipt;
  if (key.outcome.kind === 'failed' || key.outcome.kind === 'interrupted' || key.outcome.kind === 'abandoned') return null;
  throw new UiRefusal('conflict', 'Wait for the running query to settle before removing it');
}
export class UiDisplayStore {
  private readonly data: DisplayDatabase;
  private readonly pages: DisplayPages;
  private readonly owners = new Map<string, Owner>();
  private closed = false;
  constructor(private readonly options: Options) {
    this.data = new DisplayDatabase(options.db);
    this.pages = new DisplayPages(this.data, options.epoch, scope => this.scope(scope));
    options.transaction(() => {
      for (const row of options.db.prepare("SELECT scope,id FROM ui_display_keys WHERE state='running'").all()) {
        const scope = parseScope(JSON.parse(displayText(row.scope))), id = displayText(row.id), key = queryKey(this.data.key(scope, id));
        this.data.putKey(scope, id, { ...key, executeUntilMs: key.executeUntilMs || Date.now() + 45000, outcome: { kind: 'interrupted', reason: 'host-restarted' } }, 0, 0);
      }
    });
  }
  private scope(scope: ConversationScope, requireConversation = true): void {
    if (scope.hostId !== this.options.hostId) throw new UiRefusal('unavailable', 'Display scope belongs to another host');
    if (requireConversation && !this.options.checkScope(scope)) throw new UiRefusal('unavailable', 'Display conversation is unavailable');
  }
  private epoch(id: string): void {
    if (!/^\d+:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) throw new UiRefusal('invalid-input', 'Display IDs must be EPOCH:UUID from ui context');
    if (id.split(':')[0] !== String(this.options.epoch())) throw new UiRefusal('expired', 'Display request epoch expired; inspect ui context');
  }
  private connection(owner: string | null): string { if (!owner) throw new UiRefusal('unavailable', 'A live local query session is required'); return owner; }
  private owned(scope: ConversationScope, publicationId: string, attempt: number, owner: string | null): Extract<DisplayKey, { readonly mode: 'query' }> {
    const current = this.owners.get(operationKey(scope, publicationId)), connection = this.connection(owner), key = queryKey(this.data.key(scope, publicationId));
    if (!current || current.connection !== connection || current.attempt !== attempt || key.attempt !== attempt || key.outcome.kind !== 'running') throw new UiRefusal('conflict', 'Query session or attempt is no longer current');
    return key;
  }
  read(subscription: DisplaySubscription, options?: { readonly items?: number; readonly bytes?: number }): DisplayPage | null {
    return this.options.transaction(() => this.pages.read(subscription, options));
  }
  execute(request: DisplayRequest, owner: string | null = null): unknown {
    if (this.closed) throw new UiRefusal('unavailable', 'Display service is closed');
    if (request.op === 'display-schema') return { event: metricsEventSchema, source: 'OpenPane-authored display data' };
    if (request.op === 'display-list') return this.read(request.subscription);
    this.scope(request.scope, request.op !== 'display-remove');
    let committed = () => {};
    const result = this.options.transaction(() => {
      const { scope, publicationId } = request, key = this.data.key(scope, publicationId);
      switch (request.op) {
        case 'display-status': return key === null ? { mode: 'missing' } : key.mode === 'raw'
          ? { mode: 'raw', kind: key.removed ? 'removed' : 'published', receipt: key.receipt }
          : { mode: 'query', input: key.input, reservation: queryReservation(scope, publicationId, key) };
        case 'display-publish': {
          const inputDigest = displayDigest(request.event);
          if (key) {
            if (key.mode !== 'raw' || key.inputDigest !== inputDigest) throw new UiRefusal('conflict', 'Publication ID has a different mode or input');
            return { mode: 'raw', kind: key.removed ? 'removed' : 'published', receipt: key.receipt };
          }
          this.epoch(publicationId);
          const publication = this.data.preparePublication(scope, publicationId, request.event), payloadBytes = Buffer.byteLength(canonicalJson(publication));
          const created: DisplayKey = { version: 1, mode: 'raw', inputDigest, removed: false, receipt: publicationReceipt(publication) };
          this.data.reserveCapacity(scope, payloadBytes);
          this.options.capacity(displayMetadataReservation(scope, publicationId, created) + displayEventReservation(scope, publicationId) + displayRemovalReservation(scope, publicationId), 2 + DISPLAY_REMOVAL_ENTRIES);
          this.data.putKey(scope, publicationId, created, payloadBytes, 0); this.data.savePublication(publication);
          committed = this.options.notify;
          return { mode: 'raw', kind: 'published', receipt: created.receipt };
        }
        case 'display-query-reserve': {
          const connection = this.connection(owner), inputDigest = displayDigest(request.input);
          if (key) {
            const existing = queryKey(key);
            if (existing.inputDigest !== inputDigest) throw new UiRefusal('conflict', 'Query publication ID has different arguments');
            return { input: existing.input, reservation: queryReservation(scope, publicationId, existing), granted: false, executeUntilMs: null };
          }
          this.epoch(publicationId);
          const created: Extract<DisplayKey, { readonly mode: 'query' }> = { version: 1, mode: 'query', inputDigest, input: request.input,
            range: resolvePupRange(request.input.from, request.input.to, Date.now()), executeUntilMs: Date.now() + 30000, attempt: 1, outcome: { kind: 'running' } };
          const payloadBytes = displayPayloadReservation(scope, publicationId), eventBytes = displayEventReservation(scope, publicationId);
          this.data.reserveCapacity(scope, payloadBytes); this.options.capacity(displayMetadataReservation(scope, publicationId, created) + eventBytes + displayRemovalReservation(scope, publicationId), 2 + DISPLAY_REMOVAL_ENTRIES);
          this.data.putKey(scope, publicationId, created, payloadBytes, eventBytes);
          committed = () => { this.owners.set(operationKey(scope, publicationId), { scope, publicationId, attempt: created.attempt, connection }); };
          return { input: created.input, reservation: queryReservation(scope, publicationId, created), granted: true, executeUntilMs: created.executeUntilMs };
        }
        case 'display-query-retry': {
          const connection = this.connection(owner), existing = queryKey(key);
          if (existing.attempt !== request.expectedAttempt || !['failed', 'interrupted'].includes(existing.outcome.kind)) throw new UiRefusal('conflict', 'Retry requires the current failed or interrupted attempt');
          if (existing.outcome.kind === 'interrupted' && Date.now() < existing.executeUntilMs + 2000) throw new UiRefusal('conflict', `Previous query attempt is draining. Retry after ${new Date(existing.executeUntilMs + 2000).toISOString()}`);
          if (existing.attempt >= Number.MAX_SAFE_INTEGER) throw new UiRefusal('capacity', 'Query attempt generation exhausted');
          const updated = { ...existing, executeUntilMs: Date.now() + 30000, attempt: existing.attempt + 1, outcome: { kind: 'running' } } satisfies DisplayKey;
          const payloadBytes = displayPayloadReservation(scope, publicationId), eventBytes = displayEventReservation(scope, publicationId);
          this.data.reserveCapacity(scope, payloadBytes); this.options.capacity(eventBytes, 1); this.data.putKey(scope, publicationId, updated, payloadBytes, eventBytes);
          committed = () => { this.owners.set(operationKey(scope, publicationId), { scope, publicationId, attempt: updated.attempt, connection }); };
          return { input: updated.input, reservation: queryReservation(scope, publicationId, updated), granted: true, executeUntilMs: updated.executeUntilMs };
        }
        case 'display-query-finalize': {
          const existing = this.owned(scope, publicationId, request.attempt, owner), card = request.event.value;
          if (card.query !== existing.input.query || card.title !== existing.input.title || card.fromMs !== existing.range.fromSeconds * 1000 || card.toMs !== existing.range.toSeconds * 1000) throw new UiRefusal('conflict', 'Query result does not match its fixed reservation');
          const publication = this.data.preparePublication(scope, publicationId, request.event), payloadBytes = Buffer.byteLength(canonicalJson(publication));
          if (payloadBytes > displayPayloadReservation(scope, publicationId)) throw new UiRefusal('capacity', 'Query result exceeds its payload reservation');
          const updated = { ...existing, outcome: { kind: 'published', receipt: publicationReceipt(publication) } } satisfies DisplayKey;
          this.data.putKey(scope, publicationId, updated, payloadBytes, 0); this.data.savePublication(publication);
          committed = () => { this.owners.delete(operationKey(scope, publicationId)); this.options.notify(); };
          return { input: updated.input, reservation: queryReservation(scope, publicationId, updated) };
        }
        case 'display-query-fail': {
          const existing = this.owned(scope, publicationId, request.attempt, owner), updated = { ...existing, outcome: { kind: 'failed', reason: request.reason } } satisfies DisplayKey;
          this.data.putKey(scope, publicationId, updated, 0, 0); committed = () => { this.owners.delete(operationKey(scope, publicationId)); };
          return { input: updated.input, reservation: queryReservation(scope, publicationId, updated) };
        }
        case 'display-remove': {
          const inputDigest = displayDigest({ scope, publicationId });
          const replay = this.options.db.prepare('SELECT input_digest,result FROM ui_display_removals WHERE id=?').get(request.requestId);
          if (replay) {
            if (replay.input_digest !== inputDigest) throw new UiRefusal('conflict', 'Removal request ID has different input');
            return JSON.parse(displayText(replay.result));
          }
          this.epoch(request.requestId);
          if (!key) throw new UiRefusal('not-found', 'No published card exists for this ID');
          const receipt = publishedReceipt(key);
          const removed = key.mode === 'raw' ? key.removed : key.outcome.kind === 'removed' || key.outcome.kind === 'abandoned';
          const resultBytes = Buffer.byteLength(canonicalJson({ scope, publicationId, sequence: Number.MAX_SAFE_INTEGER, kind: 'removed' })) + 256;
          // The first removal consumes the two entries and bytes reserved with the active card.
          if (removed) this.options.capacity(resultBytes, 1);
          const sequence = removed ? count(this.options.db.prepare("SELECT max(sequence) AS sequence FROM ui_display_events WHERE scope=? AND id=? AND kind='removed'").get(displayScope(scope), publicationId)?.sequence)
            : this.data.removePublication(scope, publicationId);
          if (!sequence) throw new UiRefusal('unavailable', 'Removal history is unavailable');
          if (!removed) {
            const updated: DisplayKey = key.mode === 'raw' ? { ...key, removed: true } : { ...key, outcome: receipt ? { kind: 'removed', receipt } : { kind: 'abandoned' } };
            this.data.putKey(scope, publicationId, updated, 0, 0); committed = () => { this.pages.invalidate(scope); this.options.notify(); };
          }
          const result = { kind: 'removed', scope, publicationId, sequence }, serialized = canonicalJson(result);
          this.options.db.prepare('INSERT INTO ui_display_removals(id,input_digest,result,bytes) VALUES(?,?,?,?)').run(request.requestId, inputDigest, serialized, resultBytes);
          return result;
        }
      }
    });
    committed(); return result;
  }
  interrupt(connection: string): void {
    if (this.closed) return;
    const owned = [...this.owners].filter(([, value]) => value.connection === connection);
    if (!owned.length) return;
    this.options.transaction(() => {
      for (const [, value] of owned) {
        const key = this.data.key(value.scope, value.publicationId);
        if (key?.mode === 'query' && key.attempt === value.attempt && key.outcome.kind === 'running') this.data.putKey(value.scope, value.publicationId, { ...key, outcome: { kind: 'interrupted', reason: 'owner-disconnected' } }, 0, 0);
      }
    });
    for (const [id] of owned) this.owners.delete(id);
  }
  compactInTransaction(): void { this.data.compact(); }
  compacted(): void { this.pages.clear(); }
  close(): void {
    if (this.closed) return;
    for (const connection of new Set([...this.owners.values()].map(owner => owner.connection))) this.interrupt(connection);
    this.closed = true; this.pages.clear();
  }
}
