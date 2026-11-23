import { parseScope, sameScope } from '@openpane/contracts';
import type { ConversationScope } from '@openpane/contracts';
import { count, identifier, record } from '@openpane/contracts/decode';
import type { DraftTransferCommit, LocalRecords } from '@openpane/client';

interface CarryIdentity { readonly version: 1; readonly source: ConversationScope; readonly sourceViewId: string; readonly requestId: string }
export type DraftCarry = CarryIdentity & (
  | { readonly kind: 'offered'; readonly target: ConversationScope | null; readonly expected: { readonly text: string; readonly revision: number } }
  | { readonly kind: 'applied'; readonly target: ConversationScope; readonly expected: { readonly text: string; readonly revision: number } }
  | { readonly kind: 'cancelled'; readonly target: ConversationScope | null; readonly outcome: 'kept-at-source' }
  | { readonly kind: 'settled'; readonly target: ConversationScope; readonly outcome: 'cleared' | 'changed' }
);
export const carryKey = (source: ConversationScope, requestId: string): IDBValidKey => ['draft-carry', source.hostId, source.conversationId, requestId];
export const carryTargetKey = (source: ConversationScope, requestId: string, target: ConversationScope): IDBValidKey => ['draft-carry-target', target.hostId, target.conversationId, source.hostId, source.conversationId, requestId];
export const carryPrefix = (parts: readonly IDBValidKey[]) => IDBKeyRange.bound([...parts], [...parts, []], false, true);
export function parseCarry(value: unknown): DraftCarry {
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
export function namedCarry(value: unknown, source: ConversationScope, requestId: string): DraftCarry {
  const carry = parseCarry(value);
  if (!sameScope(carry.source, source) || carry.requestId !== requestId) throw new Error('Draft carry identity disagrees with its saved key');
  return carry;
}

export const carryEpochKey: IDBValidKey = ['draft-carry-epoch'];
export function carryRequestEpoch(requestId: string): number {
  const match = /^([1-9]\d*):.+$/.exec(requestId);
  return match ? count(Number(match[1])) : 0;
}

export function commitCarriedDraft(store: IDBObjectStore, viewId: string, records: LocalRecords, transfer: DraftTransferCommit, result: (committed: boolean) => void, fail: (error: unknown) => void): void {
  const request = store.get(carryKey(transfer.source, transfer.requestId));
  request.onsuccess = () => {
    try {
      if (request.result === undefined) { result(false); return; }
      const carry = namedCarry(request.result, transfer.source, transfer.requestId);
      if (carry.kind === 'cancelled' || carry.kind === 'settled') { result(false); return; }
      let next: DraftCarry;
      if (transfer.outcome === 'received') {
        if (carry.kind !== 'offered') { result(false); return; }
        if (!carry.target || !sameScope(carry.target, records.scope) || !records.draft.includes(carry.expected.text)) throw new Error('Draft transfer does not match its destination');
        next = { ...carry, kind: 'applied', target: carry.target };
      } else {
        if (carry.kind !== 'applied') { result(false); return; }
        if (!sameScope(carry.source, records.scope) || carry.sourceViewId !== viewId || transfer.outcome === 'cleared' && records.draft !== '') throw new Error('Draft transfer does not match its source');
        next = { version: 1, kind: 'settled', source: carry.source, sourceViewId: carry.sourceViewId, requestId: carry.requestId, target: carry.target, outcome: transfer.outcome };
        store.delete(carryTargetKey(carry.source, carry.requestId, carry.target));
      }
      store.put(records, ['draft', viewId, records.scope.hostId, records.scope.conversationId]);
      store.put(next, carryKey(carry.source, carry.requestId)); result(true);
    } catch (error) { fail(error); }
  };
}
