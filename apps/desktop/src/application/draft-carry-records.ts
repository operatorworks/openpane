import { parseEditorBinding, parseScope, sameScope } from '@openpane/contracts';
import type { ConversationScope } from '@openpane/contracts';
import { count, identifier, record } from '@openpane/contracts/decode';
import type { DraftTransferCommit, LocalRecords } from '@openpane/client';
import { editorBindingKey, editorViewKey } from './editor-bindings.js';

interface CarryIdentity { readonly version: 1; readonly source: ConversationScope; readonly sourceViewId: string; readonly requestId: string; readonly emptyOnly?: true }
export type DraftCarry = CarryIdentity & (
  | { readonly kind: 'offered'; readonly target: ConversationScope | null; readonly expected: { readonly text: string; readonly revision: number } }
  | { readonly kind: 'refused'; readonly target: ConversationScope | null; readonly expected: { readonly text: string; readonly revision: number } }
  | { readonly kind: 'applied'; readonly target: ConversationScope; readonly expected: { readonly text: string; readonly revision: number } }
  | { readonly kind: 'cancelled'; readonly target: ConversationScope | null; readonly outcome: 'kept-at-source'; readonly retainedText?: string }
  | { readonly kind: 'settled'; readonly target: ConversationScope; readonly outcome: 'cleared' | 'changed'; readonly retainedText?: string }
);
export const carryKey = (source: ConversationScope, requestId: string): IDBValidKey => ['draft-carry', source.hostId, source.conversationId, requestId];
export const carryTargetKey = (source: ConversationScope, requestId: string, target: ConversationScope): IDBValidKey => ['draft-carry-target', target.hostId, target.conversationId, source.hostId, source.conversationId, requestId];
export const carryPrefix = (parts: readonly IDBValidKey[]) => IDBKeyRange.bound([...parts], [...parts, []], false, true);
export function parseCarry(value: unknown): DraftCarry {
  const input = record(value);
  const common = ['version', 'source', 'sourceViewId', 'requestId', 'kind', 'target'];
  if (Object.hasOwn(input, 'emptyOnly')) { common.push('emptyOnly'); if (input.emptyOnly !== true) throw new Error('Invalid empty-target carry'); }
  if (Object.hasOwn(input, 'retainedText')) {
    common.push('retainedText');
    if (typeof input.retainedText !== 'string' || !input.retainedText || new TextEncoder().encode(input.retainedText).byteLength > 1024 * 1024 || input.kind !== 'settled' && input.kind !== 'cancelled') throw new Error('Invalid retained carry text');
  }
  record(input, input.kind === 'settled' || input.kind === 'cancelled' ? [...common, 'outcome'] : [...common, 'expected']);
  if (input.version !== 1) throw new Error('Unsupported draft carry record');
  const source = parseScope(input.source), target = input.target === null ? null : parseScope(input.target);
  if (target && (target.hostId !== source.hostId || sameScope(target, source))) throw new Error('Invalid draft carry target');
  const requestId = identifier(input.requestId, 200);
  if (!carryRequestEpoch(requestId)) throw new Error('Invalid draft carry request epoch');
  const identity = { ...(typeof input.retainedText === 'string' ? { retainedText: input.retainedText } : {}), ...(input.emptyOnly === true ? { emptyOnly: true as const } : {}), version: 1, source, sourceViewId: identifier(input.sourceViewId, 200), requestId } satisfies CarryIdentity;
  if (input.kind === 'cancelled') { if (input.outcome !== 'kept-at-source') throw new Error('Invalid cancelled carry'); return { ...identity, kind: 'cancelled', target, outcome: 'kept-at-source' }; }
  if (input.kind === 'settled') {
    if (!target || input.outcome !== 'cleared' && input.outcome !== 'changed') throw new Error('Invalid draft carry settlement');
    return { ...identity, kind: 'settled', target, outcome: input.outcome };
  }
  const expected = record(input.expected, ['text', 'revision']);
  if (typeof expected.text !== 'string' || !expected.text || new TextEncoder().encode(expected.text).byteLength > 1024 * 1024) throw new Error('Invalid carried draft text');
  const captured = { text: expected.text, revision: count(expected.revision) };
  if (input.kind === 'offered' || input.kind === 'refused') return { ...identity, kind: input.kind, target, expected: captured };
  if (input.kind === 'applied' && target) return { ...identity, kind: 'applied', target, expected: captured };
  throw new Error('Invalid draft carry state');
}
export function namedCarry(value: unknown, source: ConversationScope, requestId: string): DraftCarry {
  const carry = parseCarry(value);
  if (!sameScope(carry.source, source) || carry.requestId !== requestId) throw new Error('Draft carry identity disagrees with its saved key');
  return carry;
}

/** A global scan may inspect damaged rows, but only their canonical identity may authorize writes. */
export function keyedCarry(value: unknown, savedKey: unknown): DraftCarry {
  const carry = parseCarry(value);
  if (!Array.isArray(savedKey) || savedKey.length !== 4 || savedKey[0] !== 'draft-carry' || savedKey[1] !== carry.source.hostId
    || savedKey[2] !== carry.source.conversationId || savedKey[3] !== carry.requestId) throw new Error('Draft carry identity disagrees with its saved key');
  return carry;
}
export function readKeptDraft(store: IDBObjectStore, source: ConversationScope, target: ConversationScope, read: (kept: boolean) => void, fail: (error: unknown) => void): void {
  if (source.hostId !== target.hostId || sameScope(source, target)) throw new Error('Invalid draft carry target');
  const markerKey = ['draft-carry-kept', source.hostId, source.conversationId, target.conversationId], marker = store.get(markerKey), found = store.getKey(markerKey); let pending = 2;
  const inspect = () => {
    try {
      if (found.result !== undefined && marker.result !== true) throw new Error('The saved Keep decision is unreadable. Its original record is preserved.');
      if (marker.result === true) { read(true); return; }
      const range = carryPrefix(['draft-carry', source.hostId, source.conversationId]), values = store.getAll(range, 1025), keys = store.getAllKeys(range, 1025); let remaining = 2;
      const scanned = () => {
        try {
          if (values.result.length > 1024 || values.result.length !== keys.result.length) throw new Error('Draft carry history exceeds limits');
          let kept = false;
          for (let index = 0; index < values.result.length; index++) {
            let carry: DraftCarry;
            try { carry = keyedCarry(values.result[index], keys.result[index]); } catch { continue; }
            if (carry.kind === 'cancelled' && carry.target && sameScope(carry.target, target)) { kept = true; break; }
          }
          read(kept);
        } catch (error) { fail(error); }
      };
      for (const request of [values, keys]) request.onsuccess = () => { if (--remaining === 0) scanned(); };
    } catch (error) { fail(error); }
  };
  for (const request of [marker, found]) request.onsuccess = () => { if (--pending === 0) inspect(); };
}

export const carryEpochKey: IDBValidKey = ['draft-carry-epoch'];
export function carryRequestEpoch(requestId: string): number {
  const match = /^([1-9]\d*):.+$/.exec(requestId);
  return match ? count(Number(match[1])) : 0;
}

export function carriedDraftText(text: string, destination: string): string {
  return !destination || destination === text ? text : `${text}\n\n${destination}`;
}
const draftText = (value: unknown, scope: ConversationScope): string => {
    if (value === undefined) return '';
    const draft = record(value);
    if (!sameScope(parseScope(draft.scope), scope) || typeof draft.draft !== 'string') throw new Error('Draft transfer scope disagrees with saved text');
    return draft.draft;
  };

export function copiedDraftPresent(text: string, destination: string): boolean {
  return destination === text || destination.startsWith(`${text}\n\n`);
}
function readBoundDraft(store: IDBObjectStore, target: ConversationScope, read: (saved: { readonly viewId: string; readonly text: string } | null) => void, fail: (error: unknown) => void): void {
  const binding = store.get(editorBindingKey(target));
  binding.onsuccess = () => {
    try {
      if (binding.result === undefined) { read(null); return; }
      const editor = parseEditorBinding(binding.result);
      if (!sameScope(editor.scope, target)) throw new Error('Draft copy destination binding disagrees');
      const request = store.get(['draft', editor.viewId, target.hostId, target.conversationId]);
      request.onsuccess = () => { try { read({ viewId: editor.viewId, text: draftText(request.result, target) }); } catch (error) { fail(error); } };
    } catch (error) { fail(error); }
  };
}
export function commitCopiedDraft(store: IDBObjectStore, viewId: string, records: LocalRecords, transfer: Extract<DraftTransferCommit, { readonly outcome: 'copy-cleared' }>, result: (committed: boolean) => void, fail: (error: unknown) => void): void {
  if (sameScope(records.scope, transfer.target) || records.scope.hostId !== transfer.target.hostId || records.draft !== '') throw new Error('Invalid copied draft release');
  readKeptDraft(store, records.scope, transfer.target, kept => {
    if (kept) { result(false); return; }
    readBoundDraft(store, transfer.target, saved => {
      if (!saved && viewId === transfer.targetViewId) {
        const owner = store.get(editorViewKey(viewId)), target = store.get(['draft', viewId, transfer.target.hostId, transfer.target.conversationId]); let remaining = 2;
        const read = () => { try {
          if (owner.result !== undefined || !copiedDraftPresent(transfer.text, draftText(target.result, transfer.target))) { result(false); return; }
          store.put(records, ['draft', viewId, records.scope.hostId, records.scope.conversationId]); result(true);
        } catch (error) { fail(error); } };
        for (const request of [owner, target]) request.onsuccess = () => { if (--remaining === 0) read(); };
        return;
      }
      if (!saved || saved.viewId !== transfer.targetViewId || !copiedDraftPresent(transfer.text, saved.text)) { result(false); return; }
      store.put(records, ['draft', viewId, records.scope.hostId, records.scope.conversationId]); result(true);
    }, fail);
  }, fail);
}
export function commitIncomingCopiedDraft(store: IDBObjectStore, viewId: string, records: LocalRecords, transfer: Extract<DraftTransferCommit, { readonly outcome: 'copy-received' }>, result: (committed: boolean) => void, fail: (error: unknown) => void): void {
  if (sameScope(records.scope, transfer.source) || records.scope.hostId !== transfer.source.hostId) throw new Error('Invalid copied draft destination');
  readKeptDraft(store, transfer.source, records.scope, kept => {
    if (kept) { result(false); return; }
    store.put(records, ['draft', viewId, records.scope.hostId, records.scope.conversationId]); result(true);
  }, fail);
}
export function commitCarriedDraft(store: IDBObjectStore, viewId: string, records: LocalRecords, transfer: Exclude<DraftTransferCommit, { readonly outcome: 'copy-cleared' | 'copy-received' }>, result: (committed: boolean) => void, fail: (error: unknown) => void): void {
  const request = store.get(carryKey(transfer.source, transfer.requestId));
  request.onsuccess = () => {
    try {
      if (request.result === undefined) { result(false); return; }
      const carry = namedCarry(request.result, transfer.source, transfer.requestId);
      if (carry.kind === 'cancelled' || carry.kind === 'settled' || carry.kind === 'refused') { result(false); return; }
      const keepAtSource = () => {
        store.put({ version: 1, kind: 'cancelled', source: carry.source, sourceViewId: carry.sourceViewId, requestId: carry.requestId,
          target: carry.target, outcome: 'kept-at-source', retainedText: carry.expected.text, ...(carry.emptyOnly ? { emptyOnly: true } : {}) } satisfies DraftCarry, carryKey(carry.source, carry.requestId));
        if (carry.target) store.delete(carryTargetKey(carry.source, carry.requestId, carry.target));
        result(false);
      };
      const commit = (next: DraftCarry) => {
        store.put(records, ['draft', viewId, records.scope.hostId, records.scope.conversationId]);
        store.put(next, carryKey(carry.source, carry.requestId));
        if (next.kind === 'settled') store.delete(carryTargetKey(carry.source, carry.requestId, next.target));
        result(true);
      };
      if (transfer.outcome === 'received') {
        if (carry.kind !== 'offered') { result(false); return; }
        if (!carry.target) { result(false); return; }
        if (!sameScope(carry.target, records.scope)) throw new Error('Draft transfer does not match its destination');
        const target = carry.target;
        readKeptDraft(store, carry.source, target, kept => {
          if (kept) { keepAtSource(); return; }
          const prior = store.get(['draft', viewId, target.hostId, target.conversationId]);
          prior.onsuccess = () => {
            try {
              if (records.draft !== carriedDraftText(carry.expected.text, draftText(prior.result, target))) throw new Error('Draft transfer does not contain the complete copied text');
              commit({ ...carry, kind: 'applied', target });
            } catch (error) { fail(error); }
          };
        }, fail);
        return;
      }
      if (carry.kind !== 'applied') { result(false); return; }
      if (!sameScope(carry.source, records.scope) || transfer.outcome === 'cleared' && records.draft !== '') throw new Error('Draft transfer does not match its source');
      const outcome = transfer.outcome;
      const settleSource = () => readKeptDraft(store, carry.source, carry.target, kept => {
        if (kept) { keepAtSource(); return; }
        const settled: DraftCarry = { version: 1, kind: 'settled', source: carry.source, sourceViewId: viewId, requestId: carry.requestId, target: carry.target, outcome };
        if (outcome === 'changed') { commit({ ...settled, retainedText: carry.expected.text }); return; }
        readBoundDraft(store, carry.target, saved => {
          if (!saved || !copiedDraftPresent(carry.expected.text, saved.text)) {
            store.put({ ...settled, outcome: 'changed', retainedText: carry.expected.text }, carryKey(carry.source, carry.requestId));
            store.delete(carryTargetKey(carry.source, carry.requestId, carry.target));
            result(false); return;
          }
          commit(settled);
        }, fail);
      }, fail);
      if (carry.sourceViewId === viewId) { settleSource(); return; }
      const binding = store.get(editorBindingKey(carry.source));
      binding.onsuccess = () => {
        try {
          const current = parseEditorBinding(binding.result);
          if (current.kind !== 'editing' || !sameScope(current.scope, carry.source) || current.viewId !== viewId) throw new Error('Only the current source editor may settle its draft carry');
          settleSource();
        } catch (error) { fail(error); }
      };
    } catch (error) { fail(error); }
  };
}
