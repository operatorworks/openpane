import { parseScope, sameScope } from '@openpane/contracts';
import type { ConversationScope } from '@openpane/contracts';
import { record } from '@openpane/contracts/decode';
import type { LocalRecords } from '@openpane/client';
import { decodeView } from './view-state.js';

export function initializeDraft(store: IDBObjectStore, viewId: string, scope: ConversationScope, agentId: string, text: string, done: () => void, fail: (error: unknown) => void): void {
  if (new TextEncoder().encode(text).byteLength > 1024 * 1024) { fail(new Error('The initial draft exceeds one MiB')); return; }
  const draftKey = ['draft', viewId, scope.hostId, scope.conversationId], viewKey = ['view', viewId, scope.hostId];
  const draft = store.get(draftKey), view = store.get(viewKey); let remaining = 2;
  const commit = () => {
    try {
      const saved = decodeView(view.result, scope.hostId);
      if (saved.pendingCreation && (!sameScope(saved.pendingCreation.scope, scope) || saved.pendingCreation.agentId !== agentId)) throw new Error('Another creation already owns this saved view');
      if (draft.result !== undefined) {
        const prior = record(draft.result);
        if (!sameScope(parseScope(prior.scope), scope) || prior.draft !== text) throw new Error('This conversation already has a different saved draft');
        done(); return;
      }
      const records: LocalRecords = { version: 3, scope, draft: text, draftRevision: 1, outbox: [], frontendSends: [], image: null };
      store.put(records, draftKey);
      store.put({ ...saved, pendingCreation: { scope, agentId } }, viewKey); done();
    } catch (error) { fail(error); }
  };
  for (const request of [draft, view]) request.onsuccess = () => { if (--remaining === 0) commit(); };
}
