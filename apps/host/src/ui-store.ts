import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ApplyReceipt, ExperienceBundle, UiAppearance, UiSelection, WindowContext } from '@openpane/contracts';
import { canonicalJson, experienceSchema, parseUiAppearance, parseUiSelection, parseWindowContext } from '@openpane/contracts';
import { count, identifier, record } from '@openpane/contracts/decode';
import { EXPERIENCE_PARTS, parseExperienceBundle, sha256 } from './experience-bundle.js';
import { parseDeliveryEnvelope, UiRefusal } from './ui-protocol.js';
import type { UiRequest } from './ui-protocol.js';

const MAX_BUNDLES = 16, MAX_BUNDLE_BYTES = 32 * 1024 * 1024, MAX_RECEIPTS = 4096, MAX_METADATA_BYTES = 32 * 1024 * 1024;
const PRESENCE_MS = 15000;
interface StoreState {
  readonly version: 1; readonly profileId: string; readonly epoch: number; readonly recoveryGeneration: number;
  readonly selection: UiSelection; readonly healthy: UiAppearance;
  readonly recovery: { readonly requestId: string; readonly requestDigest: string; readonly result: ApplyReceipt } | null;
}
interface Session { readonly context: WindowContext; readonly visible: boolean; readonly sequence: number; readonly seen: number; readonly digest: string | null; readonly stagedDigest: string | null; readonly initialized: boolean }
function text(value: unknown): string { if (typeof value !== 'string') throw new Error('Corrupt UI store text'); return value; }
function parseReceipt(value: unknown): ApplyReceipt {
  const input = record(value, ['requestId', 'deliveryGeneration', 'selectionRevision', 'digest', 'requestDigest', 'participants']);
  const envelope = parseDeliveryEnvelope({ requestId: input.requestId, deliveryGeneration: input.deliveryGeneration, selectionRevision: input.selectionRevision, digest: input.digest });
  if (!Array.isArray(input.participants) || input.participants.length > 32) throw new Error('Corrupt UI receipt cohort');
  const participants = input.participants.map((value: unknown) => {
    const participant = record(value, ['slot', 'visual', 'placement']);
    const slot = record(participant.slot, ['kind', 'context']);
    if (slot.kind !== 'document') throw new Error('Unsupported UI transition');
    const context = parseWindowContext(slot.context);
    const visual = record(participant.visual);
    let result: ApplyReceipt['participants'][number]['visual'];
    if (visual.kind === 'pending' || visual.kind === 'failed') { record(visual, ['kind', 'reason']); result = { kind: visual.kind, reason: identifier(visual.reason, 500) }; }
    else if (visual.kind === 'rendered' || visual.kind === 'departed' || visual.kind === 'superseded') { record(visual, ['kind']); result = { kind: visual.kind }; }
    else throw new Error('Corrupt UI visual outcome');
    const placement = record(participant.placement, ['kind']);
    if (placement.kind !== 'unchanged') throw new Error('Unsupported UI placement');
    return { slot: { kind: 'document', context } as const, visual: result, placement: { kind: 'unchanged' } as const };
  });
  return { ...envelope, requestDigest: identifier(input.requestDigest, 64), participants };
}
function parseState(value: unknown): StoreState {
  const input = record(value, ['version', 'profileId', 'epoch', 'recoveryGeneration', 'selection', 'healthy', 'recovery']);
  if (input.version !== 1) throw new Error('Unsupported UI database version');
  const recovery = input.recovery === null ? null : record(input.recovery, ['requestId', 'requestDigest', 'result']);
  return { version: 1, profileId: identifier(input.profileId, 200), epoch: count(input.epoch), recoveryGeneration: count(input.recoveryGeneration),
    selection: parseUiSelection(input.selection), healthy: parseUiAppearance(input.healthy),
    recovery: recovery === null ? null : { requestId: identifier(recovery.requestId, 128), requestDigest: identifier(recovery.requestDigest, 64), result: parseReceipt(recovery.result) } };
}
function initial(): StoreState {
  return { version: 1, profileId: randomUUID(), epoch: 1, recoveryGeneration: 1, selection: { revision: 0, deliveryGeneration: 0, selected: { kind: 'builtin' }, previousHealthy: { kind: 'builtin' } }, healthy: { kind: 'builtin' }, recovery: null };
}
function next(value: number): number { if (value >= Number.MAX_SAFE_INTEGER) throw new UiRefusal('capacity', 'UI generation exhausted'); return value + 1; }
const digestOf = (selection: UiAppearance): string | null => selection.kind === 'experience' ? selection.digest : null;
export function receiptStatus(receipt: ApplyReceipt): string {
  if (!receipt.participants.length) return 'selected-with-no-clients';
  const outcomes = receipt.participants.map(participant => participant.visual.kind);
  if (outcomes.every(kind => kind === 'rendered')) return 'all-rendered';
  if (outcomes.includes('superseded')) return 'superseded';
  if (outcomes.includes('pending')) return 'pending';
  if (outcomes.every(kind => kind === 'failed')) return 'failed';
  return 'partial';
}
export class UiStore {
  private readonly db: DatabaseSync;
  private state: StoreState;
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<() => void>();
  private change = 0;
  private closed = false;
  readonly recoveryReason: string | null;
  constructor(path: string, readonly hostId: string, private readonly targets: (after: string | null) => unknown = () => { throw new UiRefusal('unavailable', 'Conversation catalog unavailable'); }) {
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS ui_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ui_bundles (digest TEXT PRIMARY KEY, value TEXT NOT NULL, bytes INTEGER NOT NULL, created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ui_receipts (id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, result TEXT NOT NULL, generation INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ui_operations (id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, result TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ui_receipts_generation ON ui_receipts(generation);`);
      const row = this.db.prepare('SELECT value FROM ui_state WHERE id=1').get();
      this.state = row ? parseState(JSON.parse(text(row.value))) : initial();
      this.recoveryReason = this.validateSelection();
      this.transaction(() => {
        for (const row of this.db.prepare('SELECT id,result FROM ui_receipts').all()) {
          const receipt = parseReceipt(JSON.parse(text(row.result)));
          this.writeReceipt({ ...receipt, participants: receipt.participants.map(participant => participant.visual.kind === 'pending' ? { ...participant, visual: { kind: 'departed' } } : participant) });
        }
        if (this.state.recovery) {
          const result = this.state.recovery.result;
          this.state = { ...this.state, recovery: { ...this.state.recovery, result: { ...result, participants: result.participants.map(participant => participant.visual.kind === 'pending' ? { ...participant, visual: { kind: 'departed' } } : participant) } } };
        }
      });
    } catch (error) { this.db.close(); throw error; }
  }
  private validateSelection(): string | null {
    const selected = this.state.selection.selected;
    if (selected.kind === 'builtin') return null;
    try { this.bundle(selected.digest); return null; }
    catch {
      this.state = { ...this.state, selection: { ...this.state.selection, revision: next(this.state.selection.revision), deliveryGeneration: next(this.state.selection.deliveryGeneration), selected: { kind: 'builtin' } }, healthy: { kind: 'builtin' } };
      return 'Selected experience is missing or invalid; builtin appearance is active. Repair UI data before applying again.';
    }
  }
  private transaction<T>(run: () => T): T {
    if (this.closed) throw new UiRefusal('unavailable', 'UI store is closed');
    const before = this.state;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.prepare('INSERT OR REPLACE INTO ui_state(id,value) VALUES (1,?)').run(canonicalJson(this.state));
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); this.state = before; throw error; }
  }
  private notify(): void { this.change = next(this.change); for (const listener of this.listeners) listener(); }
  context(): object {
    return { version: 1, hostId: this.hostId, profileId: this.state.profileId, requestEpoch: this.state.epoch, recoveryGeneration: this.state.recoveryGeneration,
      revision: this.state.selection.revision, selection: this.state.selection, capabilities: ['experiences-v1'], fault: this.recoveryReason };
  }
  bundle(digest: string): ExperienceBundle {
    const row = this.db.prepare('SELECT value FROM ui_bundles WHERE digest=?').get(digest);
    if (!row) throw new UiRefusal('not-found', 'Experience bundle unavailable');
    const bundle = parseExperienceBundle(JSON.parse(text(row.value)));
    if (bundle.digest !== digest) throw new Error('Corrupt UI bundle identity');
    return bundle;
  }
  private readReceipt(id: string): ApplyReceipt | null {
    if (id === this.state.recovery?.requestId) return this.state.recovery.result;
    const row = this.db.prepare('SELECT result FROM ui_receipts WHERE id=?').get(id);
    return row ? parseReceipt(JSON.parse(text(row.result))) : null;
  }
  private writeReceipt(receipt: ApplyReceipt): void {
    if (receipt.requestId === this.state.recovery?.requestId) { this.state = { ...this.state, recovery: { ...this.state.recovery, result: receipt } }; return; }
    const value = canonicalJson(receipt);
    this.db.prepare(`INSERT INTO ui_receipts(id,request_digest,result,generation,reserved_bytes) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET result=excluded.result`).run(receipt.requestId, receipt.requestDigest, value, receipt.deliveryGeneration, this.receiptBytes(receipt));
  }
  private checkEpoch(id: string): void {
    if (!/^\d+:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) throw new UiRefusal('invalid-input', 'Request ID must be EPOCH:UUID from ui context');
    if (id.split(':')[0] !== String(this.state.epoch)) throw new UiRefusal('expired', 'Request epoch expired; inspect ui context');
  }
  private expire(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) if (now - session.seen > PRESENCE_MS) { this.depart(id); this.sessions.delete(id); }
  }
  private depart(session: string): void {
    for (const receipt of this.receipts()) {
      const participants = receipt.participants.map(participant => participant.slot.kind === 'document' && participant.slot.context.documentIncarnation === session && participant.visual.kind === 'pending'
        ? { ...participant, visual: { kind: 'departed' } as const } : participant);
      this.writeReceipt({ ...receipt, participants });
    }
  }
  private receipts(): ApplyReceipt[] {
    const values = this.db.prepare('SELECT result FROM ui_receipts WHERE generation=?').all(this.state.selection.deliveryGeneration).map(row => parseReceipt(JSON.parse(text(row.result))));
    if (this.state.recovery?.result.deliveryGeneration === this.state.selection.deliveryGeneration) values.push(this.state.recovery.result);
    return values;
  }
  private receiptBytes(receipt: ApplyReceipt): number { return Buffer.byteLength(canonicalJson(receipt)) + receipt.participants.length * 4096; }
  private capacity(reservedBytes = 0): void {
    const row = this.db.prepare('SELECT count(*) AS count, coalesce(sum(bytes),0) AS bytes FROM (SELECT reserved_bytes AS bytes FROM ui_receipts UNION ALL SELECT length(CAST(result AS BLOB)) AS bytes FROM ui_operations)').get();
    if (!row || count(row.count) >= MAX_RECEIPTS || count(row.bytes) + reservedBytes > MAX_METADATA_BYTES) throw new UiRefusal('capacity', 'UI receipt capacity reached; run maintenance compact');
  }
  private select(request: Extract<UiRequest, { op: 'apply' | 'refresh' | 'restore' }>): ApplyReceipt {
    const requestDigest = sha256(canonicalJson(request));
    const replay = this.readReceipt(request.requestId);
    if (this.db.prepare('SELECT id FROM ui_operations WHERE id=?').get(request.requestId)) throw new UiRefusal('conflict', 'Request ID belongs to another UI operation');
    if (replay) {
      if (replay.requestDigest !== requestDigest) throw new UiRefusal('conflict', 'Request ID has different input');
      return replay;
    }
    if (request.op === 'restore') {
      if (!new RegExp(`^recovery:${request.expectedRecoveryGeneration}:[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}$`, 'i').test(request.requestId)) throw new UiRefusal('invalid-input', 'Use recovery:GENERATION:UUID');
      if (request.expectedRecoveryGeneration !== this.state.recoveryGeneration) throw new UiRefusal('expired', 'Recovery generation expired');
    } else { this.checkEpoch(request.requestId); this.capacity(); }
    if (request.expectedRevision !== this.state.selection.revision) throw new UiRefusal('stale-revision', `Current UI revision is ${this.state.selection.revision}`);
    this.expire();
    if (this.sessions.size > 32) throw new UiRefusal('capacity', `${this.sessions.size} compatible windows; close windows to at most 32 before applying`);
    if (request.op === 'apply' && !this.db.prepare('SELECT digest FROM ui_bundles WHERE digest=?').get(request.bundle.digest)) {
      const value = canonicalJson(request.bundle), bytes = Buffer.byteLength(value);
      const usage = this.db.prepare('SELECT count(*) AS count, coalesce(sum(bytes),0) AS bytes FROM ui_bundles').get();
      if (!usage || count(usage.count) >= MAX_BUNDLES || count(usage.bytes) + bytes > MAX_BUNDLE_BYTES) throw new UiRefusal('capacity', 'Experience capacity reached; prune unreferenced bundles');
      this.db.prepare('INSERT INTO ui_bundles VALUES (?,?,?,?)').run(request.bundle.digest, value, bytes, Date.now());
    }
    const selected: UiAppearance = request.op === 'apply' ? { kind: 'experience', digest: request.bundle.digest } : request.op === 'restore' ? { kind: 'builtin' } : this.state.selection.selected;
    const selection: UiSelection = { revision: request.op === 'refresh' ? this.state.selection.revision : next(this.state.selection.revision), deliveryGeneration: next(this.state.selection.deliveryGeneration), selected, previousHealthy: this.state.healthy };
    for (const old of this.receipts()) this.writeReceipt({ ...old, participants: old.participants.map(participant => participant.visual.kind === 'pending' ? { ...participant, visual: { kind: 'superseded' } } : participant) });
    const receipt: ApplyReceipt = { requestId: request.requestId, requestDigest, deliveryGeneration: selection.deliveryGeneration, selectionRevision: selection.revision, digest: digestOf(selected),
      participants: [...this.sessions.values()].map(session => ({ slot: { kind: 'document', context: session.context }, visual: { kind: 'pending', reason: session.visible ? 'Awaiting a painted frame' : 'Window is hidden' }, placement: { kind: 'unchanged' } })) };
    if (request.op !== 'restore') this.capacity(this.receiptBytes(receipt));
    this.state = { ...this.state, selection };
    if (request.op === 'restore') this.state = { ...this.state, recoveryGeneration: next(this.state.recoveryGeneration), recovery: { requestId: request.requestId, requestDigest, result: receipt } };
    else this.writeReceipt(receipt);
    return receipt;
  }
  private status(id: string): object {
    const receipt = this.readReceipt(id);
    if (receipt) return { receipt, outcome: receiptStatus(receipt), ...(receipt.participants.length ? {} : { instruction: 'No compatible clients. Run ./openpane to launch a compatible desktop.' }) };
    if (id.startsWith('recovery:')) throw new UiRefusal('expired', 'Recovery record expired');
    this.checkEpoch(id); throw new UiRefusal('not-found', 'UI request not found');
  }
  private present(request: Extract<UiRequest, { op: 'state' }>): void {
    const context = request.context;
    if (context.hostId !== this.hostId || context.profileId !== this.state.profileId) throw new UiRefusal('conflict', 'UI window belongs to another profile');
    const previous = this.sessions.get(context.documentIncarnation);
    if (previous && (canonicalJson(previous.context) !== canonicalJson(context) || request.presenceSequence <= previous.sequence)) throw new UiRefusal('conflict', 'Stale or conflicting window presence');
    for (const [id, session] of this.sessions) if (id !== context.documentIncarnation && session.context.brokerInstance === context.brokerInstance && session.context.label === context.label) { this.depart(id); this.sessions.delete(id); }
    if (!previous && this.sessions.size >= 64) throw new UiRefusal('capacity', 'Too many UI sessions; close windows');
    this.sessions.set(context.documentIncarnation, { context, visible: request.visible, seen: Date.now(), sequence: request.presenceSequence, digest: previous?.digest ?? null, stagedDigest: previous?.stagedDigest ?? null, initialized: previous?.initialized ?? false });
  }
  private snapshot(session: string): object {
    const selected = this.state.selection.selected;
    const current = this.sessions.get(session);
    if (current) this.sessions.set(session, { ...current, initialized: true, digest: current.initialized ? current.digest : digestOf(selected), stagedDigest: digestOf(selected) });
    const pending = this.receipts().find(receipt => receipt.deliveryGeneration === this.state.selection.deliveryGeneration && receipt.participants.some(participant => participant.slot.kind === 'document' && participant.slot.context.documentIncarnation === session && participant.visual.kind === 'pending'));
    return { version: 1, change: this.change, selection: this.state.selection, bundle: selected.kind === 'builtin' ? null : { manifest: this.bundle(selected.digest).manifest, digest: selected.digest },
      envelope: pending ? { requestId: pending.requestId, deliveryGeneration: pending.deliveryGeneration, selectionRevision: pending.selectionRevision, digest: pending.digest } : null, fault: this.recoveryReason };
  }
  async execute(request: UiRequest): Promise<unknown> {
    switch (request.op) {
      case 'context': return this.context();
      case 'targets': return this.targets(request.after);
      case 'schema': return { manifest: experienceSchema, parts: EXPERIENCE_PARTS };
      case 'apply': case 'refresh': case 'restore': {
        const receipt = this.transaction(() => this.select(request)); this.notify(); return { receipt, outcome: receiptStatus(receipt) };
      }
      case 'status': return this.transaction(() => { this.expire(); return this.status(request.requestId); });
      case 'compact': return this.transaction(() => {
        if (request.expectedEpoch !== this.state.epoch) throw new UiRefusal('expired', 'Request epoch already advanced');
        this.db.exec('DELETE FROM ui_receipts; DELETE FROM ui_operations;'); this.state = { ...this.state, epoch: next(this.state.epoch) };
        return { epoch: this.state.epoch, abandoned: 'Unconfirmed visual deliveries are abandoned; no drafts or query attempts are changed' };
      });
      case 'prune': return this.transaction(() => {
        this.checkEpoch(request.requestId);
        const digest = sha256(canonicalJson(request));
        const replay = this.db.prepare('SELECT request_digest,result FROM ui_operations WHERE id=?').get(request.requestId);
        if (replay) {
          if (replay.request_digest !== digest) throw new UiRefusal('conflict', 'Request ID has different input');
          return JSON.parse(text(replay.result));
        }
        if (this.readReceipt(request.requestId)) throw new UiRefusal('conflict', 'Request ID belongs to another UI operation');
        this.capacity(); this.expire();
        const selected = digestOf(this.state.selection.selected), previous = digestOf(this.state.selection.previousHealthy);
        const pins = new Set([selected, previous, digestOf(this.state.healthy), ...[...this.sessions.values()].flatMap(session => [session.digest, session.stagedDigest])]);
        const rows = this.db.prepare('SELECT digest FROM ui_bundles ORDER BY created DESC, digest').all();
        const removed = [];
        for (const row of rows.slice(request.keep)) { const digest = text(row.digest); if (!pins.has(digest)) { this.db.prepare('DELETE FROM ui_bundles WHERE digest=?').run(digest); removed.push(digest); } }
        const result = { removed }; this.capacity(Buffer.byteLength(canonicalJson(result)));
        this.db.prepare('INSERT INTO ui_operations VALUES (?,?,?)').run(request.requestId, digest, canonicalJson(result));
        return result;
      });
      case 'state': {
        this.transaction(() => { this.expire(); this.present(request); });
        if (request.after === this.change && request.waitMs) await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); this.listeners.delete(finish); resolve(); };
          const timer = setTimeout(finish, request.waitMs); this.listeners.add(finish);
        });
        return this.snapshot(request.context.documentIncarnation);
      }
      case 'paint': return this.transaction(() => {
        const session = this.sessions.get(request.session), selection = this.state.selection;
        if (!session || !session.visible || Date.now() - session.seen > PRESENCE_MS || request.deliveryGeneration !== selection.deliveryGeneration || request.selectionRevision !== selection.revision || request.digest !== digestOf(selection.selected)) throw new UiRefusal('conflict', 'Paint does not match the current visible selection');
        this.sessions.set(request.session, { ...session, initialized: true, digest: request.digest, stagedDigest: null });
        this.state = { ...this.state, healthy: selection.selected };
        return { observed: true };
      });
      case 'ack': {
        const result = this.transaction(() => {
          const session = this.sessions.get(request.session), receipt = this.readReceipt(request.envelope.requestId);
          if (!session || Date.now() - session.seen > PRESENCE_MS || !receipt || canonicalJson(request.envelope) !== canonicalJson({ requestId: receipt.requestId, deliveryGeneration: receipt.deliveryGeneration, selectionRevision: receipt.selectionRevision, digest: receipt.digest })) throw new UiRefusal('conflict', 'Unknown rendering attempt or document incarnation');
          if (receipt.deliveryGeneration !== this.state.selection.deliveryGeneration) throw new UiRefusal('conflict', 'Rendering attempt superseded');
          let found = false;
          const participants = receipt.participants.map(participant => {
            if (participant.slot.kind !== 'document' || participant.slot.context.documentIncarnation !== request.session) return participant;
            found = true;
            if (participant.visual.kind === 'pending') return { ...participant, visual: request.result };
            if (canonicalJson(participant.visual) !== canonicalJson(request.result)) throw new UiRefusal('conflict', 'Rendering result already committed');
            return participant;
          });
          if (!found || !session.visible) throw new UiRefusal('conflict', 'Window is not a visible participant');
          const updated = { ...receipt, participants }; this.writeReceipt(updated);
          this.sessions.set(request.session, { ...session, digest: receipt.digest, stagedDigest: null });
          if (receiptStatus(updated) === 'all-rendered') this.state = { ...this.state, healthy: this.state.selection.selected };
          return this.status(receipt.requestId);
        });
        this.notify(); return result;
      }
    }
  }
  close(): void { if (this.closed) return; this.notify(); this.closed = true; this.db.close(); }
}
