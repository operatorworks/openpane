import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_PRESENTATION, conversationPresentation } from '../../apps/desktop/src/application/agent-presentation.ts';

// The footer shows this disclosure for the open conversation, so each runtime's safety line must survive the move out of the composer.
test('each native runtime keeps its disclosure, and providers follow their own capabilities', () => {
  const native = { id: 'native', label: 'Native', runtime: { engine: 'codex-sdk', version: '1', format: 'jsonl' }, commands: ['send'],
    imageInput: { kind: 'unsupported', reason: 'No images.' }, availability: { kind: 'ready' } };
  assert.match(conversationPresentation(native, 'codex-sdk').footer, /Read-only · No interactive approvals$/);
  assert.equal(conversationPresentation(native, 'codex').footer, 'Local Codex · Approvals required for changes');
  assert.match(conversationPresentation(native, 'pi').footer, /Chat only · No tools$/);
  assert.equal(conversationPresentation(native, 'recorded').footer, AGENT_PRESENTATION.recorded.footer);
  const provider = { kind: 'provider', id: 'p', label: 'Crew', namespace: 'crew', installationId: 'i', providerAgentId: 'a',
    commands: [], imageInput: { kind: 'unsupported', reason: 'No images.' }, availability: { kind: 'ready' } };
  assert.equal(conversationPresentation(provider, 'codex').footer, 'Provider conversation · Messaging is not available for this provider');
});
