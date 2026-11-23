import type { ConversationScope, EditorBinding } from '@openpane/contracts';
import { parseEditorBinding, parseScope, sameScope } from '@openpane/contracts';
import { identifier } from '@openpane/contracts/decode';
import type { DraftStoragePort } from '@openpane/client';

import { activateEditor, conversationLock, editorBindingKey, editorViewKey, readEditorBinding, recoverEditor, transferEditor } from './editor-bindings.js';
import type { EditorClaim, EditorRecoveryGrant, HandoffPlan } from './editor-bindings.js';
import { decodeView } from './view-state.js';
import type { OwnedViewStorage, SavedView, ViewStorageFactory } from './view-state.js';

export class SupersededDraftsError extends Error {
  constructor() { super('This conversation was reopened in a newer view.'); this.name = 'SupersededDrafts'; }
}

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

  static async reopen(viewId: string, onFailure: (error: unknown) => void, waitForPreviousDocument = false, catalog = false): Promise<BrowserViewStorage> {
    if (!globalThis.indexedDB || !navigator.locks) throw new Error('This browser cannot safely save an exclusive view. IndexedDB and Web Locks are required.');
    const release = await claim(viewId, waitForPreviousDocument);
    if (!release) throw new Error('This saved view is already open in another tab.');
    let db: IDBDatabase | undefined;
    try {
      db = await openViewDatabase();
      return new BrowserViewStorage(viewId, db, release, onFailure, catalog);
    } catch (error) { db?.close(); release(); throw error; }
  }

  static async bindingForView(viewId: string): Promise<EditorBinding | null> {
    const db = await openViewDatabase();
    try {
      const scope = await new Promise<ConversationScope | null>((resolve, reject) => {
        const transaction = db.transaction('records'), request = transaction.objectStore('records').get(editorViewKey(viewId));
        transaction.oncomplete = () => { try { resolve(request.result === undefined ? null : parseScope(request.result)); } catch (error) { reject(error); } };
        transaction.onabort = () => reject(transaction.error ?? new Error('Saved editor lookup interrupted.'));
      });
      if (!scope) return null;
      const binding = await readEditorBinding(db, scope);
      if (!binding || binding.viewId !== viewId || !sameScope(binding.scope, scope)) throw new Error('Saved view and editor binding disagree. Original records are preserved.');
      return binding;
    } finally { db.close(); }
  }

  static async locateEditor(scope: ConversationScope): Promise<{ readonly binding: EditorBinding | null; readonly legacyViewIds: readonly string[] }> {
    const db = await openViewDatabase();
    try {
      const binding = await readEditorBinding(db, scope);
      if (binding) {
        if (!sameScope(binding.scope, scope)) throw new Error('Editor binding scope mismatch; local records were preserved.');
        return { binding, legacyViewIds: [] };
      }
      const legacyViewIds = await new Promise<readonly string[]>((resolve, reject) => {
        const transaction = db.transaction('records'), request = transaction.objectStore('records').openCursor();
        const found = new Set<string>(); let scanned = 0, failure: unknown;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          try {
            if (++scanned > 100_000) throw new Error('Saved work needs a paged recovery scan before this conversation can move.');
            const key = cursor.key;
            if (Array.isArray(key) && typeof key[1] === 'string' && key[2] === scope.hostId) {
              if ((key[0] === 'draft' || key[0] === 'draft-image') && key[3] === scope.conversationId) found.add(key[1]);
              if (key[0] === 'view') {
                const saved = decodeView(cursor.value, scope.hostId);
                if (saved.route && sameScope(saved.route, scope) || saved.pendingCreation && sameScope(saved.pendingCreation.scope, scope)) found.add(key[1]);
              }
            }
            if (found.size > 1) return;
            cursor.continue();
          } catch (error) { failure = error; transaction.abort(); }
        };
        transaction.oncomplete = () => resolve([...found]);
        transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Saved editor scan interrupted.'));
      });
      return { binding: null, legacyViewIds };
    } finally { db.close(); }
  }

  editorBinding(): EditorBinding | null { return this.editor; }

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
      return await transferEditor(this.db, plan);
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
    operation: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
    if (this.frozen.has(JSON.stringify(scope))) return Promise.reject(new SupersededDraftsError());
    return new Promise((resolve, reject) => {
      const transaction = this.begin(mode), store = transaction.objectStore('records'), binding = store.get(editorBindingKey(scope));
      let result: T, failure: unknown;
      binding.onsuccess = () => {
        try {
          this.checkWriter(scope, binding.result, generation);
          operation(store, value => { result = value; });
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
