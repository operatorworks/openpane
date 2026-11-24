import { DatabaseSync } from 'node:sqlite';
import { chmodSync, lstatSync, openSync, closeSync, constants, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ApplyReceipt, NativePlacementTarget, UiClientSnapshot, ExperienceBundle, UiAppearance, UiSelection, WindowContext } from '@openpane/contracts';
import { canonicalJson, experienceSchema, EXPERIENCE_STYLE_DISCOVERY, HOME_PANE_KINDS, parseUiAppearance, parseUiSelection, parseApplyReceipt, DISPLAY_PAGE_LIMITS } from '@openpane/contracts';
import { count, identifier, record } from '@openpane/contracts/decode';
import { parseExperienceBundle, sha256 } from './experience-bundle.js';
import { UiRefusal } from './ui-protocol.js';
import type { UiRequest } from './ui-protocol.js';
import { UiDisplayStore } from './ui-display-store.js';
import { DISPLAY_REMOVAL_ENTRIES, DISPLAY_REMOVAL_OVERHEAD } from './ui-display-db.js';
import type { ConversationScope, DisplayDelivery, DeliveryEnvelope, DisplaySubscription } from '@openpane/contracts';

const MAX_BUNDLES = 16, MAX_BUNDLE_BYTES = 32 * 1024 * 1024, MAX_RECEIPTS = 4096, MAX_METADATA_BYTES = 32 * 1024 * 1024;
const PRESENCE_MS = 15000;
interface Compaction { readonly fromEpoch: number; readonly toEpoch: number; readonly abandonWaits: boolean }
interface StoreState {
  readonly version: 1; readonly profileId: string; readonly epoch: number; readonly recoveryGeneration: number;
  readonly compaction: Compaction | null;
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
  const input = record(value);
  record(input, Object.hasOwn(input, 'compaction') ? ['version', 'profileId', 'epoch', 'recoveryGeneration', 'selection', 'healthy', 'recovery', 'compaction'] : ['version', 'profileId', 'epoch', 'recoveryGeneration', 'selection', 'healthy', 'recovery']);
  if (input.version !== 1) throw new Error('Unsupported UI database version');
  const recovery = input.recovery === null ? null : record(input.recovery, ['requestId', 'requestDigest', 'result']);
  const compact = input.compaction === undefined || input.compaction === null ? null : record(input.compaction, ['fromEpoch', 'toEpoch', 'abandonWaits']);
  if (compact && (typeof compact.abandonWaits !== 'boolean' || count(compact.toEpoch) !== count(compact.fromEpoch) + 1 || compact.toEpoch !== input.epoch)) throw new Error('Invalid UI compaction replay');
  return { compaction: compact === null ? null : { fromEpoch: count(compact.fromEpoch), toEpoch: count(compact.toEpoch), abandonWaits: compact.abandonWaits === true }, version: 1, profileId: identifier(input.profileId, 200), epoch: count(input.epoch), recoveryGeneration: count(input.recoveryGeneration),
    selection: parseUiSelection(input.selection), healthy: parseUiAppearance(input.healthy),
    recovery: recovery === null ? null : { requestId: identifier(recovery.requestId, 128), requestDigest: identifier(recovery.requestDigest, 64), result: parseReceipt(recovery.result) } };
}
function initial(): StoreState {
  return { compaction: null, version: 1, profileId: randomUUID(), epoch: 1, recoveryGeneration: 1, selection: { revision: 0, deliveryGeneration: 0, selected: { kind: 'builtin' }, previousHealthy: { kind: 'builtin' } }, healthy: { kind: 'builtin' }, recovery: null };
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
  private readonly display: UiDisplayStore;
  private state: StoreState;
  private readonly sessions = new Map<string, Session>();
  private readonly highestPresence = new Map<string, number>();
  private readonly manifests = new Map<string, ExperienceBundle['manifest']>();
  private readonly relayPositions = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private change = 0;
  private closed = false;
  recoveryReason: string | null = null;
  constructor(path: string, readonly hostId: string, private readonly targets: (after: string | null) => unknown = () => { throw new UiRefusal('unavailable', 'Conversation catalog unavailable'); }, checkScope: (scope: ConversationScope) => boolean = () => false) {
    let file;
    try { file = lstatSync(path); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600); closeSync(descriptor);
      file = lstatSync(path);
    }
    if (!file.isFile() || file.nlink !== 1 || process.getuid && file.uid !== process.getuid()) throw new Error('UI database must be an independent regular file owned by this user');
    let conversationFile;
    try { conversationFile = statSync(join(dirname(path), 'host.sqlite')); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (conversationFile && conversationFile.dev === file.dev && conversationFile.ino === file.ino) throw new Error('UI database must be separate from the conversation database');
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS ui_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ui_bundles (digest TEXT PRIMARY KEY, value TEXT NOT NULL, bytes INTEGER NOT NULL, created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ui_receipts (id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, result TEXT NOT NULL, generation INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ui_operations (id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ui_recovery_notice (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ui_receipts_generation ON ui_receipts(generation);`);
      const row = this.db.prepare('SELECT value FROM ui_state WHERE id=1').get();
      this.state = row ? parseState(JSON.parse(text(row.value))) : initial();
      const notice = this.db.prepare('SELECT value FROM ui_recovery_notice WHERE id=1').get();
      this.recoveryReason = notice ? text(notice.value) : null;
      this.display = new UiDisplayStore({ db: this.db, hostId, epoch: () => this.state.epoch, checkScope,
        transaction: run => this.transaction(run), capacity: (bytes, entries) => this.capacity(bytes, entries), notify: () => this.notify() });
      this.transaction(() => {
        this.recoveryReason = this.validateSelection() ?? this.recoveryReason;
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
    const normalize = (appearance: UiAppearance): UiAppearance => {
      if (appearance.kind === 'builtin') return appearance;
      try { this.bundle(appearance.digest); return appearance; }
      catch { this.manifests.delete(appearance.digest); return { kind: 'builtin' }; }
    };
    const selected = normalize(this.state.selection.selected), previousHealthy = normalize(this.state.selection.previousHealthy), healthy = normalize(this.state.healthy);
    const changed = selected !== this.state.selection.selected;
    const recovered = changed || previousHealthy !== this.state.selection.previousHealthy || healthy !== this.state.healthy;
    this.state = { ...this.state, healthy, selection: { ...this.state.selection, selected, previousHealthy,
      revision: changed ? next(this.state.selection.revision) : this.state.selection.revision,
      deliveryGeneration: changed ? next(this.state.selection.deliveryGeneration) : this.state.selection.deliveryGeneration } };
    return recovered ? 'A missing or invalid experience reference (including unsupported versions) was restored to builtin. Reauthor the bundle using experience schema; saved conversations and cards are unchanged.' : null;
  }
  private transaction<T>(run: () => T): T {
    if (this.closed) throw new UiRefusal('unavailable', 'UI store is closed');
    const before = this.state, sessions = new Map(this.sessions), highestPresence = new Map(this.highestPresence), recoveryReason = this.recoveryReason;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.prepare('INSERT OR REPLACE INTO ui_state(id,value) VALUES (1,?)').run(canonicalJson(this.state));
      if (this.recoveryReason === null) this.db.exec('DELETE FROM ui_recovery_notice');
      else this.db.prepare('INSERT OR REPLACE INTO ui_recovery_notice(id,value) VALUES (1,?)').run(this.recoveryReason);
      this.db.exec('COMMIT'); return result;
    } catch (error) {
      this.state = before; this.recoveryReason = recoveryReason;
      this.highestPresence.clear(); for (const [key, sequence] of highestPresence) this.highestPresence.set(key, sequence);
      this.manifests.clear(); this.sessions.clear(); for (const [id, session] of sessions) this.sessions.set(id, session);
      try { if (this.db.isTransaction) this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  private notify(): void { this.change = next(this.change); for (const listener of this.listeners) listener(); }
  context(): object {
    return { version: 1, hostId: this.hostId, profileId: this.state.profileId, requestEpoch: this.state.epoch, recoveryGeneration: this.state.recoveryGeneration,
      revision: this.state.selection.revision, selection: this.state.selection, capabilities: ['experiences-v2', 'display-v1'], fault: this.recoveryReason };
  }
  bundle(digest: string): ExperienceBundle {
    const row = this.db.prepare('SELECT value FROM ui_bundles WHERE digest=?').get(digest);
    if (!row) throw new UiRefusal('not-found', 'Experience bundle unavailable');
    let bundle: ExperienceBundle;
    try { bundle = parseExperienceBundle(JSON.parse(text(row.value))); }
    catch { throw new UiRefusal('unavailable', 'Experience bundle is unsupported or invalid; reauthor it using experience schema'); }
    if (bundle.digest !== digest) throw new Error('Corrupt UI bundle identity');
    if (!this.manifests.has(digest) && this.manifests.size >= MAX_BUNDLES) this.manifests.clear();
    this.manifests.set(digest, bundle.manifest);
    return bundle;
  }
  private manifest(digest: string): ExperienceBundle['manifest'] { return this.manifests.get(digest) ?? this.bundle(digest).manifest; }
  private readReceipt(id: string): ApplyReceipt | null {
    if (id === this.state.recovery?.requestId) return this.state.recovery.result;
    const row = this.db.prepare('SELECT result FROM ui_receipts WHERE id=?').get(id);
    return row ? parseReceipt(JSON.parse(text(row.result))) : null;
  }
  private writeReceipt(receipt: ApplyReceipt): void {
    if (receipt.deliveryGeneration === this.state.selection.deliveryGeneration && receiptStatus(receipt) === 'all-rendered') this.state = { ...this.state, healthy: this.state.selection.selected };
    if (receipt.requestId === this.state.recovery?.requestId) { this.state = { ...this.state, recovery: { ...this.state.recovery, result: receipt } }; return; }
    const value = canonicalJson(receipt);
    this.db.prepare(`INSERT INTO ui_receipts(id,request_digest,result,generation,reserved_bytes) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET result=excluded.result`).run(receipt.requestId, receipt.requestDigest, value, receipt.deliveryGeneration, this.receiptBytes(receipt));
  }
  private checkEpoch(id: string): void {
    if (!/^\d+:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) throw new UiRefusal('invalid-input', 'Request ID must be EPOCH:UUID from ui context');
    if (id.split(':')[0] !== String(this.state.epoch)) throw new UiRefusal('expired', 'Request epoch expired; inspect ui context');
  }
  private expire(heartbeats: ReadonlySet<string> = new Set()): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) if (!heartbeats.has(id) && now - session.seen > PRESENCE_MS) { this.depart(id); this.sessions.delete(id); }
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
  private capacity(reservedBytes = 0, entries = 1): void {
    const row = this.db.prepare(`SELECT coalesce(sum(entries),0) AS count,coalesce(sum(bytes),0) AS bytes FROM (
      SELECT 1 AS entries,reserved_bytes AS bytes FROM ui_receipts UNION ALL SELECT 1,length(CAST(result AS BLOB)) FROM ui_operations
      UNION ALL SELECT 1+CASE WHEN reserved_event_bytes>0 THEN 1 ELSE 0 END+CASE WHEN state IN ('running','published','failed','interrupted') THEN ${DISPLAY_REMOVAL_ENTRIES} ELSE 0 END,
        metadata_bytes+reserved_event_bytes+CASE WHEN state IN ('running','published','failed','interrupted') THEN ${DISPLAY_REMOVAL_ENTRIES}*(length(CAST(scope AS BLOB))+length(CAST(id AS BLOB)))+${DISPLAY_REMOVAL_OVERHEAD} ELSE 0 END FROM ui_display_keys
      UNION ALL SELECT 1,bytes FROM ui_display_events UNION ALL SELECT 1,bytes FROM ui_display_removals)`).get();
    if (!row || count(row.count) + entries > MAX_RECEIPTS || count(row.bytes) + reservedBytes > MAX_METADATA_BYTES) throw new UiRefusal('capacity', 'UI receipt capacity reached; run maintenance compact');
  }
  private select(request: Extract<UiRequest, { op: 'apply' | 'refresh' | 'restore' }>): ApplyReceipt {
    if (request.op === 'restore' && request.expectedContext && (request.expectedContext.hostId !== this.hostId || request.expectedContext.profileId !== this.state.profileId)) throw new UiRefusal('conflict', 'Appearance recovery belongs to a previous host profile');
    const requestDigest = sha256(canonicalJson(request.op === 'restore' ? { op: request.op, requestId: request.requestId,
      expectedRevision: request.expectedRevision, expectedRecoveryGeneration: request.expectedRecoveryGeneration } : request));
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
    const cohortLimit = request.op === 'restore' ? 64 : 32;
    if (this.sessions.size > cohortLimit) throw new UiRefusal('capacity', `${this.sessions.size} compatible windows; close windows to at most ${cohortLimit} before applying`);
    const existing = request.op === 'apply' ? this.db.prepare('SELECT bytes FROM ui_bundles WHERE digest=?').get(request.bundle.digest) : undefined;
    let readable = false;
    if (request.op === 'apply' && existing) { try { this.bundle(request.bundle.digest); readable = true; } catch {} }
    if (request.op === 'apply' && !readable) {
      const value = canonicalJson(request.bundle), bytes = Buffer.byteLength(value);
      const usage = this.db.prepare('SELECT count(*) AS count, coalesce(sum(bytes),0) AS bytes FROM ui_bundles').get();
      if (!usage || count(usage.count) + (existing ? 0 : 1) > MAX_BUNDLES || count(usage.bytes) - (existing ? count(existing.bytes) : 0) + bytes > MAX_BUNDLE_BYTES) throw new UiRefusal('capacity', 'Experience capacity reached; prune unreferenced bundles');
      this.db.prepare('INSERT INTO ui_bundles VALUES (?,?,?,?) ON CONFLICT(digest) DO UPDATE SET value=excluded.value,bytes=excluded.bytes').run(request.bundle.digest, value, bytes, Date.now());
      this.manifests.set(request.bundle.digest, request.bundle.manifest);
    }
    const selected: UiAppearance = request.op === 'apply' ? { kind: 'experience', digest: request.bundle.digest } : request.op === 'restore' ? { kind: 'builtin' } : this.state.selection.selected;
    const selection: UiSelection = { revision: request.op === 'refresh' ? this.state.selection.revision : next(this.state.selection.revision), deliveryGeneration: next(this.state.selection.deliveryGeneration), selected, previousHealthy: this.state.healthy };
    for (const old of this.receipts()) this.writeReceipt({ ...old, participants: old.participants.map((participant): ApplyReceipt['participants'][number] => ({ ...participant,
      visual: participant.visual.kind === 'pending' ? { kind: 'superseded' } : participant.visual,
      placement: participant.placement.kind === 'pending' ? { kind: 'failed', transitionId: participant.placement.transitionId, reason: 'A newer appearance delivery superseded this placement' } : participant.placement,
    })) });
    const previousManifest = selected.kind === 'experience' && this.state.selection.selected.kind === 'experience' ? this.manifest(this.state.selection.selected.digest) : null;
    const nextManifest = selected.kind === 'experience' ? this.manifest(selected.digest) : null;
    const geometryChanged = nextManifest !== null && canonicalJson(nextManifest.presentation.chatWindow) !== canonicalJson(previousManifest?.presentation.chatWindow ?? null);
    const participants: ApplyReceipt['participants'][number][] = [...this.sessions.values()].map(session => ({ slot: { kind: 'document', context: session.context }, visual: { kind: 'pending', reason: session.visible ? 'Awaiting a painted frame' : 'Window is hidden' }, placement: geometryChanged && session.context.role === 'chat' ? { kind: 'deferred-for-existing-windows' } : { kind: 'unchanged' } }));
    const manifest = selected.kind === 'experience' ? this.manifest(selected.digest) : null;
    if (manifest?.presentation.chats === 'separate') for (const session of this.sessions.values()) {
      if (session.context.role !== 'main' || !session.nativePlacement) continue;
      const transitionId = randomUUID();
      participants.push({ slot: { kind: 'transition', transitionId, source: session.context, target: null, resolved: null },
        visual: { kind: 'pending', reason: 'Waiting for the placement target to paint' }, placement: { kind: 'pending', transitionId, reason: 'Main has not confirmed chat placement' } });
    }
    if (participants.length > cohortLimit) throw new UiRefusal('capacity', `Windows and pending native transitions exceed the ${cohortLimit}-slot cohort limit`);
    const receipt: ApplyReceipt = { requestId: request.requestId, requestDigest, deliveryGeneration: selection.deliveryGeneration, selectionRevision: selection.revision, digest: digestOf(selected), participants };
    if (request.op !== 'restore') this.capacity(this.receiptBytes(receipt));
    this.state = { ...this.state, selection };
    if (request.op !== 'refresh') this.recoveryReason = null;
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
    const logicalWindow = canonicalJson([context.brokerInstance, context.label]), highest = this.highestPresence.get(logicalWindow);
    if (highest !== undefined && request.presenceSequence <= highest) throw new UiRefusal('conflict', 'Stale logical window presence');
    if (highest === undefined && this.highestPresence.size >= 4096) throw new UiRefusal('capacity', 'UI presence history is full; restart the host before opening more windows');
    for (const [id, session] of this.sessions) if (id !== context.documentIncarnation && session.context.brokerInstance === context.brokerInstance && session.context.label === context.label) { this.depart(id); this.sessions.delete(id); }
    if (!previous && this.sessions.size >= 64) throw new UiRefusal('capacity', 'Too many UI sessions; close windows');
    this.highestPresence.set(logicalWindow, request.presenceSequence);
    this.sessions.set(context.documentIncarnation, { context, visible: request.visible, seen: Date.now(), sequence: request.presenceSequence, digest: previous?.digest ?? null, stagedDigest: previous?.stagedDigest ?? null, initialized: previous?.initialized ?? false, nativePlacement: request.nativePlacement === true, paintedGeneration: previous?.paintedGeneration ?? null });
  }
  private snapshot(session: string): UiClientSnapshot {
    const selected = this.state.selection.selected;
    const current = this.sessions.get(session);
    if (current) this.sessions.set(session, { ...current, initialized: true, digest: current.initialized ? current.digest : digestOf(selected), stagedDigest: digestOf(selected) });
    const pending = this.receipts().find(receipt => receipt.deliveryGeneration === this.state.selection.deliveryGeneration && receipt.participants.some(participant => (participantSession(participant.slot) === session || participant.slot.kind === 'transition' && participant.slot.resolved === null && participant.slot.source.documentIncarnation === session) && participant.visual.kind === 'pending'));
    return { version: 1, change: this.change, selection: this.state.selection, bundle: selected.kind === 'builtin' ? null : { manifest: this.manifest(selected.digest), digest: selected.digest },
      envelope: pending ? { requestId: pending.requestId, deliveryGeneration: pending.deliveryGeneration, selectionRevision: pending.selectionRevision, digest: pending.digest } : null, fault: this.recoveryReason, display: null,
      transitions: this.receipts().flatMap(receipt => receipt.participants.flatMap(participant => participant.slot.kind === 'transition' && participant.slot.source.documentIncarnation === session && participant.placement.kind === 'pending'
        ? [{ envelope: { requestId: receipt.requestId, deliveryGeneration: receipt.deliveryGeneration, selectionRevision: receipt.selectionRevision, digest: receipt.digest }, slot: participant.slot }] : [])) };
  }
  private placement(request: Extract<UiRequest, { op: 'placement-reserve' | 'placement-idle' | 'placement-failed' }>): object {
    const session = this.sessions.get(request.session), receipt = this.readReceipt(request.envelope.requestId);
    if (!session || Date.now() - session.seen > PRESENCE_MS || session.context.role !== 'main' || !session.nativePlacement || !receipt || canonicalJson(request.envelope) !== canonicalJson(receiptEnvelope(receipt))) throw new UiRefusal('conflict', 'Unknown native placement attempt');
    if (receipt.deliveryGeneration !== this.state.selection.deliveryGeneration) {
      if (request.op === 'placement-reserve' && receiptStatus(receipt) === 'superseded' && receipt.participants.some(participant => participant.slot.kind === 'transition' && participant.slot.transitionId === request.transitionId && canonicalJson(participant.slot.source) === canonicalJson(session.context))) return this.status(receipt.requestId);
      throw new UiRefusal('conflict', 'Native placement attempt was superseded');
    }
    let found = false;
    const participants = receipt.participants.map(participant => {
      const slot = participant.slot;
      if (slot.kind !== 'transition' || slot.transitionId !== request.transitionId) return participant;
      found = true;
      if (canonicalJson(slot.source) !== canonicalJson(session.context)) throw new UiRefusal('conflict', 'Placement belongs to another source document');
      if (request.op === 'placement-reserve') {
        if (session.paintedGeneration !== receipt.deliveryGeneration) throw new UiRefusal('conflict', 'Placement requires the source document to paint this delivery');
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
      const rendered = receipt.participants.some(participant => participant.slot.kind === 'document' && canonicalJson(participant.slot.context) === canonicalJson(context) && participant.visual.kind === 'rendered');
      const participants = receipt.participants.map(participant => {
        const slot = participant.slot;
        if (slot.kind !== 'transition' || !slot.target || participant.placement.kind !== 'pending' || slot.target.nativeTransitionId !== target.nativeTransitionId) return participant;
        if (slot.source.brokerInstance !== context.brokerInstance || slot.target.scope.hostId !== context.scope.hostId || slot.target.scope.conversationId !== context.scope.conversationId || slot.target.label !== context.label || slot.target.viewId !== context.viewId || slot.target.bindingRevision !== target.bindingRevision) return participant;
        if (slot.resolved && canonicalJson(slot.resolved) !== canonicalJson(context)) return participant;
        changed = true;
        return { ...participant, visual: rendered ? { kind: 'rendered' } as const : participant.visual, slot: { ...slot, resolved: context }, placement: { kind: 'ready', transitionId: slot.transitionId, bindingRevision: target.bindingRevision } as const };
      });
      if (changed) this.writeReceipt({ ...receipt, participants });
    }
  }
  endUiSession(owner: string): void { this.display.interrupt(owner); }
  readDisplay(subscription: DisplaySubscription, options?: { readonly items?: number; readonly bytes?: number }) { return this.display.read(subscription, options); }
  private displayDelivery(subscription: DisplaySubscription | null | undefined, options?: { readonly items?: number; readonly bytes?: number }): DisplayDelivery | null {
    if (!subscription) return null;
    try { const page = this.display.read(subscription, options); return page === null ? null : { kind: 'page', page }; }
    catch { return { kind: 'unavailable', scope: subscription.scope, subscriptionId: subscription.subscriptionId, from: subscription.cursor, reason: 'Card data is unavailable. Refresh cards, or repair the affected UI data.' }; }
  }
  private relay(request: Extract<UiRequest, { readonly op: 'relay' }>): object {
    const pairs = this.transaction(() => {
      const main = this.sessions.get(request.main.documentIncarnation);
      if (!main || canonicalJson(main.context) !== canonicalJson(request.main) || main.context.role !== 'main') throw new UiRefusal('conflict', 'Unregistered native main relay');
      this.expire(new Set([request.main.documentIncarnation, ...request.children.map(child => child.context.documentIncarnation)]));
      this.sessions.set(request.main.documentIncarnation, { ...main, seen: Date.now() });
      for (const id of request.departed) {
        const child = this.sessions.get(id);
        if (!child) continue;
        if (child.context.role !== 'chat' || child.context.brokerInstance !== request.main.brokerInstance) throw new UiRefusal('conflict', 'Foreign relay departure');
        this.depart(id); this.sessions.delete(id);
      }
      return request.children.map(child => {
        let admitted = true;
        try { this.present({ op: 'state', ...child, after: null, waitMs: 0 }); }
        catch (error) {
          if (!(error instanceof UiRefusal && error.code === 'capacity')) throw error;
          admitted = false;
        }
        if (admitted && child.placement) this.childReady(child.context, child.placement);
        const reply: { incarnation: string; envelope: DeliveryEnvelope | null; display: DisplayDelivery | null } = {
          incarnation: child.context.documentIncarnation,
          envelope: admitted ? this.snapshot(child.context.documentIncarnation).envelope : null,
          display: !admitted && child.display ? { kind: 'unavailable', scope: child.display.scope, subscriptionId: child.display.subscriptionId,
            from: child.display.cursor, reason: 'This window could not join UI delivery because the host presence limit was reached. Close unused windows or restart the host.' } : null,
        };
        return { child, reply, admitted };
      });
    });
    for (const id of this.relayPositions.keys()) if (!this.sessions.has(id)) this.relayPositions.delete(id);
    const position = pairs.length ? (this.relayPositions.get(request.main.documentIncarnation) ?? 0) % pairs.length : 0;
    const response = { children: pairs.map(pair => pair.reply) }; let remaining = DISPLAY_PAGE_LIMITS.items;
    for (const pair of [...pairs.slice(position), ...pairs.slice(0, position)]) {
      if (!pair.admitted || !pair.child.visible || !pair.child.display) continue;
      const available = DISPLAY_PAGE_LIMITS.bytes - Buffer.byteLength(canonicalJson({ ok: true, value: response })) - 64;
      if (remaining < 1 || available < 256) break;
      const delivery = this.displayDelivery(pair.child.display, { items: remaining, bytes: available });
      if (!delivery) continue;
      pair.reply.display = delivery;
      if (Buffer.byteLength(canonicalJson({ ok: true, value: response })) > DISPLAY_PAGE_LIMITS.bytes) { pair.reply.display = null; continue; }
      if (delivery.kind === 'page') remaining -= delivery.page.kind === 'snapshot' ? delivery.page.publications.length : delivery.page.kind === 'changes' ? delivery.page.changes.length : 0;
    }
    this.relayPositions.set(request.main.documentIncarnation, (position + 1) % Math.max(1, pairs.length));
    return response;
  }
  async execute(request: UiRequest, session?: { readonly owner: string }): Promise<unknown> {
    switch (request.op) {
      case 'context': return this.context();
      case 'placement-reserve': case 'placement-idle': case 'placement-failed': {
        const result = this.transaction(() => this.placement(request)); this.notify(); return result;
      }
      case 'targets': return this.targets(request.after);
      case 'schema': return { manifest: experienceSchema, ...EXPERIENCE_STYLE_DISCOVERY, panes: HOME_PANE_KINDS, density: ['comfortable', 'compact'], transcript: ['bubbles', 'lines'] };
      case 'apply': case 'refresh': case 'restore': {
        const receipt = this.transaction(() => this.select(request)); this.notify(); return { receipt, outcome: receiptStatus(receipt) };
      }
      case 'status': return this.transaction(() => { this.expire(); return this.status(request.requestId); });
      case 'compact': {
        let compacted = false;
        const result = this.transaction(() => {
        const abandonWaits = request.abandonWaits === true, previous = this.state.compaction;
        const result = (compact: Compaction) => ({ previousEpoch: compact.fromEpoch, epoch: compact.toEpoch, abandonedWaits: compact.abandonWaits,
          retained: 'Drafts, active cards, native intents, non-abandoned query attempts and the reserved recovery replay are retained' });
        if (previous?.fromEpoch === request.expectedEpoch) {
          if (previous.abandonWaits !== abandonWaits) throw new UiRefusal('conflict', 'Compaction replay changed abandon-waits');
          return result(previous);
        }
        if (request.expectedEpoch !== this.state.epoch) throw new UiRefusal('expired', 'Request epoch already advanced');
        this.expire();
        const normal = this.db.prepare('SELECT result FROM ui_receipts').all().map(row => parseReceipt(JSON.parse(text(row.result))));
        if (!abandonWaits && normal.some(receipt => receiptStatus(receipt) === 'pending')) throw new UiRefusal('conflict', 'Visual deliveries are pending. Wait for confirmation or explicitly use --abandon-waits.');
        if (abandonWaits && this.state.recovery) {
          const receipt = this.state.recovery.result;
          this.writeReceipt({ ...receipt, participants: receipt.participants.map(participant => ({ ...participant,
            visual: participant.visual.kind === 'pending' ? { kind: 'departed' } : participant.visual,
            placement: participant.placement.kind === 'pending' ? { kind: 'failed', transitionId: participant.placement.transitionId, reason: 'Compaction explicitly abandoned this unconfirmed placement' } : participant.placement })) });
        }
        this.display.compactInTransaction(); compacted = true;
        const compact: Compaction = { fromEpoch: this.state.epoch, toEpoch: next(this.state.epoch), abandonWaits };
        this.db.exec('DELETE FROM ui_receipts; DELETE FROM ui_operations;'); this.state = { ...this.state, epoch: compact.toEpoch, compaction: compact };
        return result(compact);
        });
        if (compacted) { this.display.compacted(); this.notify(); }
        return result;
      }
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
      case 'relay': return this.relay(request);
      case 'state': {
        this.transaction(() => {
          const live = new Set([request.context.documentIncarnation]);
          if (request.liveChildren?.length && (request.context.role !== 'main' || !request.nativePlacement)) throw new UiRefusal('conflict', 'Only native main can report its child inventory');
          const children = (request.liveChildren ?? []).flatMap(id => {
            const child = this.sessions.get(id);
            if (!child) return [];
            if (child.context.role !== 'chat' || child.context.brokerInstance !== request.context.brokerInstance || child.context.profileId !== request.context.profileId || child.context.hostId !== request.context.hostId) throw new UiRefusal('conflict', 'Foreign native child inventory');
            live.add(id); return [[id, child] as const];
          });
          this.expire(live); this.present(request);
          for (const [id, child] of children) this.sessions.set(id, { ...child, seen: Date.now() });
        });
        if (request.after === this.change && request.waitMs) await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); this.listeners.delete(finish); resolve(); };
          const timer = setTimeout(finish, request.waitMs); this.listeners.add(finish);
        });
        return { ...this.snapshot(request.context.documentIncarnation), display: this.displayDelivery(request.display) };
      }
      case 'paint': return this.transaction(() => {
        const session = this.sessions.get(request.session), selection = this.state.selection;
        if (!session || !session.visible || Date.now() - session.seen > PRESENCE_MS || request.deliveryGeneration !== selection.deliveryGeneration || request.selectionRevision !== selection.revision || request.digest !== digestOf(selection.selected)) throw new UiRefusal('conflict', 'Paint does not match the current visible selection');
        this.sessions.set(request.session, { ...session, initialized: true, digest: request.digest, stagedDigest: null, paintedGeneration: request.deliveryGeneration });
        return { observed: true };
      });
      case 'ack': {
        const result = this.transaction(() => {
          const session = this.sessions.get(request.session), receipt = this.readReceipt(request.envelope.requestId);
          if (!session || Date.now() - session.seen > PRESENCE_MS || !receipt || canonicalJson(request.envelope) !== canonicalJson({ requestId: receipt.requestId, deliveryGeneration: receipt.deliveryGeneration, selectionRevision: receipt.selectionRevision, digest: receipt.digest })) throw new UiRefusal('conflict', 'Unknown rendering attempt or document incarnation');
          if (receipt.deliveryGeneration !== this.state.selection.deliveryGeneration) throw new UiRefusal('conflict', 'Rendering attempt superseded');
          let found = false;
          const participants = receipt.participants.map(participant => {
            const slot = participant.slot;
            if (request.result.kind === 'failed' && slot.kind === 'transition' && slot.source.documentIncarnation === request.session
              && slot.target === null && slot.resolved === null && participant.placement.kind === 'pending') {
              found = true;
              return { ...participant, visual: request.result, placement: { kind: 'failed' as const, transitionId: slot.transitionId, reason: request.result.reason } };
            }
            if (participantSession(slot) !== request.session) return participant;
            found = true;
            if (participant.visual.kind === 'pending') return { ...participant, visual: request.result };
            if (canonicalJson(participant.visual) !== canonicalJson(request.result)) throw new UiRefusal('conflict', 'Rendering result already committed');
            return participant;
          });
          if (!found || !session.visible) throw new UiRefusal('conflict', 'Window is not a visible participant');
          if (request.result.kind === 'rendered' && session.paintedGeneration !== receipt.deliveryGeneration) throw new UiRefusal('conflict', 'Rendered acknowledgement requires this document’s matching paint');
          const updated = { ...receipt, participants }; this.writeReceipt(updated);
          this.sessions.set(request.session, { ...session, digest: request.result.kind === 'rendered' ? receipt.digest : session.digest, stagedDigest: null });
          return this.status(receipt.requestId);
        });
        this.notify(); return result;
      }
      default: return this.display.execute(request, session?.owner ?? null);
    }
  }
  close(): void { if (this.closed) return; try { this.display.close(); } finally { this.notify(); this.closed = true; this.db.close(); } }
}
