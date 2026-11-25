import { parseScope, sameScope } from '@openpane/contracts';
import type { ConversationScope, EditorBinding } from '@openpane/contracts';
import { count, identifier, record } from '@openpane/contracts/decode';

export type EditingBinding = Extract<EditorBinding, { readonly kind: 'editing' }>;
export interface NativeEditorOrigin {
  readonly version: 1;
  readonly scope: ConversationScope;
  readonly viewId: string;
  readonly revision: number;
  readonly writerGeneration: number;
  readonly label: string;
}
export const nativeEditorOriginKey = (scope: ConversationScope): IDBValidKey => ['native-editor-origin', scope.hostId, scope.conversationId];
export function nativeEditorOriginMatches(origin: NativeEditorOrigin, binding: EditingBinding): boolean {
  return sameScope(origin.scope, binding.scope) && origin.viewId === binding.viewId && origin.revision === binding.revision && origin.writerGeneration === binding.writerGeneration;
}
export function parseNativeEditorOrigin(value: unknown, scope: ConversationScope): NativeEditorOrigin {
  const input = record(value, ['version', 'scope', 'viewId', 'revision', 'writerGeneration', 'label']);
  const origin = { version: 1, scope: parseScope(input.scope), viewId: identifier(input.viewId, 200), revision: count(input.revision), writerGeneration: count(input.writerGeneration), label: identifier(input.label, 200) } satisfies NativeEditorOrigin;
  if (input.version !== 1 || !sameScope(origin.scope, scope) || origin.revision < 1 || origin.writerGeneration < 1) throw new Error('The native editor origin is unreadable. Its saved record is preserved.');
  return origin;
}
