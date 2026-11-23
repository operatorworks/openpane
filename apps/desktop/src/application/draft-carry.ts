import { count, identifier, record } from '@openpane/contracts/decode';
import { canonicalJson, parseEditorBinding, parseScope, sameScope } from '@openpane/contracts';
import type { ConversationScope } from '@openpane/contracts';
import { openViewDatabase } from './browser-storage.js';
import { editorBindingKey } from './editor-bindings.js';
import { carryKey as key, carryTargetKey as targetKey, carryPrefix as prefix, namedCarry, parseCarry, carryEpochKey, carryRequestEpoch } from './draft-carry-records.js';
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
export async function pruneDraftCarryHistory(epoch: number): Promise<number> {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Invalid native request epoch');
  return transaction<number>('readwrite', (store, set, fail) => {
    const all = store.getAll(prefix(['draft-carry']), 1025), floor = store.get(carryEpochKey); let remaining = 2;
    const commit = () => {
      try {
        if (epoch < count(floor.result ?? 0)) throw new Error('Native request epoch advanced. Retry this request.');
        if (all.result.length > 1024) throw new Error('Draft carry history exceeds limits');
        let retained = all.result.length;
        for (const value of all.result) {
          const carry = parseCarry(value);
          if ((carry.kind === 'settled' || carry.kind === 'cancelled') && carryRequestEpoch(carry.requestId) < epoch) {
            store.delete(key(carry.source, carry.requestId));
            if (carry.target) store.delete(targetKey(carry.source, carry.requestId, carry.target));
            retained--;
          }
        }
        store.put(epoch, carryEpochKey); set(retained);
      } catch (error) { fail(error); }
    };
    for (const request of [all, floor]) request.onsuccess = () => { if (--remaining === 0) commit(); };
  });
}
export async function offerDraftCarry(input: { readonly source: ConversationScope; readonly sourceViewId: string; readonly requestId: string; readonly writerGeneration: number; readonly expected: { readonly text: string; readonly revision: number } }): Promise<void> {
  const offered = parseCarry({ version: 1, kind: 'offered', source: input.source, sourceViewId: input.sourceViewId, requestId: input.requestId, expected: input.expected, target: null });
  await transaction<void>('readwrite', (store, set, fail) => {
    const binding = store.get(editorBindingKey(input.source)), existing = store.get(key(input.source, input.requestId));
    const prior = store.getAll(prefix(['draft-carry', input.source.hostId, input.source.conversationId]), 1025), total = store.count(prefix(['draft-carry'])), floor = store.get(carryEpochKey);
    let remaining = 5;
    const commit = () => {
      try {
        const owned = parseEditorBinding(binding.result);
        if (!sameScope(owned.scope, input.source) || owned.kind !== 'editing' || owned.viewId !== input.sourceViewId || owned.writerGeneration !== input.writerGeneration) throw new Error('Only the current editor may offer its draft');
        if (existing.result !== undefined) { if (canonicalJson(namedCarry(existing.result, input.source, input.requestId)) !== canonicalJson(offered)) throw new Error('Draft carry ID has different input'); set(undefined); return; }
        const epoch = carryRequestEpoch(input.requestId);
        if (!epoch || epoch < count(floor.result ?? 0)) throw new Error('Draft carry request epoch expired');
        if (total.result >= 1024) throw new Error('Draft carry history is full. Existing drafts are preserved.');
        if (prior.result.map(parseCarry).some(item => item.kind === 'offered' || item.kind === 'applied')) throw new Error('This draft already has an unresolved carry. Wait for its target before starting another.');
        store.put(offered, key(input.source, input.requestId)); set(undefined);
      } catch (error) { fail(error); }
    };
    for (const request of [binding, existing, prior, total, floor]) request.onsuccess = () => { if (--remaining === 0) commit(); };
  });
}
export async function bindDraftCarry(source: ConversationScope, requestId: string, target: ConversationScope): Promise<void> {
  await transaction<void>('readwrite', (store, set, fail) => {
    const request = store.get(key(source, requestId)); request.onsuccess = () => {
      try {
        const carry = namedCarry(request.result, source, requestId);
        if (carry.target && !sameScope(carry.target, target)) throw new Error('Draft carry target is already fixed');
        if (carry.kind === 'cancelled' && carry.target === null) store.put({ ...carry, target }, key(source, requestId));
        if (carry.kind === 'offered' && carry.target === null) {
          const bound = parseCarry({ ...carry, target }); store.put(bound, key(source, requestId));
          store.put({ source, requestId }, targetKey(source, requestId, target));
        }
        set(undefined);
      } catch (error) { fail(error); }
    };
  });
}
export async function sourceCarries(scope: ConversationScope): Promise<readonly DraftCarry[]> {
  return transaction('readonly', (store, set, fail) => {
    const request = store.getAll(prefix(['draft-carry', scope.hostId, scope.conversationId]), 1025);
    request.onsuccess = () => { try { if (request.result.length > 1024) throw new Error('Draft carry history exceeds limits'); const values = request.result.map(parseCarry); if (values.some(carry => !sameScope(carry.source, scope))) throw new Error('Foreign source in draft carry history'); set(values); } catch (error) { fail(error); } };
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
export async function cancelDraftCarry(carry: DraftCarry): Promise<boolean> {
  return transaction<boolean>('readwrite', (store, set, fail) => {
    const request = store.get(key(carry.source, carry.requestId)); request.onsuccess = () => {
      try {
        const current = namedCarry(request.result, carry.source, carry.requestId);
        if (current.kind === 'settled') { set(false); return; }
        if (current.kind !== 'cancelled') {
          store.put({ version: 1, kind: 'cancelled', source: current.source, sourceViewId: current.sourceViewId, requestId: current.requestId, target: current.target, outcome: 'kept-at-source' } satisfies DraftCarry, key(carry.source, carry.requestId));
          if (current.target) store.delete(targetKey(current.source, current.requestId, current.target));
        }
        set(true);
      } catch (error) { fail(error); }
    };
  });
}
