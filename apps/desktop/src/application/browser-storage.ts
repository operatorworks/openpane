import { initializeDraft } from './initial-draft.js';
import { commitCarriedDraft, commitCopiedDraft, commitIncomingCopiedDraft } from './draft-carry-records.js';
import type { ConversationScope, EditorBinding } from '@openpane/contracts';
import { parseEditorBinding, parseScope, parseCommand, sameScope } from '@openpane/contracts';
import { identifier, record } from '@openpane/contracts/decode';
import type { DraftStoragePort } from '@openpane/client';

import { activateEditor, conversationLock, editorBindingKey, editorViewKey, readEditorBinding, recoverEditor, transferEditor } from './editor-bindings.js';
import type { EditorClaim, EditorRecoveryGrant, HandoffPlan } from './editor-bindings.js';
import { decodeView, SupersededDraftsError } from './view-state.js';
import type { OwnedViewStorage, SavedDraftRecovery, SavedView, ViewStorageFactory, ViewReopenOptions } from './view-state.js';

export function openViewDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open('openpane-browser-views', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('Local storage is blocked by another app version.')); };
  });
}

async function claim(viewId: string, waitForPreviousDocument = false): Promise<(() => void) | null> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = waitForPreviousDocument ? setTimeout(() => controller.abort(), 1500) : undefined;
    void navigator.locks.request(`openpane-view:${viewId}`, waitForPreviousDocument ? { signal: controller.signal } : { ifAvailable: true }, lock => {
      clearTimeout(timer);
      if (!lock) { resolve(null); return; }
      return new Promise<void>(release => resolve(release));
    }).catch(error => { clearTimeout(timer); if (controller.signal.aborted) resolve(null); else reject(error); });
  });
}

// IndexedDB arrays sort after strings, so this sentinel bounds all view identifiers.
const AFTER_ALL_STRINGS: IDBValidKey = [];
function viewKeyRange(after: string | null): IDBKeyRange {
  let lower: IDBValidKey = ['view'];
  if (after !== null) {
    const cursor: unknown = JSON.parse(after);
    if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== 'string' || typeof cursor[1] !== 'string') throw new Error('Invalid saved view cursor');
    lower = ['view', cursor[0], cursor[1]];
  }
  return IDBKeyRange.bound(lower, ['view', AFTER_ALL_STRINGS], after !== null, true);
}

export class BrowserViewStorage implements OwnedViewStorage {
  private closing: Promise<void> | null = null;
  private editor: EditorBinding | null = null;
  private readonly frozen = new Set<string>();
  private readonly transactions = new Set<Promise<void>>();
  private readonly draftOwners = new Map<string, object>();
  private constructor(readonly viewId: string, private readonly db: IDBDatabase, private readonly unlock: () => void, onFailure: (error: unknown) => void, private readonly catalog = false) {
    db.onversionchange = () => {
      void this.close();
      onFailure(new Error('Local storage changed in another app version. Reload this view before continuing.'));
    };
  }

  static async open(onFailure: (error: unknown) => void, sessionKey = 'openpane.viewId'): Promise<BrowserViewStorage> {
    if (!globalThis.indexedDB || !navigator.locks) throw new Error('This browser cannot safely save an exclusive view. IndexedDB and Web Locks are required.');
    const inherited = sessionStorage.getItem(sessionKey);
    let viewId = inherited ?? crypto.randomUUID();
    let release = await claim(viewId, inherited !== null);
    if (!release) {
      viewId = crypto.randomUUID();
      release = await claim(viewId);
    }
    if (!release) throw new Error('Could not acquire an exclusive view. Reload the app.');
    try {
      sessionStorage.setItem(sessionKey, viewId);
      return new BrowserViewStorage(viewId, await openViewDatabase(), release, onFailure, sessionKey === 'openpane.catalogViewId');
    } catch (error) { release(); throw error; }
  }

  static async reopen(viewId: string, onFailure: (error: unknown) => void, { waitForPreviousDocument = false, catalog = false }: ViewReopenOptions = {}): Promise<BrowserViewStorage> {
    if (!globalThis.indexedDB || !navigator.locks) throw new Error('This browser cannot safely save an exclusive view. IndexedDB and Web Locks are required.');
    const release = await claim(viewId, waitForPreviousDocument);
    if (!release) throw new Error('This saved view is already open in another tab.');
    let db: IDBDatabase | undefined;
    try {
      db = await openViewDatabase();
      return new BrowserViewStorage(viewId, db, release, onFailure, catalog);
    } catch (error) { db?.close(); release(); throw error; }
  }

  static async readLegacyDraft(viewId: string, hostId: string, selectedScope?: ConversationScope): Promise<SavedDraftRecovery | null> {
    const db = await openViewDatabase();
    try {
      return await new Promise<SavedDraftRecovery | null>((resolve, reject) => {
        const tx = db.transaction('records'), store = tx.objectStore('records');
        const bound = store.get(editorViewKey(viewId)), view = store.get(['view', viewId, hostId]);
        const keys = store.getAllKeys(IDBKeyRange.bound(['draft', viewId, hostId], ['draft', viewId, hostId, []], false, true), 1025);
        let remaining = 3, result: SavedDraftRecovery | null = null, failure: unknown, imageReadFailed = false;
        const fail = (cause: unknown) => { failure = cause; tx.abort(); };
        const inspect = () => {
          if (--remaining !== 0) return;
          try {
            const saved = decodeView(view.result, hostId);
            if (bound.result === undefined && keys.result.length > 1024) throw new Error('This saved view has too many drafts for recovery. Its records are preserved.');
            const scopes = bound.result === undefined ? keys.result.flatMap(key => Array.isArray(key) && typeof key[3] === 'string' ? [{ hostId, conversationId: key[3] }] : []) : [parseScope(bound.result)];
            const candidates = bound.result === undefined ? [selectedScope, saved.route ?? saved.pendingCreation?.scope, ...scopes] : scopes;
            const readCandidate = (index: number): void => {
              const scope = candidates[index];
              if (!scope) { if (index < candidates.length) readCandidate(index + 1); return; }
              if (scope.hostId !== hostId) throw new Error('Saved draft recovery belongs to another host');
              const binding = store.get(editorBindingKey(scope)), value = store.get(['draft', viewId, hostId, scope.conversationId]);
              let pending = 2;
              const loaded = () => {
                if (--pending !== 0) return;
                try {
                  if (value.result === undefined) { readCandidate(index + 1); return; }
                  const owned = binding.result === undefined ? null : parseEditorBinding(binding.result), draft = record(value.result);
                  if (typeof draft.draft !== 'string' || !sameScope(parseScope(draft.scope), scope)) throw new Error('Unsupported saved draft. Its original records are preserved.');
                  const text = draft.draft, entries = Array.isArray(draft.outbox) ? draft.outbox.slice(0, 1024) : [], queuedTexts: string[] = [];
                  for (const value of entries) {
                    try { const entry = record(value), command = parseCommand(entry.command); if (sameScope(command.scope, scope) && command.body.kind === 'send') queuedTexts.push(command.body.text); } catch {}
                  }
                  const finish = (image?: SavedDraftRecovery['image']) => {
                    result = { ...(saved.pendingCreation && sameScope(saved.pendingCreation.scope, scope) ? { pendingCreation: saved.pendingCreation } : {}), kind: !owned || owned.viewId === viewId ? 'bound' : 'independent', viewId, scope, text, scopes, queuedTexts, queuedCount: entries.length, ...(image ? { image } : {}) };
                  };
                  try {
                    if (draft.image) {
                      const metadata = record(draft.image), selectionId = identifier(metadata.selectionId), name = metadata.name;
                      const image = store.get(['draft-image', viewId, hostId, scope.conversationId, selectionId]);
                      image.onsuccess = () => { const bytes: unknown = image.result; finish(bytes instanceof Uint8Array && bytes.byteLength <= 4 * 1024 * 1024 && typeof name === 'string' ? { name: name.slice(0, 200), bytes } : undefined); };
                      image.onerror = event => { imageReadFailed = image.error !== null && image.error.name !== 'AbortError'; event.preventDefault(); event.stopPropagation(); finish(); };
                      return;
                    }
                  } catch {}
                  finish();
                } catch (cause) { fail(cause); }
              };
              binding.onsuccess = value.onsuccess = loaded;
            };
            readCandidate(0);
          } catch (cause) { fail(cause); }
        };
        bound.onsuccess = view.onsuccess = keys.onsuccess = inspect;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => { if (imageReadFailed && result !== null && failure === undefined) resolve(result); else reject(failure ?? tx.error ?? new Error('Saved draft recovery interrupted')); };
      });
    } finally { db.close(); }
  }

  async openRemainingWork(hostId: string): Promise<void> {
    const saved = await this.readView(hostId);
    if (!saved.route) return;
    const binding = await readEditorBinding(this.db, saved.route);
    if (binding && binding.viewId !== this.viewId) {
      await this.transaction('readwrite', store => store.put({ ...saved, route: null }, ['view', this.viewId, hostId]));
    }
  }

  static async bindingForView(viewId: string): Promise<EditorBinding | null> {
    const db = await openViewDatabase();
    try {
      return await new Promise<EditorBinding | null>((resolve, reject) => {
        const transaction = db.transaction('records'), store = transaction.objectStore('records'), reverse = store.get(editorViewKey(viewId));
        let result: EditorBinding | null = null, failure: unknown;
        const fail = (error: unknown) => { failure = error; transaction.abort(); };
        reverse.onsuccess = () => {
          try {
            if (reverse.result === undefined) return;
            const scope = parseScope(reverse.result), forward = store.get(editorBindingKey(scope));
            forward.onsuccess = () => {
              try {
                const binding = forward.result === undefined ? null : parseEditorBinding(forward.result);
                if (!binding || binding.viewId !== viewId || !sameScope(binding.scope, scope)) throw new Error('Saved view and editor binding disagree. Original records are preserved.');
                result = binding;
              } catch (error) { fail(error); }
            };
          } catch (error) { fail(error); }
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Saved editor lookup interrupted.'));
      });
    } finally { db.close(); }
  }

  static async locateEditor(scope: ConversationScope, preferredViewId?: string): Promise<{ readonly binding: EditorBinding | null; readonly legacyViewIds: readonly string[] }> {
    const db = await openViewDatabase();
    try {
      const binding = await readEditorBinding(db, scope);
      if (binding) {
        if (!sameScope(binding.scope, scope)) throw new Error('Editor binding scope mismatch; local records were preserved.');
        return { binding, legacyViewIds: [] };
      }
      const legacyViewIds = await new Promise<readonly string[]>((resolve, reject) => {
        const transaction = db.transaction('records'), store = transaction.objectStore('records'), request = store.openKeyCursor();
        const found = new Set<string>(), unreadable = new Set<string>(); let scanned = 0, failure: unknown;
        if (preferredViewId) {
          const draft = store.getKey(['draft', preferredViewId, scope.hostId, scope.conversationId]);
          const imagePrefix = ['draft-image', preferredViewId, scope.hostId, scope.conversationId];
          const image = store.getKey(IDBKeyRange.bound(imagePrefix, [...imagePrefix, []], false, true));
          const view = store.get(['view', preferredViewId, scope.hostId]);
          draft.onsuccess = () => { if (draft.result !== undefined) found.add(preferredViewId); };
          image.onsuccess = () => { if (image.result !== undefined) found.add(preferredViewId); };
          view.onsuccess = () => {
            try { const saved = decodeView(view.result, scope.hostId); if (saved.route && sameScope(saved.route, scope) || saved.pendingCreation && sameScope(saved.pendingCreation.scope, scope)) found.add(preferredViewId); }
            catch (error) { failure = error; transaction.abort(); }
          };
        }
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          try {
            if (++scanned > 100_000) throw new Error('Saved work needs a paged recovery scan before this conversation can move.');
            const key = cursor.key;
            if (Array.isArray(key) && typeof key[1] === 'string' && key[2] === scope.hostId) {
              if ((key[0] === 'draft' || key[0] === 'draft-image') && key[3] === scope.conversationId) found.add(key[1]);
              if (key[0] === 'view') {
                const viewId = key[1], view = store.get(key);
                view.onsuccess = () => {
                  try {
                    let saved;
                    try { saved = decodeView(view.result, scope.hostId); }
                    catch {
                      unreadable.add(viewId);
                      const raw: unknown = view.result;
                      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                        const value = record(raw), pending = value.pendingCreation && typeof value.pendingCreation === 'object' && !Array.isArray(value.pendingCreation) ? record(value.pendingCreation) : null;
                        for (const candidate of [value.route, pending?.scope, value.pendingCreation]) {
                          let matches = false; try { matches = sameScope(parseScope(candidate), scope); } catch {}
                          if (matches) throw new Error('The saved editor for this conversation is unreadable. Its original records are preserved.');
                        }
                      }
                      cursor.continue(); return;
                    }
                    if (saved.route && sameScope(saved.route, scope) || saved.pendingCreation && sameScope(saved.pendingCreation.scope, scope)) found.add(viewId);
                    cursor.continue();
                  } catch (error) { failure = error; transaction.abort(); }
                };
                return;
              }
            }
            cursor.continue();
          } catch (error) { failure = error; transaction.abort(); }
        };
        transaction.oncomplete = () => { if ([...found].some(viewId => unreadable.has(viewId))) reject(new Error('The saved editor for this conversation is unreadable. Its original records are preserved.')); else resolve([...found]); };
        transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Saved editor scan interrupted.'));
      });
      return { binding: null, legacyViewIds };
    } finally { db.close(); }
  }

  editorBinding(): EditorBinding | null { return this.editor; }

  static async prepareCreationDraft(target: { readonly scope: ConversationScope; readonly viewId: string; readonly label: string; readonly transitionId: string; readonly agentId: string }, text: string, assertCurrent?: () => void): Promise<void> {
    const releaseConversation = await conversationLock(target.scope);
    if (!releaseConversation) throw new Error('The new conversation already has an editor');
    let release: (() => void) | null = null, db: IDBDatabase | undefined;
    try {
      release = await claim(target.viewId); if (!release) throw new Error('The destination saved view is already open');
      db = await openViewDatabase();
      await new Promise<void>((resolve, reject) => {
        if (!db) { reject(new Error('Initial draft storage unavailable')); return; }
        const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records');
        const binding = store.get(editorBindingKey(target.scope)), owner = store.get(editorViewKey(target.viewId)); let remaining = 2, failure: unknown;
        const fail = (error: unknown) => { failure = error; tx.abort(); };
        const commit = () => {
          try {
            const previous = binding.result === undefined ? null : parseEditorBinding(binding.result);
            if (owner.result !== undefined && !sameScope(parseScope(owner.result), target.scope)) throw new Error('The destination belongs to another conversation');
            if (previous && (previous.kind !== 'handoff-reserved' || previous.viewId !== target.viewId || previous.transitionId !== target.transitionId || previous.targetLabel !== target.label)) throw new Error('The destination editor already changed');
            assertCurrent?.();
            const reserved: EditorBinding = previous ?? { schemaVersion: 1, kind: 'handoff-reserved', scope: target.scope, viewId: target.viewId, transitionId: target.transitionId, targetLabel: target.label, revision: 1, writerGeneration: 1 };
            store.put(reserved, editorBindingKey(target.scope)); store.put(target.scope, editorViewKey(target.viewId));
            initializeDraft(store, target.viewId, target.scope, target.agentId, text, () => {}, fail);
          } catch (error) { fail(error); }
        };
        for (const request of [binding, owner]) request.onsuccess = () => { if (--remaining === 0) commit(); };
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure ?? tx.error ?? new Error('Initial draft preparation interrupted'));
      });
    } finally { db?.close(); release?.(); releaseConversation(); }
  }

  static async claimEditor(claimed: EditorClaim, onFailure: (error: unknown) => void): Promise<BrowserViewStorage> {
    const releaseConversation = await conversationLock(claimed.scope);
    if (!releaseConversation) throw new Error('This conversation already has an editor in this browser profile.');
    let releaseView: (() => void) | null = null, db: IDBDatabase | undefined;
    try {
      releaseView = await claim(claimed.viewId);
      if (!releaseView) throw new Error('The assigned saved view is already open.');
      db = await openViewDatabase();
      const binding = await activateEditor(db, claimed);
      const release = releaseView;
      const owner = new BrowserViewStorage(claimed.viewId, db, () => { release(); releaseConversation(); }, onFailure);
      owner.editor = binding;
      return owner;
    } catch (error) { db?.close(); releaseView?.(); releaseConversation(); throw error; }
  }

  static async transferClosed(plan: HandoffPlan): Promise<EditorBinding> {
    const releaseConversation = await conversationLock(plan.scope);
    if (!releaseConversation) throw new Error('This conversation is already owned; transfer must be requested through its editor.');
    const releases: (() => void)[] = [];
    let db: IDBDatabase | undefined;
    try {
      for (const viewId of [...new Set([plan.sourceViewId, plan.targetViewId])].sort()) {
        const release = await claim(viewId);
        if (!release) throw new Error(`Saved view ${viewId} is already open; no records were moved.`);
        releases.push(release);
      }
      db = await openViewDatabase();
      return await transferEditor(db, plan);
    } finally { db?.close(); for (const release of releases.reverse()) release(); releaseConversation(); }
  }

  static async recoverBrowserHandoff(binding: Extract<EditorBinding, { readonly kind: 'handoff-reserved' }>, label: string): Promise<EditorBinding> {
    if (!binding.targetLabel.startsWith('browser:') || !label.startsWith('browser:')) throw new Error('Only a closed browser handoff can be recovered here.');
    const releaseCatalog = await claim(binding.targetLabel.slice('browser:'.length));
    if (!releaseCatalog) throw new Error('The original browser tab still owns this handoff.');
    let releaseConversation: (() => void) | null = null, releaseView: (() => void) | null = null, db: IDBDatabase | undefined;
    try {
      releaseConversation = await conversationLock(binding.scope);
      if (!releaseConversation) throw new Error('The original conversation editor is still open.');
      releaseView = await claim(binding.viewId);
      if (!releaseView) throw new Error('The saved handoff view is still open.');
      db = await openViewDatabase();
      const current = await readEditorBinding(db, binding.scope);
      if (!current || current.kind !== 'handoff-reserved' || current.transitionId !== binding.transitionId || current.targetLabel !== binding.targetLabel) throw new Error('The browser handoff changed. Retry opening the chat.');
      return await recoverEditor(db, { scope: binding.scope, viewId: binding.viewId, nativeLabel: binding.targetLabel,
        fromTransitionId: binding.transitionId, transitionId: crypto.randomUUID(), targetLabel: label, creationAgentId: null });
    } finally { db?.close(); releaseView?.(); releaseConversation?.(); releaseCatalog(); }
  }

  static async reopenForRecovery(viewId: string, onFailure: (error: unknown) => void): Promise<BrowserViewStorage | null> {
    const binding = await this.bindingForView(viewId);
    if (!binding) {
      const release = await claim(viewId);
      if (!release) return null;
      let db: IDBDatabase | undefined;
      try {
        const database = await openViewDatabase(); db = database;
        const bound = await new Promise<boolean>((resolve, reject) => {
          const transaction = database.transaction('records'), request = transaction.objectStore('records').get(editorViewKey(viewId));
          transaction.oncomplete = () => resolve(request.result !== undefined);
          transaction.onabort = () => reject(transaction.error ?? new Error('Saved editor lookup interrupted.'));
        });
        if (bound) { db.close(); release(); return null; }
        return new BrowserViewStorage(viewId, db, release, onFailure);
      } catch (error) { db?.close(); release(); throw error; }
    }
    if (binding.kind !== 'editing') return null;
    const releaseConversation = await conversationLock(binding.scope);
    if (!releaseConversation) return null;
    let releaseView: (() => void) | null = null, db: IDBDatabase | undefined;
    try {
      releaseView = await claim(viewId);
      if (!releaseView) { releaseConversation(); return null; }
      db = await openViewDatabase();
      const current = await readEditorBinding(db, binding.scope);
      if (!current || current.kind !== 'editing' || current.viewId !== viewId) { db.close(); releaseView(); releaseConversation(); return null; }
      const release = releaseView, owner = new BrowserViewStorage(viewId, db, () => { release(); releaseConversation(); }, onFailure);
      owner.editor = current;
      return owner;
    } catch (error) { db?.close(); releaseView?.(); releaseConversation(); throw error; }
  }

  static async recoverClosed(grant: EditorRecoveryGrant): Promise<EditorBinding> {
    const located = await this.locateEditor(grant.scope);
    if (located.binding && located.binding.viewId !== grant.viewId) throw new Error('Native recovery disagrees with the authoritative editor binding.');
    if (!located.binding && located.legacyViewIds.length > 1) throw new Error(`Choose one independent saved view before recovery: ${located.legacyViewIds.join(', ')}`);
    const legacy = located.legacyViewIds[0];
    if (!located.binding && legacy) return this.transferClosed({ scope: grant.scope, sourceViewId: legacy, targetViewId: grant.viewId,
      expectedBinding: null, transitionId: grant.transitionId, targetLabel: grant.targetLabel });
    const releaseConversation = await conversationLock(grant.scope);
    if (!releaseConversation) throw new Error('This conversation still has an editor in this browser profile.');
    let releaseView: (() => void) | null = null, db: IDBDatabase | undefined;
    try {
      releaseView = await claim(grant.viewId); if (!releaseView) throw new Error('The saved view is still open.');
      db = await openViewDatabase(); return await recoverEditor(db, grant);
    } finally { db?.close(); releaseView?.(); releaseConversation(); }
  }

  async reserveHandoff(plan: HandoffPlan): Promise<EditorBinding> {
    if (!this.editor || !sameScope(this.editor.scope, plan.scope) || plan.sourceViewId !== this.viewId) {
      throw new Error('Only the current conversation editor may transfer its live saved view.');
    }
    const scopeKey = JSON.stringify(plan.scope);
    this.frozen.add(scopeKey);
    await Promise.all(this.transactions);
    let releaseTarget: (() => void) | null = null;
    try {
      if (plan.targetViewId !== this.viewId) {
        releaseTarget = await claim(plan.targetViewId);
        if (!releaseTarget) throw new Error('The destination saved view is already open.');
      }
      return await transferEditor(this.db, plan, this.begin('readwrite'));
    } catch (error) { this.frozen.delete(scopeKey); throw error; }
    finally { releaseTarget?.(); }
  }

  select(): void {
    if (this.closing) throw new Error('This view no longer owns local storage.');
    sessionStorage.setItem('openpane.viewId', this.viewId);
  }

  async savedViews(hostId: string, after: string | null = null): ReturnType<OwnedViewStorage['savedViews']> {
    return new Promise((resolve, reject) => {
      const range = viewKeyRange(after);
      const transaction = this.begin('readonly');
      const request = transaction.objectStore('records').openCursor(range);
      const ids: string[] = [];
      let unreadable = 0;
      let scanned = 0;
      let next: string | null = null;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const key = cursor.key;
        if (!Array.isArray(key) || key.length !== 3 || typeof key[1] !== 'string' || typeof key[2] !== 'string') {
          transaction.abort(); reject(new Error('Unsupported saved view key. Local records were preserved.')); return;
        }
        if (key[2] === hostId && key[1] !== this.viewId) {
          try { decodeView(cursor.value, hostId); ids.push(key[1]); } catch { unreadable++; }
        }
        scanned++;
        if (scanned === 100) { next = JSON.stringify([key[1], key[2]]); return; }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve({ ids, unreadable, after: next });
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not list saved views.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Saved view listing was interrupted.'));
    });
  }

  async draftScopes(hostId: string, after: string | null): ReturnType<OwnedViewStorage['draftScopes']> {
    identifier(hostId);
    if (after !== null) identifier(after);
    return new Promise((resolve, reject) => {
      const prefix = ['draft', this.viewId, hostId];
      const range = IDBKeyRange.bound(after === null ? prefix : [...prefix, after], [...prefix, AFTER_ALL_STRINGS], after !== null, true);
      const transaction = this.begin('readonly');
      const request = transaction.objectStore('records').openKeyCursor(range);
      const scopes: ConversationScope[] = [];
      let next: string | null = null;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        try {
          const key = cursor.key;
          if (!Array.isArray(key) || key.length !== 4 || key[0] !== 'draft' || key[1] !== this.viewId || key[2] !== hostId) throw new Error('Unsupported draft key. Local records were preserved.');
          const scope = parseScope({ hostId, conversationId: key[3] });
          scopes.push(scope);
          if (scopes.length === 100) { next = scope.conversationId; return; }
          cursor.continue();
        } catch (error) { transaction.abort(); reject(error); }
      };
      transaction.oncomplete = () => resolve({ scopes, after: next });
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not list draft scopes.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Draft scope listing was interrupted.'));
    });
  }

  private begin(mode: IDBTransactionMode): IDBTransaction {
    if (this.closing) throw new Error('This view no longer owns local storage. Reload the app.');
    const transaction = this.db.transaction('records', mode);
    const settled = new Promise<void>(resolve => {
      transaction.addEventListener('complete', () => resolve(), { once: true });
      transaction.addEventListener('abort', () => resolve(), { once: true });
    });
    this.transactions.add(settled);
    void settled.then(() => this.transactions.delete(settled));
    return transaction;
  }

  private transaction(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const transaction = this.begin(mode);
      let request: IDBRequest;
      // Requests issued before a synchronous throw would otherwise still commit.
      try { request = operation(transaction.objectStore('records')); } catch (error) { transaction.abort(); throw error; }
      transaction.oncomplete = () => { const value: unknown = request.result; resolve(value); };
      transaction.onerror = () => reject(transaction.error ?? new Error('Local storage transaction failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Local storage transaction was interrupted.'));
    });
  }

  async readView(hostId: string): Promise<SavedView> {
    if (this.catalog) {
      const value = await this.transaction('readonly', store => store.get(['catalog-route', this.viewId, hostId]));
      const route = value === undefined ? null : parseScope(value);
      if (route && route.hostId !== hostId) throw new Error('Catalog navigation belongs to another host.');
      return { version: 2, route, pendingCreation: null };
    }
    return decodeView(await this.transaction('readonly', store => store.get(['view', this.viewId, hostId])), hostId);
  }

  saveInitialDraft(scope: ConversationScope, agentId: string, text: string): Promise<void> {
    if (this.catalog) return Promise.reject(new Error('A catalog cannot own an initial draft'));
    return this.fenced<void>(scope, 'readwrite', this.editor?.writerGeneration ?? null, (store, result, fail) => {
      initializeDraft(store, this.viewId, scope, agentId, text, () => result(undefined), fail);
    });
  }

  async saveNavigation(hostId: string, scope: ConversationScope): Promise<void> {
    if (!this.catalog || scope.hostId !== hostId) throw new Error('This view does not own catalog navigation.');
    await this.transaction('readwrite', store => store.put(scope, ['catalog-route', this.viewId, hostId]));
  }

  async saveView(hostId: string, state: SavedView): Promise<void> {
    const checked = decodeView(state, hostId);
    if (this.catalog) {
      if (checked.pendingCreation) throw new Error('A catalog cannot own conversation creation.');
      if (checked.route) await this.saveNavigation(hostId, checked.route);
      return;
    }
    if ([checked.route, checked.pendingCreation?.scope, this.editor?.scope].some(scope => scope && this.frozen.has(JSON.stringify(scope)))) throw new SupersededDraftsError();
    await new Promise<void>((resolve, reject) => {
      const transaction = this.begin('readwrite'), store = transaction.objectStore('records');
      const owner = store.get(editorViewKey(this.viewId));
      let failure: unknown;
      owner.onsuccess = () => {
        try {
          const scopes = [checked.route, checked.pendingCreation?.scope, owner.result === undefined ? null : parseScope(owner.result)]
            .filter((scope): scope is ConversationScope => scope !== null && scope !== undefined);
          let remaining = scopes.length;
          const put = () => store.put(checked, ['view', this.viewId, hostId]);
          if (remaining === 0) { put(); return; }
          for (const scope of scopes) {
            const request = store.get(editorBindingKey(scope));
            request.onsuccess = () => {
              try {
                this.checkWriter(scope, request.result, this.editor?.writerGeneration ?? null);
                if (--remaining === 0) put();
              } catch (error) { failure = error; transaction.abort(); }
            };
          }
        } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Saved view write interrupted.'));
    });
  }

  private checkWriter(scope: ConversationScope, value: unknown, generation: number | null): void {
    if (this.editor && !sameScope(this.editor.scope, scope)) throw new SupersededDraftsError();
    if (value === undefined) { if (generation !== null) throw new SupersededDraftsError(); return; }
    const binding = parseEditorBinding(value);
    if (!sameScope(binding.scope, scope) || binding.kind !== 'editing' || binding.viewId !== this.viewId || binding.writerGeneration !== generation) {
      throw new SupersededDraftsError();
    }
  }

  private fenced<T>(scope: ConversationScope, mode: IDBTransactionMode, generation: number | null,
    operation: (store: IDBObjectStore, result: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    if (this.frozen.has(JSON.stringify(scope))) return Promise.reject(new SupersededDraftsError());
    return new Promise((resolve, reject) => {
      const transaction = this.begin(mode), store = transaction.objectStore('records'), binding = store.get(editorBindingKey(scope));
      let result: T, failure: unknown;
      binding.onsuccess = () => {
        try {
          this.checkWriter(scope, binding.result, generation);
          operation(store, value => { result = value; }, error => { failure = error; transaction.abort(); });
        } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Local storage transaction was interrupted.'));
    });
  }

  drafts(onFailure: (error: unknown) => void): DraftStoragePort {
    const protect = async <T>(operation: () => Promise<T>): Promise<T> => {
      try { return await operation(); } catch (error) { if (!(error instanceof SupersededDraftsError)) onFailure(error); throw error; }
    };
    const port = {}, conversation = (scope: ConversationScope) => JSON.stringify([scope.hostId, scope.conversationId]);
    const generations = new Map<string, number | null>();
    const generation = (scope: ConversationScope) => generations.get(conversation(scope)) ?? null;
    const current = (scope: ConversationScope) => {
      if ((this.draftOwners.get(conversation(scope)) ?? port) !== port) throw new SupersededDraftsError();
    };
    return {
      load: async scope => {
        this.draftOwners.set(conversation(scope), port);
        const captured = this.editor && sameScope(this.editor.scope, scope) ? this.editor.writerGeneration : null;
        generations.set(conversation(scope), captured);
        return this.fenced(scope, 'readonly', captured, (store, result) => {
          const request = store.get(['draft', this.viewId, scope.hostId, scope.conversationId]);
          request.onsuccess = () => result(request.result ?? null);
        });
      },
      save: async (records, image) => {
        current(records.scope);
        await protect(() => this.fenced<void>(records.scope, 'readwrite', generation(records.scope), (store, result) => {
          const key = (selectionId: string) => ['draft-image', this.viewId, records.scope.hostId, records.scope.conversationId, selectionId];
          for (const selectionId of image?.remove ?? []) store.delete(key(selectionId));
          if (image?.put) store.put(image.put.bytes, key(image.put.selectionId));
          store.put(records, ['draft', this.viewId, records.scope.hostId, records.scope.conversationId]);
          result(undefined);
        }));
      },
      commitTransfer: async (records, transfer) => {
        current(records.scope);
        return protect(() => this.fenced<boolean>(records.scope, 'readwrite', generation(records.scope), (store, result, fail) => {
          if (transfer.outcome === 'copy-cleared') commitCopiedDraft(store, this.viewId, records, transfer, result, fail);
          else if (transfer.outcome === 'copy-received') commitIncomingCopiedDraft(store, this.viewId, records, transfer, result, fail);
          else commitCarriedDraft(store, this.viewId, records, transfer, result, fail);
        }));
      },
      loadImage: async (scope, selectionId) => {
        current(scope);
        return this.fenced(scope, 'readonly', generation(scope), (store, result) => {
          const request = store.get(['draft-image', this.viewId, scope.hostId, scope.conversationId, selectionId]);
          request.onsuccess = () => result(request.result instanceof Uint8Array ? request.result : null);
        });
      },
    };
  }

  close(): Promise<void> {
    return this.closing ??= Promise.all(this.transactions).then(() => {
      this.db.close();
      this.unlock();
    });
  }
}

BrowserViewStorage satisfies ViewStorageFactory;
