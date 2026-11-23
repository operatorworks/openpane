import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ApplyReceipt, NativePlacementTarget, UiClientSnapshot, ExperienceBundle, UiAppearance, UiSelection, WindowContext } from '@openpane/contracts';
import { canonicalJson, experienceSchema, parseUiAppearance, parseUiSelection, parseApplyReceipt } from '@openpane/contracts';
import { count, identifier, record } from '@openpane/contracts/decode';
import { EXPERIENCE_PARTS, parseExperienceBundle, sha256 } from './experience-bundle.js';
import { UiRefusal } from './ui-protocol.js';
import type { UiRequest } from './ui-protocol.js';

const MAX_BUNDLES = 16, MAX_BUNDLE_BYTES = 32 * 1024 * 1024, MAX_RECEIPTS = 4096, MAX_METADATA_BYTES = 32 * 1024 * 1024;
const PRESENCE_MS = 15000;
interface StoreState {
  readonly version: 1; readonly profileId: string; readonly epoch: number; readonly recoveryGeneration: number;
  readonly selection: UiSelection; readonly healthy: UiAppearance;
  readonly recovery: { readonly requestId: string; readonly requestDigest: string; readonly result: ApplyReceipt } | null;
}
interface Session { readonly context: WindowContext; readonly visible: boolean; readonly sequence: number; readonly seen: number; readonly digest: string | null; readonly stagedDigest: string | null; readonly initialized: boolean; readonly nativePlacement: boolean; readonly paintedGeneration: number | null }
function text(value: unknown): string { if (typeof value !== 'string') throw new Error('Corrupt UI store text'); return value; }
const parseReceipt = parseApplyReceipt;
function departedParticipant(participant: ApplyReceipt['participants'][number]): ApplyReceipt['participants'][number] {
  return { ...participant, visual: { kind: 'departed' }, placement: participant.placement.kind === 'pending'
    ? { kind: 'failed', transitionId: participant.placement.transitionId, reason: 'The placement session departed before confirmation' } : participant.placement };
}
const receiptEnvelope = (receipt: ApplyReceipt) => ({ requestId: receipt.requestId, deliveryGeneration: receipt.deliveryGeneration, selectionRevision: receipt.selectionRevision, digest: receipt.digest });
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
const participantSession = (slot: ApplyReceipt['participants'][number]['slot']) => slot.kind === 'document' ? slot.context.documentIncarnation : slot.resolved?.documentIncarnation ?? null;
const digestOf = (selection: UiAppearance): string | null => selection.kind === 'experience' ? selection.digest : null;
export function receiptStatus(receipt: ApplyReceipt): string {
  if (!receipt.participants.length) return 'selected-with-no-clients';
  const outcomes = receipt.participants.map(participant => participant.visual.kind);
  if (outcomes.includes('superseded')) return 'superseded';
  if (outcomes.includes('pending') || receipt.participants.some(participant => participant.placement.kind === 'pending')) return 'pending';
  if (outcomes.every(kind => kind === 'rendered') && receipt.participants.every(participant => participant.placement.kind !== 'failed')) return 'all-rendered';
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
          this.writeReceipt({ ...receipt, participants: receipt.participants.map(participant => participant.visual.kind === 'pending' ? departedParticipant(participant) : participant) });
        }
        if (this.state.recovery) {
          const result = this.state.recovery.result;
          this.state = { ...this.state, recovery: { ...this.state.recovery, result: { ...result, participants: result.participants.map(participant => participant.visual.kind === 'pending' ? departedParticipant(participant) : participant) } } };
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
    const before = this.state, sessions = new Map(this.sessions);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.prepare('INSERT OR REPLACE INTO ui_state(id,value) VALUES (1,?)').run(canonicalJson(this.state));
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); this.state = before; this.sessions.clear(); for (const [id, session] of sessions) this.sessions.set(id, session); throw error; }
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
      const participants = receipt.participants.map(participant => (participantSession(participant.slot) === session || participant.slot.kind === 'transition' && participant.slot.resolved === null && participant.slot.source.documentIncarnation === session) && participant.visual.kind === 'pending'
        ? departedParticipant(participant) : participant);
      this.writeReceipt({ ...receipt, participants });
    }
  }
  private receipts(): ApplyReceipt[] {
    const values = this.db.prepare('SELECT result FROM ui_receipts WHERE generation=?').all(this.state.selection.deliveryGeneration).map(row => parseReceipt(JSON.parse(text(row.result))));
    if (this.state.recovery?.result.deliveryGeneration === this.state.selection.deliveryGeneration) values.push(this.state.recovery.result);
    return values;
  }
  private receiptBytes(receipt: ApplyReceipt): number { return Buffer.byteLength(canonicalJson(receipt)) + receipt.participants.reduce((bytes, participant) => bytes + (participant.slot.kind === 'transition' ? 16384 : 4096), 0); }
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
    const previousManifest = this.state.selection.selected.kind === 'experience' ? this.bundle(this.state.selection.selected.digest).manifest : null;
    const nextManifest = selected.kind === 'experience' ? this.bundle(selected.digest).manifest : null;
    const geometryChanged = nextManifest !== null && canonicalJson(nextManifest.presentation.chatWindow) !== canonicalJson(previousManifest?.presentation.chatWindow ?? null);
    const participants: ApplyReceipt['participants'][number][] = [...this.sessions.values()].map(session => ({ slot: { kind: 'document', context: session.context }, visual: { kind: 'pending', reason: session.visible ? 'Awaiting a painted frame' : 'Window is hidden' }, placement: geometryChanged && session.context.role === 'chat' ? { kind: 'deferred-for-existing-windows' } : { kind: 'unchanged' } }));
    const manifest = selected.kind === 'experience' ? this.bundle(selected.digest).manifest : null;
    if (manifest?.presentation.chats === 'separate') for (const session of this.sessions.values()) {
      if (session.context.role !== 'main' || !session.nativePlacement) continue;
      const transitionId = randomUUID();
      participants.push({ slot: { kind: 'transition', transitionId, source: session.context, target: null, resolved: null },
        visual: { kind: 'pending', reason: 'Waiting for the placement target to paint' }, placement: { kind: 'pending', transitionId, reason: 'Main has not confirmed chat placement' } });
    }
    if (participants.length > 32) throw new UiRefusal('capacity', 'Windows and pending native transitions exceed the 32-slot cohort limit');
    const receipt: ApplyReceipt = { requestId: request.requestId, requestDigest, deliveryGeneration: selection.deliveryGeneration, selectionRevision: selection.revision, digest: digestOf(selected), participants };
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
    this.sessions.set(context.documentIncarnation, { context, visible: request.visible, seen: Date.now(), sequence: request.presenceSequence, digest: previous?.digest ?? null, stagedDigest: previous?.stagedDigest ?? null, initialized: previous?.initialized ?? false, nativePlacement: request.nativePlacement === true, paintedGeneration: previous?.paintedGeneration ?? null });
  }
  private snapshot(session: string): UiClientSnapshot {
    const selected = this.state.selection.selected;
    const current = this.sessions.get(session);
    if (current) this.sessions.set(session, { ...current, initialized: true, digest: current.initialized ? current.digest : digestOf(selected), stagedDigest: digestOf(selected) });
    const pending = this.receipts().find(receipt => receipt.deliveryGeneration === this.state.selection.deliveryGeneration && receipt.participants.some(participant => (participantSession(participant.slot) === session || participant.slot.kind === 'transition' && participant.slot.resolved === null && participant.slot.source.documentIncarnation === session) && participant.visual.kind === 'pending'));
    return { version: 1, change: this.change, selection: this.state.selection, bundle: selected.kind === 'builtin' ? null : { manifest: this.bundle(selected.digest).manifest, digest: selected.digest },
      envelope: pending ? { requestId: pending.requestId, deliveryGeneration: pending.deliveryGeneration, selectionRevision: pending.selectionRevision, digest: pending.digest } : null, fault: this.recoveryReason,
      transitions: this.receipts().flatMap(receipt => receipt.participants.flatMap(participant => participant.slot.kind === 'transition' && participant.slot.source.documentIncarnation === session && participant.placement.kind === 'pending'
        ? [{ envelope: { requestId: receipt.requestId, deliveryGeneration: receipt.deliveryGeneration, selectionRevision: receipt.selectionRevision, digest: receipt.digest }, slot: participant.slot }] : [])) };
  }
  private placement(request: Extract<UiRequest, { op: 'placement-reserve' | 'placement-idle' | 'placement-failed' }>): object {
    const session = this.sessions.get(request.session), receipt = this.readReceipt(request.envelope.requestId);
    if (!session || session.context.role !== 'main' || !session.nativePlacement || !receipt || canonicalJson(request.envelope) !== canonicalJson(receiptEnvelope(receipt)) || receipt.deliveryGeneration !== this.state.selection.deliveryGeneration) throw new UiRefusal('conflict', 'Unknown native placement attempt');
    let found = false;
    const participants = receipt.participants.map(participant => {
      const slot = participant.slot;
      if (slot.kind !== 'transition' || slot.transitionId !== request.transitionId) return participant;
      found = true;
      if (canonicalJson(slot.source) !== canonicalJson(session.context)) throw new UiRefusal('conflict', 'Placement belongs to another source document');
      if (request.op === 'placement-reserve') {
        if (request.target.scope.hostId !== this.hostId) throw new UiRefusal('conflict', 'Foreign placement scope');
        if (slot.target) {
          if (canonicalJson(slot.target) !== canonicalJson(request.target)) throw new UiRefusal('conflict', 'Placement target is already fixed');
          return participant;
        }
        if (participant.placement.kind !== 'pending') throw new UiRefusal('conflict', 'Placement already concluded');
        return { ...participant, slot: { ...slot, target: request.target } };
      }
      if (request.op === 'placement-idle') {
        if (slot.target || slot.resolved || !session.visible || session.paintedGeneration !== receipt.deliveryGeneration) throw new UiRefusal('conflict', 'Catalog placement requires the source to paint and have no reserved target');
        if (participant.placement.kind === 'unchanged') return participant;
        if (participant.placement.kind !== 'pending') throw new UiRefusal('conflict', 'Placement already concluded');
        return { ...participant, visual: { kind: 'rendered' } as const, placement: { kind: 'unchanged' } as const };
      }
      if (participant.placement.kind === 'failed' && participant.placement.reason === request.reason) return participant;
      if (participant.placement.kind !== 'pending') throw new UiRefusal('conflict', 'Placement already concluded');
      return { ...participant, visual: { kind: 'failed', reason: request.reason } as const,
        placement: { kind: 'failed', transitionId: slot.transitionId, reason: request.reason } as const };
    });
    if (!found) throw new UiRefusal('not-found', 'Unknown transition slot');
    this.writeReceipt({ ...receipt, participants }); return this.status(receipt.requestId);
  }
  private childReady(context: WindowContext, target: Pick<NativePlacementTarget, 'nativeTransitionId' | 'bindingRevision'>): void {
    if (context.role !== 'chat') throw new UiRefusal('conflict', 'Only a registered child can resolve placement');
    for (const receipt of this.receipts()) {
      let changed = false;
      const participants = receipt.participants.map(participant => {
        const slot = participant.slot;
        if (slot.kind !== 'transition' || !slot.target || participant.placement.kind !== 'pending' || slot.target.nativeTransitionId !== target.nativeTransitionId) return participant;
        if (slot.source.brokerInstance !== context.brokerInstance || slot.target.scope.hostId !== context.scope.hostId || slot.target.scope.conversationId !== context.scope.conversationId || slot.target.label !== context.label || slot.target.viewId !== context.viewId || slot.target.bindingRevision !== target.bindingRevision) throw new UiRefusal('conflict', 'Ready child does not match the fixed placement target');
        if (slot.resolved && canonicalJson(slot.resolved) !== canonicalJson(context)) throw new UiRefusal('conflict', 'Transition already resolved to another incarnation');
        changed = true;
        return { ...participant, slot: { ...slot, resolved: context }, placement: { kind: 'ready', transitionId: slot.transitionId, bindingRevision: target.bindingRevision } as const };
      });
      if (changed) this.writeReceipt({ ...receipt, participants });
    }
  }
  async execute(request: UiRequest): Promise<unknown> {
    switch (request.op) {
      case 'context': return this.context();
      case 'placement-reserve': case 'placement-idle': case 'placement-failed': {
        const result = this.transaction(() => this.placement(request)); this.notify(); return result;
      }
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
      case 'relay': return this.transaction(() => {
        this.expire();
        const main = this.sessions.get(request.main.documentIncarnation);
        if (!main || canonicalJson(main.context) !== canonicalJson(request.main) || main.context.role !== 'main') throw new UiRefusal('conflict', 'Unregistered native main relay');
        for (const id of request.departed) {
          const child = this.sessions.get(id);
          if (!child) continue;
          if (child.context.role !== 'chat' || child.context.brokerInstance !== request.main.brokerInstance) throw new UiRefusal('conflict', 'Foreign relay departure');
          this.depart(id); this.sessions.delete(id);
        }
        for (const child of request.children) {
          this.present({ op: 'state', ...child, after: null, waitMs: 0 });
          if (child.placement) this.childReady(child.context, child.placement);
        }
        return { children: request.children.map(child => ({ incarnation: child.context.documentIncarnation, envelope: this.snapshot(child.context.documentIncarnation).envelope })) };
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
        this.sessions.set(request.session, { ...session, initialized: true, digest: request.digest, stagedDigest: null, paintedGeneration: request.deliveryGeneration });
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
            if (participantSession(participant.slot) !== request.session) return participant;
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
