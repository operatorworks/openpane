import { parseEditorBinding } from '@openpane/contracts';
import type { EditorBinding } from '@openpane/contracts';
import { openViewDatabase } from './browser-storage.js';
import { editorBindingKey } from './editor-bindings.js';
import { nativeEditorOriginKey, nativeEditorOriginMatches, parseNativeEditorOrigin } from './native-editor-origin-records.js';
import type { EditingBinding, NativeEditorOrigin } from './native-editor-origin-records.js';

export async function recordNativeEditorOrigin(binding: EditingBinding, label: string): Promise<void> {
  const origin = parseNativeEditorOrigin({ version: 1, scope: binding.scope, viewId: binding.viewId, revision: binding.revision, writerGeneration: binding.writerGeneration, label }, binding.scope);
  const db = await openViewDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records'), current = store.get(editorBindingKey(binding.scope)); let failure: unknown;
      current.onsuccess = () => {
        try {
          const owned = parseEditorBinding(current.result);
          if (owned.kind !== 'editing' || !nativeEditorOriginMatches(origin, owned)) throw new Error('The native editor changed before readiness.');
          store.put(origin, nativeEditorOriginKey(binding.scope));
        } catch (cause) { failure = cause; tx.abort(); }
      };
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure ?? tx.error ?? new Error('Native editor origin write interrupted'));
    });
  } finally { db.close(); }
}
export async function nativeEditorOrigin(binding: EditorBinding): Promise<NativeEditorOrigin | null> {
  if (binding.kind !== 'editing') return null;
  const db = await openViewDatabase();
  try {
    return await new Promise<NativeEditorOrigin | null>((resolve, reject) => {
      const tx = db.transaction('records'), request = tx.objectStore('records').get(nativeEditorOriginKey(binding.scope));
      tx.oncomplete = () => { try { const origin = request.result === undefined ? null : parseNativeEditorOrigin(request.result, binding.scope); resolve(origin && nativeEditorOriginMatches(origin, binding) ? origin : null); } catch (cause) { reject(cause); } };
      tx.onabort = () => reject(tx.error ?? new Error('Native editor origin read interrupted'));
    });
  } finally { db.close(); }
}
