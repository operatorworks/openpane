import { hash } from 'fast-sha256';
import { canonicalPaletteText, parsePaletteDocument, type PaletteDocumentV1 } from '@openpane/theme';
import { defaultDesktopPreferences, safeDesktopPreferences, parseDesktopPreferences, parsePaletteDigest, isPaletteDigest, patchDesktopPreferences,
  type DesktopPreferencesV1, type PaletteDigest, type PreferencePatch } from './personalization.js';

export const MAX_PALETTE_BYTES = 64 * 1024;
export const MAX_PALETTES = 64;
export const PALETTE_SIZE_DIAGNOSTIC = 'Palette JSON must be at most 64 KiB.';
export type SavedPreferences =
  | { readonly kind: 'valid'; readonly epoch: number; readonly revision: number; readonly document: DesktopPreferencesV1 }
  | { readonly kind: 'invalid'; readonly epoch: number; readonly revision: number | null; readonly diagnostic: string }
  | { readonly kind: 'unavailable'; readonly diagnostic: string };
export type PaletteResource = { readonly key: IDBValidKey } & (
  | { readonly kind: 'ready'; readonly digest: PaletteDigest; readonly document: PaletteDocumentV1; readonly text: string }
  | { readonly kind: 'unavailable'; readonly digest: string; readonly diagnostic: string });
export interface PersonalizationSnapshot { readonly preferences: SavedPreferences; readonly palettes: readonly PaletteResource[] }
export type PersonalizationOutcome =
  | { readonly kind: 'committed'; readonly epoch: number | null; readonly revision: number | null; readonly snapshot: PersonalizationSnapshot; readonly diagnostic?: string }
  | { readonly kind: 'refused' | 'unavailable'; readonly diagnostic: string };
type StoredRow = { readonly kind: 'absent' } | { readonly kind: 'present'; readonly value: unknown };
interface RawSnapshot { readonly preferences: StoredRow; readonly epoch: StoredRow; readonly paletteGeneration: StoredRow; readonly palettes: readonly { readonly key: IDBValidKey; readonly value: unknown }[] }
interface Envelope { readonly storageVersion: 1; readonly revision: number; readonly document: DesktopPreferencesV1 }
type WriteDecision = { readonly kind: 'write'; readonly preferences?: Envelope; readonly epoch?: number; readonly supersedesPalette?: true; readonly put?: { readonly digest: PaletteDigest; readonly text: string }; readonly remove?: IDBValidKey }
  | { readonly kind: 'refused'; readonly diagnostic: string };
const SAVE_FAILURE = 'Could not save this change.';
const STORAGE_UNAVAILABLE = 'Saved personalization is unavailable. Retry to read it again.';
const FUTURE_VERSION = 'Saved personalization uses a newer version and has been preserved.';
const CAPABILITY = 'Palette verification is unavailable. Use builtin colors and retry.';
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function future(value: unknown): boolean { return typeof value === 'number' && Number.isInteger(value) && value > 1; }
function revision(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function classifyEpoch(record: StoredRow): number | null {
  if (record.kind === 'absent') return 0;
  const value = record.value;
  return object(value) && Object.keys(value).length === 2 && value.version === 1 && revision(value.value) ? value.value : null;
}
function classify(raw: RawSnapshot): SavedPreferences {
  const epoch = classifyEpoch(raw.epoch);
  if (epoch === null || classifyEpoch(raw.paletteGeneration) === null) return { kind: 'unavailable', diagnostic: 'Saved personalization metadata is unavailable and has been preserved.' };
  const record = raw.preferences;
  if (record.kind === 'absent') return { kind: 'valid', epoch, revision: 0, document: defaultDesktopPreferences };
  const value = record.value;
  if (object(value) && (future(value.storageVersion) || (object(value.document) && future(value.document.version)))) return { kind: 'unavailable', diagnostic: FUTURE_VERSION };
  const base = object(value) && value.storageVersion === 1 && revision(value.revision) ? value.revision : null;
  if (base !== null && object(value) && Object.keys(value).length === 3) {
    try { return { kind: 'valid', epoch, revision: base, document: parseDesktopPreferences(value.document) }; }
    catch { /* An explicit reset or revision-checked replacement may repair this document. */ }
  }
  return { kind: 'invalid', epoch, revision: base, diagnostic: 'Saved preferences are invalid and have been preserved. Reset saved preferences to recover.' };
}
function unavailable(diagnostic = STORAGE_UNAVAILABLE): PersonalizationSnapshot { return { preferences: { kind: 'unavailable', diagnostic }, palettes: [] }; }
function envelope(current: Extract<SavedPreferences, { kind: 'valid' }>, document: DesktopPreferencesV1): Envelope {
  if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('revision exhausted');
  return { storageVersion: 1, revision: current.revision + 1, document };
}
function refusal(diagnostic: string): WriteDecision { return { kind: 'refused', diagnostic }; }
export async function paletteDigest(text: string): Promise<PaletteDigest> {
  const bytes = new TextEncoder().encode(text);
  let digest: Uint8Array;
  try { digest = globalThis.crypto?.subtle ? new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)) : hash(bytes); } catch { throw new Error(CAPABILITY); }
  return parsePaletteDigest([...digest].map(value => value.toString(16).padStart(2, '0')).join(''));
}
async function validateResource(row: RawSnapshot['palettes'][number]): Promise<PaletteResource> {
  const digest = typeof row.key === 'string' ? row.key : String(row.key);
  try {
    if (!isPaletteDigest(row.key) || typeof row.value !== 'string' || new TextEncoder().encode(row.value).byteLength > MAX_PALETTE_BYTES) throw new Error('invalid row');
    const document = parsePaletteDocument(JSON.parse(row.value));
    const text = canonicalPaletteText(document);
    if (text !== row.value || await paletteDigest(text) !== row.key) throw new Error('digest mismatch');
    return { kind: 'ready', key: row.key, digest: row.key, document, text };
  } catch (error) { return { kind: 'unavailable', key: row.key, digest, diagnostic: error instanceof Error && error.message === CAPABILITY ? CAPABILITY : 'This palette cannot be verified. Remove it and reimport its original JSON.' }; }
}

export class PersonalizationStorage {
  private database: Promise<IDBDatabase> | null = null;
  private closed = false;
  private readToken = 0;
  private paletteIntent = 0;
  private blocked = false;
  private snapshot: PersonalizationSnapshot | null = null;
  private readonly listeners = new Set<(snapshot: PersonalizationSnapshot) => void>();
  private channel: BroadcastChannel | null = null;
  private notificationsStarted = false;
  private readonly onFocus = () => { if (!this.blocked) void this.readSnapshot(); };
  private startNotifications(): void {
    if (this.notificationsStarted) return;
    this.notificationsStarted = true;
    try { this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('openpane-personalization'); }
    catch { this.channel = null; }
    if (this.channel) this.channel.onmessage = () => { if (!this.blocked) void this.readSnapshot(); };
    globalThis.addEventListener?.('focus', this.onFocus);
  }
  subscribe = (listener: (snapshot: PersonalizationSnapshot) => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  setBlocked(blocked: boolean): void { this.blocked = blocked; }
  invalidateReads(): void { this.readToken++; }
  private open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error('closed'));
    this.startNotifications();
    if (this.database) return this.database;
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('openpane-personalization', 1);
      let rejected = false;
      request.onupgradeneeded = () => { request.result.createObjectStore('preferences'); request.result.createObjectStore('palettes'); };
      request.onerror = () => reject(new Error(request.error?.name === 'VersionError' ? FUTURE_VERSION : STORAGE_UNAVAILABLE));
      request.onblocked = () => { rejected = true; reject(new Error(STORAGE_UNAVAILABLE)); };
      request.onsuccess = () => {
        const database = request.result;
        if (this.closed || rejected) { database.close(); reject(new Error(STORAGE_UNAVAILABLE)); return; }
        const disconnected = () => { this.database = null; this.invalidateReads(); this.publish(unavailable()); };
        database.onversionchange = () => { database.close(); disconnected(); };
        database.onclose = disconnected;
        resolve(database);
      };
    }).catch(error => { this.database = null; throw error; });
    return this.database;
  }
  private publish(snapshot: PersonalizationSnapshot): void {
    if (this.closed) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
  private async transaction(mode: IDBTransactionMode, write?: (snapshot: RawSnapshot) => WriteDecision): Promise<{ readonly raw: RawSnapshot; readonly decision: WriteDecision | undefined }> {
    const database = await this.open();
    if (this.closed) throw new Error('closed');
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      try { transaction = database.transaction(['preferences', 'palettes'], mode); }
      catch (error) { if (error instanceof DOMException && error.name === 'InvalidStateError') this.database = null; reject(error); return; }
      const preferences = transaction.objectStore('preferences'), palettes = transaction.objectStore('palettes');
      const document = preferences.get('current'), presence = preferences.getKey('current'), epoch = preferences.get('epoch'), epochPresence = preferences.getKey('epoch'), paletteGeneration = preferences.get('palette-generation'), paletteGenerationPresence = preferences.getKey('palette-generation'), keys = palettes.getAllKeys(), values = palettes.getAll();
      let remaining = 8, raw: RawSnapshot | undefined, decision: WriteDecision | undefined;
      const loaded = () => {
        if (--remaining !== 0) return;
        raw = { preferences: presence.result === undefined ? { kind: 'absent' } : { kind: 'present', value: document.result }, epoch: epochPresence.result === undefined ? { kind: 'absent' } : { kind: 'present', value: epoch.result }, paletteGeneration: paletteGenerationPresence.result === undefined ? { kind: 'absent' } : { kind: 'present', value: paletteGeneration.result }, palettes: keys.result.map((key, index) => ({ key, value: values.result[index] })) };
        try {
          decision = write?.(raw);
          if (decision?.kind === 'write') {
            if (decision.supersedesPalette) {
              const generation = classifyEpoch(raw.paletteGeneration);
              if (generation === null || generation >= Number.MAX_SAFE_INTEGER) throw new Error('unavailable palette metadata');
              preferences.put({ version: 1, value: generation + 1 }, 'palette-generation');
            }
            if (decision.preferences) {
              const epoch = decision.epoch ?? classifyEpoch(raw.epoch);
              if (epoch === null) throw new Error('unavailable metadata');
              preferences.put(decision.preferences, 'current');
              preferences.put({ version: 1, value: epoch }, 'epoch');
            }
            if (decision.put) palettes.put(decision.put.text, decision.put.digest);
            if ('remove' in decision) palettes.delete(decision.remove);
          }
        } catch { transaction.abort(); }
      };
      document.onsuccess = loaded; presence.onsuccess = loaded; epoch.onsuccess = loaded; epochPresence.onsuccess = loaded; paletteGeneration.onsuccess = loaded; paletteGenerationPresence.onsuccess = loaded; keys.onsuccess = loaded; values.onsuccess = loaded;
      transaction.oncomplete = () => { if (raw) resolve({ raw, decision }); else reject(new Error(STORAGE_UNAVAILABLE)); };
      transaction.onabort = transaction.onerror = () => reject(new Error(SAVE_FAILURE));
    });
  }
  async readSnapshot(): Promise<PersonalizationSnapshot> {
    const token = ++this.readToken;
    let snapshot: PersonalizationSnapshot;
    try {
      const { raw } = await this.transaction('readonly');
      const preferences = classify(raw);
      // Disabling executable UI must not wait for unrelated palette verification.
      if (token === this.readToken && preferences.kind === 'valid' && !preferences.document.ui.enabled) {
        this.publish({ preferences, palettes: this.snapshot?.palettes ?? [] });
      }
      snapshot = { preferences, palettes: await Promise.all(raw.palettes.map(validateResource)) };
    } catch (error) { snapshot = unavailable(error instanceof Error && error.message === FUTURE_VERSION ? FUTURE_VERSION : STORAGE_UNAVAILABLE); }
    if (token === this.readToken && !this.closed) this.publish(snapshot);
    return snapshot;
  }
  private async mutate(write: (snapshot: RawSnapshot) => WriteDecision): Promise<PersonalizationOutcome> {
    if (this.closed) return { kind: 'unavailable', diagnostic: STORAGE_UNAVAILABLE };
    this.invalidateReads();
    try {
      const { raw, decision } = await this.transaction('readwrite', write);
      if (decision?.kind === 'refused') { await this.readSnapshot(); return decision; }
      try { this.channel?.postMessage('invalidate'); } catch { /* Focus rereads remain available. */ }
      const snapshot = await this.readSnapshot();
      return { kind: 'committed', epoch: decision?.kind === 'write' && decision.preferences ? decision.epoch ?? classifyEpoch(raw.epoch) : null, revision: decision?.kind === 'write' ? decision.preferences?.revision ?? null : null, snapshot };
    } catch { await this.readSnapshot(); return { kind: 'unavailable', diagnostic: SAVE_FAILURE }; }
  }
  patchPreferences(patch: PreferencePatch): Promise<PersonalizationOutcome> {
    return this.mutate(raw => {
      const current = classify(raw);
      if (current.kind !== 'valid') return refusal(current.diagnostic);
      return { kind: 'write', preferences: envelope(current, parseDesktopPreferences(patchDesktopPreferences(current.document, patch))) };
    });
  }
  replacePreferences({ expectedEpoch, expectedRevision, document }: { readonly expectedEpoch: number; readonly expectedRevision: number; readonly document: DesktopPreferencesV1 }): Promise<PersonalizationOutcome> {
    let parsed: DesktopPreferencesV1;
    try { parsed = parseDesktopPreferences(document); } catch (error) { return Promise.resolve({ kind: 'refused', diagnostic: error instanceof Error ? error.message : 'Invalid preferences.' }); }
    return this.mutate(raw => {
      const current = classify(raw);
      if (current.kind === 'unavailable') return refusal(current.diagnostic);
      if (current.epoch !== expectedEpoch || current.revision === null || current.revision !== expectedRevision) return refusal('Saved preferences changed. Review the latest saved JSON before replacing it. Your draft is retained.');
      if (current.revision >= Number.MAX_SAFE_INTEGER) return refusal(SAVE_FAILURE);
      return { kind: 'write', supersedesPalette: true, preferences: { storageVersion: 1, revision: current.revision + 1, document: parsed } };
    });
  }
  async importPalette(text: string): Promise<PersonalizationOutcome> {
    if (new TextEncoder().encode(text).byteLength > MAX_PALETTE_BYTES) return { kind: 'refused', diagnostic: PALETTE_SIZE_DIAGNOSTIC };
    let canonical: string, digest: PaletteDigest;
    try { canonical = canonicalPaletteText(parsePaletteDocument(JSON.parse(text))); }
    catch (error) { return { kind: 'refused', diagnostic: error instanceof Error ? error.message : 'Invalid palette JSON.' }; }
    try { digest = await paletteDigest(canonical); } catch { return { kind: 'unavailable', diagnostic: CAPABILITY }; }
    return this.mutate(raw => {
      const current = classify(raw);
      if (current.kind === 'unavailable') return refusal(current.diagnostic);
      const existing = raw.palettes.find(row => row.key === digest);
      if (existing) return existing.value === canonical ? { kind: 'write' } : refusal('This palette row is damaged. Remove it before reimporting.');
      if (raw.palettes.length >= MAX_PALETTES) return refusal('The palette library is full (64 resources). Remove one before importing.');
      return { kind: 'write', put: { digest, text: canonical } };
    });
  }
  async selectPalette(digest: PaletteDigest | null): Promise<PersonalizationOutcome> {
    const intent = ++this.paletteIntent;
    let selected: Extract<PaletteResource, { kind: 'ready' }> | null = null;
    let generation: number | null = null;
    if (digest !== null) {
      let raw: RawSnapshot;
      try { ({ raw } = await this.transaction('readonly')); } catch { return { kind: 'unavailable', diagnostic: STORAGE_UNAVAILABLE }; }
      generation = classifyEpoch(raw.paletteGeneration);
      const candidate = raw.palettes.find(row => row.key === digest);
      const row = candidate ? await validateResource(candidate) : undefined;
      if (row?.kind !== 'ready') return { kind: 'refused', diagnostic: row?.diagnostic ?? 'This palette is missing. Reimport it or choose builtin colors.' };
      selected = row;
    }
    return this.mutate(raw => {
      if (intent !== this.paletteIntent || (digest !== null && generation !== classifyEpoch(raw.paletteGeneration))) return refusal('A newer palette choice superseded this selection.');
      const current = classify(raw);
      if (current.kind !== 'valid') return refusal(current.diagnostic);
      if (selected && !raw.palettes.some(row => row.key === selected.digest && row.value === selected.text)) return refusal('This palette changed or was removed. Select it again.');
      return { kind: 'write', supersedesPalette: true, preferences: envelope(current, { ...current.document, palette: selected ? { kind: 'imported', digest: selected.digest } : { kind: 'builtin' } }) };
    });
  }
  removePalette(key: IDBValidKey): Promise<PersonalizationOutcome> {
    return this.mutate(raw => {
      const current = classify(raw);
      if (current.kind === 'unavailable') return refusal(current.diagnostic);
      if (current.kind === 'valid' && current.document.palette.kind === 'imported' && current.document.palette.digest === key) {
        return { kind: 'write', supersedesPalette: true, remove: key, preferences: envelope(current, { ...current.document, palette: { kind: 'builtin' } }) };
      }
      return { kind: 'write', remove: key };
    });
  }
  resetAppearance(): Promise<PersonalizationOutcome> {
    this.paletteIntent++;
    return this.mutate(raw => {
      const current = classify(raw);
      if (current.kind !== 'valid') return refusal(current.diagnostic);
      return { kind: 'write', supersedesPalette: true, preferences: envelope(current, { ...current.document, appearance: 'system', palette: { kind: 'builtin' } }) };
    });
  }
  restoreDefaultView(): Promise<PersonalizationOutcome> { return this.patchPreferences({ kind: 'ui-enabled', enabled: false }); }
  resetPersonalization(): Promise<PersonalizationOutcome> {
    this.paletteIntent++;
    const unreadable = this.snapshot?.preferences.kind === 'invalid' && this.snapshot.preferences.revision === null;
    return this.mutate(raw => {
      const current = classify(raw);
      if (current.kind === 'unavailable') return refusal(current.diagnostic);
      if (unreadable && (current.kind !== 'invalid' || current.revision !== null)) return refusal('Saved preferences changed. Retry before resetting.');
      const next = current.revision === null ? 0 : current.revision + 1;
      const epoch = current.revision === null ? current.epoch + 1 : current.epoch;
      if (!revision(next) || !revision(epoch)) return refusal(SAVE_FAILURE);
      return { kind: 'write', supersedesPalette: true, epoch, preferences: { storageVersion: 1, revision: next, document: safeDesktopPreferences } };
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.paletteIntent++; this.invalidateReads(); this.listeners.clear(); this.channel?.close();
    globalThis.removeEventListener?.('focus', this.onFocus);
    void this.database?.then(database => database.close(), () => {});
  }
}
