import { canonicalJson, parseEditorBinding, parseScope, sameScope } from '@openpane/contracts';
import type { ConversationScope } from '@openpane/contracts';
import { count, identifier, record } from '@openpane/contracts/decode';
import { openViewDatabase } from './browser-storage.js';
import { editorBindingKey } from './editor-bindings.js';

interface CarryIdentity { readonly version: 1; readonly source: ConversationScope; readonly sourceViewId: string; readonly requestId: string }
export type DraftCarry = CarryIdentity & (
  | { readonly kind: 'offered'; readonly target: ConversationScope | null; readonly expected: { readonly text: string; readonly revision: number } }
  | { readonly kind: 'applied'; readonly target: ConversationScope; readonly expected: { readonly text: string; readonly revision: number } }
  | { readonly kind: 'cancelled'; readonly target: ConversationScope | null; readonly outcome: 'kept-at-source' }
  | { readonly kind: 'settled'; readonly target: ConversationScope; readonly outcome: 'cleared' | 'changed' }
);
const key = (source: ConversationScope, requestId: string): IDBValidKey => ['draft-carry', source.hostId, source.conversationId, requestId];
const targetKey = (source: ConversationScope, requestId: string, target: ConversationScope): IDBValidKey => ['draft-carry-target', target.hostId, target.conversationId, source.hostId, source.conversationId, requestId];
const prefix = (parts: readonly IDBValidKey[]) => IDBKeyRange.bound([...parts], [...parts, []], false, true);
function parseCarry(value: unknown): DraftCarry {
  const input = record(value);
  const common = ['version', 'source', 'sourceViewId', 'requestId', 'kind', 'target'];
  record(input, input.kind === 'settled' || input.kind === 'cancelled' ? [...common, 'outcome'] : [...common, 'expected']);
  if (input.version !== 1) throw new Error('Unsupported draft carry record');
  const source = parseScope(input.source), target = input.target === null ? null : parseScope(input.target);
  if (target && (target.hostId !== source.hostId || sameScope(target, source))) throw new Error('Invalid draft carry target');
  const identity = { version: 1, source, sourceViewId: identifier(input.sourceViewId, 200), requestId: identifier(input.requestId, 200) } satisfies CarryIdentity;
  if (input.kind === 'cancelled') { if (input.outcome !== 'kept-at-source') throw new Error('Invalid cancelled carry'); return { ...identity, kind: 'cancelled', target, outcome: 'kept-at-source' }; }
  if (input.kind === 'settled') {
    if (!target || input.outcome !== 'cleared' && input.outcome !== 'changed') throw new Error('Invalid draft carry settlement');
    return { ...identity, kind: 'settled', target, outcome: input.outcome };
  }
  const expected = record(input.expected, ['text', 'revision']);
  if (typeof expected.text !== 'string' || !expected.text || new TextEncoder().encode(expected.text).byteLength > 1024 * 1024) throw new Error('Invalid carried draft text');
  const captured = { text: expected.text, revision: count(expected.revision) };
  if (input.kind === 'offered') return { ...identity, kind: 'offered', target, expected: captured };
  if (input.kind === 'applied' && target) return { ...identity, kind: 'applied', target, expected: captured };
  throw new Error('Invalid draft carry state');
}
function namedCarry(value: unknown, source: ConversationScope, requestId: string): DraftCarry {
  const carry = parseCarry(value);
  if (!sameScope(carry.source, source) || carry.requestId !== requestId) throw new Error('Draft carry identity disagrees with its saved key');
  return carry;
}
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
export async function offerDraftCarry(input: { readonly source: ConversationScope; readonly sourceViewId: string; readonly requestId: string; readonly writerGeneration: number; readonly expected: { readonly text: string; readonly revision: number } }): Promise<void> {
  const offered = parseCarry({ version: 1, kind: 'offered', source: input.source, sourceViewId: input.sourceViewId, requestId: input.requestId, expected: input.expected, target: null });
  await transaction<void>('readwrite', (store, set, fail) => {
    const binding = store.get(editorBindingKey(input.source)), existing = store.get(key(input.source, input.requestId));
    const prior = store.getAll(prefix(['draft-carry', input.source.hostId, input.source.conversationId]), 1025), total = store.count(prefix(['draft-carry']));
    let remaining = 4;
    const commit = () => {
      try {
        const owned = parseEditorBinding(binding.result);
        if (!sameScope(owned.scope, input.source) || owned.kind !== 'editing' || owned.viewId !== input.sourceViewId || owned.writerGeneration !== input.writerGeneration) throw new Error('Only the current editor may offer its draft');
        if (existing.result !== undefined) { if (canonicalJson(namedCarry(existing.result, input.source, input.requestId)) !== canonicalJson(offered)) throw new Error('Draft carry ID has different input'); set(undefined); return; }
        if (total.result >= 1024) throw new Error('Draft carry history is full. Existing drafts are preserved.');
        if (prior.result.map(parseCarry).some(item => item.kind === 'offered' || item.kind === 'applied')) throw new Error('This draft already has an unresolved carry. Wait for its target before starting another.');
        store.put(offered, key(input.source, input.requestId)); set(undefined);
      } catch (error) { fail(error); }
    };
    for (const request of [binding, existing, prior, total]) request.onsuccess = () => { if (--remaining === 0) commit(); };
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
export async function updateDraftCarry(carry: DraftCarry, outcome: 'applied' | 'cleared' | 'changed' | 'cancelled'): Promise<void> {
  await transaction<void>('readwrite', (store, set, fail) => {
    const request = store.get(key(carry.source, carry.requestId)); request.onsuccess = () => {
      try {
        const current = namedCarry(request.result, carry.source, carry.requestId);
        if (outcome === 'cancelled') {
          if (current.kind !== 'settled' && current.kind !== 'cancelled') {
            store.put({ version: 1, kind: 'cancelled', source: current.source, sourceViewId: current.sourceViewId, requestId: current.requestId, target: current.target, outcome: 'kept-at-source' } satisfies DraftCarry, key(carry.source, carry.requestId));
            if (current.target) store.delete(targetKey(current.source, current.requestId, current.target));
          }
          set(undefined); return;
        }
        if (current.kind === 'cancelled') { set(undefined); return; }
        if (!current.target || !carry.target || !sameScope(current.target, carry.target)) throw new Error('Draft carry target changed');
        if (current.kind === 'settled' || outcome === 'applied' && current.kind === 'applied') { set(undefined); return; }
        if (outcome !== 'applied' && current.kind !== 'applied') throw new Error('The target has not applied this draft');
        const next: DraftCarry = outcome === 'applied' && current.kind === 'offered' ? { ...current, kind: 'applied', target: current.target }
          : { version: 1, kind: 'settled', source: current.source, sourceViewId: current.sourceViewId, requestId: current.requestId, target: current.target, outcome: outcome === 'cleared' ? 'cleared' : 'changed' };
        store.put(next, key(carry.source, carry.requestId));
        if (next.kind === 'settled') store.delete(targetKey(next.source, next.requestId, next.target)); set(undefined);
      } catch (error) { fail(error); }
    };
  });
}
