import { canonicalJson, parseEditorBinding, parseScope, sameScope } from '@openpane/contracts';
import type { ConversationScope, EditorBinding } from '@openpane/contracts';
import type { SavedView } from './view-state.js';
import { decodeView } from './view-state.js';

export const editorBindingKey = (scope: ConversationScope): IDBValidKey => ['editor-binding', scope.hostId, scope.conversationId];
export const editorViewKey = (viewId: string): IDBValidKey => ['editor-view-binding', viewId];
export function scopeImageRange(viewId: string, scope: ConversationScope): IDBKeyRange {
  const prefix: IDBValidKey[] = ['draft-image', viewId, scope.hostId, scope.conversationId];
  return IDBKeyRange.bound(prefix, [...prefix, []], false, true);
}
export async function conversationLock(scope: ConversationScope): Promise<(() => void) | null> {
  return new Promise((resolve, reject) => {
    void navigator.locks.request(`openpane-conversation:${canonicalJson(scope)}`, { ifAvailable: true }, lock => {
      if (!lock) { resolve(null); return; }
      return new Promise<void>(release => resolve(release));
    }).catch(reject);
  });
}
export function readEditorBinding(db: IDBDatabase, scope: ConversationScope): Promise<EditorBinding | null> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('records'), request = transaction.objectStore('records').get(editorBindingKey(scope));
    transaction.oncomplete = () => {
      try { resolve(request.result === undefined ? null : parseEditorBinding(request.result)); } catch (error) { reject(error); }
    };
    transaction.onabort = () => reject(transaction.error ?? new Error('Editor binding read interrupted'));
  });
}
function next(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) throw new Error('Editor generation exhausted');
  return value + 1;
}
export interface HandoffPlan {
  readonly scope: ConversationScope;
  readonly sourceViewId: string;
  readonly targetViewId: string;
  readonly transitionId: string;
  readonly targetLabel: string;
  readonly expectedBinding: EditorBinding | null;
}
/** The caller owns the conversation lock and both distinct view locks, or reuses its already held source locks. */
export function transferEditor(db: IDBDatabase, plan: HandoffPlan): Promise<EditorBinding> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('records', 'readwrite'), store = transaction.objectStore('records');
    const { scope, sourceViewId, targetViewId } = plan;
    const sourceDraftKey = ['draft', sourceViewId, scope.hostId, scope.conversationId];
    const targetDraftKey = ['draft', targetViewId, scope.hostId, scope.conversationId];
    const sourceViewKey = ['view', sourceViewId, scope.hostId], targetViewKey = ['view', targetViewId, scope.hostId];
    const requests = {
      binding: store.get(editorBindingKey(scope)), sourceView: store.get(sourceViewKey), targetView: store.get(targetViewKey),
      sourceDraft: store.get(sourceDraftKey), targetDraft: store.get(targetDraftKey),
      imageKeys: store.getAllKeys(scopeImageRange(sourceViewId, scope)), images: store.getAll(scopeImageRange(sourceViewId, scope)),
      targetDrafts: store.count(IDBKeyRange.bound(['draft', targetViewId], ['draft', targetViewId, []], false, true)),
      targetImages: store.count(IDBKeyRange.bound(['draft-image', targetViewId], ['draft-image', targetViewId, []], false, true)),
      targetOwner: store.get(editorViewKey(targetViewId)),
    };
    let remaining = Object.keys(requests).length, result: EditorBinding | undefined, failure: unknown;
    const commit = () => {
      try {
        const current = requests.binding.result === undefined ? null : parseEditorBinding(requests.binding.result);
        if (current?.kind === 'handoff-reserved' && current.transitionId === plan.transitionId) {
          if (current.viewId !== targetViewId || current.targetLabel !== plan.targetLabel || !sameScope(current.scope, scope)) throw new Error('Conflicting editor handoff replay');
          result = current; return;
        }
        if (requests.targetOwner.result !== undefined && !sameScope(parseScope(requests.targetOwner.result), scope)) throw new Error('The destination is dedicated to another conversation');
        if (current?.kind === 'handoff-reserved') throw new Error('This editor is already reserved for another handoff');
        if (current && !sameScope(current.scope, scope)) throw new Error('Editor binding scope mismatch');
        if (canonicalJson(current) !== canonicalJson(plan.expectedBinding) || current && current.viewId !== sourceViewId) throw new Error('Editor binding changed before handoff');
        const source = decodeView(requests.sourceView.result, scope.hostId);
        if (sourceViewId === targetViewId && (requests.targetDrafts.result > (requests.sourceDraft.result === undefined ? 0 : 1) || requests.targetImages.result !== requests.imageKeys.result.length || source.route && !sameScope(source.route, scope) || source.pendingCreation && !sameScope(source.pendingCreation.scope, scope))) throw new Error('This legacy view contains other conversations; use a distinct dedicated destination.');
        if (sourceViewId !== targetViewId) {
          const target = decodeView(requests.targetView.result, scope.hostId);
          if (target.route !== null || target.pendingCreation !== null || requests.targetDrafts.result !== 0 || requests.targetImages.result !== 0 || requests.targetOwner.result !== undefined) throw new Error('Target saved view already contains work; no records were moved');
          if (requests.sourceDraft.result !== undefined) store.put(requests.sourceDraft.result, targetDraftKey);
          store.delete(sourceDraftKey);
          const keys = requests.imageKeys.result, images = requests.images.result;
          if (keys.length !== images.length) throw new Error('Draft image inventory changed');
          for (let index = 0; index < keys.length; index++) {
            const key = keys[index];
            if (!Array.isArray(key) || key.length !== 5 || typeof key[4] !== 'string') throw new Error('Invalid draft image key; original records retained');
            store.put(images[index], ['draft-image', targetViewId, scope.hostId, scope.conversationId, key[4]]);
            store.delete(key);
          }
          const pending = source.pendingCreation && sameScope(source.pendingCreation.scope, scope) ? source.pendingCreation : null;
          const destination: SavedView = { version: 2, route: pending ? null : scope, pendingCreation: pending };
          store.put(destination, targetViewKey);
          store.put({ ...source, route: source.route && sameScope(source.route, scope) ? null : source.route,
            pendingCreation: pending ? null : source.pendingCreation }, sourceViewKey);
        }
        result = { schemaVersion: 1, kind: 'handoff-reserved', scope, viewId: targetViewId,
          revision: next(current?.revision ?? 0), writerGeneration: next(current?.writerGeneration ?? 0), transitionId: plan.transitionId, targetLabel: plan.targetLabel };
        store.put(result, editorBindingKey(scope)); store.put(scope, editorViewKey(targetViewId));
      } catch (error) { failure = error; transaction.abort(); }
    };
    for (const request of Object.values(requests)) request.onsuccess = () => { if (--remaining === 0) commit(); };
    transaction.oncomplete = () => result ? resolve(result) : reject(new Error('Editor handoff did not commit'));
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Editor handoff interrupted; records retained'));
  });
}
export interface EditorClaim {
  readonly scope: ConversationScope;
  readonly viewId: string;
  readonly label: string;
  readonly creation: { readonly agentId: string } | null;
  readonly transitionId: string | null;
}
/** The caller holds the conversation lock, then the assigned view lock. */
export function activateEditor(db: IDBDatabase, claim: EditorClaim): Promise<EditorBinding> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('records', 'readwrite'), store = transaction.objectStore('records');
    const binding = store.get(editorBindingKey(claim.scope)), view = store.get(['view', claim.viewId, claim.scope.hostId]), owner = store.get(editorViewKey(claim.viewId));
    let remaining = 3, result: EditorBinding | undefined, failure: unknown;
    const commit = () => {
      try {
        const previous = binding.result === undefined ? null : parseEditorBinding(binding.result);
        if (owner.result !== undefined && !sameScope(parseScope(owner.result), claim.scope)) throw new Error('Assigned view belongs to another conversation');
        if (previous && (!sameScope(previous.scope, claim.scope) || previous.viewId !== claim.viewId || previous.kind === 'handoff-reserved' && (previous.targetLabel !== claim.label || previous.transitionId !== claim.transitionId))) throw new Error('The editor is reserved for another window');
        if (!previous && !claim.creation) throw new Error('This conversation has no committed editor binding');
        const saved = decodeView(view.result, claim.scope.hostId);
        if (saved.route && !sameScope(saved.route, claim.scope) || saved.pendingCreation && !sameScope(saved.pendingCreation.scope, claim.scope)) throw new Error('Assigned view contains another conversation');
        if (claim.creation && saved.pendingCreation && saved.pendingCreation.agentId !== claim.creation.agentId) throw new Error('Saved creation belongs to a different agent');
        result = { schemaVersion: 1, kind: 'editing', scope: claim.scope, viewId: claim.viewId,
          revision: previous?.revision ?? 1, writerGeneration: next(previous?.writerGeneration ?? 0) };
        const pending = saved.pendingCreation ?? (claim.creation && saved.route === null ? { scope: claim.scope, agentId: claim.creation.agentId } : null);
        const nextSaved: SavedView = { version: 2, route: saved.route ?? (pending ? null : claim.scope), pendingCreation: pending };
        store.put(result, editorBindingKey(claim.scope)); store.put(claim.scope, editorViewKey(claim.viewId));
        store.put(nextSaved, ['view', claim.viewId, claim.scope.hostId]);
      } catch (error) { failure = error; transaction.abort(); }
    };
    binding.onsuccess = view.onsuccess = owner.onsuccess = () => { if (--remaining === 0) commit(); };
    transaction.oncomplete = () => result ? resolve(result) : reject(new Error('Editor claim did not commit'));
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Editor claim interrupted'));
  });
}

export interface EditorRecoveryGrant {
  readonly scope: ConversationScope;
  readonly viewId: string;
  readonly nativeLabel: string;
  readonly fromTransitionId: string;
  readonly transitionId: string;
  readonly targetLabel: 'main';
  readonly creationAgentId: string | null;
}
/** Only main receives this grant from the broker after the native target is closed. */
export function recoverEditor(db: IDBDatabase, grant: EditorRecoveryGrant): Promise<EditorBinding> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records');
    const binding = store.get(editorBindingKey(grant.scope)), view = store.get(['view', grant.viewId, grant.scope.hostId]), marker = store.get(editorViewKey(grant.viewId));
    const drafts = store.count(IDBKeyRange.bound(['draft', grant.viewId], ['draft', grant.viewId, []], false, true)), images = store.count(IDBKeyRange.bound(['draft-image', grant.viewId], ['draft-image', grant.viewId, []], false, true));
    let remaining = 5, result: EditorBinding | undefined, failure: unknown;
    const commit = () => {
      try {
        const current = binding.result === undefined ? null : parseEditorBinding(binding.result);
        if (current && (!sameScope(current.scope, grant.scope) || current.viewId !== grant.viewId)) throw new Error('Native recovery disagrees with the authoritative draft location');
        if (!current && (drafts.result !== 0 || images.result !== 0)) throw new Error('The recovery view contains unclaimed work; no records were changed');
        if (marker.result !== undefined && !sameScope(parseScope(marker.result), grant.scope)) throw new Error('Recovery view belongs to another conversation');
        if (current?.kind === 'handoff-reserved') {
          if (current.targetLabel === grant.targetLabel && current.transitionId === grant.transitionId) { result = current; return; }
          if (current.targetLabel !== grant.nativeLabel || current.transitionId !== grant.fromTransitionId) throw new Error('A different handoff owns this conversation');
        }
        const saved = decodeView(view.result, grant.scope.hostId);
        if (saved.route && !sameScope(saved.route, grant.scope) || saved.pendingCreation && !sameScope(saved.pendingCreation.scope, grant.scope)) throw new Error('Recovery view contains another conversation');
        if (saved.pendingCreation && grant.creationAgentId !== null && saved.pendingCreation.agentId !== grant.creationAgentId) throw new Error('Recovery creation belongs to another agent');
        const pending = saved.pendingCreation ?? (saved.route === null && grant.creationAgentId !== null ? { scope: grant.scope, agentId: grant.creationAgentId } : null);
        store.put({ version: 2, route: saved.route ?? (pending ? null : grant.scope), pendingCreation: pending } satisfies SavedView, ['view', grant.viewId, grant.scope.hostId]);
        result = { schemaVersion: 1, kind: 'handoff-reserved', scope: grant.scope, viewId: grant.viewId,
          revision: next(current?.revision ?? 0), writerGeneration: next(current?.writerGeneration ?? 0), transitionId: grant.transitionId, targetLabel: grant.targetLabel };
        store.put(result, editorBindingKey(grant.scope)); store.put(grant.scope, editorViewKey(grant.viewId));
      } catch (error) { failure = error; tx.abort(); }
    };
    for (const request of [binding, view, marker, drafts, images]) request.onsuccess = () => { if (--remaining === 0) commit(); };
    tx.oncomplete = () => result ? resolve(result) : reject(new Error('Recovery binding did not commit'));
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('Recovery was interrupted; original records were preserved'));
  });
}
