import { count, identifier, record } from '@openpane/contracts/decode';
import { canonicalJson, parseEditorBinding, parseScope, sameScope } from '@openpane/contracts';
import type { ConversationScope } from '@openpane/contracts';
import { openViewDatabase } from './browser-storage.js';
import { editorBindingKey } from './editor-bindings.js';
import { carryKey as key, carryTargetKey as targetKey, carryPrefix as prefix, namedCarry, parseCarry, keyedCarry, readKeptDraft, carryEpochKey, carryRequestEpoch, keptDraftKey, keptDraftCarry } from './draft-carry-records.js';
import type { DraftCarry } from './draft-carry-records.js';
export type { DraftCarry } from './draft-carry-records.js';

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, set: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  const db = await openViewDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('records', mode); let result: T, failure: unknown;
      const fail = (error: unknown) => { failure = error; tx.abort(); };
      try { operation(tx.objectStore('records'), value => { result = value; }, fail); } catch (error) { fail(error); }
      tx.oncomplete = () => resolve(result); tx.onabort = () => reject(failure ?? tx.error ?? new Error('Draft carry transaction interrupted'));
    });
  } finally { db.close(); }
}
export async function pruneDraftCarryHistory(epoch: number, pendingRequestIds: readonly string[] = []): Promise<number> {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Invalid native request epoch');
  return transaction<number>('readwrite', (store, set, fail) => {
    const range = prefix(['draft-carry']), all = store.getAll(range, 1025), keys = store.getAllKeys(range, 1025), floor = store.get(carryEpochKey), floorKey = store.getKey(carryEpochKey); let remaining = 4;
    const commit = () => {
      try {
        if (epoch < count(floorKey.result === undefined ? 0 : floor.result)) throw new Error('Native request epoch advanced. Retry this request.');
        if (all.result.length > 1024 || all.result.length !== keys.result.length) throw new Error('Draft carry history exceeds limits');
        let retained = all.result.length;
        for (let index = 0; index < all.result.length; index++) {
          let carry: DraftCarry;
          try { carry = keyedCarry(all.result[index], keys.result[index]); } catch { continue; }
          if ((carry.kind === 'settled' || carry.kind === 'cancelled') && !carry.retainedText && carryRequestEpoch(carry.requestId) < epoch && !pendingRequestIds.includes(carry.requestId)) {
            if (carry.kind === 'cancelled' && carry.target) store.put(true, keptDraftKey(carry.source, carry.target));
            store.delete(key(carry.source, carry.requestId));
            if (carry.target) store.delete(targetKey(carry.source, carry.requestId, carry.target));
            retained--;
          }
        }
        store.put(epoch, carryEpochKey); set(retained);
      } catch (error) { fail(error); }
    };
    for (const request of [all, keys, floor, floorKey]) request.onsuccess = () => { if (--remaining === 0) commit(); };
  });
}
export async function offerDraftCarry(input: { readonly source: ConversationScope; readonly sourceViewId: string; readonly requestId: string; readonly writerGeneration: number; readonly emptyOnly?: true; readonly expected: { readonly text: string; readonly revision: number } }): Promise<void> {
  const offered = parseCarry({ ...(input.emptyOnly ? { emptyOnly: true } : {}), version: 1, kind: 'offered', source: input.source, sourceViewId: input.sourceViewId, requestId: input.requestId, expected: input.expected, target: null });
  await transaction<void>('readwrite', (store, set, fail) => {
    const binding = store.get(editorBindingKey(input.source)), existing = store.get(key(input.source, input.requestId));
    const prior = store.getAll(prefix(['draft-carry', input.source.hostId, input.source.conversationId]), 1025), total = store.count(prefix(['draft-carry'])), floor = store.get(carryEpochKey), floorKey = store.getKey(carryEpochKey);
    let remaining = 6;
    const commit = () => {
      try {
        const owned = parseEditorBinding(binding.result);
        if (!sameScope(owned.scope, input.source) || owned.kind !== 'editing' || owned.viewId !== input.sourceViewId || owned.writerGeneration !== input.writerGeneration) throw new Error('Only the current editor may offer its draft');
        if (existing.result !== undefined) {
          const current = namedCarry(existing.result, input.source, input.requestId);
          if ((current.kind !== 'offered' && current.kind !== 'applied') || canonicalJson({ ...current, kind: 'offered', target: null }) !== canonicalJson(offered)) throw new Error('Draft carry ID has different input');
          set(undefined); return;
        }
        const epoch = carryRequestEpoch(input.requestId);
        if (!epoch || epoch < count(floorKey.result === undefined ? 0 : floor.result)) throw new Error('Draft carry request epoch expired');
        if (total.result >= 1024) throw new Error('Draft carry history is full. Existing drafts are preserved.');
        if (prior.result.map(parseCarry).some(item => item.kind === 'offered' || item.kind === 'applied')) throw new Error('This draft already has an unresolved carry. Wait for its target before starting another.');
        store.put(offered, key(input.source, input.requestId)); set(undefined);
      } catch (error) { fail(error); }
    };
    for (const request of [binding, existing, prior, total, floor, floorKey]) request.onsuccess = () => { if (--remaining === 0) commit(); };
  });
}
export async function bindDraftCarry(source: ConversationScope, requestId: string, target: ConversationScope): Promise<void> {
  await transaction<void>('readwrite', (store, set, fail) => {
    const savedKey = key(source, requestId), request = store.get(savedKey), found = store.getKey(savedKey); let remaining = 2;
    const bind = () => {
      try {
        if (found.result === undefined) { set(undefined); return; }
        const carry = namedCarry(request.result, source, requestId);
        if (carry.target && !sameScope(carry.target, target)) throw new Error('Draft carry target is already fixed');
        if (carry.kind === 'cancelled') {
          const bound = parseCarry({ ...carry, target });
          if (carry.target === null) store.put(bound, key(source, requestId));
          store.put(true, keptDraftKey(source, target));
        }
        if (carry.kind === 'offered') {
          readKeptDraft(store, source, target, kept => {
            try {
              if (kept) {
                store.put(true, keptDraftKey(source, target));
                store.put({ ...keptDraftCarry(carry), target }, key(source, requestId));
                store.delete(targetKey(source, requestId, target));
              } else if (carry.target === null) {
                const bound = parseCarry({ ...carry, target }); store.put(bound, key(source, requestId));
                store.put({ source, requestId }, targetKey(source, requestId, target));
              }
              set(undefined);
            } catch (error) { fail(error); }
          }, fail);
          return;
        }
        set(undefined);
      } catch (error) { fail(error); }
    };
    for (const item of [request, found]) item.onsuccess = () => { if (--remaining === 0) bind(); };
  });
}
export async function sourceCarries(scope: ConversationScope): Promise<readonly DraftCarry[]> {
  return transaction('readonly', (store, set, fail) => {
    const range = prefix(['draft-carry', scope.hostId, scope.conversationId]), request = store.getAll(range, 1025), keys = store.getAllKeys(range, 1025); let remaining = 2;
    const read = () => {
      try {
        if (request.result.length > 1024 || request.result.length !== keys.result.length) throw new Error('Draft carry history exceeds limits');
        const values = request.result.map((value, index) => keyedCarry(value, keys.result[index]));
        if (values.some(carry => !sameScope(carry.source, scope))) throw new Error('Foreign source in draft carry history');
        set(values);
      } catch (error) { fail(error); }
    };
    for (const item of [request, keys]) item.onsuccess = () => { if (--remaining === 0) read(); };
  });
}
export async function targetCarries(scope: ConversationScope): Promise<readonly DraftCarry[]> {
  return transaction('readonly', (store, set, fail) => {
    const request = store.getAll(prefix(['draft-carry-target', scope.hostId, scope.conversationId]), 1025);
    request.onsuccess = () => {
      try {
        if (request.result.length > 1024) throw new Error('Draft carry history exceeds limits');
        const values: DraftCarry[] = []; let remaining = request.result.length;
        if (!remaining) { set(values); return; }
        for (const value of request.result) {
          const reference = record(value, ['source', 'requestId']), source = parseScope(reference.source), requestId = identifier(reference.requestId, 200);
          const row = store.get(key(source, requestId)); row.onsuccess = () => {
            try { const carry = namedCarry(row.result, source, requestId); if (!carry.target || !sameScope(carry.target, scope)) throw new Error('Draft carry index disagrees with its target'); values.push(carry); if (--remaining === 0) set(values); } catch (error) { fail(error); }
          };
        }
      } catch (error) { fail(error); }
    };
  });
}
export async function cancelDraftCarry(carry: Pick<DraftCarry, 'source' | 'requestId'>): Promise<boolean> {
  return transaction<boolean>('readwrite', (store, set, fail) => {
    const savedKey = key(carry.source, carry.requestId), request = store.get(savedKey), found = store.getKey(savedKey); let remaining = 2;
    const cancel = () => {
      try {
        if (found.result === undefined) { set(false); return; }
        const current = namedCarry(request.result, carry.source, carry.requestId);
        if (current.kind === 'settled') { set(false); return; }
        if (current.kind !== 'cancelled') {
          store.put(keptDraftCarry(current), key(carry.source, carry.requestId));
          if (current.target) store.delete(targetKey(current.source, current.requestId, current.target));
        }
        if (current.target) store.put(true, keptDraftKey(current.source, current.target));
        set(true);
      } catch (error) { fail(error); }
    };
    for (const item of [request, found]) item.onsuccess = () => { if (--remaining === 0) cancel(); };
  });
}

export async function refuseDraftCarry(carry: DraftCarry, { unboundOnly = false }: { readonly unboundOnly?: boolean } = {}): Promise<void> {
  await transaction<void>('readwrite', (store, set, fail) => {
    const request = store.get(key(carry.source, carry.requestId));
    request.onsuccess = () => {
      try {
        const current = namedCarry(request.result, carry.source, carry.requestId);
        if (current.kind === 'offered' && (!unboundOnly || current.target === null)) {
          store.put({ ...current, kind: 'refused' } satisfies DraftCarry, key(current.source, current.requestId));
          if (current.target) store.delete(targetKey(current.source, current.requestId, current.target));
        }
        set(undefined);
      } catch (error) { fail(error); }
    };
  });
}
export async function retryDraftCarry(source: ConversationScope, requestId: string, sourceViewId: string, writerGeneration: number): Promise<void> {
  await transaction<void>('readwrite', (store, set, fail) => {
    const request = store.get(key(source, requestId)), binding = store.get(editorBindingKey(source));
    const prior = store.getAll(prefix(['draft-carry', source.hostId, source.conversationId]), 1025), floor = store.get(carryEpochKey), floorKey = store.getKey(carryEpochKey);
    let remaining = 5;
    const commit = () => {
      try {
        const current = namedCarry(request.result, source, requestId), owned = parseEditorBinding(binding.result);
        if (current.kind === 'cancelled') throw new Error('This draft was explicitly kept at its source. Copy it manually before retrying the chat.');
        if (current.kind !== 'refused') { set(undefined); return; }
        if (!sameScope(owned.scope, source) || owned.kind !== 'editing' || owned.viewId !== sourceViewId || owned.writerGeneration !== writerGeneration) throw new Error('Only the current source editor may retry its draft carry');
        if (carryRequestEpoch(requestId) < count(floorKey.result === undefined ? 0 : floor.result)) throw new Error('Draft carry request epoch expired');
        if (prior.result.length > 1024 || prior.result.map(parseCarry).some(item => item.kind === 'offered' || item.kind === 'applied')) throw new Error('Another draft carry remains unresolved. Finish it before retrying this one.');
        // Main binds the target after native retry admission.
        store.put({ ...current, sourceViewId, kind: 'offered', target: null } satisfies DraftCarry, key(source, requestId));
        if (current.target) store.delete(targetKey(source, requestId, current.target));
        set(undefined);
      } catch (error) { fail(error); }
    };
    for (const item of [request, binding, prior, floor, floorKey]) item.onsuccess = () => { if (--remaining === 0) commit(); };
  });
}

export async function hostCarries(hostId: string, after: IDBValidKey | null = null): Promise<{ readonly carries: readonly DraftCarry[]; readonly after: IDBValidKey | null; readonly unreadable: number }> {
  return transaction('readonly', (store, set) => {
    const range = IDBKeyRange.bound(after ?? ['draft-carry', hostId], ['draft-carry', hostId, []], after !== null, true);
    const request = store.openCursor(range), carries: DraftCarry[] = []; let scanned = 0, unreadable = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { set({ carries, after: null, unreadable }); return; }
      try {
        const carry = keyedCarry(cursor.value, cursor.key);
        if (carry.source.hostId !== hostId) throw new Error('Foreign carry');
        carries.push(carry);
      } catch { unreadable++; }
      if (++scanned === 8) { set({ carries, after: cursor.key, unreadable }); return; }
      cursor.continue();
    };
  });
}
export async function removeRetainedCarry(carry: DraftCarry): Promise<void> {
  await transaction<void>('readwrite', (store, set, fail) => {
    const request = store.get(key(carry.source, carry.requestId));
    request.onsuccess = () => { try {
      if (request.result === undefined) { set(undefined); return; }
      const current = namedCarry(request.result, carry.source, carry.requestId);
      if (current.kind === 'offered' || current.kind === 'applied' || canonicalJson(current) !== canonicalJson(carry)) throw new Error('This draft transfer changed. Refresh its saved recovery before removing it.');
      if (current.kind === 'cancelled' && current.target) { store.put(true, keptDraftKey(current.source, current.target)); store.delete(key(carry.source, carry.requestId)); }
      else if (current.kind === 'cancelled') store.put({ version: 1, kind: 'cancelled', source: current.source, sourceViewId: current.sourceViewId,
        requestId: current.requestId, target: null, outcome: 'kept-at-source', ...(current.emptyOnly ? { emptyOnly: true } : {}) } satisfies DraftCarry, key(carry.source, carry.requestId));
      else store.delete(key(carry.source, carry.requestId));
      if (current.target) store.delete(targetKey(carry.source, carry.requestId, current.target));
      set(undefined);
    } catch (error) { fail(error); } };
  });
}

export async function keptDraft(source: ConversationScope, target: ConversationScope): Promise<boolean> {
  return transaction<boolean>('readonly', (store, set, fail) => readKeptDraft(store, source, target, set, fail));
}
