import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEditorBinding } from '../../packages/contracts/dist/index.js';
const binding = { schemaVersion: 1, kind: 'editing', scope: { hostId: 'host', conversationId: 'chat' }, viewId: 'dedicated', revision: 1, writerGeneration: 2 };
test('versioned editor bindings distinguish active ownership and one reserved target', () => {
  assert.deepEqual(parseEditorBinding(binding), binding);
  const reserved = { ...binding, kind: 'handoff-reserved', transitionId: 'transition', targetLabel: 'chat-label' };
  assert.deepEqual(parseEditorBinding(reserved), reserved);
  for (const invalid of [{ ...binding, schemaVersion: 2 }, { ...binding, revision: 0 }, { ...binding, writerGeneration: 0 },
    { ...binding, writerGeneration: Number.MAX_SAFE_INTEGER + 1 }, { ...binding, kind: 'handoff-reserved' }, { ...binding, transitionId: 'extra' },
    { ...reserved, targetLabel: '' }, { ...binding, scope: { ...binding.scope, hostId: '' } }]) assert.throws(() => parseEditorBinding(invalid));
});
