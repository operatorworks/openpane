import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, METRICS_CARD_LIMITS, METRICS_EVENT_NAME, parseDisplayPublication, sameScope } from '@openpane/contracts';
import type { ConversationScope, DisplayPublication, DisplayReceipt } from '@openpane/contracts';
import { count } from '@openpane/contracts/decode';
import { parseDisplayKey, keyState } from './ui-display-records.js';
import type { DisplayKey } from './ui-display-records.js';
import { UiRefusal } from './ui-protocol.js';

export const displayDigest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function displayText(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 128 * 1024) throw new Error('Invalid or oversized stored display text');
  return value;
}
export const displayScope = (scope: ConversationScope): string => canonicalJson(scope);
export function publicationReceipt(publication: DisplayPublication): DisplayReceipt {
  return { scope: publication.scope, publicationId: publication.publicationId, sequence: publication.sequence, publishedAtMs: publication.publishedAtMs, digest: publication.digest };
}
const maxReceipt = (scope: ConversationScope, publicationId: string): DisplayReceipt => ({ scope, publicationId, sequence: Number.MAX_SAFE_INTEGER, publishedAtMs: Number.MAX_SAFE_INTEGER, digest: 'a'.repeat(64) });
export function displayPayloadReservation(scope: ConversationScope, publicationId: string): number {
  return METRICS_CARD_LIMITS.bytes + Buffer.byteLength(canonicalJson({ ...maxReceipt(scope, publicationId), event: { type: 'CUSTOM', name: METRICS_EVENT_NAME, value: null } })) + 32;
}
export function displayMetadataReservation(scope: ConversationScope, publicationId: string, key: DisplayKey): number {
  return Buffer.byteLength(canonicalJson(key)) + 256 + (key.mode === 'query' ? Buffer.byteLength(canonicalJson(maxReceipt(scope, publicationId))) : 0);
}
export const DISPLAY_REMOVAL_ENTRIES = 2, DISPLAY_REMOVAL_OVERHEAD = 1024;
export function displayRemovalReservation(scope: ConversationScope, publicationId: string): number {
  return DISPLAY_REMOVAL_ENTRIES * (Buffer.byteLength(displayScope(scope)) + Buffer.byteLength(publicationId)) + DISPLAY_REMOVAL_OVERHEAD;
}
export function displayEventReservation(scope: ConversationScope, publicationId: string): number {
  return Buffer.byteLength(canonicalJson({ scope, publicationId, sequence: Number.MAX_SAFE_INTEGER, kind: 'published' }));
}

/** Display records share the UI transaction and never write conversation data. */
export class DisplayDatabase {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS ui_display_meta (id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL);
      INSERT OR IGNORE INTO ui_display_meta(id,sequence) VALUES(1,0);
      CREATE TABLE IF NOT EXISTS ui_display_keys (scope TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, state TEXT NOT NULL,
        metadata_bytes INTEGER NOT NULL, reserved_event_bytes INTEGER NOT NULL, payload_bytes INTEGER NOT NULL, slot INTEGER NOT NULL,
        PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS ui_display_cards (scope TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL UNIQUE,
        value TEXT NOT NULL, PRIMARY KEY(scope,id), FOREIGN KEY(scope,id) REFERENCES ui_display_keys(scope,id));
      CREATE INDEX IF NOT EXISTS ui_display_cards_scope_sequence ON ui_display_cards(scope,sequence);
      CREATE TABLE IF NOT EXISTS ui_display_events (sequence INTEGER PRIMARY KEY, scope TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, bytes INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ui_display_events_scope_sequence ON ui_display_events(scope,sequence);
      CREATE TABLE IF NOT EXISTS ui_display_removals (id TEXT PRIMARY KEY, input_digest TEXT NOT NULL, result TEXT NOT NULL, bytes INTEGER NOT NULL);`);
    this.sequence();
  }
  sequence(): number {
    const row = this.db.prepare(`SELECT sequence,(SELECT coalesce(max(sequence),0) FROM ui_display_cards) AS cards,
      (SELECT coalesce(max(sequence),0) FROM ui_display_events) AS events FROM ui_display_meta WHERE id=1`).get();
    if (!row) throw new Error('Display sequence is unavailable');
    const sequence = count(row.sequence);
    if (sequence < count(row.cards) || sequence < count(row.events)) throw new Error('Display sequence moved behind its retained data');
    return sequence;
  }
  private nextSequence(): number {
    const current = this.sequence();
    if (current >= Number.MAX_SAFE_INTEGER) throw new UiRefusal('capacity', 'Display sequence exhausted');
    const sequence = current + 1; this.db.prepare('UPDATE ui_display_meta SET sequence=? WHERE id=1').run(sequence); return sequence;
  }
  key(scope: ConversationScope, publicationId: string): DisplayKey | null {
    const row = this.db.prepare('SELECT value,state FROM ui_display_keys WHERE scope=? AND id=?').get(displayScope(scope), publicationId);
    if (!row) return null;
    const key = parseDisplayKey(JSON.parse(displayText(row.value)), scope, publicationId);
    if (row.state !== keyState(key)) throw new Error('Stored display state disagrees with its record');
    return key;
  }
  putKey(scope: ConversationScope, publicationId: string, key: DisplayKey, payloadBytes: number, reservedEventBytes: number): void {
    const value = canonicalJson(key), existing = this.db.prepare('SELECT metadata_bytes FROM ui_display_keys WHERE scope=? AND id=?').get(displayScope(scope), publicationId);
    const metadataBytes = existing ? count(existing.metadata_bytes) : displayMetadataReservation(scope, publicationId, key);
    if (Buffer.byteLength(value) > metadataBytes) throw new UiRefusal('capacity', 'Display record exceeded its reserved metadata');
    const state = keyState(key), slot = state === 'running' || state === 'published' ? 1 : 0;
    this.db.prepare(`INSERT INTO ui_display_keys(scope,id,value,state,metadata_bytes,reserved_event_bytes,payload_bytes,slot) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(scope,id) DO UPDATE SET value=excluded.value,state=excluded.state,reserved_event_bytes=excluded.reserved_event_bytes,payload_bytes=excluded.payload_bytes,slot=excluded.slot`)
      .run(displayScope(scope), publicationId, value, state, metadataBytes, reservedEventBytes, payloadBytes, slot);
  }
  reserveCapacity(scope: ConversationScope, payloadBytes: number): void {
    const all = this.db.prepare('SELECT coalesce(sum(payload_bytes),0) AS bytes FROM ui_display_keys').get();
    const scoped = this.db.prepare('SELECT coalesce(sum(slot),0) AS slots FROM ui_display_keys WHERE scope=?').get(displayScope(scope));
    if (!all || !scoped || count(all.bytes) + payloadBytes > 32 * 1024 * 1024 || count(scoped.slots) >= 32) throw new UiRefusal('capacity', 'Display capacity reached; remove a card before publishing another');
  }
  preparePublication(scope: ConversationScope, publicationId: string, event: DisplayPublication['event']): DisplayPublication {
    return { scope, publicationId, event, sequence: this.nextSequence(), publishedAtMs: Date.now(), digest: displayDigest(event) };
  }
  savePublication(publication: DisplayPublication): void {
    this.db.prepare('INSERT INTO ui_display_cards(scope,id,sequence,value) VALUES(?,?,?,?)').run(displayScope(publication.scope), publication.publicationId, publication.sequence, canonicalJson(publication));
    this.event(publication.scope, publication.publicationId, publication.sequence, 'published');
  }
  private event(scope: ConversationScope, publicationId: string, sequence: number, kind: 'published' | 'removed'): void {
    const bytes = Buffer.byteLength(canonicalJson({ scope, publicationId, sequence, kind }));
    this.db.prepare('INSERT INTO ui_display_events(sequence,scope,id,kind,bytes) VALUES(?,?,?,?,?)').run(sequence, displayScope(scope), publicationId, kind, bytes);
  }
  publication(scope: ConversationScope, publicationId: string): DisplayPublication | null {
    const row = this.db.prepare('SELECT value FROM ui_display_cards WHERE scope=? AND id=?').get(displayScope(scope), publicationId);
    if (!row) return null;
    const publication = parseDisplayPublication(JSON.parse(displayText(row.value)));
    if (!sameScope(publication.scope, scope) || publication.publicationId !== publicationId || publication.digest !== displayDigest(publication.event)) throw new Error('Stored display payload identity or digest mismatch');
    return publication;
  }
  removePublication(scope: ConversationScope, publicationId: string): number {
    this.db.prepare('DELETE FROM ui_display_cards WHERE scope=? AND id=?').run(displayScope(scope), publicationId);
    const sequence = this.nextSequence(); this.event(scope, publicationId, sequence, 'removed'); return sequence;
  }
  requireReadable(scope: ConversationScope): void {
    const row = this.db.prepare(`SELECT (SELECT count(*) FROM ui_display_keys WHERE scope=? AND state='published') AS expected,
      (SELECT count(*) FROM ui_display_cards WHERE scope=?) AS actual`).get(displayScope(scope), displayScope(scope));
    if (!row || row.expected !== row.actual) throw new UiRefusal('unavailable', 'Stored display payload is unavailable; remove the affected card or repair UI data');
  }
  compact(): void {
    this.db.exec(`DELETE FROM ui_display_keys WHERE state IN ('removed','abandoned'); DELETE FROM ui_display_events; DELETE FROM ui_display_removals;`);
  }
}
