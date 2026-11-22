import { canonicalPaletteText, parsePaletteDocument, type PaletteDocumentV1 } from '@openpane/theme';
import { defaultDesktopPreferences, safeDesktopPreferences, parseDesktopPreferences, parsePaletteDigest, isPaletteDigest, patchDesktopPreferences,
  type DesktopPreferencesV1, type PaletteDigest, type PreferencePatch } from './personalization.js';

export const MAX_PALETTE_BYTES = 64 * 1024;
export const MAX_PALETTES = 64;
export type SavedPreferences =
  | { readonly kind: 'valid'; readonly revision: number; readonly document: DesktopPreferencesV1 }
  | { readonly kind: 'invalid'; readonly revision: number | null; readonly repairable: boolean; readonly diagnostic: string }
  | { readonly kind: 'unavailable'; readonly diagnostic: string };
export type PaletteResource =
  | { readonly kind: 'ready'; readonly digest: PaletteDigest; readonly document: PaletteDocumentV1; readonly text: string }
  | { readonly kind: 'unavailable'; readonly digest: string; readonly diagnostic: string };
export interface PersonalizationSnapshot { readonly preferences: SavedPreferences; readonly palettes: readonly PaletteResource[] }
export type PersonalizationOutcome =
  | { readonly kind: 'committed'; readonly snapshot: PersonalizationSnapshot }
  | { readonly kind: 'refused' | 'unavailable'; readonly diagnostic: string };
interface RawSnapshot { readonly preferences: unknown; readonly palettes: readonly { readonly key: IDBValidKey; readonly value: unknown }[] }
interface Envelope { readonly storageVersion: 1; readonly revision: number; readonly document: DesktopPreferencesV1 }
type WriteDecision = { readonly kind: 'write'; readonly preferences?: Envelope; readonly put?: { readonly digest: PaletteDigest; readonly text: string }; readonly remove?: string }
  | { readonly kind: 'refused'; readonly diagnostic: string };
const SAVE_FAILURE = 'Could not save this change.';
const STORAGE_UNAVAILABLE = 'Saved personalization is unavailable. Retry to read it again.';
const FUTURE_VERSION = 'Saved personalization uses a newer version and has been preserved.';
const CAPABILITY = 'Palette verification is unavailable. Use builtin colors until WebCrypto is available.';
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function future(value: unknown): boolean { return typeof value === 'number' && Number.isInteger(value) && value > 1; }
function revision(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function classify(value: unknown): SavedPreferences {
  if (value === undefined) return { kind: 'valid', revision: 0, document: defaultDesktopPreferences };
  if (object(value) && (future(value.storageVersion) || (object(value.document) && future(value.document.version)))) return { kind: 'unavailable', diagnostic: FUTURE_VERSION };
  const base = object(value) && value.storageVersion === 1 && revision(value.revision) ? value.revision : null;
  if (base !== null && object(value) && Object.keys(value).length === 3) {
    try { return { kind: 'valid', revision: base, document: parseDesktopPreferences(value.document) }; }
    catch { /* An explicit reset or revision-checked replacement may repair this document. */ }
  }
  return { kind: 'invalid', revision: base, repairable: true, diagnostic: 'Saved preferences are invalid and have been preserved. Reset saved preferences to recover.' };
}
function unavailable(diagnostic = STORAGE_UNAVAILABLE): PersonalizationSnapshot { return { preferences: { kind: 'unavailable', diagnostic }, palettes: [] }; }
function envelope(current: Extract<SavedPreferences, { kind: 'valid' }>, document: DesktopPreferencesV1): Envelope {
  if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('revision exhausted');
  return { storageVersion: 1, revision: current.revision + 1, document };
}
function refusal(diagnostic: string): WriteDecision { return { kind: 'refused', diagnostic }; }
export async function paletteDigest(text: string): Promise<PaletteDigest> {
  if (!globalThis.crypto?.subtle) throw new Error(CAPABILITY);
  let digest: ArrayBuffer;
  try { digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); } catch { throw new Error(CAPABILITY); }
  return parsePaletteDigest([...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''));
}
async function validateResource(row: RawSnapshot['palettes'][number]): Promise<PaletteResource> {
  const digest = typeof row.key === 'string' ? row.key : String(row.key);
  if (!globalThis.crypto?.subtle) return { kind: 'unavailable', digest, diagnostic: CAPABILITY };
  try {
    if (!isPaletteDigest(row.key) || typeof row.value !== 'string' || new TextEncoder().encode(row.value).byteLength > MAX_PALETTE_BYTES) throw new Error('invalid row');
    const document = parsePaletteDocument(JSON.parse(row.value));
    const text = canonicalPaletteText(document);
    if (text !== row.value || await paletteDigest(text) !== row.key) throw new Error('digest mismatch');
    return { kind: 'ready', digest: row.key, document, text };
  } catch (error) { return { kind: 'unavailable', digest, diagnostic: error instanceof Error && error.message === CAPABILITY ? CAPABILITY : 'This palette cannot be verified. Remove it and reimport its original JSON.' }; }
}

export class PersonalizationStorage {
  private database: Promise<IDBDatabase> | null = null;
  private closed = false;
  private readToken = 0;
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
        database.onversionchange = () => { database.close(); this.database = null; this.invalidateReads(); this.publish(unavailable()); };
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
      const transaction = database.transaction(['preferences', 'palettes'], mode);
      const preferences = transaction.objectStore('preferences'), palettes = transaction.objectStore('palettes');
      const document = preferences.get('current'), keys = palettes.getAllKeys(), values = palettes.getAll();
      let remaining = 3, raw: RawSnapshot | undefined, decision: WriteDecision | undefined;
      const loaded = () => {
        if (--remaining !== 0) return;
        raw = { preferences: document.result, palettes: keys.result.map((key, index) => ({ key, value: values.result[index] })) };
        try {
          decision = write?.(raw);
          if (decision?.kind === 'write') {
            if (decision.preferences) preferences.put(decision.preferences, 'current');
            if (decision.put) palettes.put(decision.put.text, decision.put.digest);
            if (decision.remove) palettes.delete(decision.remove);
          }
        } catch { transaction.abort(); }
      };
      document.onsuccess = loaded; keys.onsuccess = loaded; values.onsuccess = loaded;
      transaction.oncomplete = () => { if (raw) resolve({ raw, decision }); else reject(new Error(STORAGE_UNAVAILABLE)); };
      transaction.onabort = transaction.onerror = () => reject(new Error(SAVE_FAILURE));
    });
  }
  async readSnapshot(): Promise<PersonalizationSnapshot> {
    const token = ++this.readToken;
    let snapshot: PersonalizationSnapshot;
    try {
      const { raw } = await this.transaction('readonly');
      snapshot = { preferences: classify(raw.preferences), palettes: await Promise.all(raw.palettes.map(validateResource)) };
    } catch (error) { snapshot = unavailable(error instanceof Error && error.message === FUTURE_VERSION ? FUTURE_VERSION : STORAGE_UNAVAILABLE); }
    if (token === this.readToken && !this.closed) this.publish(snapshot);
    return snapshot;
  }
  private async mutate(write: (snapshot: RawSnapshot) => WriteDecision): Promise<PersonalizationOutcome> {
    if (this.closed) return { kind: 'unavailable', diagnostic: STORAGE_UNAVAILABLE };
    this.invalidateReads();
    try {
      const { decision } = await this.transaction('readwrite', write);
      if (decision?.kind === 'refused') return decision;
      const snapshot = await this.readSnapshot();
      try { this.channel?.postMessage('invalidate'); } catch { /* Focus rereads remain available. */ }
      return { kind: 'committed', snapshot };
    } catch { return { kind: 'unavailable', diagnostic: SAVE_FAILURE }; }
  }
  patchPreferences(patch: PreferencePatch): Promise<PersonalizationOutcome> {
    return this.mutate(raw => {
      const current = classify(raw.preferences);
      if (current.kind !== 'valid') return refusal(current.diagnostic);
      return { kind: 'write', preferences: envelope(current, parseDesktopPreferences(patchDesktopPreferences(current.document, patch))) };
    });
  }
  replacePreferences({ expectedRevision, document }: { readonly expectedRevision: number; readonly document: DesktopPreferencesV1 }): Promise<PersonalizationOutcome> {
    let parsed: DesktopPreferencesV1;
    try { parsed = parseDesktopPreferences(document); } catch (error) { return Promise.resolve({ kind: 'refused', diagnostic: error instanceof Error ? error.message : 'Invalid preferences.' }); }
    return this.mutate(raw => {
      const current = classify(raw.preferences);
      if (current.kind === 'unavailable') return refusal(current.diagnostic);
      if (current.revision === null || current.revision !== expectedRevision) return refusal('Saved preferences changed. Review the latest saved JSON before replacing it. Your draft is retained.');
      if (current.revision >= Number.MAX_SAFE_INTEGER) return refusal(SAVE_FAILURE);
      return { kind: 'write', preferences: { storageVersion: 1, revision: current.revision + 1, document: parsed } };
    });
  }
  async importPalette(text: string): Promise<PersonalizationOutcome> {
    if (new TextEncoder().encode(text).byteLength > MAX_PALETTE_BYTES) return { kind: 'refused', diagnostic: 'Palette JSON must be at most 64 KiB.' };
    let canonical: string, digest: PaletteDigest;
    try { canonical = canonicalPaletteText(parsePaletteDocument(JSON.parse(text))); }
    catch (error) { return { kind: 'refused', diagnostic: error instanceof Error ? error.message : 'Invalid palette JSON.' }; }
    try { digest = await paletteDigest(canonical); } catch { return { kind: 'unavailable', diagnostic: CAPABILITY }; }
    return this.mutate(raw => {
      const existing = raw.palettes.find(row => row.key === digest);
      if (existing) return existing.value === canonical ? { kind: 'write' } : refusal('This palette row is damaged. Remove it before reimporting.');
      if (raw.palettes.length >= MAX_PALETTES) return refusal('The palette library is full (64 resources). Remove one before importing.');
      return { kind: 'write', put: { digest, text: canonical } };
    });
  }
  async selectPalette(digest: PaletteDigest | null): Promise<PersonalizationOutcome> {
    let selected: Extract<PaletteResource, { kind: 'ready' }> | null = null;
    if (digest !== null) {
      const snapshot = await this.readSnapshot();
      const row = snapshot.palettes.find(row => row.digest === digest);
      if (row?.kind !== 'ready') return { kind: 'refused', diagnostic: row?.diagnostic ?? 'This palette is missing. Reimport it or choose builtin colors.' };
      selected = row;
    }
    return this.mutate(raw => {
      const current = classify(raw.preferences);
      if (current.kind !== 'valid') return refusal(current.diagnostic);
      if (selected && !raw.palettes.some(row => row.key === selected.digest && row.value === selected.text)) return refusal('This palette changed or was removed. Select it again.');
      return { kind: 'write', preferences: envelope(current, { ...current.document, palette: selected ? { kind: 'imported', digest: selected.digest } : { kind: 'builtin' } }) };
    });
  }
  removePalette(digest: string): Promise<PersonalizationOutcome> {
    return this.mutate(raw => {
      const current = classify(raw.preferences);
      if (current.kind === 'valid' && current.document.palette.kind === 'imported' && current.document.palette.digest === digest) {
        return { kind: 'write', remove: digest, preferences: envelope(current, { ...current.document, palette: { kind: 'builtin' } }) };
      }
      return { kind: 'write', remove: digest };
    });
  }
  resetAppearance(): Promise<PersonalizationOutcome> {
    return this.mutate(raw => {
      const current = classify(raw.preferences);
      if (current.kind !== 'valid') return refusal(current.diagnostic);
      return { kind: 'write', preferences: envelope(current, { ...current.document, appearance: 'system', palette: { kind: 'builtin' } }) };
    });
  }
  restoreDefaultView(): Promise<PersonalizationOutcome> { return this.patchPreferences({ kind: 'ui-enabled', enabled: false }); }
  resetPersonalization(): Promise<PersonalizationOutcome> {
    const unreadable = this.snapshot?.preferences.kind === 'invalid' && this.snapshot.preferences.revision === null;
    return this.mutate(raw => {
      const current = classify(raw.preferences);
      if (current.kind === 'unavailable') return refusal(current.diagnostic);
      if (unreadable && (current.kind !== 'invalid' || current.revision !== null)) return refusal('Saved preferences changed. Retry before resetting.');
      const next = current.revision === null ? 0 : current.revision + 1;
      if (!revision(next)) return refusal(SAVE_FAILURE);
      return { kind: 'write', preferences: { storageVersion: 1, revision: next, document: safeDesktopPreferences } };
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.invalidateReads(); this.listeners.clear(); this.channel?.close();
    globalThis.removeEventListener?.('focus', this.onFocus);
    void this.database?.then(database => database.close(), () => {});
  }
}
