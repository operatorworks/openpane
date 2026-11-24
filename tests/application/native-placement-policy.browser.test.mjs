import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t) {
  const bundle = await build({ stdin: { contents: `import { windowContext } from './tests/application/window-context-fixture.mjs';
    import { PlacementSuperseded } from './apps/desktop/src/application/placement-port.ts';
    import { WindowCoordinator } from './apps/desktop/src/application/window-coordinator.ts';
    import { WindowRuntime } from './apps/desktop/src/application/window-runtime.ts';
    import { UiConnection } from './apps/desktop/src/application/ui-connection.ts';
    import { ServiceConnectionLost, ServiceError } from '@openpane/client/service';
    import { fixture as controllerFixture } from './tests/application/controller-fixture.mjs';
    import { BrowserViewStorage } from './apps/desktop/src/application/browser-storage.ts';
    import { createConversationStore } from './packages/client/src/index.ts';
    import { transcriptProjection } from '@openpane/contracts/conversation';
    import { recordNativeEditorOrigin } from './apps/desktop/src/application/native-editor-origin.ts';
    import * as carries from './apps/desktop/src/application/draft-carry.ts';
    Object.assign(globalThis, { captureSupersession: error => { if (!(error instanceof PlacementSuperseded)) throw error; return { superseded: true }; }, windowContext, recordNativeEditorOrigin, ServiceError, ServiceConnectionLost, controllerFixture, WindowCoordinator, WindowRuntime, UiConnection, BrowserViewStorage, carries, createConversationStore, transcriptProjection });`, resolveDir: root }, bundle: true, write: false, format: 'iife' });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Native placement policy</title>' }));
  await page.goto('http://localhost/policy'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return page;
}

test('a new unconfirmed delivery cannot place an ordinary creation with the previous separate policy', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const scope = { hostId: 'host', conversationId: 'new-chat' }, context = { role: 'main', version: 1, label: 'main', brokerInstance: 'broker', documentIncarnation: 'main', viewId: 'catalog', reservation: null, liveRelay: true };
    const runtime = new globalThis.WindowRuntime(context), calls = [];
    const presentation = chats => ({ chats, chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const delivered = (generation, chats) => ({ selection: { deliveryGeneration: generation, revision: generation, selected: { kind: 'bundle', digest: 'a'.repeat(64) } }, bundle: { digest: 'a'.repeat(64), manifest: { presentation: presentation(chats) } }, transitions: [] });
    let ui = { state: delivered(1, 'separate'), localBuiltin: false, deliveryContext: globalThis.windowContext('main-context'), confirmedGeneration: 1,
      validatedVisual: { kind: 'delivery', context: globalThis.windowContext('main-context'), generation: 1, revision: 1, digest: 'a'.repeat(64) } };
    runtime.ui.getSnapshot = () => ui; runtime.recoveryWake = async () => {}; runtime.drive = async () => {};
    runtime.controller.getSnapshot = () => ({ host: { kind: 'ready', metadata: { hostId: 'host' } }, active: null, lastPlacement: null });
    runtime.port.request = async command => {
      calls.push(command.kind);
      if (command.kind === 'lookup') return { kind: 'absent' };
      if (command.kind === 'reserve') return { scope, viewId: command.viewId, label: 'chat-new', transitionId: 'move', creationAgentId: 'agent', phase: 'requested', bindingRevision: null, writerGeneration: null };
      if (command.kind === 'launch') return { kind: 'pending', scope, reason: 'Opening' };
      throw new Error(command.kind);
    };
    runtime.uiChanged();
    ui = { ...ui, state: delivered(2, 'inline') }; runtime.uiChanged();
    const placed = await runtime.coordinator.acquire({ scope, creation: true, agentId: 'agent', agentLabel: 'Agent', carryFrom: null, initialDraft: null },
      { storage: { viewId: 'catalog' }, holds: () => false, async quiesce() { throw new Error('Source must not quiesce'); }, async release() { throw new Error('Source must not release'); } }).catch(globalThis.captureSupersession);
    return { calls, placed };
  });
  assert.equal(result.placed.superseded, true);
  assert.deepEqual(result.calls, ['lookup']);
});

test('ordinary separate placement rechecks its delivery after native reservation', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const scope = { hostId: 'host', conversationId: 'late-creation' }, calls = []; let current = true;
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', liveRelay: true }, async request(command) {
      calls.push(command.kind);
      if (command.kind === 'lookup') return { kind: 'absent' };
      if (command.kind === 'cancel-reservation') return true;
      if (command.kind === 'reserve') { current = false; return { scope, viewId: command.viewId, label: 'chat-new', transitionId: 'move', creationAgentId: 'agent', phase: 'requested', bindingRevision: null, writerGeneration: null }; }
      if (command.kind === 'launch') return { kind: 'pending', scope, reason: 'Opening' };
      throw new Error(command.kind);
    } });
    coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, () => current);
    const placed = await coordinator.acquire({ scope, creation: true, agentId: 'agent', agentLabel: 'Agent', carryFrom: null, initialDraft: null },
      { storage: { viewId: 'catalog' }, holds: () => false, async quiesce() { throw new Error('Source must not quiesce'); }, async release() { throw new Error('Source must not release'); } }).catch(globalThis.captureSupersession);
    return { calls, placed };
  });
  assert.equal(result.placed.superseded, true); assert.deepEqual(result.calls, ['lookup', 'reserve', 'lookup', 'cancel-reservation']);
});

for (const settlesImmediately of [false, true]) test(`retrying an older history result replaces its refusal (settles immediately ${settlesImmediately})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async settlesImmediately => {
    const scope = { hostId: 'host', conversationId: 'source' }, target = { hostId: 'host', conversationId: 'target' };
    const old = { sourceScope: scope, requestId: '1:older-request', action: { kind: 'create', agentId: 'agent', carry: false }, target: null, result: { kind: 'refused', reason: 'Old refusal' } };
    const retry = { ...old, result: null }, terminal = { ...old, result: { kind: 'inline', scope: target } };
    let saved = settlesImmediately ? terminal : retry; const calls = [];
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat', reservation: { scope } }, historyEpoch: 1,
      requestHistory: new Map([[old.requestId, old]]), historyAfter: 'older-page', historyExtended: true, pendingIntents: new Map(), pendingIntent: null,
      snapshot: { recovery: { kind: 'chat', pending: [], history: [old], after: 'older-page', carries: [] } }, listeners: new Set(), controller: { settlePlacement() {} },
      port: { async request(command) {
        calls.push(command.kind);
        if (command.kind === 'retry-intent') return retry;
        if (command.kind === 'own-intents') return { epoch: 1, pending: saved.result === null ? [saved] : [], items: [], after: 'first-page' };
        if (command.kind === 'read-intent') return saved;
        throw new Error(command.kind);
      } } });
    await runtime.retryIntent(old);
    const during = runtime.snapshot.recovery;
    saved = terminal; await runtime.refreshRecovery();
    return { during, after: runtime.snapshot.recovery, calls };
  }, settlesImmediately);
  assert.equal(result.during.history.some(item => item.result?.kind === 'refused'), false);
  assert.equal(result.during.pending.length, settlesImmediately ? 0 : 1);
  assert.deepEqual(result.after.history.map(item => item.result), [{ kind: 'inline', scope: { hostId: 'host', conversationId: 'target' } }]);
  assert.deepEqual(result.after.pending, []);
});

test('explicit separate recovery remains available while an appearance delivery is unconfirmed', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const scope = { hostId: 'host', conversationId: 'explicit-recovery' }, calls = [];
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', liveRelay: true }, async request(command) {
      calls.push(command.kind);
      if (command.kind === 'lookup') return { kind: 'absent' };
      if (command.kind === 'reserve') return { scope, viewId: command.viewId, label: 'chat-explicit', transitionId: 'move', creationAgentId: 'agent', phase: 'requested', bindingRevision: null, writerGeneration: null };
      if (command.kind === 'launch') return { kind: 'pending', scope, reason: 'Opening' };
      throw new Error(command.kind);
    } });
    coordinator.setPresentation({ chats: 'inline', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, () => false);
    const placed = await coordinator.placeExplicitly(scope, 'separate', () => coordinator.acquire({ scope, creation: true, agentId: 'agent', agentLabel: 'Agent', carryFrom: null, initialDraft: null },
      { storage: { viewId: 'catalog' }, holds: () => false, async quiesce() {}, async release() {} }));
    return { calls, placed };
  });
  assert.equal(result.placed.kind, 'pending'); assert.deepEqual(result.calls, ['lookup', 'reserve', 'launch']);
});


test('a committed native handoff finishes after its appearance is superseded', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const scope = { hostId: 'host', conversationId: 'committed-native' }, S = globalThis.BrowserViewStorage;
    const source = await S.claimEditor({ scope, viewId: 'committed-view', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const drafts = source.drafts(() => {}); await drafts.load(scope);
    await drafts.save({ version: 3, scope, draft: 'Preserve the committed editor', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    let current = true; const calls = [];
    const reservation = { scope, viewId: 'committed-view', label: 'committed-child', transitionId: 'committed-move', creationAgentId: null, phase: 'requested', bindingRevision: null, writerGeneration: null };
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', liveRelay: true }, async request(command) {
      calls.push(command.kind === 'phase' ? command.phase : command.kind);
      if (command.kind === 'lookup') return { kind: 'absent' };
      if (command.kind === 'reserve') return reservation;
      if (command.kind === 'phase') return {};
      if (command.kind === 'launch') return { kind: 'pending', scope, reason: 'Opening committed editor' };
      throw new Error(command.kind);
    } });
    coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, () => current);
    const placed = await coordinator.withPlacementGuard(scope, () => current, () => coordinator.acquire({ scope, creation: false, agentId: 'agent', agentLabel: 'Agent', carryFrom: null, initialDraft: null }, {
      storage: source, holds: id => id === source.viewId, async quiesce() {}, async release() { await source.close(); current = false; },
    }));
    const binding = (await S.locateEditor(scope)).binding;
    let text = null;
    if (calls.includes('launch')) {
      const target = await S.claimEditor({ scope, viewId: reservation.viewId, label: reservation.label, transitionId: reservation.transitionId, creation: null }, () => {});
      text = (await target.drafts(() => {}).load(scope)).draft; await target.close();
    }
    return { placed, calls, binding, text };
  });
  assert.equal(result.placed.kind, 'pending'); assert.equal(result.calls.includes('launch'), true);
  assert.equal(result.binding.kind, 'handoff-reserved'); assert.equal(result.text, 'Preserve the committed editor');
});

test('a child that closes after lookup cannot be relaunched through the focus path under inline policy', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const scope = { hostId: 'host', conversationId: 'closed-after-lookup' }, S = globalThis.BrowserViewStorage;
    const source = await S.claimEditor({ scope, viewId: 'closed-view', label: 'old-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const drafts = source.drafts(() => {}); await drafts.load(scope);
    await drafts.save({ version: 3, scope, draft: 'Closed child saved text', draftRevision: 1, outbox: [], frontendSends: [], image: null }); await source.close();
    const reservation = { scope, viewId: 'closed-view', label: 'old-child', transitionId: 'old-transition', creationAgentId: null, phase: 'target-ready', bindingRevision: 1, writerGeneration: 1 };
    let lookups = 0, created = 0; const calls = [];
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      calls.push(command);
      if (command.kind === 'lookup') return { kind: ++lookups === 1 ? 'ready' : 'closed', reservation };
      if (command.kind === 'launch') {
        if (command.existingOnly) return null;
        created++; return { kind: 'detached', scope, label: reservation.label };
      }
      throw new Error(command.kind);
    } });
    coordinator.setPresentation(null);
    const placed = await coordinator.acquire({ scope, creation: false, agentId: 'agent', agentLabel: 'Agent', carryFrom: null, initialDraft: null },
      { storage: { viewId: 'catalog' }, holds: () => false, async quiesce() {}, async release() {} });
    const text = await new Promise((resolve, reject) => { const opening = indexedDB.open('openpane-browser-views', 1); opening.onerror = () => reject(opening.error); opening.onsuccess = () => { const db = opening.result, tx = db.transaction('records'), read = tx.objectStore('records').get(['draft', 'closed-view', 'host', 'closed-after-lookup']); read.onsuccess = () => resolve(read.result?.draft); read.onerror = () => reject(read.error); tx.oncomplete = () => db.close(); }; });
    return { kind: placed.kind, created, text, focusOnly: calls.find(command => command.kind === 'launch')?.existingOnly };
  });
  assert.equal(result.created, 0); assert.equal(result.kind, 'detached'); assert.equal(result.focusOnly, true);
  assert.equal(result.text, 'Closed child saved text');
});

test('an older recovery observation finishes before a retry can replace its result', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const scope = { hostId: 'host', conversationId: 'recovery-source' };
    const old = { sourceScope: scope, requestId: '1:retry-after-refresh', action: { kind: 'create', agentId: 'agent', carry: false }, target: null, result: { kind: 'refused', reason: 'Earlier refusal' } };
    const retry = { ...old, result: null }; let release, entered, reads = 0, saved = old;
    const held = new Promise(resolve => { release = resolve; }), reading = new Promise(resolve => { entered = resolve; }), calls = [];
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat', reservation: { scope } }, historyEpoch: 1,
      requestHistory: new Map([[old.requestId, old]]), historyAfter: null, historyExtended: false, pendingIntents: new Map(), pendingIntent: null,
      snapshot: { recovery: { kind: 'chat', pending: [], history: [old], after: null, carries: [] } }, listeners: new Set(), controller: { settlePlacement() {} },
      port: { async request(command) {
        calls.push(command.kind);
        if (command.kind === 'retry-intent') { saved = retry; return retry; }
        if (command.kind === 'own-intents') {
          if (reads++ === 0) { entered(); await held; return { epoch: 1, pending: [], items: [old], after: null }; }
          return { epoch: 1, pending: saved.result === null ? [saved] : [], items: saved.result ? [saved] : [], after: null };
        }
        if (command.kind === 'read-intent') return saved;
        throw new Error(command.kind);
      } } });
    const first = runtime.refreshRecovery(); await reading;
    const retrying = runtime.retryIntent(old), beforeRelease = [...calls]; release(); await Promise.all([first, retrying]);
    return { beforeRelease, calls, recovery: runtime.snapshot.recovery };
  });
  assert.deepEqual(result.beforeRelease, ['own-intents']);
  assert.equal(result.recovery.history.some(item => item.result?.kind === 'refused'), false);
  assert.equal(result.recovery.pending.length, 1);
});


test('a durable first draft completes its assigned window when appearance changes after storage commit', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const scope = { hostId: 'host', conversationId: 'first-draft-committed' }, S = globalThis.BrowserViewStorage;
    const original = S.prepareCreationDraft; let current = true, launched = 0;
    S.prepareCreationDraft = async (...args) => { await original(...args); current = false; };
    const reservation = { scope, viewId: 'first-draft-view', label: 'first-draft-child', transitionId: 'first-draft-move', creationAgentId: 'agent', phase: 'requested', bindingRevision: null, writerGeneration: null };
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return { kind: 'absent' };
      if (command.kind === 'reserve') return reservation;
      if (command.kind === 'launch') { launched++; return { kind: 'pending', scope, reason: 'Opening durable creation' }; }
      throw new Error(command.kind);
    } });
    coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, () => current);
    const placed = await coordinator.acquire({ scope, creation: true, agentId: 'agent', agentLabel: 'Agent', carryFrom: null, initialDraft: 'Keep this first draft' },
      { storage: { viewId: 'catalog' }, holds: () => false, async quiesce() {}, async release() {} });
    S.prepareCreationDraft = original;
    const binding = (await S.locateEditor(scope)).binding;
    const target = await S.claimEditor({ scope, viewId: reservation.viewId, label: reservation.label, transitionId: reservation.transitionId, creation: { agentId: 'agent' } }, () => {});
    const text = (await target.drafts(() => {}).load(scope)).draft; await target.close();
    return { placed, binding, text, launched };
  });
  assert.equal(result.placed.kind, 'pending'); assert.equal(result.launched, 1);
  assert.equal(result.binding.kind, 'handoff-reserved'); assert.equal(result.text, 'Keep this first draft');
});

for (const failure of ['superseded', 'transport']) test(`failed host tracking cancels a fresh reservation without touching the inline editor (${failure})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async failure => {
    const scope = { hostId: 'host', conversationId: 'tracking-source' }, S = globalThis.BrowserViewStorage;
    const source = await S.claimEditor({ scope, viewId: 'tracking-view', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const drafts = source.drafts(() => {}); await drafts.load(scope);
    await drafts.save({ version: 3, scope, draft: 'Keep inline until tracking succeeds', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    let current = true, reserved = false, cancelled = 0, quiesced = 0;
    const envelope = { requestId: '1:11111111-1111-4111-8111-111111111111', deliveryGeneration: 1, selectionRevision: 1, digest: null }, transition = { envelope, slot: { transitionId: 'tracking-slot', target: null } };
    const ui = new globalThis.UiConnection();
    ui.window = { role: 'main', hostId: 'host', profileId: 'profile', viewId: 'main-view', brokerInstance: 'broker', label: 'main', documentIncarnation: 'main' };
    ui.snapshot = { ...ui.getSnapshot(), state: { selection: { deliveryGeneration: 1, revision: 1 }, bundle: null }, localBuiltin: false, deliveryContext: 'main' };
    ui.post = async () => { if (failure === 'transport') throw new Error('Tracking reply unavailable'); current = false; return { receipt: null, outcome: 'superseded' }; };
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return { kind: 'absent' };
      if (command.kind === 'reserve') { reserved = true; return { scope, viewId: command.viewId, label: 'tracking-child', transitionId: 'tracking-move', creationAgentId: null, phase: 'requested', bindingRevision: null, writerGeneration: null }; }
      if (command.kind === 'cancel-reservation') { reserved = false; cancelled++; return true; }
      throw new Error(command.kind);
    } });
    coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, () => current);
    coordinator.trackPlacement((reservation, binding) => ui.reservePlacement(transition, { scope, viewId: reservation.viewId, label: reservation.label, nativeTransitionId: reservation.transitionId, bindingRevision: binding.revision }));
    const placed = await coordinator.withPlacementGuard(scope, () => current, () => coordinator.acquire({ scope, creation: false, agentId: 'agent', agentLabel: 'Agent', carryFrom: null, initialDraft: null },
      { storage: source, holds: id => id === source.viewId, async quiesce() { quiesced++; }, async release() { await source.close(); } })).catch(globalThis.captureSupersession);
    const binding = (await S.locateEditor(scope)).binding, text = (await drafts.load(scope)).draft;
    await source.close(); ui.close(); return { placed, binding, text, reserved, cancelled, quiesced };
  }, failure);
  if (failure === 'superseded') assert.equal(result.placed.superseded, true); else assert.equal(result.placed.kind, 'refused'); assert.equal(result.reserved, false); assert.equal(result.cancelled, 1);
  assert.equal(result.quiesced, 0); assert.equal(result.binding.kind, 'editing'); assert.equal(result.text, 'Keep inline until tracking succeeds');
});

test('an ordinary reserved creation finishes its offered carry after appearance changes', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const sourceScope = { hostId: 'host', conversationId: 'ordinary-carry-source' }, scope = { hostId: 'host', conversationId: 'ordinary-carry-target' }, S = globalThis.BrowserViewStorage;
    const source = await S.claimEditor({ scope: sourceScope, viewId: 'ordinary-carry-view', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const drafts = source.drafts(() => {}); await drafts.load(sourceScope);
    await drafts.save({ version: 3, scope: sourceScope, draft: 'Ordinary carry stays owned', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    let current = true, launched = 0;
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return { kind: 'absent' };
      if (command.kind === 'reserve') return { scope, viewId: command.viewId, label: 'ordinary-carry-child', transitionId: 'ordinary-carry-move', creationAgentId: 'agent', phase: 'requested', bindingRevision: null, writerGeneration: null };
      if (command.kind === 'intent-context') { current = false; return { epoch: 1, pendingCarryRequests: [] }; }
      if (command.kind === 'launch') { launched++; return { kind: 'pending', scope, reason: 'Opening carried draft' }; }
      throw new Error(command.kind);
    } });
    coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, () => current);
    coordinator.captureCarry(async requestId => {
      const binding = source.editorBinding();
      await globalThis.carries.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId, writerGeneration: binding.writerGeneration, expected: { text: 'Ordinary carry stays owned', revision: 1 }, emptyOnly: true });
      return { async cancel() { const carry = (await globalThis.carries.sourceCarries(sourceScope)).find(carry => carry.requestId === requestId); await globalThis.carries.refuseDraftCarry(carry); } };
    });
    const placed = await coordinator.acquire({ scope, creation: true, agentId: 'agent', agentLabel: 'Agent', carryFrom: sourceScope, initialDraft: null },
      { storage: source, holds: id => id === source.viewId, async quiesce() {}, async release() { await source.close(); } });
    const carries = await globalThis.carries.sourceCarries(sourceScope), text = (await drafts.load(sourceScope)).draft;
    await source.close(); return { placed, launched, carries, text };
  });
  assert.equal(result.placed.kind, 'pending'); assert.equal(result.launched, 1);
  assert.equal(result.carries[0].kind, 'offered'); assert.deepEqual(result.carries[0].target, { hostId: 'host', conversationId: 'ordinary-carry-target' });
  assert.equal(result.text, 'Ordinary carry stays owned');
});

test('automatic first-draft preparation checks its guard inside the write transaction', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const scope = { hostId: 'host', conversationId: 'transaction-guard' }, S = globalThis.BrowserViewStorage;
    let current = true, reserved = false, intercepted = false, launched = 0, cancelled = 0;
    const original = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(key) {
      const request = original.call(this, key);
      if (reserved && Array.isArray(key) && key[0] === 'editor-binding' && key[2] === scope.conversationId) request.addEventListener('success', () => { intercepted = true; current = false; }, { once: true });
      return request;
    };
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return { kind: 'absent' };
      if (command.kind === 'reserve') { reserved = true; return { scope, viewId: command.viewId, label: 'transaction-child', transitionId: 'transaction-move', creationAgentId: 'agent', phase: 'requested', bindingRevision: null, writerGeneration: null }; }
      if (command.kind === 'cancel-reservation') { reserved = false; cancelled++; return true; }
      if (command.kind === 'launch') { launched++; return { kind: 'pending', scope, reason: 'Unexpected launch' }; }
      throw new Error(command.kind);
    } });
    coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, () => current);
    const placed = await coordinator.withPlacementGuard(scope, () => current, () => coordinator.acquire({ scope, creation: true, agentId: 'agent', agentLabel: 'Agent', carryFrom: null, initialDraft: 'Must remain with its caller' },
      { storage: { viewId: 'catalog' }, holds: () => false, async quiesce() {}, async release() {} })).catch(globalThis.captureSupersession);
    IDBObjectStore.prototype.get = original;
    return { placed, intercepted, launched, cancelled, reserved, binding: (await S.locateEditor(scope)).binding };
  });
  assert.equal(result.intercepted, true); assert.equal(result.placed.superseded, true); assert.equal(result.launched, 0);
  assert.equal(result.binding, null); assert.equal(result.reserved, false); assert.equal(result.cancelled, 1);
});

for (const replacement of ['delivery', 'document']) test(`a superseded old placement cannot revoke a newer ${replacement} confirmation`, async t => {
  const page = await fixture(t), result = await page.evaluate(async replacement => {
    const makeState = generation => ({ version: 1, change: generation, selection: { revision: generation, deliveryGeneration: generation, selected: { kind: 'builtin' }, previousHealthy: { kind: 'builtin' } }, bundle: null, envelope: null, transitions: [], fault: null, display: null });
    const ui = new globalThis.UiConnection(), first = makeState(1); let release;
    const held = new Promise(resolve => { release = resolve; });
    ui.window = { role: 'main', hostId: 'host', profileId: 'profile', viewId: 'main-view', brokerInstance: 'broker', label: 'main', documentIncarnation: 'first' };
    ui.snapshot = { ...ui.getSnapshot(), state: first, localBuiltin: false, deliveryContext: 'first-document' };
    ui.post = async request => request.op === 'placement-reserve' ? held : {};
    await ui.rendered(first);
    const old = ui.reservePlacement({ envelope: { requestId: '1:22222222-2222-4222-8222-222222222222', deliveryGeneration: 1, selectionRevision: 1, digest: null }, slot: { transitionId: 'old-slot', target: null } }, { scope: { hostId: 'host', conversationId: 'chat' }, viewId: 'chat-view', label: 'chat', nativeTransitionId: 'move', bindingRevision: 1 });
    const next = replacement === 'delivery' ? makeState(2) : first;
    if (replacement === 'document') ui.window = { role: 'main', hostId: 'host', profileId: 'profile', viewId: 'main-view', brokerInstance: 'broker', label: 'main', documentIncarnation: 'second' };
    ui.snapshot = { ...ui.getSnapshot(), state: next, deliveryContext: replacement === 'document' ? 'second-document' : 'first-document' };
    await ui.rendered(next);
    release({ receipt: null, outcome: 'superseded' }); await old.catch(() => {});
    const confirmed = ui.getSnapshot().confirmedGeneration; await ui.rendered(next);
    const afterRepaint = ui.getSnapshot().confirmedGeneration; ui.close(); return { confirmed, afterRepaint, expected: next.selection.deliveryGeneration };
  }, replacement);
  assert.equal(result.confirmed, result.expected); assert.equal(result.afterRepaint, result.expected);
});

test('supersession of the current delivery clears its cached confirmation key for a new paint', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const state = { version: 1, change: 1, selection: { revision: 1, deliveryGeneration: 1, selected: { kind: 'builtin' }, previousHealthy: { kind: 'builtin' } }, bundle: null, envelope: null, transitions: [], fault: null, display: null };
    const ui = new globalThis.UiConnection(); let paints = 0;
    ui.window = { role: 'main', hostId: 'host', profileId: 'profile', viewId: 'main-view', brokerInstance: 'broker', label: 'main', documentIncarnation: 'main' }; ui.snapshot = { ...ui.getSnapshot(), state, localBuiltin: false, deliveryContext: 'main' };
    ui.post = async request => { if (request.op === 'paint') paints++; return request.op === 'placement-reserve' ? { receipt: null, outcome: 'superseded' } : {}; };
    await ui.rendered(state);
    await ui.reservePlacement({ envelope: { requestId: '1:33333333-3333-4333-8333-333333333333', deliveryGeneration: 1, selectionRevision: 1, digest: null }, slot: { transitionId: 'same-slot', target: null } }, { scope: { hostId: 'host', conversationId: 'chat' }, viewId: 'chat-view', label: 'chat', nativeTransitionId: 'move', bindingRevision: 1 }).catch(() => {});
    const invalidated = ui.getSnapshot().confirmedGeneration; await ui.rendered(state); const confirmed = ui.getSnapshot().confirmedGeneration;
    ui.close(); return { paints, invalidated, confirmed };
  });
  assert.equal(result.invalidated, null); assert.equal(result.paints, 2); assert.equal(result.confirmed, 1);
});

for (const withReceipt of [false, true]) test(`a pre-rejection paint reply cannot confirm the same snapshot after re-rendering it (receipt ${withReceipt})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async withReceipt => {
    const envelope = withReceipt ? { requestId: '1:44444444-4444-4444-8444-444444444444', deliveryGeneration: 0, selectionRevision: 0, digest: null } : null;
    const state = { version: 1, change: 1, selection: { revision: 0, deliveryGeneration: 0, selected: { kind: 'builtin' }, previousHealthy: { kind: 'builtin' } }, bundle: null, envelope, transitions: [], fault: null, display: null };
    const ui = new globalThis.UiConnection(), acknowledgements = []; let release, entered, paints = 0;
    const held = new Promise(resolve => { release = resolve; }), reporting = new Promise(resolve => { entered = resolve; });
    ui.window = { role: 'main', hostId: 'host', profileId: 'profile', viewId: 'main-view', brokerInstance: 'broker', label: 'main', documentIncarnation: 'main' }; ui.snapshot = { ...ui.getSnapshot(), state, localBuiltin: false, deliveryContext: 'main' };
    ui.post = async request => {
      if (request.op === 'paint') { if (paints++ === 0) { entered(); await held; } else throw new Error('Replacement paint reply lost'); }
      else acknowledgements.push(request.result.kind);
      return {};
    };
    const first = ui.rendered(state); await reporting; await ui.failed(state, 'Rejected essential control');
    await ui.rendered(state).catch(() => {}); release(); await first;
    const confirmed = ui.getSnapshot().confirmedGeneration; ui.close(); return { acknowledgements, confirmed };
  }, withReceipt);
  assert.deepEqual(result.acknowledgements, withReceipt ? ['failed'] : []); assert.equal(result.confirmed, null);
});

test('a superseded rollover restores the closed native record after the editor reopened inline', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const scope = { hostId: 'host', conversationId: 'closed-inline-rollover' }, S = globalThis.BrowserViewStorage;
    const old = await S.claimEditor({ scope, viewId: 'rollover-view', label: 'old-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const drafts = old.drafts(() => {}); await drafts.load(scope);
    await drafts.save({ version: 3, scope, draft: 'Keep the inline editor', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    const binding = old.editorBinding(); await old.close();
    const previous = { scope, viewId: 'rollover-view', label: 'old-child', transitionId: crypto.randomUUID(), creationAgentId: null, phase: 'target-ready', bindingRevision: binding.revision, writerGeneration: binding.writerGeneration };
    let saved = previous, current = true, cancelled = null;
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return { kind: 'closed', reservation: saved };
      if (command.kind === 'reserve') {
        if (!command.newTransition) throw new Error('Reopened editing binding must restart the closed native transition');
        saved = { ...previous, phase: 'requested', transitionId: crypto.randomUUID() }; current = false; return saved;
      }
      if (command.kind === 'cancel-reservation') { cancelled = command; if (JSON.stringify(command.previous) !== JSON.stringify(previous)) throw new Error('Historical native record changed'); saved = previous; return true; }
      throw new Error(command.kind);
    } });
    const catalog = await S.reopen('rollover-catalog', () => {});
    const request = { scope, creation: false, agentId: 'agent', agentLabel: 'Agent', carryFrom: null, initialDraft: null };
    const opened = await coordinator.acquire(request, { storage: catalog, holds: () => false, async quiesce() {}, async release() {} });
    if (opened.kind !== 'inline' || opened.view.kind !== 'acquired') throw new Error('Closed child did not reopen inline');
    const inline = opened.view.storage;
    coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, () => current);
    const placed = await coordinator.withPlacementGuard(scope, () => current, () => coordinator.acquire(request,
      { storage: inline, holds: id => id === inline.viewId, async quiesce() { throw new Error('Superseded source must remain editable'); }, async release() { throw new Error('Superseded source must remain owned'); } })).catch(globalThis.captureSupersession);
    const after = (await S.locateEditor(scope)).binding, text = (await inline.drafts(() => {}).load(scope)).draft;
    await inline.close(); await catalog.close(); return { placed, saved, previous, after, text, cancelled };
  });
  assert.equal(result.placed.superseded, true); assert.deepEqual(result.saved, result.previous);
  assert.equal(result.cancelled.previous.transitionId, result.previous.transitionId);
  assert.equal(result.after.kind, 'editing'); assert.equal(result.after.targetLabel, undefined); assert.equal(result.text, 'Keep the inline editor');
});

for (const firstReadFails of [false, true]) test(`a lost older retry reply reconciles the exact result (first read fails ${firstReadFails})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async firstReadFails => {
    const scope = { hostId: 'host', conversationId: 'retry-reply-source' }, target = { hostId: 'host', conversationId: 'retry-reply-target' };
    const old = { sourceScope: scope, requestId: '1:older-lost-reply', action: { kind: 'create', agentId: 'agent', carry: false }, target: null, result: { kind: 'refused', reason: 'Old refusal' } };
    const terminal = { ...old, result: { kind: 'inline', scope: target } }; let reads = 0, retries = 0, saved = old;
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat', reservation: { scope } }, historyEpoch: 1,
      requestHistory: new Map([[old.requestId, old]]), historyAfter: 'older-page', historyExtended: true, pendingIntents: new Map(), pendingIntent: null,
      snapshot: { recovery: { kind: 'chat', pending: [], history: [old], after: 'older-page', carries: [] } }, listeners: new Set(), controller: { settlePlacement() {} },
      port: { async request(command) {
        if (command.kind === 'retry-intent') { retries++; saved = terminal; throw new Error('Native retry reply lost'); }
        if (command.kind === 'read-intent') { if (command.requestId !== old.requestId) throw new Error('Read the exact request'); if (reads++ === 0 && firstReadFails) throw new Error('First status read lost'); return saved; }
        if (command.kind === 'own-intents') return { epoch: 1, pending: [], items: [], after: 'first-page' };
        throw new Error(command.kind);
      } } });
    await runtime.retryIntent(old); await runtime.refreshRecovery();
    return { retries, reads, recovery: runtime.snapshot.recovery };
  }, firstReadFails);
  assert.equal(result.retries, 1); assert.equal(result.reads, firstReadFails ? 2 : 1);
  assert.deepEqual(result.recovery.history.map(item => item.result), [{ kind: 'inline', scope: { hostId: 'host', conversationId: 'retry-reply-target' } }]);
  assert.deepEqual(result.recovery.pending, []);
});


test('cleanup failure after a committed handoff preserves its native reservation and saved target', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const scope = { hostId: 'host', conversationId: 'committed-release-failure' }, S = globalThis.BrowserViewStorage;
    const source = await S.claimEditor({ scope, viewId: 'committed-release-view', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const drafts = source.drafts(() => {}); await drafts.load(scope);
    await drafts.save({ version: 3, scope, draft: 'Keep committed target after cleanup failure', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    const reservation = { scope, viewId: source.viewId, label: 'committed-release-child', transitionId: crypto.randomUUID().replaceAll('-', ''), creationAgentId: null, phase: 'requested', bindingRevision: null, writerGeneration: null };
    let reserved = false, cancelled = 0;
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return { kind: 'absent' };
      if (command.kind === 'reserve') { reserved = true; return reservation; }
      if (command.kind === 'cancel-reservation') { cancelled++; reserved = false; return true; }
      throw new Error(command.kind);
    } });
    coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const placed = await coordinator.acquire({ scope, creation: false, agentId: 'agent', agentLabel: 'Agent', carryFrom: null, initialDraft: null },
      { storage: source, holds: id => id === source.viewId, async quiesce() {}, async release() { await source.close(); throw new Error('Owner cleanup failed after commit'); } });
    const binding = (await S.locateEditor(scope)).binding;
    const target = await S.claimEditor({ scope, viewId: reservation.viewId, label: reservation.label, transitionId: reservation.transitionId, creation: null }, () => {});
    const text = (await target.drafts(() => {}).load(scope)).draft; await target.close();
    return { placed, binding, text, reserved, cancelled, transitionId: reservation.transitionId };
  });
  assert.equal(result.placed.kind, 'refused'); assert.match(result.placed.reason, /cleanup failed/);
  assert.equal(result.reserved, true); assert.equal(result.cancelled, 0);
  assert.equal(result.binding.kind, 'handoff-reserved'); assert.equal(result.binding.transitionId, result.transitionId);
  assert.equal(result.text, 'Keep committed target after cleanup failure');
});

test('a failed read-only carry lookup restores the untouched terminal reservation and slot', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const from = { hostId: 'host', conversationId: 'read-only-carry-source' }, scope = { hostId: 'host', conversationId: 'read-only-carry-target' }, S = globalThis.BrowserViewStorage;
    const records = (scope, text) => ({ version: 3, scope, draft: text, draftRevision: 1, outbox: [], frontendSends: [], image: null });
    const source = await S.claimEditor({ scope: from, viewId: 'read-only-carry-source', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    await source.saveView(from.hostId, { version: 2, route: from, pendingCreation: null });
    const a = source.drafts(() => {}); await a.load(from); await a.save(records(from, 'Source remains untouched'));
    const old = await S.claimEditor({ scope, viewId: 'read-only-carry-target', label: 'old-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    await old.saveView(scope.hostId, { version: 2, route: scope, pendingCreation: null });
    const b = old.drafts(() => {}); await b.load(scope); await b.save(records(scope, 'Target stays inline'));
    const oldBinding = old.editorBinding(); await old.close();
    const prior = { scope, viewId: old.viewId, label: 'old-child', transitionId: crypto.randomUUID().replaceAll('-', ''), creationAgentId: null, phase: 'target-ready', bindingRevision: oldBinding.revision, writerGeneration: oldBinding.writerGeneration };
    let saved = prior, reserved = false, aborted = false, captures = 0, cancelled = 0;
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return { kind: 'closed', reservation: saved };
      if (command.kind === 'reserve') { saved = { ...prior, phase: 'requested', transitionId: crypto.randomUUID().replaceAll('-', '') }; reserved = true; return saved; }
      if (command.kind === 'cancel-reservation') { cancelled++; saved = command.previous; reserved = false; return true; }
      throw new Error(command.kind);
    } });
    const catalog = await S.reopen('read-only-carry-catalog', () => {});
    const base = { scope, creation: false, agentId: 'agent', agentLabel: 'Agent', carryFrom: null, initialDraft: null };
    const inline = await coordinator.acquire(base, { storage: catalog, holds: () => false, async quiesce() {}, async release() {} });
    if (inline.kind !== 'inline' || inline.view.kind !== 'acquired') throw new Error('Target did not reopen inline');
    const target = inline.view.storage, original = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(key) {
      const request = original.call(this, key);
      if (reserved && !aborted && Array.isArray(key) && key[0] === 'draft-carry-kept') { aborted = true; request.transaction.abort(); }
      return request;
    };
    coordinator.captureCarry(async () => { captures++; throw new Error('Capture must not start after failed lookup'); });
    coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const placed = await coordinator.acquire({ ...base, carryFrom: from }, { storage: target, holds: id => id === target.viewId, async quiesce() { throw new Error('Target must stay editable'); }, async release() { throw new Error('Target must stay owned'); } });
    IDBObjectStore.prototype.get = original;
    const carries = await globalThis.carries.sourceCarries(from), text = (await target.drafts(() => {}).load(scope)).draft, sourceText = (await a.load(from)).draft;
    await Promise.all([target.close(), source.close(), catalog.close()]);
    return { placed, aborted, captures, cancelled, carries, text, sourceText, saved, prior, occupiedSlots: saved.phase === 'requested' ? 32 : 31 };
  });
  assert.equal(result.placed.kind, 'refused'); assert.equal(result.aborted, true); assert.equal(result.captures, 0);
  assert.equal(result.cancelled, 1); assert.deepEqual(result.saved, result.prior); assert.equal(result.occupiedSlots, 31);
  assert.deepEqual(result.carries, []); assert.equal(result.text, 'Target stays inline'); assert.equal(result.sourceText, 'Source remains untouched');
});

for (const stage of ['existing-offered', 'existing-applied', 'new-offer', 'new-offer-bind-fails', 'new-offer-bind-fails-rollover', 'new-offer-bind-and-cancel-fail']) test(`a carry failure preserves live dependencies and compensates a cancelled offer (${stage})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async stage => {
    const from = { hostId: 'host', conversationId: 'dependent-source' }, scope = { hostId: 'host', conversationId: 'dependent-target' }, S = globalThis.BrowserViewStorage, c = globalThis.carries;
    const records = (scope, text) => ({ version: 3, scope, draft: text, draftRevision: 1, outbox: [], frontendSends: [], image: null });
    const source = await S.claimEditor({ scope: from, viewId: 'dependent-source', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const target = await S.claimEditor({ scope, viewId: 'dependent-target', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    for (const [owner, route] of [[source, from], [target, scope]]) await owner.saveView(route.hostId, { version: 2, route, pendingCreation: null });
    const a = source.drafts(() => {}), b = target.drafts(() => {}); await a.load(from); await b.load(scope);
    await a.save(records(from, 'Captured source text')); await b.save(records(scope, 'Target text'));
    const transitionId = crypto.randomUUID().replaceAll('-', ''), requestId = `1:main-${transitionId}`;
    const offer = () => c.offerDraftCarry({ source: from, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected: { text: 'Captured source text', revision: 1 } });
    if (stage.startsWith('existing-')) { await offer(); await c.bindDraftCarry(from, requestId, scope); }
    if (stage === 'existing-applied') {
      const prior = await b.load(scope);
      if (!await b.commitTransfer({ ...prior, draft: 'Captured source text\n\nTarget text', draftRevision: 2 }, { source: from, requestId, outcome: 'received' })) throw new Error('Destination did not apply carry');
    }
    const rollover = stage === 'new-offer-bind-fails-rollover', bindFails = stage.includes('bind-');
    const prior = { scope, viewId: target.viewId, label: 'dependent-child', transitionId: crypto.randomUUID().replaceAll('-', ''), creationAgentId: null, phase: 'target-ready', bindingRevision: target.editorBinding().revision, writerGeneration: target.editorBinding().writerGeneration };
    let saved = rollover ? prior : null, reserved = false, cancelled = null, captured = false, bindAborted = false, cancelAborted = false;
    const original = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(key) {
      const request = original.call(this, key);
      if (bindFails && captured && Array.isArray(key) && key[0] === 'draft-carry' && key[3] === requestId) {
        if (!bindAborted) { bindAborted = true; request.transaction.abort(); }
        else if (stage === 'new-offer-bind-and-cancel-fail' && !cancelAborted) { cancelAborted = true; request.transaction.abort(); }
      }
      return request;
    };
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return saved ? { kind: 'closed', reservation: saved } : { kind: 'absent' };
      if (command.kind === 'reserve') { reserved = true; saved = { scope, viewId: target.viewId, label: 'dependent-child', transitionId, creationAgentId: null, phase: 'requested', bindingRevision: rollover ? prior.bindingRevision : null, writerGeneration: rollover ? prior.writerGeneration : null }; return saved; }
      if (command.kind === 'intent-context') return { epoch: 1, pendingCarryRequests: [] };
      if (command.kind === 'cancel-reservation') {
        if (command.transitionId !== saved?.transitionId || JSON.stringify(command.scope) !== JSON.stringify(scope) || JSON.stringify(command.previous ?? null) !== JSON.stringify(rollover ? prior : null)) throw new Error('Compensation did not identify the exact untouched reservation');
        reserved = false; cancelled = command; saved = command.previous ?? null; return true;
      }
      throw new Error(command.kind);
    } });
    coordinator.captureCarry(async () => { await offer(); captured = true; return { async cancel() { const carry = (await c.sourceCarries(from)).find(carry => carry.requestId === requestId); await c.refuseDraftCarry(carry); } }; });
    coordinator.trackPlacement(async () => { throw new Error('Tracking unavailable after durable carry'); });
    coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const placed = await coordinator.acquire({ scope, creation: false, agentId: 'agent', agentLabel: 'Agent', carryFrom: from, initialDraft: null }, { storage: target, holds: id => id === target.viewId, async quiesce() { throw new Error('No editor handoff after tracking failure'); }, async release() {} });
    IDBObjectStore.prototype.get = original;
    const [carry] = await c.sourceCarries(from), sourceText = (await a.load(from)).draft;
    await Promise.all([source.close(), target.close()]); return { placed, reserved, cancelled, carry, sourceText, bindAborted, cancelAborted, saved, prior, transitionId };
  }, stage);
  const compensated = stage === 'new-offer-bind-fails' || stage === 'new-offer-bind-fails-rollover';
  assert.equal(result.placed.kind, 'refused'); assert.equal(result.reserved, !compensated);
  if (compensated) {
    assert.equal(result.cancelled.transitionId, result.transitionId);
    assert.deepEqual(result.saved, stage.endsWith('rollover') ? result.prior : null);
  } else { assert.equal(result.cancelled, null); assert.equal(result.saved.phase, 'requested'); }
  assert.equal(result.carry.kind, stage === 'existing-applied' ? 'applied' : compensated ? 'refused' : 'offered');
  assert.equal(result.carry.expected.text, 'Captured source text'); assert.equal(result.sourceText, 'Captured source text');
  if (stage.includes('bind-')) { assert.equal(result.bindAborted, true); assert.equal(result.carry.target, null); }
  else assert.deepEqual(result.carry.target, { hostId: 'host', conversationId: 'dependent-target' });
  assert.equal(result.cancelAborted, stage === 'new-offer-bind-and-cancel-fail');
});

test('an unchanged refusal after a failed retry preserves status and shows the specific retry error', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const scope = { hostId: 'host', conversationId: 'retry-rejected-before-effect' };
    const old = { sourceScope: scope, requestId: '1:unchanged-refusal', action: { kind: 'create', agentId: 'agent', carry: false }, target: null, result: { kind: 'refused', reason: 'Original refusal' } };
    let reads = 0, retries = 0;
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat', reservation: { scope } }, historyEpoch: 1, requestHistory: new Map([[old.requestId, old]]), historyAfter: 'older-page', historyExtended: true, pendingIntents: new Map(), pendingIntent: null,
      snapshot: { placementNotice: null, recovery: { kind: 'chat', pending: [], history: [old], after: 'older-page', carries: [] } }, listeners: new Set(), controller: { settlePlacement() {} },
      port: { async request(command) {
        if (command.kind === 'retry-intent') { retries++; throw new Error('native-intent-capacity'); }
        if (command.kind === 'read-intent') { reads++; if (command.requestId !== old.requestId) throw new Error('Wrong request'); return old; }
        if (command.kind === 'own-intents') return { epoch: 1, pending: [], items: [], after: 'first-page' };
        throw new Error(command.kind);
      } } });
    await runtime.retryIntent(old);
    const first = runtime.snapshot, stillRecheckable = runtime.requestHistory.get(old.requestId).result === null;
    await runtime.refreshRecovery(); return { first, after: runtime.snapshot, stillRecheckable, reads, retries };
  });
  assert.match(result.first.placementNotice, /Retry.*native-intent-capacity/);
  assert.deepEqual(result.first.recovery.history.map(item => item.result), [{ kind: 'refused', reason: 'Original refusal' }]);
  assert.equal(result.stillRecheckable, true); assert.equal(result.reads, 2); assert.equal(result.retries, 1);
  assert.deepEqual(result.after.recovery.history, result.first.recovery.history); assert.deepEqual(result.after.recovery.pending, []);
});


for (const outcome of ['unchanged-refusal', 'pending-lost-reply', 'completed-lost-reply', 'foreign-source', 'foreign-request']) test(`a carry retry reconciles a lost native response without exposing a refused offer (${outcome})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async outcome => {
    const scope = { hostId: 'host', conversationId: 'rejected-carry-source' }, targetScope = { hostId: 'host', conversationId: 'rejected-carry-target' }, foreignScope = { hostId: 'host', conversationId: 'foreign-carry-source' };
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, text = 'The source text remains saved';
    const source = await S.claimEditor({ scope, viewId: 'rejected-carry-view', label: 'source-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    await source.saveView(scope.hostId, { version: 2, route: scope, pendingCreation: null });
    const drafts = source.drafts(() => {}); await drafts.load(scope);
    await drafts.save({ version: 3, scope, draft: text, draftRevision: 1, outbox: [], frontendSends: [], image: null });
    const requestId = '1:retry-bound-carry', binding = source.editorBinding();
    const offer = id => c.offerDraftCarry({ source: scope, sourceViewId: source.viewId, requestId: id, writerGeneration: binding.writerGeneration, expected: { text, revision: 1 } });
    await offer(requestId); await c.bindDraftCarry(scope, requestId, targetScope); await c.refuseDraftCarry((await c.sourceCarries(scope))[0]);
    const foreign = await S.claimEditor({ scope: foreignScope, viewId: 'foreign-carry-view', label: 'foreign-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    await c.offerDraftCarry({ source: foreignScope, sourceViewId: foreign.viewId, requestId, writerGeneration: foreign.editorBinding().writerGeneration, expected: { text: 'Foreign snapshot', revision: 1 } });
    await c.bindDraftCarry(foreignScope, requestId, { hostId: 'host', conversationId: 'foreign-carry-target' });
    const target = { scope: targetScope, viewId: 'target-view', label: 'target-child', transitionId: 'target-transition', creationAgentId: null, phase: 'target-ready', bindingRevision: 1, writerGeneration: 1 };
    const old = { sourceScope: scope, requestId, action: { kind: 'open', scope: targetScope, carry: true }, target, result: { kind: 'refused', reason: 'Original refusal' } };
    let reads = 0, retries = 0;
    const recovered = outcome === 'pending-lost-reply' ? { ...old, result: null } : outcome === 'completed-lost-reply' ? { ...old, result: { kind: 'inline', scope: targetScope } } : outcome === 'foreign-source' ? { ...old, sourceScope: foreignScope } : outcome === 'foreign-request' ? { ...old, requestId: '1:foreign-request' } : old;
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { childOwner: source, context: { role: 'chat', reservation: { scope } }, historyEpoch: 1,
      requestHistory: new Map([[requestId, old]]), historyAfter: 'older-page', historyExtended: true, pendingIntents: new Map(), pendingIntent: null,
      snapshot: { placementNotice: null, recovery: { kind: 'chat', pending: [], history: [old], after: 'older-page', carries: [] } }, listeners: new Set(), controller: { settlePlacement() {} },
      port: { async request(command) {
        if (command.kind === 'retry-intent') { retries++; if (outcome === 'completed-lost-reply') await c.bindDraftCarry(scope, requestId, targetScope); throw new Error('native-intent-capacity'); }
        if (command.kind === 'read-intent') { reads++; if (command.requestId !== requestId) throw new Error('Wrong exact request'); return recovered; }
        if (command.kind === 'own-intents') return { epoch: 1, pending: recovered.result === null ? [recovered] : [], items: [], after: 'first-page' };
        throw new Error(command.kind);
      } } });
    await runtime.retryIntent(old);
    // Inspect durable state before a manual refresh or a target carry consumer runs.
    const carry = (await c.sourceCarries(scope))[0], targetCarries = await c.targetCarries(targetScope), foreignCarry = (await c.sourceCarries(foreignScope))[0], sourceText = (await drafts.load(scope)).draft;
    let nextOffer = null;
    if (outcome === 'unchanged-refusal') { try { await offer('1:next-carry'); nextOffer = 'offered'; } catch (error) { nextOffer = String(error); } }
    await Promise.all([source.close(), foreign.close()]);
    return { carry, targetCarries, foreignCarry, sourceText, nextOffer, reads, retries, snapshot: runtime.snapshot };
  }, outcome);
  assert.equal(result.reads, outcome === 'completed-lost-reply' ? 2 : 1); assert.equal(result.retries, 1); assert.equal(result.sourceText, 'The source text remains saved');
  assert.equal(result.foreignCarry.kind, 'offered'); assert.equal(result.foreignCarry.expected.text, 'Foreign snapshot');
  assert.equal(result.carry.kind, outcome === 'unchanged-refusal' ? 'refused' : 'offered');
  assert.equal(result.targetCarries.length, outcome === 'completed-lost-reply' ? 1 : 0);
  if (outcome === 'unchanged-refusal') { assert.match(result.snapshot.placementNotice, /Retry.*native-intent-capacity/); assert.equal(result.nextOffer, 'offered'); }
  else if (outcome.startsWith('foreign-')) assert.match(result.snapshot.placementNotice, /identity mismatch/);
  else { assert.equal(result.snapshot.placementNotice, null); assert.equal(result.snapshot.recovery.pending.length, outcome === 'pending-lost-reply' ? 1 : 0); }
});


for (const outcome of ['refused-bound', 'pending-bound', 'pending-lost-reply-bound', 'completed-lost-reply-bound', 'pending-lost-read-bound', 'pending-unbound', 'same-target-replay']) test(`native admission gates retried draft delivery while the destination synchronizes (${outcome})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async outcome => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries;
    const scope = { hostId: 'host', conversationId: 'admission-source' }, targetScope = { hostId: 'host', conversationId: 'admission-target' };
    const source = await S.claimEditor({ scope, viewId: 'admission-source-view', label: 'source-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const target = await S.claimEditor({ scope: targetScope, viewId: 'admission-target-view', label: 'target-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const makeStore = (owner, scope) => globalThis.createConversationStore({ scope, port: { scope }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}) });
    const a = makeStore(source, scope), b = makeStore(target, targetScope); await Promise.all([a.ready, b.ready]);
    await a.setDraft('Original source text'); await b.setDraft('Original destination text');
    const requestId = '1:admission-carry', binding = source.editorBinding(), expected = await a.captureDraft();
    await c.offerDraftCarry({ source: scope, sourceViewId: source.viewId, requestId, writerGeneration: binding.writerGeneration, expected });
    const reservation = { scope: targetScope, viewId: target.viewId, label: 'target-child', transitionId: 'admitted-target-transition', creationAgentId: null, phase: 'source-released', bindingRevision: target.editorBinding().revision, writerGeneration: target.editorBinding().writerGeneration };
    if (outcome !== 'pending-unbound') await c.bindDraftCarry(scope, requestId, targetScope);
    await c.refuseDraftCarry((await c.sourceCarries(scope))[0]);
    const old = { sourceScope: scope, requestId, action: { kind: 'open', scope: targetScope, carry: true }, target: outcome === 'pending-unbound' ? null : { ...reservation, phase: 'assigned' }, result: { kind: 'refused', reason: 'Prior refusal' } };
    let saved = old, entered, release, writes = 0, completes = 0, opens = 0, assigns = 0, lostRead = false;
    const admitted = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
    const destination = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat', reservation: { scope: targetScope } }, port: null,
      controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope: targetScope, viewId: target.viewId, store: b } }) } });
    const main = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, snapshot: { placementNotice: null }, listeners: new Set(),
      controller: {
        getSnapshot: () => ({ busy: false, host: { kind: 'ready', metadata: { hostId: 'host' } }, saved: { pendingCreation: null }, active: { scope: targetScope, viewId: target.viewId, store: b } }),
        async inspectConversation(found) { return { agent: { id: 'agent' }, continuation: { successor: found.conversationId === scope.conversationId ? { kind: 'confirmed', scope: targetScope } : null } }; },
        async openReserved(found) { if (found.conversationId !== targetScope.conversationId) throw new Error('Wrong admitted target'); opens++; return outcome.startsWith('completed-') ? { kind: 'inline', scope: targetScope } : { kind: 'pending', scope: targetScope, reason: 'Existing target is opening' }; },
        async settleCarriedDraft(carry) { await a.transferDraft(carry.expected, '', { kind: 'release', source: carry.source, requestId: carry.requestId }); }
      }, port: { async request(command) {
        if (command.kind === 'read-intent') return saved;
        if (command.kind === 'lookup') return { kind: 'opening', reservation };
        if (command.kind === 'assign-intent') { assigns++; saved = { ...saved, target: reservation }; return saved; }
        if (command.kind === 'complete-intent') { completes++; saved = { ...saved, result: command.result }; return { ok: true }; }
        if (command.kind === 'carry-applied') return { ok: true };
        throw new Error(command.kind);
      } } });
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { childOwner: source, context: { role: 'chat', reservation: { scope } }, historyEpoch: 1,
      requestHistory: new Map([[requestId, old]]), historyAfter: null, historyExtended: false, pendingIntents: new Map(), pendingIntent: null,
      snapshot: { placementNotice: null, recovery: { kind: 'chat', pending: [], history: [old], after: null, carries: [] } }, listeners: new Set(),
      controller: { settlePlacement() {}, getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope, viewId: source.viewId, store: a } }) },
      port: { async request(command) {
        if (command.kind === 'retry-intent') {
          writes++; entered(); await held;
          if (outcome.startsWith('refused-')) throw new Error('native-intent-capacity');
          // Profile.retry_intent preserves target and clears only result after admission.
          saved = { ...old, result: null };
          if (outcome !== 'pending-lost-read-bound') await main.processIntent(saved);
          if (outcome.includes('lost-reply') || outcome === 'pending-lost-read-bound') throw new Error('Admitted reply lost');
          return saved;
        }
        if (command.kind === 'read-intent') { if (outcome === 'pending-lost-read-bound' && !lostRead) { lostRead = true; throw new Error('Accepted status reply lost'); } return saved; }
        if (command.kind === 'own-intents') return { epoch: 1, pending: saved.result === null ? [saved] : [], items: saved.result === null ? [] : [saved], after: null };
        if (command.kind === 'carry-applied') return { ok: true };
        throw new Error(command.kind);
      } } });
    const retry = runtime.retryIntent(old);
    await Promise.race([admitted, retry.then(() => { throw new Error(`Retry ended before native admission: ${runtime.snapshot.placementNotice ?? 'no admission reached'}`); })]);
    // Run the actual live target receive and source release consumers while native admission is held.
    await destination.syncDraftCarries(); await runtime.syncDraftCarries();
    const during = { source: (await a.captureDraft()).text, target: (await b.captureDraft()).text, indexed: (await c.targetCarries(targetScope)).length, carry: (await c.sourceCarries(scope))[0] };
    release(); await retry;
    if (outcome === 'pending-lost-read-bound') { await main.processIntent(saved); await runtime.refreshRecovery(); }
    if (outcome === 'same-target-replay') await main.processIntent(saved);
    await destination.syncDraftCarries(); await runtime.syncDraftCarries();
    if (outcome === 'same-target-replay') { await main.processIntent(saved); await destination.syncDraftCarries(); await runtime.syncDraftCarries(); }
    const after = { source: (await a.captureDraft()).text, target: (await b.captureDraft()).text, indexed: (await c.targetCarries(targetScope)).length, carry: (await c.sourceCarries(scope))[0], notice: runtime.snapshot.placementNotice };
    let next = null;
    if (outcome.startsWith('refused-')) { await c.offerDraftCarry({ source: scope, sourceViewId: source.viewId, requestId: '1:after-failed-admission', writerGeneration: binding.writerGeneration, expected }); next = 'offered'; }
    await Promise.all([a.dispose(), b.dispose()]); await Promise.all([source.close(), target.close()]);
    return { during, after, next, writes, completes, opens, assigns };
  }, outcome);
  assert.equal(result.during.source, 'Original source text'); assert.equal(result.during.target, 'Original destination text'); assert.equal(result.during.indexed, 0); assert.equal(result.during.carry.target, null);
  assert.equal(result.writes, 1);
  if (outcome.startsWith('refused-')) {
    assert.equal(result.after.source, 'Original source text'); assert.equal(result.after.target, 'Original destination text'); assert.equal(result.after.carry.kind, 'refused'); assert.equal(result.after.indexed, 0);
    assert.match(result.after.notice, /native-intent-capacity/); assert.equal(result.next, 'offered'); assert.equal(result.opens, 0);
  } else {
    assert.equal(result.after.source, ''); assert.equal(result.after.target, 'Original source text\n\nOriginal destination text'); assert.equal(result.after.carry.kind, 'settled'); assert.equal(result.after.indexed, 0);
    if (outcome === 'pending-lost-read-bound') assert.match(result.after.notice, /Admitted reply lost/); else assert.equal(result.after.notice, null);
    assert.equal(result.assigns, outcome === 'pending-unbound' ? 1 : 0); assert.equal(result.completes, outcome.startsWith('completed-') ? 1 : 0);
  }
});


for (const mode of ['inline', 'separate']) for (const outcome of ['admitted', 'lost-completion-reply', 'kept', 'missing', 'applied', 'unadmitted']) test(`manual ${mode} recovery publishes only its admitted carry before completing placement (${outcome})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async ({ mode, outcome }) => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'resume-source' }, targetScope = { hostId: 'host', conversationId: 'resume-target' };
    const source = await S.claimEditor({ scope, viewId: 'resume-source-view', label: 'source-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const target = await S.claimEditor({ scope: targetScope, viewId: 'resume-target-view', label: mode === 'inline' ? 'main' : 'target-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const makeStore = (owner, scope) => globalThis.createConversationStore({ scope, port: { scope }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}) });
    const a = makeStore(source, scope), b = makeStore(target, targetScope); await Promise.all([a.ready, b.ready]); await a.setDraft('Resume source text'); await b.setDraft('Resume destination text');
    const requestId = '1:resume-carry', binding = source.editorBinding(), expected = await a.captureDraft();
    if (outcome !== 'missing') {
      await c.offerDraftCarry({ source: scope, sourceViewId: source.viewId, requestId, writerGeneration: binding.writerGeneration, expected });
      await c.bindDraftCarry(scope, requestId, targetScope);
      if (outcome !== 'applied') await c.refuseDraftCarry((await c.sourceCarries(scope))[0]);
    }
    const reservation = { scope: targetScope, viewId: target.viewId, label: 'target-child', transitionId: 'resume-native-transition', creationAgentId: null, phase: 'failed', bindingRevision: target.editorBinding().revision, writerGeneration: target.editorBinding().writerGeneration };
    const old = { sourceScope: scope, requestId, action: { kind: 'open', scope: targetScope, carry: true }, target: { ...reservation, phase: 'assigned' }, result: outcome === 'applied' ? null : { kind: 'refused', reason: 'Resume prior refusal' } };
    let saved = old, entered, release, opens = 0, completions = 0, wakes = 0, restores = 0, lost = false, forced = null;
    const opening = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
    const destination = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat', reservation: { scope: targetScope } }, port: null,
      controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope: targetScope, viewId: target.viewId, store: b } }) } });
    if (outcome === 'applied') await destination.syncDraftCarries();
    const main = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, processing: false, snapshot: { placementNotice: null }, listeners: new Set(),
      ui: { async restore() { restores++; }, getSnapshot: () => ({ state: null }) }, refreshRecovery: async () => {},
      controller: { getSnapshot: () => ({ busy: false, host: { kind: 'ready', metadata: { hostId: 'host' } }, active: mode === 'inline' ? { scope: targetScope, viewId: target.viewId, store: b } : null }),
        async inspectConversation() { return { agent: { id: 'agent' } }; },
        async openReserved() { opens++; if (opens === 1) { entered(); await held; } return mode === 'inline' ? { kind: 'inline', scope: targetScope } : { kind: 'detached', scope: targetScope, label: 'target-child' }; },
        async refreshCatalog() {},
        async settleCarriedDraft(carry) { await a.transferDraft(carry.expected, '', { kind: 'release', source: carry.source, requestId: carry.requestId }); }
      }, port: { async request(command) {
        if (command.kind === 'recover-inline') return { scope: targetScope, viewId: target.viewId, nativeLabel: 'target-child', fromTransitionId: reservation.transitionId, transitionId: 'inline:resume-transition', targetLabel: 'main', creationAgentId: null };
        if (command.kind === 'phase') return { ok: true };
        if (command.kind === 'pending-intents') return saved.result === null ? [saved] : [];
        if (command.kind === 'complete-intent') { completions++; saved = { ...saved, result: command.result }; if (outcome === 'lost-completion-reply' && !lost) { lost = true; throw new Error('Completion reply lost'); } return { ok: true }; }
        if (command.kind === 'launch') { if (!command.existingOnly || mode !== 'separate' || command.scope.conversationId !== targetScope.conversationId) throw new Error('Recovery must only wake its existing separate target'); wakes++; return { kind: 'detached', scope: targetScope, label: 'target-child' }; }
        if (command.kind === 'carry-applied') return { ok: true };
        throw new Error(command.kind);
      } } });
    main.coordinator = new globalThis.WindowCoordinator(main.port);
    const placeExplicitly = main.coordinator.placeExplicitly.bind(main.coordinator);
    main.coordinator.placeExplicitly = (scope, mode, operation) => { forced = mode; return placeExplicitly(scope, mode, operation); };
    main.processIntent = async () => { throw new Error('Manual inline recovery must not rerun normal placement'); };
    const child = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { childOwner: source, context: { role: 'chat', reservation: { scope } }, historyEpoch: 1,
      requestHistory: new Map([[requestId, old]]), historyAfter: null, historyExtended: false, pendingIntents: new Map(), pendingIntent: null,
      snapshot: { placementNotice: null, recovery: { kind: 'chat', pending: [], history: [old], after: null, carries: [] } }, listeners: new Set(),
      controller: { settlePlacement() {}, getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope, viewId: source.viewId, store: a } }) },
      port: { async request(command) {
        if (command.kind === 'retry-intent') { if (outcome === 'unadmitted') throw new Error('native-intent-capacity'); saved = { ...old, result: null }; return saved; }
        if (command.kind === 'read-intent') return saved;
        if (command.kind === 'own-intents') return { epoch: 1, pending: saved.result === null ? [saved] : [], items: saved.result === null ? [] : [saved], after: null };
        if (command.kind === 'carry-applied') return { ok: true };
        throw new Error(command.kind);
      } } });
    const recovery = main.resumeWindow(reservation, mode === 'inline');
    await Promise.race([opening, recovery.then(() => { throw new Error(`Recovery ended before opening: ${main.snapshot.placementNotice ?? 'no opening reached'}`); })]);
    if (outcome !== 'applied') await child.retryIntent(old);
    if (outcome === 'kept') await c.cancelDraftCarry((await c.sourceCarries(scope))[0]);
    await destination.syncDraftCarries();
    const during = { source: (await a.captureDraft()).text, target: (await b.captureDraft()).text, processing: main.processing };
    release(); await recovery;
    const beforeTargetWake = { source: (await a.captureDraft()).text, carry: (await c.sourceCarries(scope))[0] ?? null };
    if (wakes) await destination.syncDraftCarries();
    await child.syncDraftCarries(); await child.refreshRecovery();
    await main.resumeWindow(reservation, mode === 'inline');
    if (wakes) await destination.syncDraftCarries();
    await child.syncDraftCarries();
    const after = { source: (await a.captureDraft()).text, target: (await b.captureDraft()).text, carries: await c.sourceCarries(scope), indexed: await c.targetCarries(targetScope), native: saved, child: child.snapshot, main: main.snapshot };
    await a.setDraft('Next source draft');
    await c.offerDraftCarry({ source: scope, sourceViewId: source.viewId, requestId: '1:resume-next', writerGeneration: binding.writerGeneration, expected: await a.captureDraft() });
    await Promise.all([a.dispose(), b.dispose()]); await Promise.all([source.close(), target.close()]);
    return { during, beforeTargetWake, after, forced, completions, wakes, restores, opens };
  }, { mode, outcome });
  assert.equal(result.forced, mode); assert.equal(result.during.processing, true);
  const copied = ['admitted', 'lost-completion-reply', 'applied'].includes(outcome);
  assert.equal(result.during.source, 'Resume source text');
  if (outcome !== 'applied') assert.equal(result.during.target, 'Resume destination text');
  assert.equal(result.after.source, copied ? '' : 'Resume source text');
  assert.equal(result.after.target, copied ? 'Resume source text\n\nResume destination text' : 'Resume destination text');
  assert.deepEqual(result.after.indexed, []); assert.equal(result.completions, outcome === 'unadmitted' ? 0 : 1);
  if (outcome === 'unadmitted') assert.equal(result.after.native.result.kind, 'refused'); else assert.equal(result.after.native.result.kind, mode === 'inline' ? 'inline' : 'detached');
  if (outcome !== 'missing') assert.equal(result.after.carries[0].kind, copied ? 'settled' : outcome === 'kept' ? 'cancelled' : 'refused');
  if (mode === 'separate' && outcome === 'admitted') { assert.equal(result.beforeTargetWake.source, 'Resume source text'); assert.equal(result.beforeTargetWake.carry.target.conversationId, 'resume-target'); assert.equal(result.wakes, 1); }
  if (mode === 'inline') { assert.equal(result.wakes, 0); assert.equal(result.restores, 2); }
});

for (const admitted of [false, true]) test(`a stale destination receive tolerates a retry awaiting native admission (${admitted})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async admitted => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, failures = [], scope = { hostId: 'host', conversationId: 'stale-source' }, targetScope = { hostId: 'host', conversationId: 'stale-target' };
    const source = await S.claimEditor({ scope, viewId: 'stale-source-view', label: 'source', transitionId: null, creation: { agentId: 'agent' } }, error => failures.push(error.message));
    const target = await S.claimEditor({ scope: targetScope, viewId: 'stale-target-view', label: 'target', transitionId: null, creation: { agentId: 'agent' } }, error => failures.push(error.message));
    const makeStore = (owner, scope) => globalThis.createConversationStore({ scope, port: { scope }, projection: globalThis.transcriptProjection, drafts: owner.drafts(error => failures.push(error.message)) });
    const a = makeStore(source, scope), b = makeStore(target, targetScope); await Promise.all([a.ready, b.ready]); await a.setDraft('Stale source text'); await b.setDraft('Stale target text');
    const requestId = '1:stale-retry', expected = await a.captureDraft();
    await c.offerDraftCarry({ source: scope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected }); await c.bindDraftCarry(scope, requestId, targetScope);
    const capture = b.captureDraft.bind(b); let entered, release, paused = true;
    const sampling = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
    b.captureDraft = async () => { if (paused) { paused = false; entered(); await held; } return capture(); };
    const destination = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat' }, port: null, controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope: targetScope, viewId: target.viewId, store: b } }) } });
    const receiving = destination.syncDraftCarries().then(() => null, error => String(error));
    await Promise.race([sampling, receiving.then(error => { throw new Error(`Destination synchronization ended before capture: ${error ?? 'no capture reached'}`); })]);
    await c.refuseDraftCarry((await c.sourceCarries(scope))[0]); await c.retryDraftCarry(scope, requestId, source.viewId, source.editorBinding().writerGeneration);
    release(); const staleError = await receiving;
    const during = { source: (await a.captureDraft()).text, target: (await capture()).text, carry: (await c.sourceCarries(scope))[0], failures: [...failures] };
    if (!staleError) {
      if (admitted) { await c.bindDraftCarry(scope, requestId, targetScope); await destination.syncDraftCarries(); }
      else await c.refuseDraftCarry((await c.sourceCarries(scope))[0]);
    }
    const sourceRuntime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat' }, port: null, controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope, viewId: source.viewId, store: a } }) } });
    if (!staleError) { await sourceRuntime.syncDraftCarries(); await destination.syncDraftCarries(); }
    const after = { source: (await a.captureDraft()).text, target: (await capture()).text, carry: (await c.sourceCarries(scope))[0], failures: [...failures] };
    await Promise.all([a.dispose().catch(() => {}), b.dispose().catch(() => {})]); await Promise.all([source.close(), target.close()]); return { staleError, during, after };
  }, admitted);
  assert.equal(result.staleError, null); assert.deepEqual(result.during.failures, []); assert.deepEqual(result.after.failures, []);
  assert.equal(result.during.source, 'Stale source text'); assert.equal(result.during.target, 'Stale target text'); assert.equal(result.during.carry.target, null);
  assert.equal(result.after.source, admitted ? '' : 'Stale source text'); assert.equal(result.after.target, admitted ? 'Stale source text\n\nStale target text' : 'Stale target text'); assert.equal(result.after.carry.kind, admitted ? 'settled' : 'refused');
});


test('a receive still rejects a carry bound to another destination', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, failures = [], scope = { hostId: 'host', conversationId: 'wrong-binding-source' }, targetScope = { hostId: 'host', conversationId: 'wrong-binding-target' }, other = { hostId: 'host', conversationId: 'different-bound-target' };
    const source = await S.claimEditor({ scope, viewId: 'wrong-binding-source-view', label: 'source', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const target = await S.claimEditor({ scope: targetScope, viewId: 'wrong-binding-target-view', label: 'target', transitionId: null, creation: { agentId: 'agent' } }, error => failures.push(error.message));
    const makeStore = (owner, scope) => globalThis.createConversationStore({ scope, port: { scope }, projection: globalThis.transcriptProjection, drafts: owner.drafts(error => failures.push(error.message)) });
    const a = makeStore(source, scope), b = makeStore(target, targetScope); await Promise.all([a.ready, b.ready]); await a.setDraft('Bound source text'); await b.setDraft('Bound target text');
    await c.offerDraftCarry({ source: scope, sourceViewId: source.viewId, requestId: '1:wrong-binding', writerGeneration: source.editorBinding().writerGeneration, expected: await a.captureDraft() }); await c.bindDraftCarry(scope, '1:wrong-binding', other);
    const rejected = await b.transferDraft(await b.captureDraft(), 'Bound source text\n\nBound target text', { kind: 'receive', source: scope, requestId: '1:wrong-binding' }).then(() => null, error => error.message);
    const carry = (await c.sourceCarries(scope))[0], sourceText = (await a.captureDraft()).text, targetText = b.getSnapshot().draft;
    await Promise.all([a.dispose().catch(() => {}), b.dispose().catch(() => {})]); await Promise.all([source.close(), target.close()]);
    return { rejected, carry, sourceText, targetText, failures };
  });
  assert.match(result.rejected, /does not match its destination/); assert.ok(result.failures.some(error => /does not match its destination/.test(error)));
  assert.equal(result.sourceText, 'Bound source text'); assert.equal(result.targetText, 'Bound target text'); assert.equal(result.carry.kind, 'offered'); assert.equal(result.carry.target.conversationId, 'different-bound-target');
});


for (const scenario of ['plain', 'wake-rejects', 'history-expired', 'intent-close', 'closed-before-wake', 'lost-completion', 'ready-before-assign', 'rolled-before-bind', 'assignment-lost-reply', 'bind-abort-after-success', 'rolled-failed-after-ready']) test(`a child closed after known detached recovery keeps its bound carry until an explicit catalog reopen (${scenario})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async scenario => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'closed-after-source' }, targetScope = { hostId: 'host', conversationId: 'closed-after-target' };
    const source = await S.claimEditor({ scope, viewId: 'closed-after-source-view', label: 'source-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    let target = await S.claimEditor({ scope: targetScope, viewId: 'closed-after-target-view', label: 'target-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const makeStore = (owner, scope) => globalThis.createConversationStore({ scope, port: { scope }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}) });
    const a = makeStore(source, scope); let b = makeStore(target, targetScope); await Promise.all([a.ready, b.ready]); await a.setDraft('Close-race source text'); await b.setDraft('Close-race destination text');
    const requestId = '1:close-after-success', expected = await a.captureDraft();
    await c.offerDraftCarry({ source: scope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected }); await c.bindDraftCarry(scope, requestId, targetScope);
    await c.refuseDraftCarry((await c.sourceCarries(scope))[0]); await c.retryDraftCarry(scope, requestId, source.viewId, source.editorBinding().writerGeneration);
    let native = { scope: targetScope, viewId: target.viewId, label: 'target-child', transitionId: 'known-detached-transition', creationAgentId: scenario === 'intent-close' ? 'agent' : null, phase: 'target-ready', bindingRevision: target.editorBinding().revision, writerGeneration: target.editorBinding().writerGeneration };
    let saved = { sourceScope: scope, requestId, action: scenario === 'intent-close' ? { kind: 'create', agentId: 'agent', carry: true } : { kind: 'open', scope: targetScope, carry: true }, target: ['ready-before-assign', 'assignment-lost-reply'].includes(scenario) ? null : { ...native, phase: 'assigned' }, result: null };
    let live = true, closeAfterResult = true, knownDetached = 0, wakesOfAbsent = 0, creations = 0, explicitReopen = false, beforeReopen = null;
    let queueReads = 0, completionAttempts = 0, sourceWakes = 0, sourceRuntime = null; const launches = [], catalog = await S.reopen('closed-after-catalog', () => {}), owner = { storage: catalog, holds: () => false, async quiesce() {}, async release() {} };
    const request = { scope: targetScope, creation: false, agentId: 'agent', agentLabel: 'Agent', carryFrom: null, initialDraft: null };
    const childRuntime = () => Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat' }, port: scenario === 'history-expired' ? port : null,
      controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope: targetScope, viewId: target.viewId, store: b } }) } });
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'read-intent') return saved;
      if (command.kind === 'lookup') { const observed = { kind: scenario === 'rolled-failed-after-ready' && !explicitReopen ? 'opening' : live ? 'ready' : 'closed', reservation: native }; if (['intent-close', 'ready-before-assign', 'assignment-lost-reply'].includes(scenario) && live && !explicitReopen) { await b.dispose(); await target.close(); live = false; closeAfterResult = false; } return observed; }
      if (command.kind === 'launch') {
        launches.push({ existingOnly: !!command.existingOnly, explicitReopen });
        if (command.existingOnly) { if (live) { knownDetached++; return { kind: 'detached', scope: targetScope, label: native.label }; } wakesOfAbsent++; if (scenario === 'wake-rejects') throw new Error('window-focus-failed'); return null; }
        if (!explicitReopen) throw new Error('Normal child close must not automatically recreate a window');
        creations++; live = true;
        target = await S.claimEditor({ scope: targetScope, viewId: native.viewId, label: native.label, transitionId: native.transitionId, creation: null }, () => {});
        b = makeStore(target, targetScope); await b.ready; await childRuntime().syncDraftCarries(); native = { ...native, phase: 'target-ready', bindingRevision: target.editorBinding().revision, writerGeneration: target.editorBinding().writerGeneration };
        return { kind: 'detached', scope: targetScope, label: native.label };
      }
      if (command.kind === 'assign-intent') { saved = { ...saved, target: native }; if (['ready-before-assign', 'assignment-lost-reply'].includes(scenario) && live) { await b.dispose(); await target.close(); live = false; closeAfterResult = false; } if (scenario === 'assignment-lost-reply') throw new Error('Assigned reply lost'); return saved; }
      if (command.kind === 'reserve') { native = { ...native, transitionId: 'explicit-reopen-transition', phase: 'requested' }; return native; }
      if (command.kind === 'phase') { native = { ...native, phase: command.phase }; return { ok: true }; }
      if (command.kind === 'pending-intents') {
        queueReads++; if (closeAfterResult) { if (knownDetached !== 1) throw new Error('Fixture requires a known successful detached opening before close'); closeAfterResult = false; await b.dispose(); await target.close(); live = false; }
        return saved.result === null ? [saved] : [];
      }
      if (command.kind === 'complete-intent') { if (['lost-completion', 'bind-abort-after-success'].includes(scenario) && completionAttempts++ === 0) throw new Error('Native completion write failed before persistence'); saved = { ...saved, result: command.result }; return { ok: true }; }
      if (command.kind === 'carry-applied') { if (sourceRuntime && scenario === 'history-expired') { sourceWakes++; await sourceRuntime.drive(); } return { ok: true }; }
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port); coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const main = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, processing: false, snapshot: { placementNotice: null }, listeners: new Set(), coordinator, port, recoveryDirty: false, policyScope: null, ui: { getSnapshot: () => ({ state: null, localBuiltin: true, confirmedGeneration: null, validatedVisual: { kind: 'none' }, deliveryContext: null }) }, refreshRecovery: async () => {},
      controller: { getSnapshot: () => ({ busy: false, host: { kind: 'ready', metadata: { hostId: 'host', agents: [{ id: 'agent' }] } }, active: null, saved: { pendingCreation: null }, lastPlacement: null }),
        async inspectConversation() { return { agent: { id: 'agent' }, continuation: { successor: { kind: 'confirmed', scope: targetScope } } }; }, async openReserved() { return coordinator.acquire(request, owner); }, async refreshCatalog() {},
        async settleCarriedDraft(carry) { await a.transferDraft(carry.expected, '', { kind: 'release', source: carry.source, requestId: carry.requestId }); }
      } });
    const stale = saved;
    if (['rolled-before-bind', 'rolled-failed-after-ready'].includes(scenario)) { saved = { ...saved, target: native }; await b.dispose(); await target.close(); live = false; closeAfterResult = false; native = { ...native, transitionId: 'newer-assigned-transition', phase: scenario === 'rolled-failed-after-ready' ? 'failed' : 'assigned' }; }
    if (scenario === 'closed-before-wake') { await b.dispose(); await target.close(); live = false; closeAfterResult = false; }
    if (['intent-close', 'closed-before-wake', 'ready-before-assign', 'rolled-before-bind', 'assignment-lost-reply', 'rolled-failed-after-ready'].includes(scenario)) await main.processIntent(stale); else await main.resumeWindow(native);
    // Normal main processing observes terminal history and does not recreate the child.
    let afterAbortedBind = null;
    const originalGet = IDBObjectStore.prototype.get;
    if (scenario === 'bind-abort-after-success') {
      let abort = true;
      IDBObjectStore.prototype.get = function(key) { const request = originalGet.call(this, key); if (abort && Array.isArray(key) && key[0] === 'draft-carry' && key[3] === requestId) { abort = false; request.addEventListener('success', () => this.transaction.abort(), { once: true }); } return request; };
    }
    const beforeQueueReads = queueReads;
    try { await main.drive(); } finally { IDBObjectStore.prototype.get = originalGet; }
    if (scenario === 'bind-abort-after-success') { afterAbortedBind = { result: saved.result, carry: (await c.sourceCarries(scope))[0], indexed: (await c.targetCarries(targetScope)).length }; await main.drive(); }

    if (scenario === 'history-expired') {
      const sourceRecovery = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat', reservation: { scope } }, historyEpoch: 1, requestHistory: new Map(), pendingIntents: new Map(), pendingIntent: null, snapshot: { recovery: { kind: 'chat', pending: [], history: [] } }, listeners: new Set(), controller: { settlePlacement() {} }, port: { async request(command) { if (command.kind === 'own-intents') return { epoch: 2, pending: [], items: [], after: null }; if (command.kind === 'read-intent') return null; throw new Error(command.kind); } } });
      await sourceRecovery.readRecovery();
    }
    const drive = { queueReads: queueReads - beforeQueueReads, notice: main.snapshot.placementNotice };
    beforeReopen = { source: (await a.captureDraft()).text, carry: (await c.sourceCarries(scope))[0], live, nativeResult: saved.result, creations, launches: [...launches] };
    explicitReopen = true;
    sourceRuntime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat', reservation: { scope } }, port: null, childOwner: source, childReady: true, recoveryDirty: false, processing: false, snapshot: { placementNotice: null }, listeners: new Set(),
      controller: { getSnapshot: () => ({ busy: false, host: { kind: 'ready', metadata: { hostId: 'host' } }, saved: { pendingCreation: null }, active: { scope, viewId: source.viewId, store: a } }) } });
    const reopened = await coordinator.acquire(request, owner), sourceAfterWake = (await a.captureDraft()).text;
    await sourceRuntime.syncDraftCarries(); await childRuntime().syncDraftCarries(); await sourceRuntime.syncDraftCarries();
    const after = { source: (await a.captureDraft()).text, target: (await b.captureDraft()).text, carry: (await c.sourceCarries(scope))[0], live, nativeResult: saved.result, creations, reopened, launches };
    await Promise.all([a.dispose(), b.dispose()]); await Promise.all([source.close(), target.close(), catalog.close()]);
    return { beforeReopen, after, knownDetached, wakesOfAbsent, drive, sourceAfterWake, sourceWakes, afterAbortedBind };
  }, scenario);
  assert.equal(result.drive.queueReads, scenario === 'bind-abort-after-success' ? 2 : 1); assert.equal(result.drive.notice, null);
  assert.equal(result.knownDetached, ['intent-close', 'closed-before-wake', 'ready-before-assign', 'rolled-before-bind', 'assignment-lost-reply', 'rolled-failed-after-ready'].includes(scenario) ? 0 : 1); assert.equal(result.wakesOfAbsent, ['lost-completion', 'bind-abort-after-success'].includes(scenario) ? 2 : 1);
  if (scenario === 'bind-abort-after-success') { assert.equal(result.afterAbortedBind.result, null); assert.equal(result.afterAbortedBind.carry.kind, 'offered'); assert.equal(result.afterAbortedBind.indexed, 1); }
  if (scenario === 'history-expired') { assert.equal(result.sourceAfterWake, ''); assert.ok(result.sourceWakes > 0); }
  assert.equal(result.beforeReopen.live, false); assert.equal(result.beforeReopen.creations, 0); assert.equal(result.beforeReopen.source, 'Close-race source text');
  assert.equal(result.beforeReopen.nativeResult.kind, 'detached'); assert.equal(result.beforeReopen.carry.kind, 'offered'); assert.equal(result.beforeReopen.carry.target.conversationId, 'closed-after-target');
  assert.ok(result.beforeReopen.launches.every(call => call.existingOnly));
  assert.equal(result.after.creations, 1); assert.equal(result.after.reopened.kind, 'detached'); assert.equal(result.after.source, ''); assert.equal(result.after.target, 'Close-race source text\n\nClose-race destination text'); assert.equal(result.after.carry.kind, 'settled');
  assert.deepEqual(result.after.nativeResult, result.beforeReopen.nativeResult);
});


for (const closesAfterReady of [false, true]) test(`opening an already ready child without carried text focuses only that child (closes ${closesAfterReady})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async closesAfterReady => {
    const sourceScope = { hostId: 'host', conversationId: 'focus-source' }, targetScope = { hostId: 'host', conversationId: 'focus-target' };
    const reservation = { scope: targetScope, viewId: 'focus-target-view', label: 'focus-target-child', transitionId: 'focus-target-transition', creationAgentId: null, phase: 'target-ready', bindingRevision: 1, writerGeneration: 1 };
    const intent = { sourceScope, requestId: '1:focus-without-carry', action: { kind: 'open', scope: targetScope, carry: false }, target: reservation, result: null };
    let live = true, replacementPlacements = 0, completed = null; const launches = [];
    const main = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, snapshot: { placementNotice: null }, listeners: new Set(),
      controller: { getSnapshot: () => ({ busy: false, host: { kind: 'ready', metadata: { hostId: 'host' } }, saved: { pendingCreation: null } }),
        async inspectConversation(scope) { return { agent: { id: 'agent' }, continuation: { successor: scope.conversationId === sourceScope.conversationId ? { kind: 'confirmed', scope: targetScope } : null } }; },
        async openReserved() { replacementPlacements++; throw new Error('A known ready child must not be placed again'); }
      }, port: { async request(command) {
        if (command.kind === 'read-intent') { if (closesAfterReady) live = false; return { ...intent, result: completed }; }
        if (command.kind === 'lookup') throw new Error('Saved Ready proof must not require a new lookup');
        if (command.kind === 'launch') { launches.push({ existingOnly: command.existingOnly, scope: command.scope }); if (!command.existingOnly) throw new Error('A normal child close must not create another window'); return live ? { kind: 'detached', scope: targetScope, label: reservation.label } : null; }
        if (command.kind === 'complete-intent') { completed = command.result; return { ok: true }; }
        throw new Error(command.kind);
      } }
    });
    await main.processIntent(intent); return { launches, replacementPlacements, completed, notice: main.snapshot.placementNotice, live };
  }, closesAfterReady);
  assert.deepEqual(result.launches, [{ existingOnly: true, scope: { hostId: 'host', conversationId: 'focus-target' } }]);
  assert.equal(result.replacementPlacements, 0); assert.equal(result.completed.kind, 'detached'); assert.equal(result.completed.label, 'focus-target-child'); assert.equal(result.notice, null); assert.equal(result.live, !closesAfterReady);
});


test('a new child open of an already closed historical target still requests explicit placement', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const sourceScope = { hostId: 'host', conversationId: 'new-open-source' }, scope = { hostId: 'host', conversationId: 'new-open-target' };
    let reservation = { scope, viewId: 'new-open-view', label: 'new-open-child', transitionId: 'historical-transition', creationAgentId: null, phase: 'target-ready', bindingRevision: 1, writerGeneration: 1 };
    let placements = 0, completed = null, assignmentHint = 'not assigned';
    const intent = { sourceScope, requestId: '1:new-explicit-open', action: { kind: 'open', scope, carry: false }, target: null, result: null };
    const main = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, snapshot: { placementNotice: null }, listeners: new Set(),
      controller: { getSnapshot: () => ({ busy: false, host: { kind: 'ready', metadata: { hostId: 'host' } }, saved: { pendingCreation: null } }),
        async inspectConversation() { return { agent: { id: 'agent' }, continuation: { successor: { kind: 'confirmed', scope } } }; },
        async openReserved() { placements++; return { kind: 'detached', scope, label: reservation.label }; }
      }, port: { async request(command) {
        if (command.kind === 'read-intent') return { ...intent, result: completed };
        if (command.kind === 'lookup') return { kind: 'closed', reservation };
        if (command.kind === 'assign-intent') { assignmentHint = command.viewId; return { ...intent, target: { ...reservation, transitionId: 'fresh-explicit-transition', phase: 'assigned' } }; }
        if (command.kind === 'complete-intent') { completed = command.result; return { ok: true }; }
        throw new Error(command.kind);
      } }
    });
    await main.processIntent(intent); return { placements, completed, assignmentHint, notice: main.snapshot.placementNotice };
  });
  assert.equal(result.placements, 1); assert.equal(result.assignmentHint, null); assert.equal(result.completed.kind, 'detached'); assert.equal(result.notice, null);
});

for (const outcome of ['closed-ready', 'closed-other-attempt', 'inline-ready', 'rollover-before-refresh']) test(`main settles only its exact native pending opening (${outcome})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async outcome => {
    const scope = { hostId: 'host', conversationId: 'main-pending-target' }, S = globalThis.BrowserViewStorage;
    const catalog = await S.reopen('main-pending-catalog', () => {}); let native = null, launched = 0, settled = null;
    const owner = { storage: catalog, holds: () => false, async quiesce() { throw new Error('Independent catalog must stay usable'); }, async release() { throw new Error('Independent catalog must stay owned'); } };
    const port = { context: { role: 'main', liveRelay: true, label: 'main' }, async request(command) {
      if (command.kind === 'lookup') return native ? { kind: 'closed', reservation: native } : { kind: 'absent' };
      if (command.kind === 'reserve') { const previous = native; native = { scope, viewId: command.viewId, label: 'main-pending-child', transitionId: previous ? 'main-later-attempt' : 'main-pending-attempt', creationAgentId: 'agent', phase: 'requested', bindingRevision: previous?.bindingRevision ?? null, writerGeneration: previous?.writerGeneration ?? null }; return native; }
      if (command.kind === 'phase') { native = { ...native, phase: command.phase }; return { ok: true }; }
      if (command.kind === 'launch') { launched++; return { kind: 'pending', scope, reason: 'Assigned editor opening' }; }
      if (command.kind === 'reservations') return [native];
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port); coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const request = { scope, creation: true, agentId: 'agent', agentLabel: 'Agent', carryFrom: null, initialDraft: null };
    const pending = await coordinator.acquire(request, owner);
    if (pending.kind !== 'pending') throw new Error('Producer must return a real native pending result');
    if (outcome === 'rollover-before-refresh') {
      const child = await S.claimEditor({ scope, viewId: native.viewId, label: native.label, transitionId: native.transitionId, creation: { agentId: 'agent' } }, () => {});
      const store = globalThis.createConversationStore({ scope, port: { scope }, projection: globalThis.transcriptProjection, drafts: child.drafts(() => {}) });
      await store.ready; await store.setDraft('Retained A draft'); await child.saveView(scope.hostId, { version: 2, route: scope, pendingCreation: null });
      const binding = child.editorBinding(); native = { ...native, bindingRevision: binding.revision, writerGeneration: binding.writerGeneration };
      await store.dispose(); await child.close();
    }
    native = { ...native, phase: outcome === 'inline-ready' ? 'inline-ready' : 'target-ready', transitionId: outcome === 'closed-other-attempt' ? 'different-attempt' : native.transitionId, bindingRevision: native.bindingRevision ?? 2, writerGeneration: native.writerGeneration ?? 3 };
    let published = pending, later = null;
    const main = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, port, coordinator, snapshot: { placementNotice: pending.reason }, listeners: new Set(), carryRecoveryAfter: null,
      controller: { pendingPlacements: () => [...(!settled ? [pending] : []), ...(published !== pending ? [published] : [])], getSnapshot: () => ({ host: { kind: 'ready', metadata: { hostId: 'host' } }, lastPlacement: published }), settlePlacement(expected, result) { if (expected !== pending) throw new Error('A later opening was incorrectly settled from old readiness'); settled = result; return true; } }
    });
    coordinator.observeReady(reservation => main.settleReadyPlacements(reservation));
    if (outcome === 'rollover-before-refresh') { later = await coordinator.acquire({ ...request, creation: false }, owner); if (later.kind !== 'pending') throw new Error(`Later explicit placement failed: ${later.reason}`); published = later; }
    await main.readRecovery(); await catalog.close(); return { pending, settled, launched, notice: main.snapshot.placementNotice, laterKept: later !== null && published === later, nativePhase: native.phase };
  }, outcome);
  assert.equal(result.launched, outcome === 'rollover-before-refresh' ? 2 : 1);
  if (outcome === 'closed-ready' || outcome === 'rollover-before-refresh') { assert.equal(result.settled.kind, 'detached'); assert.equal(result.notice, null); }
  else { assert.equal(result.settled, null); assert.equal(result.notice, result.pending.reason); }
  if (outcome === 'rollover-before-refresh') { assert.equal(result.laterKept, true); assert.equal(result.nativePhase, 'source-released'); }
});

test('native intent completion bounds and repairs controller-produced refusal diagnostics', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const sourceScope = { hostId: 'host', conversationId: 'diagnostic-source' }, scope = { hostId: 'host', conversationId: 'diagnostic-target' };
    const target = { scope, viewId: 'diagnostic-view', label: 'diagnostic-child', transitionId: 'diagnostic-transition', creationAgentId: null, phase: 'requested', bindingRevision: null, writerGeneration: null };
    const results = [];
    for (const reason of ['x'.repeat(999) + '\uD83D', 'bad\uD800diagnostic', '']) {
      const intent = { sourceScope, requestId: '1:diagnostic', action: { kind: 'open', scope, carry: false }, target, result: null };
      const main = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, snapshot: {}, listeners: new Set(),
        controller: { getSnapshot: () => ({ busy: false, host: { kind: 'ready', metadata: { hostId: 'host' } }, saved: { pendingCreation: null } }), async inspectConversation() { return { agent: { id: 'agent' }, continuation: { successor: { kind: 'confirmed', scope } } }; }, async openReserved() { return { kind: 'refused', reason }; } },
        port: { async request(command) { if (command.kind === 'read-intent') return intent; if (command.kind === 'lookup') return { kind: 'closed', reservation: target }; if (command.kind === 'complete-intent') { results.push(command.result); return { ok: true }; } throw new Error(command.kind); } }
      }); await main.processIntent(intent);
    }
    return results;
  });
  assert.equal(result.length, 3);
  for (const item of result) { assert.equal(item.kind, 'refused'); assert.ok(item.reason.isWellFormed()); assert.ok(item.reason.length > 0 && item.reason.length <= 1000); }
});

test('catalog navigation cancels an older appearance handoff before it can reopen a closed chat', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const prior = { hostId: 'host', conversationId: 'old-policy-target' }, selected = { hostId: 'host', conversationId: 'catalog-selection' }, opens = [];
    const digest = 'a'.repeat(64), presentation = { chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } };
    const state = { selection: { deliveryGeneration: 1, revision: 1, selected: { kind: 'bundle', digest } }, bundle: { digest, manifest: { presentation } }, transitions: [{ slot: { target: { scope: prior } } }] };
    const ui = { getSnapshot: () => ({ state, localBuiltin: false, deliveryContext: globalThis.windowContext('main-context'), confirmedGeneration: 1, validatedVisual: { kind: 'delivery', context: globalThis.windowContext('main-context'), generation: 1, revision: 1, digest } }) };
    const port = { async request(command) { if (command.kind === 'pending-intents') return []; throw new Error(command.kind); } };
    const pending = { kind: 'pending', scope: prior, reason: 'Old chat opening' }, latest = { kind: 'inline', scope: selected };
    const coordinator = new globalThis.WindowCoordinator(null);
    const main = Object.assign(new globalThis.WindowRuntime({ role: 'main', version: 1, label: 'main', brokerInstance: 'broker', documentIncarnation: 'main', viewId: 'catalog', reservation: null, liveRelay: true }), { context: { role: 'main', liveRelay: true }, port, coordinator, ui, processing: true, closed: false, catalogDirty: false, recoveryDirty: false,
      policyScope: prior, policyAppliedScope: prior, policyDelivery: JSON.stringify([globalThis.windowContext('main-context'), 1, 1, digest]), lastPlacement: pending, snapshot: { placementNotice: null }, listeners: new Set(),
      controller: { getSnapshot: () => ({ busy: false, host: { kind: 'ready', metadata: { hostId: 'host' } }, active: null, saved: { pendingCreation: null }, lastPlacement: latest }), pendingPlacements: () => [],
        async openReserved(scope) { opens.push(scope); return { kind: 'detached', scope, label: 'unwanted-reopen' }; }, async refreshCatalog() {} }
    });
    main.uiChanged(); main.processing = false; await main.drive(); return { opens, notice: main.snapshot.placementNotice, policyScope: main.policyScope };
  });
  assert.deepEqual(result.opens, []); assert.equal(result.policyScope, null); assert.equal(result.notice, null);
});

for (const guarded of [false, true]) test(`a ready catalog target closed before focus is historical success without replacement (guarded ${guarded})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async guarded => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'ready-focus-close' };
    const child = await S.claimEditor({ scope, viewId: 'ready-focus-child-view', label: 'ready-focus-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const binding = child.editorBinding(), catalog = await S.reopen('ready-focus-catalog', () => {});
    let live = true, current = true, reserves = 0, creates = 0;
    let reservation = { scope, viewId: child.viewId, label: 'ready-focus-child', transitionId: 'ready-focus-transition', creationAgentId: null, phase: 'target-ready', bindingRevision: binding.revision, writerGeneration: binding.writerGeneration };
    const port = { context: { role: 'main', liveRelay: true, label: 'main' }, async request(command) {
      if (command.kind === 'lookup') return { kind: live ? 'ready' : 'closed', reservation };
      if (command.kind === 'launch' && command.existingOnly) { live = false; await child.close(); return null; }
      if (command.kind === 'reserve') { reserves++; reservation = { ...reservation, transitionId: 'unwanted-replacement', phase: 'requested' }; return reservation; }
      if (command.kind === 'phase') { reservation = { ...reservation, phase: command.phase }; return { ok: true }; }
      if (command.kind === 'launch') { creates++; return { kind: 'pending', scope, reason: 'Unwanted new window' }; }
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port); coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    if (guarded) coordinator.observeReady(() => { current = false; });
    const operation = () => coordinator.acquire({ scope, creation: false, agentId: 'agent', agentLabel: 'Agent', carryFrom: null, initialDraft: null }, { storage: catalog, holds: () => false, async quiesce() {}, async release() {} });
    const placement = guarded ? await coordinator.withPlacementGuard(scope, () => current, operation) : await operation();
    await child.close(); await catalog.close(); return { placement, reserves, creates };
  }, guarded);
  assert.equal(result.placement.kind, 'detached'); assert.equal(result.placement.label, 'ready-focus-child'); assert.equal(result.reserves, 0); assert.equal(result.creates, 0);
});

test('saved child readiness completes before fresh metadata or lookup and permits the next queue item', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const firstSource = { hostId: 'host', conversationId: 'historical-source' }, firstScope = { hostId: 'host', conversationId: 'historical-ready' };
    const secondSource = { hostId: 'host', conversationId: 'next-source' }, secondScope = { hostId: 'host', conversationId: 'next-target' };
    const target = (scope, phase) => ({ scope, viewId: scope.conversationId, label: scope.conversationId, transitionId: scope.conversationId, creationAgentId: null, phase, bindingRevision: 1, writerGeneration: 1 });
    const one = { sourceScope: firstSource, requestId: '1:historical', action: { kind: 'open', scope: firstScope, carry: false }, target: target(firstScope, 'target-ready'), result: null };
    const two = { sourceScope: secondSource, requestId: '1:next', action: { kind: 'open', scope: secondScope, carry: false }, target: target(secondScope, 'source-released'), result: null };
    const saved = new Map([[one.requestId, one], [two.requestId, two]]), metadata = [], lookups = [], completed = [];
    const main = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, processing: false, closed: false, recoveryDirty: false, catalogDirty: false, policyScope: null, listeners: new Set(), snapshot: {},
      ui: { getSnapshot: () => ({ state: null }) },
      controller: { getSnapshot: () => ({ busy: false, host: { kind: 'ready', metadata: { hostId: 'host' } }, active: null, saved: { pendingCreation: null }, lastPlacement: null }),
        async inspectConversation(scope) { metadata.push(scope.conversationId); if (scope.conversationId === firstSource.conversationId) throw new Error('Source metadata disconnected'); return { agent: { id: 'agent' }, continuation: { successor: { kind: 'confirmed', scope: secondScope } } }; },
        async openReserved(scope) { return { kind: 'detached', scope, label: scope.conversationId }; }
      }, port: { async request(command) {
        if (command.kind === 'pending-intents') return [...saved.values()].filter(intent => !intent.result);
        if (command.kind === 'read-intent') return saved.get(command.requestId);
        if (command.kind === 'lookup') { lookups.push(command.scope.conversationId); if (command.scope.conversationId === firstScope.conversationId) throw new Error('Old live lookup unavailable'); return { kind: 'opening', reservation: two.target }; }
        if (command.kind === 'launch' && command.existingOnly) return null;
        if (command.kind === 'complete-intent') { const intent = saved.get(command.requestId); if (intent.target.phase === 'target-ready' && command.result.kind === 'refused') throw new Error('confirmed-opening-cannot-be-refused'); completed.push(command.requestId); saved.set(command.requestId, { ...intent, result: command.result }); return { ok: true }; }
        throw new Error(command.kind);
      } }
    }); await main.drive(); return { completed, metadata, lookups, notice: main.snapshot.placementNotice };
  });
  assert.deepEqual(result.completed, ['1:historical', '1:next']); assert.deepEqual(result.metadata, ['next-source']); assert.deepEqual(result.lookups, ['next-target']); assert.equal(result.notice, null);
});

test('native readiness settles a continuation after an unrelated refusal replaces the latest placement', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const source = { hostId: 'host', conversationId: 'source' }, successor = { ...source, conversationId: 'native-continuation' }, other = { ...source, conversationId: 'refused-unrelated' };
    const none = { predecessor: null, carried: null, closure: null, successor: null };
    let ready = false, started = false, recoveryLookups = 0, hostActions = 0;
    const reservation = { scope: successor, viewId: 'successor-view', label: 'successor-child', transitionId: 'successor-attempt', creationAgentId: null, phase: 'source-released', bindingRevision: null, writerGeneration: null };
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'reservations') return [reservation];
      if (command.kind === 'intent-context') return { epoch: 1, pendingCarryRequests: [] };
      if (command.kind === 'lookup') {
        if (command.scope.conversationId === other.conversationId) throw new Error('Unrelated native open refused');
        if (ready) recoveryLookups++;
        return { kind: ready ? 'ready' : 'opening', reservation: ready ? { ...reservation, phase: 'target-ready', bindingRevision: 1, writerGeneration: 1 } : reservation };
      }
      if (command.kind === 'launch') return { kind: 'pending', scope: successor, reason: 'Waiting for continuation child' };
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port);
    const f = globalThis.controllerFixture({ placement: { acquire(request, owner) { return request.scope.conversationId === source.conversationId ? Promise.resolve({ kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } }) : coordinator.acquire(request, owner); } } });
    f.views.set('original-view/host', { version: 2, route: source, pendingCreation: null });
    f.behavior.observation = async () => ({ kind: 'concluded', cause: 'cancelled' });
    f.behavior.continuation = async input => { hostActions++; if (input.action === 'start') started = true; return input.scope.conversationId === source.conversationId ? { ...none, closure: 'cancelled', successor: started ? { kind: 'confirmed', scope: successor } : null } : none; };
    try {
      await f.app.start(); for (let n = 0; n < 100 && !f.app.getSnapshot().continuation?.view; n++) await new Promise(resolve => setTimeout(resolve, 0));
      const original = f.app.getSnapshot().active; await original.store.setDraft('Retain continuation source bytes');
      const actions = f.app.conversationActions(original); await actions.continueConversation();
      const pending = f.app.getSnapshot().lastPlacement, deduplicated = f.app.pendingPlacements().length === 1 && f.app.pendingPlacements()[0] === pending;
      const refused = await f.app.openReserved(other), sameActive = f.app.getSnapshot().active.store === original.store;
      const before = hostActions; await actions.continueConversation(); await actions.checkContinuation(); const blocked = hostActions === before;
      const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, controller: f.app, coordinator, port, carryRecoveryAfter: null, policyScope: null,
        snapshot: { placementNotice: null }, listeners: new Set() });
      ready = true; await runtime.readRecovery();
      return { pendingKind: pending.kind, deduplicated, refusalKind: refused.kind, sameActive, blocked, recoveryLookups, error: f.app.getSnapshot().continuation.error,
        refusedRemains: f.app.getSnapshot().lastPlacement === refused, remaining: f.app.pendingPlacements().length, draft: original.store.getSnapshot().draft, created: f.created.length, sent: f.submitted.length };
    } finally { await f.app.dispose(); }
  });
  assert.equal(result.pendingKind, 'pending'); assert.equal(result.deduplicated, true); assert.equal(result.refusalKind, 'refused'); assert.equal(result.sameActive, true); assert.equal(result.blocked, true);
  assert.equal(result.recoveryLookups, 1, 'native recovery discovers the earlier live continuation');
  assert.equal(result.error, 'Continuation opened in its assigned editor.'); assert.equal(result.refusedRemains, true); assert.equal(result.remaining, 0);
  assert.equal(result.draft, 'Retain continuation source bytes'); assert.equal(result.created, 0); assert.equal(result.sent, 0);
});

test('confirming a separate appearance still attempts its retained source after a delegated chat opens', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const activeScope = { hostId: 'host', conversationId: 'retained-main' }, childScope = { ...activeScope, conversationId: 'child-source' }, targetScope = { ...activeScope, conversationId: 'delegated-target' };
    const target = { scope: targetScope, viewId: 'target-view', label: 'target-child', transitionId: 'target-attempt', creationAgentId: null, phase: 'source-released', bindingRevision: null, writerGeneration: null };
    let intent = { sourceScope: childScope, requestId: '1:delegated-open', action: { kind: 'open', scope: targetScope, carry: false }, target, result: null }, policyLookups = 0;
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'pending-intents') return intent.result ? [] : [intent];
      if (command.kind === 'read-intent') return intent;
      if (command.kind === 'reservations') return [target];
      if (command.kind === 'lookup') {
        if (command.scope.conversationId === activeScope.conversationId) { policyLookups++; throw new Error('Native source placement unavailable'); }
        return { kind: 'opening', reservation: target };
      }
      if (command.kind === 'launch') return { kind: 'detached', scope: targetScope, label: target.label };
      if (command.kind === 'complete-intent') { intent = { ...intent, result: command.result }; return { ok: true }; }
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port); let starting = true;
    const f = globalThis.controllerFixture({ placement: { acquire(request, owner) { return starting && request.scope.conversationId === activeScope.conversationId ? Promise.resolve({ kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } }) : coordinator.acquire(request, owner); } } });
    f.views.set('original-view/host', { version: 2, route: activeScope, pendingCreation: null });
    const none = { predecessor: null, carried: null, closure: null, successor: null };
    f.behavior.continuation = async input => input.scope.conversationId === childScope.conversationId ? { ...none, successor: { kind: 'confirmed', scope: targetScope } } : none;
    await f.app.start(); starting = false; const original = f.app.getSnapshot().active; await original.store.setDraft('Retained main policy draft');
    const digest = 'a'.repeat(64), transition = { envelope: { requestId: '1:appearance', deliveryGeneration: 2, selectionRevision: 2, digest }, slot: { transitionId: 'appearance-slot', target: null } };
    const state = { selection: { deliveryGeneration: 2, revision: 2, selected: { kind: 'bundle', digest } }, bundle: { digest, manifest: { presentation: { chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } } } }, transitions: [transition] };
    let confirmed = false; const failed = [], idled = [], ui = Object.create(globalThis.UiConnection.prototype);
    ui.getSnapshot = () => ({ state, localBuiltin: false, deliveryContext: globalThis.windowContext('main-context'), confirmedGeneration: confirmed ? 2 : 1, validatedVisual: { kind: 'delivery', context: globalThis.windowContext('main-context'), generation: 2, revision: 2, digest } });
    ui.failPlacement = async (item, reason) => { failed.push({ transition: item.slot.transitionId, reason }); };
    ui.idlePlacement = async item => { idled.push(item.slot.transitionId); };
    const runtime = Object.assign(new globalThis.WindowRuntime({ role: 'main', version: 1, label: 'main', brokerInstance: 'broker', documentIncarnation: 'main', viewId: 'catalog', reservation: null, liveRelay: true }), { controller: f.app, coordinator, port, ui, processing: true });
    runtime.configurePlacementTracking(); const drive = runtime.drive.bind(runtime); runtime.drive = async () => {};
    const unsubscribe = f.app.subscribe(() => runtime.uiChanged());
    try {
      runtime.uiChanged(); runtime.processing = false; await drive();
      const retainedAfterIntent = f.app.getSnapshot().active?.store === original.store, delegated = intent.result;
      confirmed = true; runtime.uiChanged(); await drive();
      return { retainedAfterIntent, delegated, policyLookups, failed, idled, activeScope: f.app.getSnapshot().active?.scope,
        draft: original.store.getSnapshot().draft, created: f.created.length, sent: f.submitted.length };
    } finally { unsubscribe(); await f.app.dispose(); }
  });
  assert.equal(result.retainedAfterIntent, true, 'the actual controller retains the original inline source after focusing the delegated child');
  assert.equal(result.delegated.kind, 'detached'); assert.equal(result.delegated.scope.conversationId, 'delegated-target');
  assert.equal(result.policyLookups, 1, 'confirming the appearance still attempts the retained source');
  assert.deepEqual(result.failed, [{ transition: 'appearance-slot', reason: 'Native source placement unavailable' }]); assert.deepEqual(result.idled, []);
  assert.equal(result.activeScope.conversationId, 'retained-main'); assert.equal(result.draft, 'Retained main policy draft'); assert.equal(result.created, 0); assert.equal(result.sent, 0);
});

test('a delegated carry that becomes ready during binding cannot reserve or create a replacement', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, sourceScope = { hostId: 'host', conversationId: 'atomic-source' }, targetScope = { hostId: 'host', conversationId: 'atomic-target' };
    const source = await S.claimEditor({ scope: sourceScope, viewId: 'atomic-source-view', label: 'source-child', transitionId: null, creation: { agentId: 'default' } }, () => {});
    let target = await S.claimEditor({ scope: targetScope, viewId: 'atomic-target-view', label: 'atomic-child', transitionId: null, creation: { agentId: 'default' } }, () => {});
    const make = (owner, scope) => globalThis.createConversationStore({ scope, port: { scope }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}) });
    const a = make(source, sourceScope); let b = make(target, targetScope); await Promise.all([a.ready, b.ready]); await a.setDraft('Captured child text'); await b.setDraft('Retained target text');
    await target.saveView('host', { version: 2, route: targetScope, pendingCreation: null });
    const requestId = '1:atomic-placement'; await c.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected: await a.captureDraft() });
    let reservation = { scope: targetScope, viewId: target.viewId, label: 'atomic-child', transitionId: 'atomic-original', creationAgentId: null, phase: 'source-released', bindingRevision: target.editorBinding().revision, writerGeneration: target.editorBinding().writerGeneration };
    let intent = { sourceScope, requestId, action: { kind: 'open', scope: targetScope, carry: true }, target: reservation, result: null }, close = Promise.resolve(), mutations = 0, creates = 0, guarded = 0;
    const port = { context: { role: 'main', liveRelay: true, label: 'main' }, async request(command) {
      if (command.kind === 'read-intent') return intent;
      if (command.kind === 'lookup') { await close; return { kind: intent.target.phase === 'target-ready' ? 'closed' : 'opening', reservation }; }
      if (command.kind === 'launch' && command.existingOnly) return null;
      if (command.kind === 'reserve') {
        if (command.intentRef && intent.target.phase === 'target-ready') { guarded++; if (command.intentRef.requestId !== requestId || command.intentRef.sourceScope.conversationId !== sourceScope.conversationId) throw new Error('Wrong request fence'); throw new Error('intent-already-ready'); }
        mutations++; reservation = { ...reservation, transitionId: 'unwanted-replacement', phase: 'requested' }; return reservation;
      }
      if (command.kind === 'phase') { reservation = { ...reservation, phase: command.phase }; return { ok: true }; }
      if (command.kind === 'launch') { creates++; return { kind: 'pending', scope: targetScope, reason: 'Unwanted replacement' }; }
      if (command.kind === 'complete-intent') { intent = { ...intent, result: command.result }; return { ok: true }; }
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port); coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const f = globalThis.controllerFixture({ placement: coordinator }); f.behavior.continuation = async input => ({ predecessor: null, carried: null, closure: null, successor: input.scope.conversationId === sourceScope.conversationId ? { kind: 'confirmed', scope: targetScope } : null }); await f.app.start();
    const main = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, controller: f.app, coordinator, port, snapshot: {}, listeners: new Set() });
    const originalGet = IDBObjectStore.prototype.get; let injected = false;
    IDBObjectStore.prototype.get = function(key) {
      const request = originalGet.call(this, key);
      if (!injected && Array.isArray(key) && key[0] === 'draft-carry' && key[3] === requestId) request.addEventListener('success', () => {
        injected = true; reservation = { ...reservation, phase: 'target-ready' }; intent = { ...intent, target: reservation }; close = (async () => { await b.dispose(); await target.close(); })();
      }, { once: true });
      return request;
    };
    try { await main.processIntent(intent); } finally { IDBObjectStore.prototype.get = originalGet; }
    await close; const before = { result: intent.result, mutations, creates, guarded, carry: (await c.sourceCarries(sourceScope))[0], source: (await a.captureDraft()).text };
    target = await S.claimEditor({ scope: targetScope, viewId: reservation.viewId, label: reservation.label, transitionId: reservation.transitionId, creation: null }, () => {}); b = make(target, targetScope); await b.ready;
    const child = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat' }, port: null, controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope: targetScope, viewId: target.viewId, store: b } }) } });
    const origin = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat' }, port: null, controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope: sourceScope, viewId: source.viewId, store: a } }) } });
    await child.syncDraftCarries(); await origin.syncDraftCarries(); await child.syncDraftCarries();
    const after = { source: (await a.captureDraft()).text, target: (await b.captureDraft()).text, carry: (await c.sourceCarries(sourceScope))[0] };
    await f.app.dispose(); await Promise.all([a.dispose(), b.dispose()]); await Promise.all([source.close(), target.close()]); return { injected, before, after };
  });
  assert.equal(result.injected, true); assert.equal(result.before.guarded, 1); assert.equal(result.before.mutations, 0); assert.equal(result.before.creates, 0); assert.equal(result.before.result.kind, 'detached');
  assert.equal(result.before.carry.kind, 'offered'); assert.equal(result.before.source, 'Captured child text'); assert.equal(result.after.source, ''); assert.equal(result.after.target, 'Captured child text\n\nRetained target text'); assert.equal(result.after.carry.kind, 'settled');
});

for (const order of ['older-first', 'newer-first']) test(`inline recovery keeps historical detached receipt while completing only its failed attempt inline (${order})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async order => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries;
    const sourceScope = { hostId: 'host', conversationId: 'history-source' }, targetScope = { ...sourceScope, conversationId: 'history-target' };
    const source = await S.claimEditor({ scope: sourceScope, viewId: 'history-source-view', label: 'source-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    let target = await S.claimEditor({ scope: targetScope, viewId: 'history-target-view', label: 'original-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const store = (owner, scope) => globalThis.createConversationStore({ scope, port: { scope }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}) });
    const a = store(source, sourceScope); let b = store(target, targetScope); await Promise.all([a.ready, b.ready]);
    await a.setDraft('Historical carry text'); await b.setDraft('Original destination text');
    await target.saveView('host', { version: 2, route: targetScope, pendingCreation: null });
    const requestId = '1:historical-ready', expected = await a.captureDraft();
    await c.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected });
    await c.bindDraftCarry(sourceScope, requestId, targetScope);
    const old = { scope: targetScope, viewId: target.viewId, label: 'original-child', transitionId: 'original-ready-attempt', creationAgentId: null, phase: 'target-ready', bindingRevision: target.editorBinding().revision, writerGeneration: target.editorBinding().writerGeneration };
    const failed = { ...old, transitionId: 'newer-failed-attempt', phase: 'failed' };
    const intents = [
      { sourceScope, requestId, action: { kind: 'open', scope: targetScope, carry: true }, target: old, result: null },
      { sourceScope, requestId: '1:newer-failed', action: { kind: 'open', scope: targetScope, carry: false }, target: { ...failed, phase: 'assigned' }, result: null },
    ];
    if (order === 'newer-first') intents.reverse();
    await b.dispose(); await target.close(); let active = null, opened = 0, restores = 0, completions = 0;
    const grant = { scope: targetScope, viewId: target.viewId, nativeLabel: failed.label, fromTransitionId: failed.transitionId, transitionId: 'inline:newer-failed-attempt', targetLabel: 'main', creationAgentId: null };
    const main = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, processing: false, snapshot: { placementNotice: null }, listeners: new Set(),
      ui: { async restore() { restores++; }, getSnapshot: () => ({ state: null }) }, refreshRecovery: async () => {},
      controller: { getSnapshot: () => ({ busy: false, host: { kind: 'ready', metadata: { hostId: 'host' } }, active, saved: { pendingCreation: null } }),
        async inspectConversation() { return { agent: { id: 'agent' } }; },
        async openReserved() { opened++; target = await S.claimEditor({ scope: targetScope, viewId: grant.viewId, label: 'main', transitionId: grant.transitionId, creation: null }, () => {}); b = store(target, targetScope); await b.ready; active = { scope: targetScope, viewId: target.viewId, store: b }; return { kind: 'inline', scope: targetScope }; },
        async refreshCatalog() {}, async settleCarriedDraft(carry) { await a.transferDraft(carry.expected, '', { kind: 'release', source: carry.source, requestId: carry.requestId }); }
      }, port: { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
        if (command.kind === 'recover-inline') return grant;
        if (command.kind === 'phase' || command.kind === 'carry-applied') return { ok: true };
        if (command.kind === 'pending-intents') return intents.filter(intent => intent.result === null);
        if (command.kind === 'complete-intent') {
          completions++; const intent = intents.find(intent => intent.requestId === command.requestId);
          if (command.result.kind === 'inline' && intent.target.label !== failed.label) throw new Error('native-intent-target-mismatch');
          intent.result = command.result; return { ok: true };
        }
        throw new Error(command.kind);
      } } });
    main.coordinator = new globalThis.WindowCoordinator(main.port);
    try {
      await main.resumeWindow(failed, true); const beforeReplay = await b.captureDraft();
      await main.syncDraftCarries(); await main.syncDraftCarries();
      const sourceRecord = await source.drafts(() => {}).load(sourceScope), targetRecord = await target.drafts(() => {}).load(targetScope);
      return { oldReceipt: intents.find(intent => intent.requestId === requestId).result, newReceipt: intents.find(intent => intent.requestId !== requestId).result,
        beforeReplay, afterReplay: await b.captureDraft(), sourceText: sourceRecord.draft, targetText: targetRecord.draft, carries: await c.sourceCarries(sourceScope), indexed: (await c.targetCarries(targetScope)).length,
        activeView: active?.viewId, activeBinding: target.editorBinding(), originalWriter: old.writerGeneration, opened, restores, completions, notice: main.snapshot.placementNotice };
    } finally { await Promise.all([a.dispose(), b.dispose()]); await Promise.all([source.close(), target.close()]); }
  }, order);
  assert.deepEqual(result.oldReceipt, { kind: 'detached', scope: { hostId: 'host', conversationId: 'history-target' }, label: 'original-child' });
  assert.deepEqual(result.newReceipt, { kind: 'inline', scope: { hostId: 'host', conversationId: 'history-target' } });
  assert.equal(result.activeView, 'history-target-view'); assert.equal(result.activeBinding.kind, 'editing'); assert.ok(result.activeBinding.writerGeneration > result.originalWriter, 'the closed editor was reacquired with a fresh writer generation');
  assert.equal(result.sourceText, ''); assert.equal(result.targetText, 'Historical carry text\n\nOriginal destination text');
  assert.deepEqual(result.afterReplay, result.beforeReplay); assert.equal(result.carries[0].kind, 'settled'); assert.equal(result.indexed, 0);
  assert.equal(result.opened, 1); assert.equal(result.restores, 1); assert.equal(result.completions, 2); assert.equal(result.notice, null);
});

for (const creation of [false, true]) test(`launch rejection after native Ready reconciles the actual reserved controller action (creation ${creation})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async creation => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'launch-ready-target' }, sourceScope = { ...scope, conversationId: 'launch-ready-source' };
    let reservation = { scope, viewId: 'launch-ready-view', label: 'launch-ready-child', transitionId: 'launch-ready-attempt', creationAgentId: creation ? 'default' : null, phase: 'assigned', bindingRevision: null, writerGeneration: null };
    const intentRef = { sourceScope, requestId: '1:launch-ready' }; let intent = { ...intentRef, action: creation ? { kind: 'create', agentId: 'default', carry: false } : { kind: 'open', scope, carry: false }, target: reservation, result: null }, launches = 0, reserves = 0, childBinding = null;
    if (!creation) { const owner = await S.claimEditor({ scope, viewId: reservation.viewId, label: 'old-child', transitionId: null, creation: { agentId: 'default' } }, () => {}); const drafts = owner.drafts(() => {}); await drafts.load(scope); await drafts.save({ version: 3, scope, draft: 'Saved launch text', draftRevision: 1, outbox: [], frontendSends: [], image: null }); await owner.close(); }
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return { kind: 'closed', reservation };
      if (command.kind === 'reserve') { reserves++; if (JSON.stringify(command.intentRef) !== JSON.stringify(intentRef)) throw new Error('Missing reserved request identity'); reservation = { ...reservation, phase: 'requested' }; return reservation; }
      if (command.kind === 'phase') { reservation = { ...reservation, phase: command.phase }; return { ok: true }; }
      if (command.kind === 'launch') {
        launches++; if (command.existingOnly) throw new Error('Only creating launch should reach this fixture');
        const child = await S.claimEditor({ scope, viewId: reservation.viewId, label: reservation.label, transitionId: reservation.transitionId, creation: creation ? { agentId: 'default' } : null }, () => {});
        childBinding = child.editorBinding(); reservation = { ...reservation, phase: 'target-ready', bindingRevision: childBinding.revision, writerGeneration: childBinding.writerGeneration }; intent = { ...intent, target: reservation }; await child.close(); throw new Error('intent-already-ready');
      }
      if (command.kind === 'read-intent') return intent;
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port); coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const f = globalThis.controllerFixture({ placement: coordinator }); await f.app.start();
    try { const placed = creation ? await f.app.createReserved(scope, 'default', intentRef) : await f.app.openReserved(scope, intentRef); return { placed, launches, reserves, childBinding, latest: f.app.getSnapshot().lastPlacement }; } finally { await f.app.dispose(); }
  }, creation);
  assert.equal(result.placed.kind, 'detached'); assert.equal(result.placed.label, 'launch-ready-child'); assert.equal(result.reserves, 1); assert.equal(result.launches, 1); assert.ok(result.childBinding.writerGeneration > 0); assert.equal(result.latest.kind, 'detached');
});

for (const creation of [false, true]) test(`ordinary creating launch failure returns a bounded refusal (creation ${creation})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async creation => {
    const scope = { hostId: 'host', conversationId: 'launch-error-target' }, reservation = { scope, viewId: 'launch-error-view', label: 'launch-error-child', transitionId: 'launch-error-attempt', creationAgentId: creation ? 'default' : null, phase: 'requested', bindingRevision: null, writerGeneration: null };
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return { kind: 'absent' }; if (command.kind === 'reserve') return reservation; if (command.kind === 'phase') return { ok: true }; if (command.kind === 'launch') throw new Error('window-load-failed'); throw new Error(command.kind);
    } }); coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    return await coordinator.acquire({ scope, creation, agentId: 'default', agentLabel: 'Default', carryFrom: null, initialDraft: null }, { storage: { viewId: 'catalog' }, holds: () => false, async quiesce() {}, async release() {} });
  }, creation);
  assert.equal(result.kind, 'refused'); assert.equal(result.reason, 'window-load-failed');
});

for (const assignment of ['reply', 'lost-reply', 'opening']) test(`assignment Ready proof completes before unavailable lookup and leaves the next queue request live (${assignment})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async assignment => {
    const sourceScope = { hostId: 'host', conversationId: 'assignment-source' }, scope = { ...sourceScope, conversationId: 'assignment-target' };
    const reservation = { scope, viewId: 'assignment-view', label: 'assignment-child', transitionId: 'assignment-attempt', creationAgentId: null, phase: 'target-ready', bindingRevision: 2, writerGeneration: 3 };
    let intent = { sourceScope, requestId: '1:assignment-ready', action: { kind: 'open', scope, carry: false }, target: null, result: null }, next = { ...intent, requestId: '1:assignment-next', target: reservation }, lookups = 0, assignments = 0, completed = [], hints = [];
    const main = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, snapshot: { placementNotice: null }, listeners: new Set(),
      controller: { getSnapshot: () => ({ busy: false, host: { kind: 'ready', metadata: { hostId: 'host' } }, saved: { pendingCreation: null } }), async inspectConversation() { return { agent: { id: 'default' }, continuation: { successor: { kind: 'confirmed', scope } } }; }, async openReserved() { throw new Error('No replacement placement is allowed'); } },
      port: { async request(command) {
        if (command.kind === 'read-intent') return command.requestId === intent.requestId ? intent : next;
        if (command.kind === 'lookup') { lookups++; if (assignments === 0) return { kind: assignment === 'opening' ? 'opening' : 'ready', reservation: assignment === 'opening' ? { ...reservation, phase: 'source-released' } : reservation }; throw new Error('Native lookup disconnected after assignment'); }
        if (command.kind === 'assign-intent') { assignments++; hints.push(command.viewId); intent = { ...intent, target: reservation }; if (assignment === 'lost-reply') throw new Error('Assignment reply lost'); return intent; }
        if (command.kind === 'launch') { if (!command.existingOnly) throw new Error('No creating launch is allowed'); return null; }
        if (command.kind === 'complete-intent') { if (command.result.kind === 'refused') throw new Error('Native Ready receipt cannot be revoked'); completed.push(command.requestId); if (command.requestId === intent.requestId) intent = { ...intent, result: command.result }; else next = { ...next, result: command.result }; return { ok: true }; }
        throw new Error(command.kind);
      } } });
    await main.processIntent(intent); await main.processIntent(next); return { lookups, assignments, completed, hints, result: intent.result, next: next.result, notice: main.snapshot.placementNotice };
  }, assignment);
  assert.equal(result.lookups, 0); assert.equal(result.assignments, 1); assert.deepEqual(result.completed, ['1:assignment-ready', '1:assignment-next']); assert.equal(result.result.kind, 'detached'); assert.equal(result.next.kind, 'detached'); assert.equal(result.notice, null);
});

for (const stage of ['startup', 'reconnect']) test(`catalog ${stage} leaves a completed closed separate chat alone until explicit open`, async t => {
  const page = await fixture(t), result = await page.evaluate(async stage => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'saved-closed-child' };
    let child = await S.claimEditor({ scope, viewId: 'saved-child-view', label: 'saved-child', transitionId: null, creation: { agentId: 'default' } }, () => {});
    const store = owner => globalThis.createConversationStore({ scope, port: { scope }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}) });
    let childStore = store(child); await childStore.ready; await childStore.setDraft('Closed child unsent bytes'); await child.saveView('host', { version: 2, route: scope, pendingCreation: null });
    const binding = child.editorBinding(); await childStore.dispose(); await child.close();
    const catalog = await S.open(() => {}, 'openpane.catalogViewId'); if (stage === 'startup') await catalog.saveNavigation('host', scope); const catalogId = catalog.viewId; await catalog.close();
    let native = { scope, viewId: 'saved-child-view', label: 'saved-child', transitionId: 'completed-original-attempt', creationAgentId: null, phase: 'target-ready', bindingRevision: binding.revision, writerGeneration: binding.writerGeneration };
    let explicit = false, backgroundReserves = 0, launches = 0, catalogOwner;
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return { kind: 'closed', reservation: native };
      if (command.kind === 'reserve') { if (!explicit) { backgroundReserves++; throw new Error('Background saved-route placement was not requested'); } native = { ...native, transitionId: 'explicit-new-attempt', phase: 'requested', bindingRevision: null, writerGeneration: null }; return native; }
      if (command.kind === 'phase') { native = { ...native, phase: command.phase }; return { ok: true }; }
      if (command.kind === 'launch') {
        launches++; child = await S.claimEditor({ scope, viewId: native.viewId, label: native.label, transitionId: native.transitionId, creation: null }, () => {}); childStore = store(child); await childStore.ready;
        native = { ...native, phase: 'target-ready', bindingRevision: child.editorBinding().revision, writerGeneration: child.editorBinding().writerGeneration }; return { kind: 'detached', scope, label: native.label };
      }
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port); coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const f = globalThis.controllerFixture({ placement: coordinator }); f.storage.catalogViewId = catalogId;
    f.storage.open = async failed => catalogOwner = await S.reopen(catalogId, failed, { waitForPreviousDocument: true, catalog: true });
    f.storage.locate = async requested => (await S.locateEditor(requested)).binding?.viewId ?? null;
    f.storage.reopen = async (viewId, failed) => { const current = await S.bindingForView(viewId); return current ? S.claimEditor({ scope: current.scope, viewId, label: 'main', transitionId: current.kind === 'handoff-reserved' ? current.transitionId : null, creation: null }, failed) : S.reopen(viewId, failed); };
    try {
      await f.app.start(); if (stage === 'reconnect') { await catalogOwner.saveNavigation('host', scope); await f.app.reconnect(); }
      const automatic = { backgroundReserves, launches, error: f.app.getSnapshot().error, last: f.app.getSnapshot().lastPlacement, active: f.app.getSnapshot().active, transition: native.transitionId };
      explicit = true; const opened = await f.app.open(scope);
      return { automatic, opened, launches, transition: native.transitionId, childDraft: (await childStore.captureDraft()).text, created: f.created.length, sent: f.submitted.length };
    } finally { await f.app.dispose(); await childStore.dispose(); await child.close(); }
  }, stage);
  assert.equal(result.automatic.backgroundReserves, 0, 'automatic catalog restoration never reserves a new native attempt'); assert.equal(result.automatic.launches, 0);
  assert.equal(result.automatic.error, ''); assert.equal(result.automatic.last, null); assert.equal(result.automatic.active, null); assert.equal(result.automatic.transition, 'completed-original-attempt');
  assert.equal(result.opened.kind, 'detached'); assert.equal(result.launches, 1); assert.equal(result.transition, 'explicit-new-attempt');
  assert.equal(result.childDraft, 'Closed child unsent bytes'); assert.equal(result.created, 0); assert.equal(result.sent, 0);
});


for (const fault of ['rejected', 'malformed', 'restore-failed']) test(`inline recovery validates the native grant before changing appearance (${fault})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async fault => {
    const scope = { hostId: 'host', conversationId: 'denied-recovery' };
    const reservation = { scope, viewId: 'denied-view', label: 'denied-child', transitionId: 'denied-attempt', creationAgentId: null, phase: 'failed', bindingRevision: null, writerGeneration: null };
    const calls = []; let selection = 'retro';
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, processing: false, closed: false, snapshot: { placementNotice: null }, listeners: new Set(),
      controller: { getSnapshot: () => ({ busy: false, host: { kind: 'ready', metadata: { hostId: 'host' } } }) },
      ui: { async restore() { calls.push('restore-appearance'); if (fault === 'restore-failed') throw new Error('Appearance restore unavailable'); selection = 'builtin'; } },
      port: { async request(command) {
        if (command.kind !== 'recover-inline') throw new Error('Unexpected command '+command.kind);
        calls.push('native-grant');
        if (fault === 'rejected') throw new Error('stale-recovery-reservation');
        if (fault === 'malformed') return {};
        return { scope, viewId: reservation.viewId, nativeLabel: reservation.label, fromTransitionId: reservation.transitionId, transitionId: 'inline:'+reservation.transitionId, targetLabel: 'main', creationAgentId: null };
      } }
    });
    await runtime.resumeWindow(reservation, true);
    return { calls, selection, notice: runtime.snapshot.placementNotice, processing: runtime.processing };
  }, fault);
  assert.deepEqual(result.calls, fault === 'restore-failed' ? ['native-grant', 'restore-appearance'] : ['native-grant']);
  assert.equal(result.selection, 'retro'); assert.equal(result.processing, false); assert.ok(result.notice);
  if (fault === 'rejected') assert.equal(result.notice, 'stale-recovery-reservation');
});


test('an unrelated unreadable inline carry does not block a different confirmed detached receipt', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries;
    const sourceScope = { hostId: 'host', conversationId: 'isolated-carry-source' }, targetScope = { hostId: 'host', conversationId: 'isolated-carry-target' }, activeScope = { hostId: 'host', conversationId: 'unrelated-inline' };
    const source = await S.claimEditor({ scope: sourceScope, viewId: 'isolated-source-view', label: 'source-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const activeOwner = await S.claimEditor({ scope: activeScope, viewId: 'unrelated-inline-view', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    let target = await S.claimEditor({ scope: targetScope, viewId: 'isolated-target-view', label: 'closed-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const make = (owner, scope) => globalThis.createConversationStore({ scope, port: { scope }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}) });
    const a = make(source, sourceScope), active = make(activeOwner, activeScope); let b = make(target, targetScope); await Promise.all([a.ready, active.ready, b.ready]);
    await a.setDraft('Independent carried text'); await b.setDraft('Original closed target'); await active.setDraft('Unrelated inline draft');
    const requestId = '1:independent-ready'; await c.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected: await a.captureDraft() });
    const ready = { scope: targetScope, viewId: target.viewId, label: 'closed-child', transitionId: 'independent-original', creationAgentId: null, phase: 'target-ready', bindingRevision: target.editorBinding().revision, writerGeneration: target.editorBinding().writerGeneration };
    await b.dispose(); await target.close();
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const brokenKey = ['draft-carry-target', 'host', activeScope.conversationId, 'dangling-fixture'];
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put({ source: { hostId: 'host', conversationId: 'missing-record' }, requestId: '1:missing' }, brokenKey); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    let intent = { sourceScope, requestId, action: { kind: 'open', scope: targetScope, carry: true }, target: ready, result: null }, completions = 0;
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, snapshot: { placementNotice: null }, listeners: new Set(),
      controller: { getSnapshot: () => ({ busy: false, host: { kind: 'ready', metadata: { hostId: 'host' } }, active: { scope: activeScope, viewId: activeOwner.viewId, store: active } }), async settleCarriedDraft() {} },
      port: { async request(command) { if (command.kind === 'read-intent') return intent; if (command.kind === 'launch' && command.existingOnly) return null; if (command.kind === 'complete-intent') { completions++; intent = { ...intent, result: command.result }; return { ok: true }; } throw new Error(command.kind); } }
    });
    await runtime.processIntent(intent);
    const before = { completions, receipt: intent.result, carry: (await c.sourceCarries(sourceScope))[0], source: (await a.captureDraft()).text, active: (await active.captureDraft()).text, notice: runtime.snapshot.placementNotice };
    target = await S.claimEditor({ scope: targetScope, viewId: ready.viewId, label: ready.label, transitionId: ready.transitionId, creation: null }, () => {}); b = make(target, targetScope); await b.ready;
    const childRuntime = (owner, scope, store) => Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat' }, port: null, controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope, viewId: owner.viewId, store } }) } });
    await childRuntime(target, targetScope, b).syncDraftCarries(); await childRuntime(source, sourceScope, a).syncDraftCarries(); const first = await b.captureDraft(); await childRuntime(target, targetScope, b).syncDraftCarries();
    const broken = await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readonly'), r = tx.objectStore('records').get(brokenKey); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const after = { source: (await a.captureDraft()).text, target: await b.captureDraft(), first, carry: (await c.sourceCarries(sourceScope))[0], broken };
    db.close(); await Promise.all([a.dispose(), b.dispose(), active.dispose()]); await Promise.all([source.close(), target.close(), activeOwner.close()]); return { before, after };
  });
  assert.equal(result.before.completions, 1); assert.equal(result.before.receipt.kind, 'detached'); assert.equal(result.before.receipt.label, 'closed-child');
  assert.equal(result.before.carry.kind, 'offered'); assert.equal(result.before.carry.target.conversationId, 'isolated-carry-target'); assert.equal(result.before.source, 'Independent carried text'); assert.equal(result.before.active, 'Unrelated inline draft'); assert.ok(result.before.notice);
  assert.equal(result.after.source, ''); assert.equal(result.after.target.text, 'Independent carried text\n\nOriginal closed target'); assert.deepEqual(result.after.target, result.after.first); assert.equal(result.after.carry.kind, 'settled'); assert.equal(result.after.broken.requestId, '1:missing');
});

for (const stage of ['focus', 'launch', 'creation']) for (const closes of [false, true]) test(`direct catalog ${stage} reconciles its exact Ready child after a lost reply (closes ${closes})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async ({ stage, closes }) => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'catalog-lost-reply' };
    let child, native, currentScope = scope, creates = 0, reserves = 0, lookups = 0;
    if (stage !== 'creation') {
      child = await S.claimEditor({ scope, viewId: 'catalog-reply-view', label: 'catalog-reply-child', transitionId: null, creation: { agentId: 'default' } }, () => {});
      const drafts = child.drafts(() => {}); await drafts.load(scope); await drafts.save({ version: 3, scope, draft: 'Catalog native text', draftRevision: 1, outbox: [], frontendSends: [], image: null });
      native = { scope, viewId: child.viewId, label: 'catalog-reply-child', transitionId: 'catalog-reply-attempt', creationAgentId: null, phase: 'source-released', bindingRevision: child.editorBinding().revision, writerGeneration: child.editorBinding().writerGeneration };
      if (stage === 'launch') { await child.close(); child = null; native = { ...native, phase: 'failed' }; }
    }
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') { lookups++; return native ? { kind: stage === 'focus' && native.phase !== 'target-ready' ? 'opening' : native.phase === 'target-ready' && child ? 'ready' : 'closed', reservation: native } : { kind: 'absent' }; }
      if (command.kind === 'reserve') { reserves++; currentScope = command.scope; native = { scope: command.scope, viewId: command.viewId, label: 'catalog-reply-child', transitionId: 'catalog-creating-attempt', creationAgentId: stage === 'creation' ? 'default' : null, phase: 'requested', bindingRevision: null, writerGeneration: null }; return native; }
      if (command.kind === 'phase') { native = { ...native, phase: command.phase }; return { ok: true }; }
      if (command.kind === 'launch') {
        creates++; if (!!command.existingOnly !== (stage === 'focus')) throw new Error('Only the original launch may run');
        if (!child) child = await S.claimEditor({ scope: currentScope, viewId: native.viewId, label: native.label, transitionId: native.transitionId, creation: stage === 'creation' ? { agentId: 'default' } : null }, () => {});
        const binding = child.editorBinding(); native = { ...native, phase: 'target-ready', bindingRevision: binding.revision, writerGeneration: binding.writerGeneration };
        if (closes) { await child.close(); child = null; }
        throw new Error('Original native launch reply lost');
      }
      if (command.kind === 'cancel-reservation') throw new Error('A completed reservation must not be cancelled');
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port); coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const f = globalThis.controllerFixture({ placement: coordinator }); await f.app.start();
    try { const placed = stage === 'creation' ? await f.app.create() : await f.app.open(scope); return { placed, creates, reserves, lookups, actualCreates: f.created.length, sent: f.submitted.length, latest: f.app.getSnapshot().lastPlacement }; }
    finally { await f.app.dispose(); await child?.close(); }
  }, { stage, closes });
  assert.equal(result.placed.kind, 'detached'); assert.equal(result.placed.label, 'catalog-reply-child'); assert.equal(result.latest.kind, 'detached'); assert.equal(result.creates, 1); assert.equal(result.reserves, stage === 'focus' ? 0 : 1); assert.equal(result.sent, 0); assert.ok(result.lookups >= 2);
});

for (const stage of ['focus', 'launch']) for (const outcome of ['unconfirmed', 'different-attempt']) test(`catalog ${stage} keeps its original launch error when follow-up readiness is ${outcome}`, async t => {
  const page = await fixture(t), result = await page.evaluate(async ({ stage, outcome }) => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'catalog-unconfirmed' };
    const editor = await S.claimEditor({ scope, viewId: 'catalog-unconfirmed-view', label: 'old-child', transitionId: null, creation: { agentId: 'default' } }, () => {}); await editor.close();
    let native = { scope, viewId: editor.viewId, label: 'catalog-unconfirmed-child', transitionId: 'original-attempt', creationAgentId: null, phase: stage === 'focus' ? 'source-released' : 'failed', bindingRevision: 1, writerGeneration: 1 }, launched = false, launches = 0;
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return { kind: stage === 'focus' && !launched ? 'opening' : 'closed', reservation: native };
      if (command.kind === 'reserve') { native = { ...native, phase: 'requested', transitionId: 'creating-original-attempt' }; return native; }
      if (command.kind === 'phase') { native = { ...native, phase: command.phase }; return { ok: true }; }
      if (command.kind === 'launch') { launches++; launched = true; if (outcome === 'different-attempt') native = { ...native, transitionId: 'unrelated-ready-attempt', phase: 'target-ready' }; throw new Error('Original specific window failure'); }
      throw new Error(command.kind);
    } }); coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const f = globalThis.controllerFixture({ placement: coordinator }); await f.app.start();
    try { return { placed: await f.app.open(scope), launches }; } finally { await f.app.dispose(); }
  }, { stage, outcome });
  assert.equal(result.placed.kind, 'refused'); assert.equal(result.placed.reason, 'Original specific window failure'); assert.equal(result.launches, 1);
});

test('a delegated opening that reaches Ready before inline admission keeps its detached receipt and child draft', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, sourceScope = { hostId: 'host', conversationId: 'inline-race-source' }, scope = { ...sourceScope, conversationId: 'inline-race-target' };
    const child = await S.claimEditor({ scope, viewId: 'inline-race-view', label: 'inline-race-child', transitionId: null, creation: { agentId: 'default' } }, () => {});
    const drafts = child.drafts(() => {}); await drafts.load(scope); await drafts.save({ version: 3, scope, draft: 'Child text remains closed', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    const originalBinding = child.editorBinding(); let native = { scope, viewId: child.viewId, label: 'inline-race-child', transitionId: 'inline-race-attempt', creationAgentId: null, phase: 'source-released', bindingRevision: originalBinding.revision, writerGeneration: originalBinding.writerGeneration };
    let intent = { sourceScope, requestId: '1:inline-admission-race', action: { kind: 'open', scope, carry: false }, target: native, result: null }, lookups = 0, launches = 0;
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'read-intent') return intent;
      if (command.kind === 'lookup') { if (++lookups === 1) { const observed = { kind: 'opening', reservation: native }; native = { ...native, phase: 'target-ready' }; intent = { ...intent, target: native }; await child.close(); return observed; } return { kind: 'closed', reservation: native }; }
      if (command.kind === 'launch') { launches++; throw new Error('Closed historical child must not be launched'); }
      if (command.kind === 'complete-intent') { intent = { ...intent, result: command.result }; return { ok: true }; }
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port); coordinator.setPresentation(null);
    const f = globalThis.controllerFixture({ placement: coordinator }); f.behavior.continuation = async input => ({ predecessor: null, carried: null, closure: null, successor: input.scope.conversationId === sourceScope.conversationId ? { kind: 'confirmed', scope } : null }); await f.app.start();
    const main = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, controller: f.app, coordinator, port, snapshot: { placementNotice: null }, listeners: new Set() });
    try { await main.processIntent(intent); const binding = (await S.locateEditor(scope)).binding; const text = await new Promise((resolve, reject) => { const open = indexedDB.open('openpane-browser-views', 1); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result, tx = db.transaction('records'), get = tx.objectStore('records').get(['draft', child.viewId, scope.hostId, scope.conversationId]); get.onsuccess = () => resolve(get.result?.draft); get.onerror = () => reject(get.error); tx.oncomplete = () => db.close(); }; }); return { text, receipt: intent.result, active: f.app.getSnapshot().active?.scope ?? null, binding, originalBinding, launches, lookups, created: f.created.length }; } finally { await f.app.dispose(); await child.close(); }
  });
  assert.deepEqual(result.receipt, { kind: 'detached', scope: { hostId: 'host', conversationId: 'inline-race-target' }, label: 'inline-race-child' }); assert.equal(result.active, null); assert.deepEqual(result.binding, result.originalBinding); assert.equal(result.text, 'Child text remains closed'); assert.equal(result.launches, 0); assert.equal(result.created, 0); assert.equal(result.lookups, 2);
});

test('inline catalog restoration leaves the child binding closed but preserves later explicit main restoration', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'inline-saved-child' };
    const child = await S.claimEditor({ scope, viewId: 'inline-saved-view', label: 'inline-saved-child', transitionId: null, creation: { agentId: 'default' } }, () => {});
    const drafts = child.drafts(() => {}); await drafts.load(scope); await drafts.save({ version: 3, scope, draft: 'Saved inline recovery text', draftRevision: 1, outbox: [], frontendSends: [], image: null }); await child.saveView('host', { version: 2, route: scope, pendingCreation: null });
    const binding = child.editorBinding(); await child.close(); const catalog = await S.open(() => {}, 'openpane.catalogViewId'); await catalog.saveNavigation('host', scope); const catalogId = catalog.viewId; await catalog.close();
    const native = { scope, viewId: child.viewId, label: 'inline-saved-child', transitionId: 'inline-saved-original', creationAgentId: null, phase: 'target-ready', bindingRevision: binding.revision, writerGeneration: binding.writerGeneration }; let launches = 0, reserves = 0;
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', label: 'main', liveRelay: true }, async request(command) { if (command.kind === 'lookup') return { kind: 'closed', reservation: native }; if (command.kind === 'launch') launches++; if (command.kind === 'reserve') reserves++; throw new Error('Native placement was not requested'); } }); coordinator.setPresentation(null);
    const make = () => { const f = globalThis.controllerFixture({ placement: coordinator }); f.storage.catalogViewId = catalogId;
      f.storage.open = failed => S.reopen(catalogId, failed, { waitForPreviousDocument: true, catalog: true });
      f.storage.locate = async requested => (await S.locateEditor(requested)).binding?.viewId ?? null;
      f.storage.reopen = async (viewId, failed) => { const current = await S.bindingForView(viewId); return current ? S.claimEditor({ scope: current.scope, viewId, label: 'main', transitionId: current.kind === 'handoff-reserved' ? current.transitionId : null, creation: null }, failed) : S.reopen(viewId, failed); }; return f;
    };
    let f = make();
    try {
      await f.app.start(); const automatic = { active: f.app.getSnapshot().active?.scope ?? null, last: f.app.getSnapshot().lastPlacement, error: f.app.getSnapshot().error, binding: (await S.locateEditor(scope)).binding };
      const explicit = await f.app.open(scope); const mainBinding = (await S.locateEditor(scope)).binding; await f.app.dispose(); f = make(); await f.app.start();
      return { automatic, explicit, mainBinding, restored: f.app.getSnapshot().active?.scope ?? null, draft: f.app.getSnapshot().active?.store.getSnapshot().draft, launches, reserves, originalBinding: binding, error: f.app.getSnapshot().error };
    } finally { await f.app.dispose(); }
  });
  assert.equal(result.automatic.active, null); assert.equal(result.automatic.last, null); assert.equal(result.automatic.error, ''); assert.deepEqual(result.automatic.binding, result.originalBinding);
  assert.equal(result.explicit.kind, 'inline'); assert.ok(result.mainBinding.writerGeneration > result.originalBinding.writerGeneration); assert.deepEqual(result.restored, { hostId: 'host', conversationId: 'inline-saved-child' }); assert.equal(result.draft, 'Saved inline recovery text'); assert.equal(result.error, ''); assert.equal(result.launches, 0); assert.equal(result.reserves, 0);
});


for (const failure of ['once', 'persistent']) test(`a failed pending catalog lookup does not block unrelated native receipts (${failure})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async failure => {
    const S = globalThis.BrowserViewStorage, catalogScope = { hostId: 'host', conversationId: 'pending-catalog' }, sourceScope = { hostId: 'host', conversationId: 'queued-source' };
    const original = { scope: catalogScope, viewId: 'pending-catalog-view', label: 'pending-child', transitionId: 'pending-original', creationAgentId: null, phase: 'source-released', bindingRevision: null, writerGeneration: null };
    const catalog = await S.reopen('lookup-isolation-catalog', () => {}); let armed = false, lookupFailures = 0, settled = 0, reads = 0; const completed = [], diagnostics = [];
    const pendingIntents = ['one', 'two'].map(id => { const scope = { hostId: 'host', conversationId: 'queued-'+id }; return { sourceScope, requestId: '1:'+id, action: { kind: 'open', scope, carry: false }, target: { ...original, scope, viewId: id, label: id, transitionId: id, phase: 'target-ready', bindingRevision: 1, writerGeneration: 1 }, result: null }; });
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') {
        if (armed && (failure === 'persistent' || lookupFailures === 0)) { lookupFailures++; throw new Error('Unrelated catalog lookup unavailable'); }
        return { kind: armed ? 'ready' : 'opening', reservation: armed ? { ...original, phase: 'target-ready', bindingRevision: 1, writerGeneration: 1 } : original };
      }
      if (command.kind === 'launch') return command.existingOnly && command.scope.conversationId === catalogScope.conversationId ? { kind: 'pending', scope: catalogScope, reason: 'Waiting for original child' } : null;
      if (command.kind === 'reservations') return [original];
      if (command.kind === 'pending-intents') { reads++; return pendingIntents.filter(intent => intent.result === null); }
      if (command.kind === 'read-intent') return pendingIntents.find(intent => intent.requestId === command.requestId);
      if (command.kind === 'complete-intent') { const intent = pendingIntents.find(intent => intent.requestId === command.requestId); intent.result = command.result; completed.push(command.requestId); return { ok: true }; }
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port);
    const pending = await coordinator.acquire({ scope: catalogScope, creation: false, agentId: 'agent', agentLabel: 'Agent', carryFrom: null, initialDraft: null }, { storage: catalog, holds: () => false, async quiesce() {}, async release() {} });
    if (pending.kind !== 'pending' || !coordinator.pendingReservation(pending)) throw new Error('Fixture requires actual coordinator pending provenance');
    let latest = pending;
    const controller = { getSnapshot: () => ({ busy: false, storageFailure: null, host: { kind: 'ready', metadata: { hostId: 'host' } }, active: null, saved: { pendingCreation: null }, lastPlacement: latest }), pendingPlacements: () => latest === pending ? [pending] : [],
      settlePlacement(expected, result) { if (expected !== pending || latest !== pending) return false; latest = result; settled++; return true; }, async settleCarriedDraft() {} };
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, controller, coordinator, port, processing: false, closed: false, recoveryDirty: true, catalogDirty: false, policyScope: null, carryRecoveryAfter: null, carrySettlementAfter: null,
      snapshot: { recovery: { kind: 'none' }, placementNotice: null }, listeners: new Set(), ui: { getSnapshot: () => ({ state: null }) } });
    runtime.listeners.add(() => { if (runtime.snapshot.placementNotice) diagnostics.push(runtime.snapshot.placementNotice); });
    armed = true; await runtime.drive(); const first = { completed: [...completed], reads, retained: latest === pending, failures: lookupFailures };
    await runtime.drive(); const after = { completed: [...completed], reads, retained: latest === pending, settled, failures: lookupFailures, diagnostics };
    await catalog.close(); return { first, after };
  }, failure);
  assert.deepEqual(result.first.completed, ['1:one', '1:two']); assert.equal(result.first.reads, 1); assert.equal(result.first.retained, true); assert.equal(result.first.failures, 1);
  assert.deepEqual(result.after.completed, ['1:one', '1:two']); assert.equal(result.after.reads, 2); assert.equal(result.after.settled, failure === 'once' ? 1 : 0); assert.equal(result.after.retained, failure === 'persistent'); assert.ok(result.after.diagnostics.includes('Unrelated catalog lookup unavailable'));
});

for (const mode of ['process-inline', 'resume-inline', 'resume-separate']) test(`unrelated unreadable carry cannot block successful ${mode} receipts or the next queued request`, async t => {
  const page = await fixture(t), result = await page.evaluate(async mode => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, sourceScope = { hostId: 'host', conversationId: 'receipt-source' }, targetScope = { hostId: 'host', conversationId: 'receipt-target' };
    const activeScope = mode === 'resume-separate' ? { hostId: 'host', conversationId: 'unrelated-active' } : targetScope;
    const source = await S.claimEditor({ scope: sourceScope, viewId: 'receipt-source-view', label: 'source-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const target = await S.claimEditor({ scope: targetScope, viewId: 'receipt-target-view', label: mode === 'resume-separate' ? 'target-child' : 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const activeOwner = mode === 'resume-separate' ? await S.claimEditor({ scope: activeScope, viewId: 'unrelated-active-view', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {}) : target;
    const make = (owner, scope) => globalThis.createConversationStore({ scope, port: { scope }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}) });
    const a = make(source, sourceScope), b = make(target, targetScope), active = activeOwner === target ? b : make(activeOwner, activeScope); await Promise.all([a.ready, b.ready, active.ready]);
    await a.setDraft('Requested carried text'); await b.setDraft('Original destination'); if (active !== b) await active.setDraft('Unrelated active draft');
    await source.saveView('host', { version: 2, route: sourceScope, pendingCreation: null }); await target.saveView('host', { version: 2, route: targetScope, pendingCreation: null }); if (activeOwner !== target) await activeOwner.saveView('host', { version: 2, route: activeScope, pendingCreation: null });
    const requestId = '1:receipt-first'; if (mode === 'resume-separate') await c.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected: await a.captureDraft() });
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const brokenKey = ['draft-carry-target', 'host', activeScope.conversationId, 'unrelated-missing-record'];
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put({ source: { hostId: 'host', conversationId: 'missing' }, requestId: '1:missing' }, brokenKey); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const reservation = { scope: targetScope, viewId: target.viewId, label: 'target-child', transitionId: 'receipt-attempt', creationAgentId: null, phase: mode === 'process-inline' ? 'source-released' : 'failed', bindingRevision: 1, writerGeneration: 1 };
    const intents = [requestId, '1:receipt-second'].map((id, index) => ({ sourceScope, requestId: id, action: { kind: 'open', scope: targetScope, carry: mode === 'resume-separate' && index === 0 }, target: { ...reservation, phase: 'assigned' }, result: null }));
    let opened = 0; const activeView = { scope: activeScope, viewId: activeOwner.viewId, store: active };
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'read-intent') return intents.find(intent => intent.requestId === command.requestId);
      if (command.kind === 'lookup') return { kind: 'opening', reservation };
      if (command.kind === 'pending-intents') return intents.filter(intent => !intent.result);
      if (command.kind === 'complete-intent') { intents.find(intent => intent.requestId === command.requestId).result = command.result; return { ok: true }; }
      if (command.kind === 'recover-inline') return { scope: targetScope, viewId: target.viewId, nativeLabel: reservation.label, fromTransitionId: reservation.transitionId, transitionId: 'inline:receipt-attempt', targetLabel: 'main', creationAgentId: null };
      if (command.kind === 'phase' || command.kind === 'carry-applied') return { ok: true };
      if (command.kind === 'launch' && command.existingOnly) return { kind: 'detached', scope: targetScope, label: reservation.label };
      throw new Error(command.kind);
    } };
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, processing: false, closed: false, recoveryDirty: false, catalogDirty: false, policyScope: null, snapshot: { placementNotice: null }, listeners: new Set(), port,
      ui: { async restore() {}, getSnapshot: () => ({ state: null, localBuiltin: true, confirmedGeneration: null, validatedVisual: { kind: 'none' }, deliveryContext: null }) }, refreshRecovery: async () => {},
      controller: { getSnapshot: () => ({ busy: false, storageFailure: '', host: { kind: 'ready', metadata: { hostId: 'host' } }, active: activeView, saved: { pendingCreation: null }, lastPlacement: null }), pendingPlacements: () => [],
        async inspectConversation() { return { agent: { id: 'agent' }, continuation: { successor: { kind: 'confirmed', scope: targetScope } } }; },
        async openReserved() { opened++; return mode === 'resume-separate' ? { kind: 'detached', scope: targetScope, label: reservation.label } : { kind: 'inline', scope: targetScope }; }, async refreshCatalog() {},
        async settleCarriedDraft(carry) { await a.transferDraft(carry.expected, '', { kind: 'release', source: carry.source, requestId: carry.requestId }); }
      } });
    runtime.coordinator = new globalThis.WindowCoordinator(port);
    try {
      if (mode === 'process-inline') await runtime.drive(); else await runtime.resumeWindow(reservation, mode === 'resume-inline');
      const before = { receipts: intents.map(intent => intent.result), notice: runtime.snapshot.placementNotice, carry: (await c.sourceCarries(sourceScope))[0] ?? null, activeText: (await active.captureDraft()).text };
      if (mode === 'resume-separate') {
        const child = (owner, scope, store) => Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat' }, port: null, controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope, viewId: owner.viewId, store } }) } });
        await child(target, targetScope, b).syncDraftCarries(); await child(source, sourceScope, a).syncDraftCarries(); const first = await b.captureDraft(); await child(target, targetScope, b).syncDraftCarries();
        before.receivedOnce = JSON.stringify(first) === JSON.stringify(await b.captureDraft());
      }
      const broken = await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readonly'), r = tx.objectStore('records').get(brokenKey); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      return { before, opened, sourceText: (await a.captureDraft()).text, targetText: (await b.captureDraft()).text, broken };
    } finally { db.close(); await Promise.all([a.dispose(), b.dispose(), ...(active === b ? [] : [active.dispose()])]); await Promise.all([source.close(), target.close(), ...(activeOwner === target ? [] : [activeOwner.close()])]); }
  }, mode);
  assert.equal(result.before.receipts.length, 2); for (const receipt of result.before.receipts) assert.equal(receipt?.kind, mode === 'resume-separate' ? 'detached' : 'inline');
  assert.ok(result.before.notice, 'the unrelated damaged transfer remains visible'); assert.equal(result.broken.requestId, '1:missing');
  if (mode === 'resume-separate') { assert.equal(result.before.carry.target.conversationId, 'receipt-target'); assert.equal(result.before.activeText, 'Unrelated active draft'); assert.equal(result.sourceText, ''); assert.equal(result.targetText, 'Requested carried text\n\nOriginal destination'); assert.equal(result.before.receivedOnce, true); }
  else { assert.equal(result.sourceText, 'Requested carried text'); assert.equal(result.targetText, 'Original destination'); }
});


for (const bindingMode of ['bound', 'late-bound']) for (const control of ['new-chat', 'new-successor']) test(`child Keep survives reconnect without reoffering to its successor (${bindingMode}, ${control})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async ({ bindingMode, control }) => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, sourceScope = { hostId: 'host', conversationId: 'kept-child-source' }, oldScope = { hostId: 'host', conversationId: 'kept-child-successor' }, nextScope = { hostId: 'host', conversationId: 'different-successor' };
    const make = (owner, scope) => globalThis.createConversationStore({ scope, port: { scope }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}) });
    const seed = await S.claimEditor({ scope: sourceScope, viewId: 'kept-child-source-view', label: 'source-child', transitionId: null, creation: { agentId: 'default' } }, () => {}), seedStore = make(seed, sourceScope); await seedStore.ready; await seedStore.setDraft('Keep these exact source bytes'); await seed.saveView('host', { version: 2, route: sourceScope, pendingCreation: null }); await seedStore.dispose(); await seed.close();
    const destinations = new Map();
    async function destination(scope) { let found = destinations.get(scope.conversationId); if (found) return found; const owner = await S.claimEditor({ scope, viewId: `view-${scope.conversationId}`, label: `child-${scope.conversationId}`, transitionId: null, creation: { agentId: 'default' } }, () => {}), store = make(owner, scope); await store.ready; await owner.saveView('host', { version: 2, route: scope, pendingCreation: null }); found = { owner, store }; destinations.set(scope.conversationId, found); return found; }
    const old = await destination(oldScope); await old.store.setDraft('Successor original text');
    const records = new Map(), requests = []; let started = false, advanced = false, sourceOwner;
    const childContext = { role: 'chat', version: 1, label: 'source-child', brokerInstance: 'broker', documentIncarnation: 'source-document', viewId: 'kept-child-source-view', liveRelay: true,
      reservation: { scope: sourceScope, viewId: 'kept-child-source-view', label: 'source-child', transitionId: 'source-attempt', creationAgentId: null, phase: 'target-ready', bindingRevision: 1, writerGeneration: 1 } };
    const port = { context: childContext, async request(command) {
      if (command.kind === 'intent-context') return { epoch: 1, pendingCarryRequests: [] };
      if (command.kind === 'placement-intent') {
        const targetScope = command.action.kind === 'create' ? { hostId: 'host', conversationId: 'fresh-created' } : command.action.scope, target = await destination(targetScope);
        const first = requests.length === 0, pending = first && bindingMode === 'late-bound'; requests.push({ requestId: command.requestId, action: command.action });
        if (command.action.carry && !pending) await c.bindDraftCarry(sourceScope, command.requestId, targetScope);
        const native = { scope: targetScope, viewId: target.owner.viewId, label: `child-${targetScope.conversationId}`, transitionId: `attempt-${targetScope.conversationId}`, creationAgentId: command.action.kind === 'create' ? command.action.agentId : null,
          phase: pending ? 'assigned' : 'target-ready', bindingRevision: target.owner.editorBinding().revision, writerGeneration: target.owner.editorBinding().writerGeneration };
        const intent = { sourceScope, requestId: command.requestId, action: command.action, target: native, result: pending ? null : { kind: 'detached', scope: targetScope, label: native.label } }; records.set(intent.requestId, intent); return intent;
      }
      if (command.kind === 'own-intents') return { epoch: 1, pending: [...records.values()].filter(intent => !intent.result), items: [...records.values()].filter(intent => intent.result), after: null };
      if (command.kind === 'read-intent') return records.get(command.requestId) ?? null;
      if (command.kind === 'carry-applied') return { ok: true };
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port), f = globalThis.controllerFixture({ placement: coordinator, fixedScope: sourceScope });
    f.storage.open = async failure => sourceOwner = await S.claimEditor({ scope: sourceScope, viewId: 'kept-child-source-view', label: 'source-child', transitionId: null, creation: null }, failure);
    f.storage.reopen = async () => { throw new Error('A child keeps its assigned editor'); };
    const none = { predecessor: null, carried: null, closure: null, successor: null };
    f.behavior.continuation = async input => { if (input.action === 'start') started = true; if (input.scope.conversationId === sourceScope.conversationId) return { ...none, closure: 'cancelled', successor: started ? { kind: 'confirmed', scope: oldScope } : null }; if (advanced && input.scope.conversationId === oldScope.conversationId) return { ...none, closure: 'cancelled', successor: { kind: 'confirmed', scope: nextScope } }; return none; };
    const wait = async predicate => { for (let n = 0; n < 400; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Continuation did not reach its recorded native request: '+JSON.stringify({ requests, host: f.app.getSnapshot().host, error: f.app.getSnapshot().error, continuation: f.app.getSnapshot().continuation, active: f.app.getSnapshot().active?.scope })); };
    let child;
    try {
      await f.app.start(); child = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: childContext, childOwner: sourceOwner, controller: f.app, coordinator, port, historyEpoch: 1, requestHistory: new Map(), historyAfter: null, historyExtended: false, pendingIntents: new Map(), pendingIntent: null, recoveryDirty: false,
        snapshot: { placementNotice: null, recovery: { kind: 'chat', pending: [], history: [], after: null, carries: [] } }, listeners: new Set() }); child.configurePlacementTracking();
      await wait(() => Boolean(f.app.getSnapshot().continuation?.view)); const original = f.app.getSnapshot().active;
      await f.app.conversationActions(original).continueConversation(); const first = requests[0];
      await child.keepDraft(first.requestId);
      if (bindingMode === 'late-bound') { await c.bindDraftCarry(sourceScope, first.requestId, oldScope); const intent = records.get(first.requestId); records.set(first.requestId, { ...intent, target: { ...intent.target, phase: 'target-ready' }, result: { kind: 'detached', scope: oldScope, label: intent.target.label } }); await child.refreshRecovery(); }
      f.connectionLost(new globalThis.ServiceConnectionLost('Recorded source disconnect')); await f.app.reconnect(); await wait(() => requests.length >= 2 && !f.app.getSnapshot().busy);
      const receiver = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat' }, port: null, controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope: oldScope, viewId: old.owner.viewId, store: old.store } }) } });
      await receiver.syncDraftCarries(); await child.syncDraftCarries();
      const afterKeep = { source: (await sourceOwner.drafts(() => {}).load(sourceScope))?.draft ?? null, target: (await old.store.captureDraft()).text, secondCarry: requests[1].action.carry, carries: await c.sourceCarries(sourceScope) };
      if (control === 'new-chat') await f.app.conversationActions(f.app.getSnapshot().active).startNewChat();
      else { advanced = true; f.connectionLost(new globalThis.ServiceConnectionLost('Recorded source disconnect for a newer successor')); await f.app.reconnect(); await wait(() => requests.length >= 3 && !f.app.getSnapshot().busy); }
      const last = requests.at(-1); return { afterKeep, firstCarry: first.action.carry, lastAction: last.action, requests: requests.length, sent: f.submitted.length };
    } finally { await f.app.dispose(); for (const target of destinations.values()) { await target.store.dispose(); await target.owner.close(); } }
  }, { bindingMode, control });
  assert.equal(result.firstCarry, true); assert.equal(result.afterKeep.secondCarry, false, 'a new continuation request respects the prior Keep decision');
  assert.equal(result.afterKeep.source, 'Keep these exact source bytes'); assert.equal(result.afterKeep.target, 'Successor original text'); assert.equal(result.afterKeep.carries.length, 1); assert.equal(result.afterKeep.carries[0].kind, 'cancelled');
  assert.equal(result.lastAction.carry, true, 'a different successor or explicit new chat can still carry'); assert.equal(result.lastAction.kind, control === 'new-chat' ? 'create' : 'open'); assert.equal(result.requests, 3); assert.equal(result.sent, 0);
});


test('settling failed opening A preserves the confirmed policy placement of retained B', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const b = { hostId: 'host', conversationId: 'policy-retained-b' }, a = { ...b, conversationId: 'policy-failed-a' };
    let failed = false, bLookups = 0, reservation;
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') { if (command.scope.conversationId === b.conversationId) { bLookups++; throw new Error('B policy attempted'); } return reservation ? { kind: 'opening', reservation: { ...reservation, phase: failed ? 'failed' : 'source-released' } } : { kind: 'absent' }; }
      if (command.kind === 'reserve') { reservation = { scope: a, viewId: command.viewId, label: 'failed-a-child', transitionId: 'failed-a-attempt', creationAgentId: 'default', phase: 'requested', bindingRevision: null, writerGeneration: null }; return reservation; }
      if (command.kind === 'launch') return { kind: 'pending', scope: a, reason: 'Opening A' };
      if (command.kind === 'reservations') return [reservation];
      if (command.kind === 'pending-intents') return [];
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port); let starting = true;
    const f = globalThis.controllerFixture({ placement: { acquire(request, owner) { return starting ? Promise.resolve({ kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } }) : coordinator.acquire(request, owner); } } });
    f.views.set('original-view/host', { version: 2, route: b, pendingCreation: null }); await f.app.start(); starting = false;
    const original = f.app.getSnapshot().active; await original.store.setDraft('Retained B exact draft');
    coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    await f.app.createReserved(a, 'default'); const pending = f.app.getSnapshot().lastPlacement;
    const digest = 'a'.repeat(64), delivery = JSON.stringify([globalThis.windowContext('main-context'), 2, 2, digest]);
    const ui = { getSnapshot: () => ({ state: { selection: { deliveryGeneration: 2, revision: 2, selected: { kind: 'bundle', digest } }, bundle: { digest }, transitions: [] }, localBuiltin: false, deliveryContext: globalThis.windowContext('main-context'), confirmedGeneration: 2, validatedVisual: { kind: 'delivery', context: globalThis.windowContext('main-context'), generation: 2, revision: 2, digest } }) };
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, controller: f.app, coordinator, port, ui, policyScope: b, policyDelivery: delivery, policyAppliedScope: null,
      processing: false, closed: false, recoveryDirty: true, catalogDirty: false, carryRecoveryAfter: null, carrySettlementAfter: null, listeners: new Set(), snapshot: { placementNotice: null } });
    try { failed = true; await runtime.drive(); return { pending: pending.kind, bLookups, latest: f.app.getSnapshot().lastPlacement, draft: original.store.getSnapshot().draft, sameActive: f.app.getSnapshot().active === original, created: f.created.length, sent: f.submitted.length }; }
    finally { await f.app.dispose(); }
  });
  assert.equal(result.pending, 'pending'); assert.equal(result.bLookups, 1, 'settling A must not cancel the queued placement of B'); assert.equal(result.latest.reason, 'B policy attempted');
  assert.equal(result.sameActive, true); assert.equal(result.draft, 'Retained B exact draft'); assert.equal(result.created, 0); assert.equal(result.sent, 0);
});

test('same-epoch authoritative absence resolves an ambiguous child admission and releases its offered draft', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'absent-admission-source' };
    const context = { role: 'chat', label: 'source-child', viewId: 'absent-admission-view', reservation: { scope }, liveRelay: true };
    let owner, uncertain = true, submissions = 0;
    const port = { context, async request(command) {
      if (command.kind === 'intent-context') return { epoch: 1, pendingCarryRequests: [] };
      if (command.kind === 'placement-intent') { submissions++; throw new Error('Admission unavailable'); }
      if (command.kind === 'read-intent') { if (uncertain) throw new Error('Read unavailable'); return null; }
      if (command.kind === 'own-intents') return { epoch: 1, pending: [], items: [], after: null };
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port), f = globalThis.controllerFixture({ placement: coordinator, fixedScope: scope });
    f.storage.open = async failure => { owner = await S.claimEditor({ scope, viewId: context.viewId, label: context.label, transitionId: null, creation: { agentId: 'default' } }, failure); await owner.saveView('host', { version: 2, route: scope, pendingCreation: null }); return owner; };
    try {
      await f.app.start(); const active = f.app.getSnapshot().active; await active.store.setDraft('Ambiguous admission exact source bytes');
      const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context, childOwner: owner, controller: f.app, coordinator, port, historyEpoch: 1, requestHistory: new Map(), historyAfter: null, historyExtended: false, pendingIntents: new Map(), pendingIntent: null, recoveryDirty: false,
        snapshot: { placementNotice: null, recovery: { kind: 'chat', pending: [], history: [], after: null, carries: [] } }, listeners: new Set() }); runtime.configurePlacementTracking();
      await f.app.conversationActions(active).startNewChat(); const before = { placement: f.app.getSnapshot().lastPlacement.kind, carry: (await c.sourceCarries(scope))[0].kind, pending: runtime.pendingIntents.size };
      uncertain = false; await runtime.readRecovery(); const settled = { placement: f.app.getSnapshot().lastPlacement, carry: (await c.sourceCarries(scope))[0].kind, pending: runtime.pendingIntents.size, notice: runtime.snapshot.placementNotice };
      const expected = await active.store.captureDraft(); let offerError = null; try { await c.offerDraftCarry({ source: scope, sourceViewId: owner.viewId, requestId: '1:after-authoritative-absence', writerGeneration: owner.editorBinding().writerGeneration, expected }); } catch (error) { offerError = String(error); }
      return { before, settled, offerError, source: (await owner.drafts(() => {}).load(scope)).draft, carries: (await c.sourceCarries(scope)).map(row => row.kind), submissions, created: f.created.length, sent: f.submitted.length };
    } finally { await f.app.dispose(); }
  });
  assert.deepEqual(result.before, { placement: 'pending', carry: 'offered', pending: 1 }); assert.equal(result.settled.placement.kind, 'refused'); assert.equal(result.settled.carry, 'refused'); assert.equal(result.settled.pending, 0); assert.match(result.settled.notice, /no recorded result|not recorded/i);
  assert.equal(result.offerError, null); assert.equal(result.source, 'Ambiguous admission exact source bytes'); assert.deepEqual(result.carries.sort(), ['offered', 'refused']); assert.equal(result.submissions, 1); assert.equal(result.created, 0); assert.equal(result.sent, 0);
});

for (const mode of ['reply', 'reject', 'repeat-warning']) test(`a ready successor still focuses when its draft Keep decision is unreadable (${mode})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async mode => {
    const focusRejects = mode === 'reject';
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'ready-focus-source' }, targetScope = { ...scope, conversationId: 'ready-focus-target' };
    let owner, focuses = 0, captured = 0;
    const target = await S.claimEditor({ scope: targetScope, viewId: 'ready-focus-target-view', label: 'ready-focus-child', transitionId: null, creation: { agentId: 'default' } }, () => {});
    const b = globalThis.createConversationStore({ scope: targetScope, port: { scope: targetScope }, projection: globalThis.transcriptProjection, drafts: target.drafts(() => {}) }); await b.ready; await b.setDraft('Existing target bytes');
    const binding = target.editorBinding(), reservation = { scope: targetScope, viewId: target.viewId, label: 'ready-focus-child', transitionId: 'ready-focus-attempt', creationAgentId: null, phase: 'target-ready', bindingRevision: binding.revision, writerGeneration: binding.writerGeneration };
    const context = { role: 'main', label: 'main', liveRelay: true }, port = { context, async request(command) {
      if (command.kind === 'lookup') return command.scope.conversationId === targetScope.conversationId ? { kind: 'ready', reservation } : { kind: 'absent' };
      if (command.kind === 'launch' && command.existingOnly) { focuses++; if (focusRejects) throw new Error('Focus reply unavailable'); return { kind: 'detached', scope: targetScope, label: reservation.label }; }
      if (command.kind === 'pending-intents') return [];
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port), f = globalThis.controllerFixture({ placement: coordinator });
    f.storage.open = async failure => { owner = await S.claimEditor({ scope, viewId: 'ready-focus-source-view', label: 'main', transitionId: null, creation: { agentId: 'default' } }, failure); await owner.saveView('host', { version: 2, route: scope, pendingCreation: null }); return owner; };
    let continued = false; const none = { predecessor: null, carried: null, closure: null, successor: null };
    f.behavior.continuation = async input => input.scope.conversationId === scope.conversationId ? { ...none, closure: 'cancelled', successor: continued ? { kind: 'confirmed', scope: targetScope } : null } : none;
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const markerKey = ['draft-carry-kept', 'host', scope.conversationId, targetScope.conversationId], malformed = { damaged: 'Keep source bytes' };
    try {
      await f.app.start(); const active = f.app.getSnapshot().active; await active.store.setDraft('Source bytes must stay exactly');
      await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(malformed, markerKey); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      const unrelated = { kind: 'pending', scope: { ...scope, conversationId: 'unrelated-pending' }, reason: 'Unrelated request pending' };
      const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context, controller: f.app, coordinator, port, listeners: new Set(), pendingIntents: new Map([['1:unrelated', unrelated]]), pendingIntent: { requestId: '1:unrelated', result: unrelated }, snapshot: { placementNotice: mode === 'repeat-warning' ? 'The saved Keep decision is unreadable. Its original record is preserved.' : null }, processing: false, closed: false, recoveryDirty: false, catalogDirty: false, refreshRecovery: async () => {} }); runtime.configurePlacementTracking();
      const capture = f.app.capturePlacementDraft.bind(f.app); f.app.capturePlacementDraft = async (...args) => { captured++; return capture(...args); };
      for (let n = 0; n < 400 && !f.app.getSnapshot().continuation?.view; n++) await new Promise(resolve => setTimeout(resolve, 5));
      if (mode === 'repeat-warning') {
        let enter, release; const entered = new Promise(resolve => { enter = resolve; }), released = new Promise(resolve => { release = resolve; }); let held = false;
        f.behavior.agentLookup = async selected => { if (!held && selected.conversationId === targetScope.conversationId) { held = true; enter(); await released; } return f.descriptor(); };
        const resumed = runtime.resumeWindow(reservation, false);
        try {
          await Promise.race([entered, resumed.then(() => { throw new Error('Recovery finished before its target lookup'); })]);
          continued = true; await f.app.conversationActions(active).continueConversation();
        } finally { release(); await resumed; }
      } else { continued = true; await f.app.conversationActions(active).continueConversation(); }
      const marker = await new Promise((resolve, reject) => { const tx = db.transaction('records'), r = tx.objectStore('records').get(markerKey); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      return { placement: f.app.getSnapshot().lastPlacement, notice: runtime.snapshot.placementNotice, focuses, captured, marker, source: (await owner.drafts(() => {}).load(scope)).draft, target: (await b.captureDraft()).text, pendingId: runtime.pendingIntent?.requestId, pendingCount: runtime.pendingIntents.size, created: f.created.length, sent: f.submitted.length };
    } finally { db.close(); await f.app.dispose(); await b.dispose(); await target.close(); }
  }, mode);
  assert.equal(result.placement.kind, 'detached'); assert.equal(result.placement.label, 'ready-focus-child'); assert.equal(result.focuses, mode === 'repeat-warning' ? 2 : 1); assert.equal(result.captured, 0); assert.match(result.notice, /Keep decision is unreadable/);
  assert.deepEqual(result.marker, { damaged: 'Keep source bytes' }); assert.equal(result.source, 'Source bytes must stay exactly'); assert.equal(result.target, 'Existing target bytes'); assert.equal(result.pendingId, '1:unrelated'); assert.equal(result.pendingCount, 1); assert.equal(result.created, 0); assert.equal(result.sent, 0);
});


test('native terminal placement settles despite a malformed source carry history', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'broken-receipt-source' }, targetScope = { ...scope, conversationId: 'broken-receipt-target' };
    let owner, intent;
    const context = { role: 'chat', label: 'receipt-child', viewId: 'broken-receipt-view', reservation: { scope }, liveRelay: true };
    const port = { context, async request(command) {
      if (command.kind === 'intent-context') return { epoch: 1, pendingCarryRequests: [] };
      if (command.kind === 'placement-intent') return intent = { sourceScope: scope, requestId: command.requestId, action: command.action, target: null, result: null };
      if (command.kind === 'own-intents') return { epoch: 1, pending: [], items: [intent], after: null };
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port), f = globalThis.controllerFixture({ placement: coordinator, fixedScope: scope });
    f.storage.open = async failure => { owner = await S.claimEditor({ scope, viewId: context.viewId, label: context.label, transitionId: null, creation: { agentId: 'default' } }, failure); await owner.saveView('host', { version: 2, route: scope, pendingCreation: null }); return owner; };
    let db;
    try {
      await f.app.start(); const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context, childOwner: owner, controller: f.app, coordinator, port, historyEpoch: 1, requestHistory: new Map(), historyAfter: null, historyExtended: false, pendingIntents: new Map(), pendingIntent: null, recoveryDirty: false,
        snapshot: { placementNotice: null, recovery: { kind: 'chat', pending: [], history: [], after: null, carries: [] } }, listeners: new Set() }); runtime.configurePlacementTracking();
      await f.app.conversationActions(f.app.getSnapshot().active).startNewChat(); const before = f.app.getSnapshot().lastPlacement.kind;
      intent = { ...intent, target: { scope: targetScope, viewId: 'receipt-target', label: 'receipt-target-child', transitionId: 'receipt-target-attempt', creationAgentId: 'default', phase: 'target-ready', bindingRevision: 1, writerGeneration: 1 }, result: { kind: 'detached', scope: targetScope, label: 'receipt-target-child' } };
      db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const key = ['draft-carry', 'host', scope.conversationId, '1:broken'], broken = { broken: 'Preserve raw receipt source row' };
      await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(broken, key); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      let failure = null; try { await runtime.readRecovery(); } catch (error) { failure = String(error); }
      const raw = await new Promise((resolve, reject) => { const tx = db.transaction('records'), r = tx.objectStore('records').get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      return { before, failure, placement: f.app.getSnapshot().lastPlacement, pending: runtime.pendingIntents.size, notice: runtime.snapshot.placementNotice, history: runtime.snapshot.recovery.history, raw, sent: f.submitted.length };
    } finally { db?.close(); await f.app.dispose(); }
  });
  assert.equal(result.before, 'pending'); assert.equal(result.failure, null); assert.equal(result.placement.kind, 'detached'); assert.equal(result.pending, 0); assert.equal(result.history[0].result.kind, 'detached'); assert.match(result.notice, /transfer|carry|history/i); assert.deepEqual(result.raw, { broken: 'Preserve raw receipt source row' }); assert.equal(result.sent, 0);
});

for (const immediate of [false, true]) test(`a bound carry survives native creation refusal and reaches assigned retry once (immediate ${immediate})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async immediate => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'refused-carry-source' }, targetScope = { ...scope, conversationId: 'refused-carry-target' };
    const seed = await S.claimEditor({ scope: targetScope, viewId: 'refused-target-view', label: 'target-child', transitionId: null, creation: { agentId: 'default' } }, () => {}); await seed.saveView('host', { version: 2, route: null, pendingCreation: { scope: targetScope, agentId: 'default' } }); await seed.close();
    const targetContext = { role: 'chat', label: 'target-child', viewId: 'refused-target-view', reservation: { scope: targetScope, creationAgentId: 'default' } }, target = globalThis.controllerFixture({ fixedScope: targetScope }); let targetOwner, creates = 0;
    target.storage.open = failure => S.claimEditor({ scope: targetScope, viewId: targetContext.viewId, label: targetContext.label, transitionId: null, creation: null }, failure).then(owner => targetOwner = owner);
    target.behavior.create = async () => { if (++creates === 1) throw new globalThis.ServiceError('create-rejected', 'First creation rejected'); };
    await target.app.start();
    const targetPort = { async request(command) { if (['creation-refused', 'ready', 'carry-applied'].includes(command.kind)) return { ok: true }; throw new Error(command.kind); } };
    const receiver = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: targetContext, controller: target.app, childOwner: targetOwner, port: targetPort, processing: false, closed: false, childReady: false, childRefusalReported: false, recoveryDirty: false, snapshot: { canRetryCreation: false, placementNotice: null }, listeners: new Set() });
    await receiver.drive();
    let sourceOwner, intent; const sourceContext = { role: 'chat', label: 'source-child', viewId: 'refused-source-view', reservation: { scope }, liveRelay: true };
    const reservation = { scope: targetScope, viewId: targetContext.viewId, label: targetContext.label, transitionId: 'refused-target-attempt', creationAgentId: 'default', phase: 'failed', bindingRevision: null, writerGeneration: null };
    const refused = { kind: 'refused', reason: 'Assigned creation was refused; retry its saved window' };
    const port = { context: sourceContext, async request(command) {
      if (command.kind === 'intent-context') return { epoch: 1, pendingCarryRequests: [] };
      if (command.kind === 'placement-intent') { await c.bindDraftCarry(scope, command.requestId, targetScope); intent = { sourceScope: scope, requestId: command.requestId, action: command.action, target: reservation, result: immediate ? refused : null }; return intent; }
      if (command.kind === 'own-intents') return { epoch: 1, pending: [], items: [intent], after: null };
      if (command.kind === 'carry-applied') return { ok: true };
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port), source = globalThis.controllerFixture({ placement: coordinator, fixedScope: scope });
    source.storage.open = async failure => { sourceOwner = await S.claimEditor({ scope, viewId: sourceContext.viewId, label: sourceContext.label, transitionId: null, creation: { agentId: 'default' } }, failure); await sourceOwner.saveView('host', { version: 2, route: scope, pendingCreation: null }); return sourceOwner; };
    try {
      await source.app.start(); const active = source.app.getSnapshot().active; await active.store.setDraft('Carry survives assigned refusal');
      const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: sourceContext, childOwner: sourceOwner, controller: source.app, coordinator, port, historyEpoch: 1, requestHistory: new Map(), historyAfter: null, historyExtended: false, pendingIntents: new Map(), pendingIntent: null, recoveryDirty: false,
        snapshot: { placementNotice: null, recovery: { kind: 'chat', pending: [], history: [], after: null, carries: [] } }, listeners: new Set() }); runtime.configurePlacementTracking();
      await source.app.conversationActions(active).startNewChat(); if (!immediate) { intent = { ...intent, result: refused }; await runtime.readRecovery(); }
      const beforeRetry = { retry: receiver.snapshot.canRetryCreation, carry: (await c.sourceCarries(scope))[0], indexed: (await c.targetCarries(targetScope)).length, source: (await active.store.captureDraft()).text };
      await receiver.retryAssignedCreation();
      await receiver.syncDraftCarries(); await runtime.syncDraftCarries();
      const first = await target.app.getSnapshot().active.store.captureDraft(); await receiver.syncDraftCarries();
      return { beforeRetry, creates, destination: first.text, once: JSON.stringify(first) === JSON.stringify(await target.app.getSnapshot().active.store.captureDraft()), source: (await active.store.captureDraft()).text, sent: source.submitted.length + target.submitted.length };
    } finally { await Promise.all([source.app.dispose(), target.app.dispose()]); }
  }, immediate);
  assert.equal(result.beforeRetry.retry, true); assert.equal(result.beforeRetry.carry.kind, 'offered'); assert.equal(result.beforeRetry.indexed, 1); assert.equal(result.beforeRetry.source, 'Carry survives assigned refusal'); assert.equal(result.creates, 2); assert.equal(result.destination, 'Carry survives assigned refusal'); assert.equal(result.once, true); assert.equal(result.source, ''); assert.equal(result.sent, 0);
});

for (const pendingRecovery of [false, true]) test(`a matching closed failed creation waits for explicit retry (main pending ${pendingRecovery})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async pendingRecovery => {
    const scope = { hostId: 'host', conversationId: 'closed-failed-target' }, sourceScope = { ...scope, conversationId: 'closed-failed-source' }; let reservation, failed = false, reserves = 0, launches = 0, intent;
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return reservation ? { kind: failed ? 'closed' : 'opening', reservation: { ...reservation, phase: failed ? 'failed' : 'source-released' } } : { kind: 'absent' };
      if (command.kind === 'reserve') { reserves++; return reservation = { scope, viewId: command.viewId, label: 'closed-failed-child', transitionId: 'closed-failed-attempt', creationAgentId: 'default', phase: 'requested', bindingRevision: null, writerGeneration: null }; }
      if (command.kind === 'launch') { launches++; return { kind: 'pending', scope, reason: 'Opening' }; }
      if (command.kind === 'read-intent') return intent;
      if (command.kind === 'reservations') return [{ ...reservation, phase: 'failed' }];
      if (command.kind === 'complete-intent') { intent = { ...intent, result: command.result }; return { ok: true }; }
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port); coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const f = globalThis.controllerFixture({ placement: coordinator }); f.behavior.agentLookup = selected => selected.conversationId === scope.conversationId ? null : f.descriptor(); await f.app.start();
    try {
      if (pendingRecovery) await f.app.createReserved(scope, 'default');
      else reservation = { scope, viewId: 'closed-failed-view', label: 'closed-failed-child', transitionId: 'closed-failed-attempt', creationAgentId: 'default', phase: 'failed', bindingRevision: null, writerGeneration: null };
      failed = true; intent = { sourceScope, requestId: '1:closed-failed-intent', action: { kind: 'create', agentId: 'default', carry: false }, target: { ...reservation, phase: 'assigned' }, result: null };
      const prior = { reserves, launches }, runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, controller: f.app, coordinator, port, carryRecoveryAfter: null, policyScope: null, snapshot: { placementNotice: null }, listeners: new Set(), ui: { getSnapshot: () => ({ state: null }) } });
      if (pendingRecovery) await runtime.readRecovery(); else await runtime.processIntent(intent);
      return { reserveDelta: reserves-prior.reserves, launchDelta: launches-prior.launches, placement: pendingRecovery ? f.app.getSnapshot().lastPlacement : intent.result, pending: f.app.pendingPlacements().length, created: f.created.length, sent: f.submitted.length };
    } finally { await f.app.dispose(); }
  }, pendingRecovery);
  assert.equal(result.reserveDelta, 0); assert.equal(result.launchDelta, 0); assert.equal(result.placement.kind, 'refused'); assert.match(result.placement.reason, /assigned|refused|saved/i); assert.equal(result.pending, 0); assert.equal(result.created, 0); assert.equal(result.sent, 0);
});

for (const creation of [false, true]) test(`a lost launch reply with exact opening remains tracked until Ready (creation ${creation})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async creation => {
    const scope = { hostId: 'host', conversationId: 'lost-opening-target' }; let reservation, ready = false, launches = 0;
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return reservation ? { kind: ready ? 'ready' : 'opening', reservation: { ...reservation, phase: ready ? 'target-ready' : 'source-released', bindingRevision: ready ? 1 : null, writerGeneration: ready ? 1 : null } } : { kind: 'absent' };
      if (command.kind === 'reserve') return reservation = { scope, viewId: command.viewId, label: 'lost-opening-child', transitionId: 'lost-opening-attempt', creationAgentId: creation ? 'default' : null, phase: 'requested', bindingRevision: null, writerGeneration: null };
      if (command.kind === 'phase') return { ok: true };
      if (command.kind === 'launch') { launches++; throw new Error('Launch reply lost while opening'); }
      if (command.kind === 'reservations') return [reservation];
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port); coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const f = globalThis.controllerFixture({ placement: coordinator }); await f.app.start();
    try { const placed = creation ? await f.app.createReserved(scope, 'default') : await f.app.openReserved(scope); const before = { kind: placed.kind, pending: f.app.pendingPlacements().length, tracked: placed.kind === 'pending' && coordinator.pendingReservation(placed)?.transitionId };
      const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, controller: f.app, coordinator, port, carryRecoveryAfter: null, policyScope: null, snapshot: { placementNotice: null }, listeners: new Set() }); ready = true; await runtime.readRecovery(); return { before, latest: f.app.getSnapshot().lastPlacement, pending: f.app.pendingPlacements().length, launches, created: f.created.length, sent: f.submitted.length }; }
    finally { await f.app.dispose(); }
  }, creation);
  assert.equal(result.before.kind, 'pending'); assert.equal(result.before.pending, 1); assert.equal(result.before.tracked, 'lost-opening-attempt'); assert.equal(result.latest.kind, 'detached'); assert.equal(result.pending, 0); assert.equal(result.launches, 1); assert.equal(result.created, 0); assert.equal(result.sent, 0);
});


test('replacement child retires an authenticated absent UUID offer while live admission remains protected', async t => {
  const page = await fixture(t), bundle = await page.locator('script').innerText();
  const before = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'reload-orphan-source' }; let owner, enter;
    const entered = new Promise(resolve => { enter = resolve; }), context = { role: 'chat', label: 'reload-child', documentIncarnation: 'old-document', viewId: 'reload-orphan-view', reservation: { scope }, liveRelay: true };
    const port = { context, async request(command) {
      if (command.kind === 'intent-context') return { epoch: 1, pendingCarryRequests: [] };
      if (command.kind === 'placement-intent') { enter(); return new Promise(() => {}); }
      if (command.kind === 'own-intents') return { epoch: 1, pending: [], items: [], after: null };
      if (command.kind === 'read-intent') return null;
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port), f = globalThis.controllerFixture({ placement: coordinator, fixedScope: scope });
    f.storage.open = async failure => { owner = await S.claimEditor({ scope, viewId: context.viewId, label: context.label, transitionId: null, creation: { agentId: 'default' } }, failure); await owner.saveView('host', { version: 2, route: scope, pendingCreation: null }); return owner; };
    await f.app.start(); const active = f.app.getSnapshot().active; await active.store.setDraft('Reload orphan exact source bytes');
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context, childOwner: owner, controller: f.app, coordinator, port, historyEpoch: 1, requestHistory: new Map(), historyAfter: null, historyExtended: false, pendingIntents: new Map(), pendingIntent: null, recoveryDirty: false,
      snapshot: { placementNotice: null, recovery: { kind: 'chat', pending: [], history: [], after: null, carries: [] } }, listeners: new Set() }); runtime.configurePlacementTracking();
    globalThis.heldAdmission = f.app.conversationActions(active).startNewChat();
    await Promise.race([entered, globalThis.heldAdmission.then(() => { throw new Error('Admission finished before hold'); })]); await runtime.readRecovery();
    return { carry: (await c.sourceCarries(scope))[0], source: (await owner.drafts(() => {}).load(scope)).draft };
  });
  assert.equal(before.carry.kind, 'offered', 'the current document must retain an offer while native admission is still in flight');
  await page.reload(); await page.addScriptTag({ content: bundle });
  const after = await page.evaluate(async oldRequest => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'reload-orphan-source' }; let owner, submitted = 0;
    const context = { role: 'chat', label: 'reload-child', documentIncarnation: 'replacement-document', viewId: 'reload-orphan-view', reservation: { scope }, liveRelay: true };
    const port = { context, async request(command) {
      if (command.kind === 'own-intents') return { epoch: 1, pending: [], items: [], after: null };
      if (command.kind === 'read-intent') return null;
      if (command.kind === 'intent-context') return { epoch: 1, pendingCarryRequests: [] };
      if (command.kind === 'placement-intent') { submitted++; return { sourceScope: scope, requestId: command.requestId, action: command.action, target: null, result: null }; }
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port), f = globalThis.controllerFixture({ placement: coordinator, fixedScope: scope });
    f.storage.open = async failure => owner = await S.claimEditor({ scope, viewId: context.viewId, label: context.label, transitionId: null, creation: null }, failure);
    try { await f.app.start(); const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context, childOwner: owner, controller: f.app, coordinator, port, historyEpoch: 1, requestHistory: new Map(), historyAfter: null, historyExtended: false, pendingIntents: new Map(), pendingIntent: null, recoveryDirty: false,
      snapshot: { placementNotice: null, recovery: { kind: 'chat', pending: [], history: [], after: null, carries: [] } }, listeners: new Set() }); runtime.configurePlacementTracking();
      await runtime.readRecovery(); const retired = (await c.sourceCarries(scope)).find(carry => carry.requestId === oldRequest); await f.app.conversationActions(f.app.getSnapshot().active).startNewChat();
      return { retired, submitted, next: f.app.getSnapshot().lastPlacement, source: (await owner.drafts(() => {}).load(scope)).draft, sent: f.submitted.length };
    } finally { await f.app.dispose(); }
  }, before.carry.requestId);
  assert.equal(after.retired.kind, 'refused'); assert.equal(after.source, before.source); assert.equal(after.submitted, 1); assert.equal(after.next.kind, 'pending'); assert.equal(after.sent, 0);
});

for (const requestId of ['1:main-retained-transfer', '1:manual-or-legacy-request']) test(`authenticated absence preserves an unbound non-child request (${requestId})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async requestId => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'non-child-carry-source' };
    const owner = await S.claimEditor({ scope, viewId: 'non-child-view', label: 'source-child', transitionId: null, creation: { agentId: 'default' } }, () => {}), store = globalThis.createConversationStore({ scope, port: { scope }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}) }); await store.ready; await store.setDraft('Preserve non-child offer');
    try {
      await c.offerDraftCarry({ source: scope, sourceViewId: owner.viewId, requestId, writerGeneration: owner.editorBinding().writerGeneration, expected: await store.captureDraft() });
      const port = { context: { role: 'chat', reservation: { scope } }, async request(command) { if (command.kind === 'own-intents') return { epoch: 1, pending: [], items: [], after: null }; if (command.kind === 'read-intent') return null; throw new Error(command.kind); } };
      const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: port.context, coordinator: new globalThis.WindowCoordinator(port), port, controller: { settlePlacement() { throw new Error('No pending native result'); } }, historyEpoch: 1, requestHistory: new Map(), historyAfter: null, historyExtended: false, pendingIntents: new Map(), pendingIntent: null, snapshot: { recovery: { kind: 'chat', pending: [], history: [], carries: [] } }, listeners: new Set() });
      await runtime.readRecovery(); return { carry: (await c.sourceCarries(scope))[0], draft: (await store.captureDraft()).text };
    } finally { await store.dispose(); await owner.close(); }
  }, requestId);
  assert.equal(result.carry.kind, 'offered'); assert.equal(result.carry.target, null); assert.equal(result.draft, 'Preserve non-child offer');
});

for (const pending of [false, true]) test(`live close wakeup checks the current native request before saving (pending ${pending})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async pending => {
    const context = { version: 1, role: 'chat', label: 'close-child', brokerInstance: 'broker', documentIncarnation: 'close-document', viewId: 'original-view', reservation: { scope: { hostId: 'host', conversationId: 'close-source' } }, liveRelay: true };
    const handlers = new Map(), wakeTasks = [], f = globalThis.controllerFixture({ fixedScope: context.reservation.scope }); f.views.set('original-view/host', { version: 2, route: context.reservation.scope, pendingCreation: null }); await f.app.start(); await f.app.getSnapshot().active.store.setDraft('Close wakeup exact source bytes');
    let nativePending = false, reads = 0, saves = 0, ready = 0; const prepare = f.app.prepareClose.bind(f.app); f.app.prepareClose = async () => { saves++; return prepare(); };
    const port = { context, async listen(event, handler) { handlers.set(event, handler); return () => {}; }, async request(command) { if (command.kind === 'read-close') { reads++; return { pending: nativePending, attemptId: nativePending ? 'live-close' : null }; } if (command.kind === 'close-ready') { ready++; return { ok: true }; } if (command.kind === 'close-cancelled') return { ok: true }; throw new Error(command.kind); } };
    const runtime = Object.assign(new globalThis.WindowRuntime(context), { controller: f.app, port, coordinator: new globalThis.WindowCoordinator(port), ui: { subscribe: () => () => {}, start() {} }, uiChanged() {}, drive: async () => {} });
    const closeWake = runtime.closeWake.bind(runtime); runtime.closeWake = () => { const task = closeWake(); wakeTasks.push(task); return task; };
    const bounded = async task => { let timer; try { await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native close wake did not finish')), 1000); })]); } finally { clearTimeout(timer); } };
    try { runtime.start(); await Promise.resolve(); await bounded(Promise.all(wakeTasks)); const registrationReads = reads, priorWakes = wakeTasks.length; nativePending = pending; handlers.get('openpane-close-requested')();
      if (wakeTasks.length !== priorWakes + 1) throw new Error('Live close event did not start a readable close wake');
      await bounded(wakeTasks.at(-1));
      return { reads: reads-registrationReads, saves, ready, draft: f.drafts.get('original-view/host/close-source')?.draft }; }
    finally { await f.app.dispose(); }
  }, pending);
  assert.equal(result.reads, 1); assert.equal(result.saves, pending ? 1 : 0); assert.equal(result.ready, pending ? 1 : 0); assert.equal(result.draft, 'Close wakeup exact source bytes');
});


for (const mode of ['explicit-open', 'pending-open']) test(`a failed non-creation handoff remains available for explicit opening (${mode})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async mode => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'failed-open-target' }, sourceScope = { ...scope, conversationId: 'failed-open-source' };
    let child = await S.claimEditor({ scope, viewId: 'failed-open-view', label: 'old-target-child', transitionId: null, creation: { agentId: 'default' } }, () => {});
    const draft = child.drafts(() => {}); await draft.load(scope); await draft.save({ version: 3, scope, draft: 'Preserved failed handoff bytes', draftRevision: 1, outbox: [], frontendSends: [], image: null }); await child.close(); child = null;
    let reservation = { scope, viewId: 'failed-open-view', label: 'failed-open-child', transitionId: 'failed-open-original', creationAgentId: null, phase: 'failed', bindingRevision: null, writerGeneration: null }, failed = mode !== 'pending-open', reserves = 0, launches = 0, initial = mode === 'pending-open';
    let intent = { sourceScope, requestId: '1:failed-explicit-open', action: { kind: 'open', scope, carry: false }, target: reservation, result: null };
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'read-intent') return intent;
      if (command.kind === 'lookup') return reservation.phase === 'target-ready' ? { kind: child ? 'ready' : 'closed', reservation } : { kind: failed ? 'closed' : 'opening', reservation: { ...reservation, phase: failed ? 'failed' : 'source-released' } };
      if (command.kind === 'reservations') return [{ ...reservation, phase: 'failed' }];
      if (command.kind === 'reserve') { reserves++; reservation = { ...reservation, phase: 'requested', transitionId: 'failed-open-explicit-retry' }; return reservation; }
      if (command.kind === 'phase') return { ok: true };
      if (command.kind === 'launch') {
        launches++; if (initial) return { kind: 'pending', scope, reason: 'Initial open awaits readiness' };
        child = await S.claimEditor({ scope, viewId: reservation.viewId, label: reservation.label, transitionId: reservation.transitionId, creation: null }, () => {});
        const binding = child.editorBinding(); reservation = { ...reservation, phase: 'target-ready', bindingRevision: binding.revision, writerGeneration: binding.writerGeneration }; return { kind: 'detached', scope, label: reservation.label };
      }
      if (command.kind === 'complete-intent') { intent = { ...intent, result: command.result }; return { ok: true }; }
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port); coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const f = globalThis.controllerFixture({ placement: coordinator }), none = { predecessor: null, carried: null, closure: null, successor: null };
    f.behavior.continuation = async input => input.scope.conversationId === sourceScope.conversationId ? { ...none, successor: { kind: 'confirmed', scope } } : none;
    await f.app.start();
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, controller: f.app, coordinator, port, carryRecoveryAfter: null, policyScope: null, snapshot: { placementNotice: null }, listeners: new Set(), ui: { getSnapshot: () => ({ state: null }) } });
    try {
      let settled = null;
      if (mode === 'pending-open') { await f.app.openReserved(scope); failed = true; initial = false; await runtime.readRecovery(); settled = f.app.getSnapshot().lastPlacement; }
      await runtime.processIntent(intent);
      let text = null; if (child) { const saved = await child.drafts(() => {}).load(scope); text = saved?.draft ?? null; }
      return { settled, receipt: intent.result, reserves, launches, text, pending: f.app.pendingPlacements().length, created: f.created.length, sent: f.submitted.length };
    } finally { await f.app.dispose(); await child?.close(); }
  }, mode);
  if (mode === 'pending-open') { assert.equal(result.settled.kind, 'refused'); assert.match(result.settled.reason, /opened|opening/i); assert.doesNotMatch(result.settled.reason, /created|creation/i); }
  assert.equal(result.receipt.kind, 'detached'); assert.equal(result.reserves, 1); assert.equal(result.launches, mode === 'pending-open' ? 2 : 1); assert.equal(result.text, 'Preserved failed handoff bytes'); assert.equal(result.pending, 0); assert.equal(result.created, 0); assert.equal(result.sent, 0);
});

for (const damaged of ['malformed', 'miskeyed']) test(`selected Keep preserves its draft despite an unrelated ${damaged} source carry`, async t => {
  const page = await fixture(t), result = await page.evaluate(async damaged => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'selected-keep-source' }, targetScope = { ...scope, conversationId: 'selected-keep-target' }, requestId = '1:selected-keep';
    let owner; const f = globalThis.controllerFixture(); f.storage.open = async failure => { owner = await S.claimEditor({ scope, viewId: 'selected-keep-view', label: 'main', transitionId: null, creation: { agentId: 'default' } }, failure); await owner.saveView('host', { version: 2, route: scope, pendingCreation: null }); return owner; };
    const target = await S.claimEditor({ scope: targetScope, viewId: 'selected-keep-target-view', label: 'target-child', transitionId: null, creation: { agentId: 'default' } }, () => {});
    let db;
    try {
      await f.app.start(); const active = f.app.getSnapshot().active; await active.store.setDraft('Selected Keep exact source bytes');
      await c.offerDraftCarry({ source: scope, sourceViewId: owner.viewId, requestId, writerGeneration: owner.editorBinding().writerGeneration, expected: await active.store.captureDraft() }); await c.bindDraftCarry(scope, requestId, targetScope);
      const key = ['draft-carry', 'host', scope.conversationId, '1:corrupt-sibling'];
      const raw = damaged === 'malformed' ? { broken: 'Preserve malformed sibling' } : { version: 1, kind: 'settled', source: scope, sourceViewId: owner.viewId, requestId: '1:different-request', target: targetScope, outcome: 'changed', retainedText: 'Preserve miskeyed sibling' };
      db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(raw, key); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      const port = { async request(command) { if (command.kind === 'reservations') return []; throw new Error(command.kind); } };
      const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, controller: f.app, coordinator: new globalThis.WindowCoordinator(null), port, carryRecoveryAfter: null, policyScope: null, snapshot: { placementNotice: null }, listeners: new Set() });
      await runtime.readRecovery(); const listed = runtime.snapshot.recovery.carries.some(carry => carry.requestId === requestId); await runtime.keepDraft(requestId, scope);
      const read = k => new Promise((resolve, reject) => { const tx = db.transaction('records'), r = tx.objectStore('records').get(k); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      return { listed, selected: await read(['draft-carry', 'host', scope.conversationId, requestId]), sibling: await read(key), raw, indexed: (await c.targetCarries(targetScope)).length,
        draft: (await active.store.captureDraft()).text, marker: await read(['draft-carry-kept', 'host', scope.conversationId, targetScope.conversationId]), notice: runtime.snapshot.placementNotice, sent: f.submitted.length };
    } finally { db?.close(); await f.app.dispose(); await target.close(); }
  }, damaged);
  assert.equal(result.listed, true); assert.equal(result.selected.kind, 'cancelled'); assert.equal(result.indexed, 0); assert.equal(result.marker, true); assert.deepEqual(result.sibling, result.raw); assert.equal(result.draft, 'Selected Keep exact source bytes'); assert.match(result.notice, /draft stays in this chat/); assert.equal(result.sent, 0);
});


test('a close cancelled after its draft save reloads the saved child when close-ready is rejected', async t => {
  const page = await fixture(t), bundle = await page.locator('script').innerText(), events = []; let prepared;
  const saved = new Promise(resolve => { prepared = resolve; });
  await page.exposeFunction('recordSavedCloseLifecycle', event => { events.push(event); if (event === 'prepared') prepared(); });
  await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'cancel-after-save-source' }; let owner, pending = true, release;
    const cancelled = new Promise(resolve => { release = resolve; }), f = globalThis.controllerFixture({ fixedScope: scope });
    f.storage.open = async failure => { owner = await S.claimEditor({ scope, viewId: 'cancel-after-save-view', label: 'cancelled-child', transitionId: null, creation: { agentId: 'default' } }, failure); await owner.saveView('host', { version: 2, route: scope, pendingCreation: null }); return owner; };
    await f.app.start(); await f.app.getSnapshot().active.store.setDraft('Cancelled close exact saved bytes');
    const prepare = f.app.prepareClose.bind(f.app), dispose = f.app.dispose.bind(f.app);
    f.app.prepareClose = async () => { await prepare(); await globalThis.recordSavedCloseLifecycle('prepared'); await cancelled; };
    f.app.dispose = async () => { await dispose(); await globalThis.recordSavedCloseLifecycle('disposed'); };
    const port = { async request(command) {
      if (command.kind === 'read-close') { await globalThis.recordSavedCloseLifecycle('read-close'); return { pending, attemptId: pending ? 'saved-close' : null }; }
      if (command.kind === 'close-ready') { if (pending) throw new Error('Quit must be cancelled before close-ready'); await globalThis.recordSavedCloseLifecycle('close-ready-rejected'); throw new Error('native-close-not-pending'); }
      if (command.kind === 'close-cancelled') { await globalThis.recordSavedCloseLifecycle('close-cancelled'); return { ok: true }; }
      throw new Error(command.kind);
    } };
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat' }, controller: f.app, port, closed: false, handledCloseAttempts: new Set(), pendingCloseCancellations: new Set(), closeWakePending: false, snapshot: { closing: false, placementNotice: null }, listeners: new Set() });
    globalThis.cancelSavedQuit = async () => { pending = false; await globalThis.recordSavedCloseLifecycle('quit-cancelled'); release(); };
    globalThis.savedCloseTask = runtime.closeWake();
  });
  let timer;
  try { await Promise.race([saved, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Child did not reach saved close boundary')), 3000); })]); }
  finally { clearTimeout(timer); }
  assert.deepEqual(events, ['read-close', 'prepared']);
  const reloaded = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 3000 });
  await page.evaluate(() => globalThis.cancelSavedQuit()); await reloaded;
  assert.deepEqual(events, ['read-close', 'prepared', 'quit-cancelled', 'disposed', 'close-ready-rejected', 'close-cancelled']);
  await page.addScriptTag({ content: bundle });
  const text = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'cancel-after-save-source' };
    const owner = await S.claimEditor({ scope, viewId: 'cancel-after-save-view', label: 'cancelled-child', transitionId: null, creation: null }, () => {});
    try { return (await owner.drafts(() => {}).load(scope))?.draft ?? null; } finally { await owner.close(); }
  });
  assert.equal(text, 'Cancelled close exact saved bytes');
});


for (const healthy of [false, true]) test(`assigned readiness records its exact native editor before Ready and requires healthy storage (${healthy})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async healthy => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'origin-ready-source' }, label = 'origin-ready-child', viewId = 'origin-ready-view';
    const seed = await S.claimEditor({ scope, viewId, label, transitionId: null, creation: { agentId: 'default' } }, () => {}); await seed.saveView('host', { version: 2, route: null, pendingCreation: { scope, agentId: 'default' } }); await seed.close();
    let owner, ready = 0, markerAtReady = null; const f = globalThis.controllerFixture({ fixedScope: scope });
    f.storage.open = async failure => {
      owner = await S.claimEditor({ scope, viewId, label, transitionId: null, creation: null }, failure); const save = owner.saveView.bind(owner);
      owner.saveView = async (hostId, view) => { if (!healthy && view.pendingCreation === null) throw new Error('Creation completion storage failed'); return save(hostId, view); }; return owner;
    };
    await f.app.start();
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const read = key => new Promise((resolve, reject) => { const tx = db.transaction('records'), r = tx.objectStore('records').get(key); r.onsuccess = () => resolve(r.result ?? null); r.onerror = () => reject(r.error); });
    try {
      if (healthy) await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put({ damaged: 'Readiness must survive unrelated carry history' }, ['draft-carry', 'host', scope.conversationId, '1:damaged']); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      const context = { role: 'chat', label, viewId, reservation: { scope, creationAgentId: 'default' } };
      const port = { async request(command) { if (command.kind !== 'ready') throw new Error(command.kind); ready++; markerAtReady = await read(['native-editor-origin', 'host', scope.conversationId]); return { ok: true }; } };
      const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context, controller: f.app, childOwner: owner, port, processing: false, closed: false, childReady: false, childRefusalReported: false, recoveryDirty: false, snapshot: { canRetryCreation: false, placementNotice: null }, listeners: new Set(), ui: {} });
      await runtime.drive(); return { ready, markerAtReady, binding: owner.editorBinding(), childReady: runtime.childReady, storageFailure: f.app.getSnapshot().storageFailure, notice: runtime.snapshot.placementNotice, created: f.created.length, sent: f.submitted.length };
    } finally { db.close(); await f.app.dispose(); }
  }, healthy);
  assert.equal(result.ready, healthy ? 1 : 0); assert.equal(result.childReady, healthy); assert.equal(result.created, 1); assert.equal(result.sent, 0);
  if (healthy) { assert.equal(result.storageFailure, ''); assert.deepEqual(result.markerAtReady, { version: 1, scope: result.binding.scope, viewId: result.binding.viewId, revision: result.binding.revision, writerGeneration: result.binding.writerGeneration, label: 'origin-ready-child' }); assert.ok(result.notice, 'strict damaged carry history remains visible without blocking readiness'); }
  else { assert.match(result.storageFailure, /storage failed/); assert.equal(result.markerAtReady, null); }
});


test('a delayed rejected close from Quit one cannot cancel Quit two', async t => {
  const page = await fixture(t), bundle = await page.locator('script').innerText(), events = []; let prepared, rejected, completed;
  const saved = new Promise(resolve => { prepared = resolve; }), denied = new Promise(resolve => { rejected = resolve; }), done = new Promise(resolve => { completed = resolve; });
  await page.exposeFunction('recordCloseAttemptRace', event => { events.push(event); if (event.kind === 'prepared') prepared(); if (event.kind === 'rejected') rejected(); if (event.kind === 'cancelled') completed(event); });
  await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'two-quit-source' }, f = globalThis.controllerFixture({ fixedScope: scope });
    f.storage.open = async failure => { const owner = await S.claimEditor({ scope, viewId: 'two-quit-view', label: 'second', transitionId: null, creation: { agentId: 'default' } }, failure); await owner.saveView('host', { version: 2, route: scope, pendingCreation: null }); return owner; };
    await f.app.start(); await f.app.getSnapshot().active.store.setDraft('Exact text survives both Quit attempts');
    let mainClosing = true, attemptId = 'quit-1-second', saves = 0, resumePrepare, deliverRejection;
    const heldPrepare = new Promise(resolve => { resumePrepare = resolve; }), prepare = f.app.prepareClose.bind(f.app);
    f.app.prepareClose = async () => { saves++; await prepare(); await globalThis.recordCloseAttemptRace({ kind: 'prepared' }); await heldPrepare; };
    const port = { async request(command) {
      if (command.kind === 'read-close') return { pending: attemptId !== null, attemptId };
      if (command.kind === 'close-ready') {
        if (command.attemptId !== 'quit-1-second') throw new Error('Close readiness lost its first attempt identity');
        if (attemptId !== null) throw new Error('First child must cancel Quit one before readiness');
        await globalThis.recordCloseAttemptRace({ kind: 'rejected' });
        return new Promise((_, reject) => { deliverRejection = () => reject(new Error('close-request-cancelled')); });
      }
      if (command.kind === 'close-cancelled') {
        if (command.attemptId === undefined || command.attemptId === attemptId) { mainClosing = false; attemptId = null; }
        await globalThis.recordCloseAttemptRace({ kind: 'cancelled', mainClosing, attemptId, saves, echoed: command.attemptId ?? null });
        throw new Error('close-request-cancelled');
      }
      throw new Error(command.kind);
    } };
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat' }, controller: f.app, port, closed: false, handledCloseAttempts: new Set(), pendingCloseCancellations: new Set(), closeWakePending: false, snapshot: { closing: false, placementNotice: null }, listeners: new Set() });
    globalThis.cancelFirstQuit = () => { mainClosing = false; attemptId = null; resumePrepare(); };
    globalThis.beginSecondQuit = async () => { mainClosing = true; attemptId = 'quit-2-second'; await runtime.closeWake(); return { closing: runtime.snapshot.closing, saves }; };
    globalThis.deliverFirstQuitRejection = () => deliverRejection();
    globalThis.twoQuitCloseTask = runtime.closeWake();
  });
  const bounded = async task => { let timer; try { return await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Two Quit close race did not reach its boundary')), 3000); })]); } finally { clearTimeout(timer); } };
  await bounded(saved); await page.evaluate(() => globalThis.cancelFirstQuit()); await bounded(denied);
  assert.deepEqual(await page.evaluate(() => globalThis.beginSecondQuit()), { closing: true, saves: 1 }, 'the live closing guard prevents a second saver while the rejection is held');
  const reloaded = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 3000 });
  await page.evaluate(() => globalThis.deliverFirstQuitRejection());
  const result = await bounded(done); await reloaded;
  assert.equal(result.mainClosing, true); assert.equal(result.attemptId, 'quit-2-second'); assert.equal(result.saves, 1); assert.equal(result.echoed, 'quit-1-second');
  await page.addScriptTag({ content: bundle });
  const text = await page.evaluate(async () => { const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'two-quit-source' }, owner = await S.claimEditor({ scope, viewId: 'two-quit-view', label: 'second', transitionId: null, creation: null }, () => {}); try { return (await owner.drafts(() => {}).load(scope)).draft; } finally { await owner.close(); } });
  assert.equal(text, 'Exact text survives both Quit attempts');
});

for (const history of ['closed-ready', 'retired', 'unseen']) test(`replaying a confirmed appearance preserves closed native history (${history})`, { timeout: 15000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async history => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'policy-replay' }, catalog = await S.reopen('policy-catalog', () => {});
    let prior = null, original = null, launches = 0, reserves = 0;
    if (history !== 'unseen') {
      const child = await S.claimEditor({ scope, viewId: 'policy-child-view', label: 'policy-child', transitionId: null, creation: { agentId: 'agent' } }, () => {}); original = child.editorBinding();
      const drafts = child.drafts(() => {}); await drafts.load(scope); await drafts.save({ version: 3, scope, draft: 'Exact closed policy draft', draftRevision: 1, outbox: [], frontendSends: [], image: null });
      await globalThis.recordNativeEditorOrigin(original, 'policy-child'); await child.close();
      if (history === 'closed-ready') prior = { scope, viewId: original.viewId, label: 'policy-child', transitionId: 'old-policy', creationAgentId: null, phase: 'target-ready', bindingRevision: original.revision, writerGeneration: original.writerGeneration };
    }
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return prior ? { kind: 'closed', reservation: prior } : { kind: 'absent' };
      if (command.kind === 'reserve') { reserves++; if (!prior || command.newTransition) prior = { scope, viewId: command.viewId, label: 'new-policy-child', transitionId: 'new-policy', creationAgentId: null, phase: 'requested', bindingRevision: null, writerGeneration: null }; return prior; }
      if (command.kind === 'phase') { prior = { ...prior, phase: command.phase }; return {}; }
      if (command.kind === 'launch') { launches++; return { kind: 'pending', scope, reason: 'Opening' }; }
      if (command.kind === 'pending-intents') return [];
      throw new Error(command.kind);
    } }, coordinator = new globalThis.WindowCoordinator(port);
    coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    let latest = null;
    const controller = { getSnapshot: () => ({ busy: false, storageFailure: null, host: { kind: 'ready', metadata: { hostId: 'host' } }, active: null, lastPlacement: latest, saved: { pendingCreation: null } }), async openReserved(scope, intentRef, purpose) {
      latest = await coordinator.acquire({ scope, intentRef, ...(purpose === 'passive' ? { purpose } : {}), agentId: 'agent', agentLabel: 'Agent', creation: false, carryFrom: null, initialDraft: null }, { storage: catalog, holds: () => false, async quiesce() {}, async release() {} }); return latest;
    } };
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, controller, coordinator, port, processing: false, closed: false, recoveryDirty: false, catalogDirty: false, policyScope: scope, policyDelivery: 'delivered', policyAppliedScope: null, confirmedPolicyDelivery: () => 'delivered', syncDraftCarries: async () => {}, snapshot: { placementNotice: null }, listeners: new Set(), ui: { getSnapshot: () => ({ state: { transitions: [{ slot: { target: { scope } } }] } }) } });
    await runtime.drive(); const after = { launches, reserves, binding: (await S.locateEditor(scope)).binding, latest };
    if (history !== 'unseen') await controller.openReserved(scope);
    await catalog.close(); return { original, after, explicit: { launches, reserves, latest } };
  }, history);
  if (history === 'unseen') { assert.equal(result.after.launches, 1); assert.equal(result.after.latest.kind, 'pending'); }
  else { assert.equal(result.after.launches, 0); assert.equal(result.after.reserves, 0); assert.deepEqual(result.after.binding, result.original); assert.equal(result.explicit.launches, 1); assert.equal(result.explicit.latest.kind, 'pending'); }
});

for (const state of ['reclaimed-inline', 'unchanged', 'ready-after-read', 'attached-ready', 'explicit-closed', 'handoff', 'absent']) test(`fresh passive assignment carries current editing generation without revoking Ready (${state})`, { timeout: 15000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async state => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'assignment-reclaim-target' }, sourceScope = { ...scope, conversationId: 'assignment-reclaim-source' };
    let owner = await S.claimEditor({ scope, viewId: 'assignment-reclaim-view', label: 'old-child', transitionId: null, creation: { agentId: 'default' } }, () => {});
    const drafts = owner.drafts(() => {}); await drafts.load(scope); await drafts.save({ version: 3, scope, draft: 'Exact reclaimed editor bytes', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    const oldBinding = owner.editorBinding(); let native = { scope, viewId: owner.viewId, label: 'old-child', transitionId: 'old-ready-assignment', creationAgentId: null, phase: 'target-ready', bindingRevision: oldBinding.revision, writerGeneration: oldBinding.writerGeneration }; await owner.close(); owner = null;
    if (['reclaimed-inline', 'ready-after-read'].includes(state)) owner = await S.claimEditor({ scope, viewId: native.viewId, label: state === 'reclaimed-inline' ? 'main' : 'new-child', transitionId: null, creation: null }, () => {});
    if (state === 'handoff') { owner = await S.claimEditor({ scope, viewId: native.viewId, label: 'main', transitionId: null, creation: null }, () => {}); await owner.reserveHandoff({ scope, sourceViewId: native.viewId, targetViewId: native.viewId, expectedBinding: owner.editorBinding(), transitionId: 'pending-handoff', targetLabel: 'future-child' }); await owner.close(); owner = null; }
    if (state === 'absent') { const db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'), rows = tx.objectStore('records'); rows.delete(['editor-binding', scope.hostId, scope.conversationId]); rows.delete(['editor-view-binding', native.viewId]); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close(); }
    const located = (await S.locateEditor(scope)).binding, expectedHint = located?.kind === 'editing' ? located : null; let assigned = null, placements = 0, launches = 0;
    let intent = { sourceScope, requestId: '1:fresh-passive-reclaim', action: { kind: 'open', scope, carry: false, ...(state === 'explicit-closed' ? {} : { passive: true }) }, target: state === 'attached-ready' ? native : null, result: null };
    const main = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, snapshot: { placementNotice: null }, listeners: new Set(),
      controller: { getSnapshot: () => ({ busy: false, host: { kind: 'ready', metadata: { hostId: 'host' } }, saved: { pendingCreation: null } }), async inspectConversation() { return { agent: { id: 'default' }, continuation: { successor: { kind: 'confirmed', scope } } }; }, async openReserved(target, reference, purpose) { placements++; if (state !== 'explicit-closed' && purpose !== 'passive') throw new Error('Passive producer lost its purpose'); return { kind: 'inline', scope: target }; } },
      port: { async request(command) {
        if (command.kind === 'read-intent') return intent;
        if (command.kind === 'assign-intent') { assigned = command; if (state === 'ready-after-read') native = { ...native, bindingRevision: located.revision, writerGeneration: located.writerGeneration }; const b = command.currentBinding, newer = b && b.scope.hostId === scope.hostId && b.scope.conversationId === scope.conversationId && b.viewId === native.viewId && b.revision >= native.bindingRevision && b.writerGeneration >= native.writerGeneration && (b.revision > native.bindingRevision || b.writerGeneration > native.writerGeneration); intent = { ...intent, target: state === 'explicit-closed' || newer ? { ...native, phase: 'assigned', transitionId: 'fresh-reclaimed-assignment' } : native }; return intent; }
        if (command.kind === 'lookup') return { kind: 'closed', reservation: native };
        if (command.kind === 'launch') { launches++; if (!command.existingOnly) throw new Error('Passive completed history must not recreate a child'); return null; }
        if (command.kind === 'complete-intent') { intent = { ...intent, result: command.result }; return { ok: true }; }
        throw new Error(command.kind);
      } }, async syncDraftCarries() {} });
    try { await main.processIntent(intent); return { assigned, expectedHint, placements, launches, receipt: intent.result, text: owner ? (await owner.drafts(() => {}).load(scope)).draft : null }; } finally { await owner?.close(); }
  }, state);
  if (state === 'attached-ready') assert.equal(result.assigned, null); else assert.deepEqual(result.assigned.currentBinding, result.expectedHint);
  const placed = state === 'reclaimed-inline' || state === 'explicit-closed'; assert.equal(result.placements, placed ? 1 : 0); assert.equal(result.receipt.kind, placed ? 'inline' : 'detached'); assert.equal(result.launches, placed ? 0 : 1);
  if (state === 'reclaimed-inline' || state === 'ready-after-read') assert.equal(result.text, 'Exact reclaimed editor bytes');
});

for (const current of ['newer', 'equal', 'older']) test(`passive separate placement requests a fresh transition only after inline reclamation (${current})`, { timeout: 15000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async current => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'separate-reclaim' }, owner = await S.claimEditor({ scope, viewId: 'separate-reclaim-view', label: 'main', transitionId: null, creation: { agentId: 'default' } }, () => {}), binding = owner.editorBinding(), draft = owner.drafts(() => {});
    await draft.load(scope); await draft.save({ version: 3, scope, draft: 'Separate reclaimed bytes', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    let native = { scope, viewId: owner.viewId, label: 'closed-child', transitionId: 'closed-separate-ready', creationAgentId: null, phase: 'target-ready', bindingRevision: current === 'older' ? binding.revision + 1 : binding.revision, writerGeneration: current === 'older' ? binding.writerGeneration + 1 : binding.writerGeneration };
    if (current === 'newer') { await owner.close(); const reclaimed = await S.claimEditor({ scope, viewId: owner.viewId, label: 'main', transitionId: null, creation: null }, () => {}); return run(reclaimed, { ...native, bindingRevision: binding.revision, writerGeneration: binding.writerGeneration }); }
    return run(owner, native);
    async function run(source, previous) {
      native = previous; let newTransition = null, launches = 0, released = false;
      const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', label: 'main', liveRelay: true }, async request(command) { if (command.kind === 'lookup') return { kind: 'closed', reservation: native }; if (command.kind === 'read-intent') return null; if (command.kind === 'reserve') { newTransition = command.newTransition; if (newTransition) native = { ...native, phase: 'requested', transitionId: 'fresh-separate-reclaim' }; return native; } if (command.kind === 'phase') return {}; if (command.kind === 'launch') { launches++; return { kind: 'pending', scope, reason: 'Fresh reclaimed editor is opening' }; } throw new Error(command.kind); } }); coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
      try { const placed = await coordinator.acquire({ scope, creation: false, carryFrom: null, initialDraft: null, agentId: 'default', agentLabel: 'Default', purpose: 'passive' }, { storage: source, holds: id => id === source.viewId, async quiesce() {}, async release() { released = true; await source.close(); } }); return { placed, newTransition, launches, released }; } finally { await source.close(); }
    }
  }, current);
  assert.equal(result.placed.kind, current === 'newer' ? 'pending' : current === 'equal' ? 'detached' : 'refused'); assert.equal(result.newTransition, current === 'newer' ? true : current === 'equal' ? null : false); assert.equal(result.launches, current === 'newer' ? 1 : 0); assert.equal(result.released, current === 'newer');
});

 test('a fresh passive child request uses the reclaimed main inline editor and preserves both drafts', { timeout: 15000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'real-inline-reclaim' }, sourceScope = { ...scope, conversationId: 'real-inline-source' };
    const old = await S.claimEditor({ scope, viewId: 'real-inline-view', label: 'old-child', transitionId: null, creation: { agentId: 'default' } }, () => {}), oldDrafts = old.drafts(() => {});
    await oldDrafts.load(scope); await oldDrafts.save({ version: 3, scope, draft: 'Exact target draft before reclaim', draftRevision: 1, outbox: [], frontendSends: [], image: null }); const prior = old.editorBinding(); await old.close();
    const native = { scope, viewId: old.viewId, label: 'old-child', transitionId: 'old-native-target', creationAgentId: null, phase: 'target-ready', bindingRevision: prior.revision, writerGeneration: prior.writerGeneration };
    const source = await S.claimEditor({ scope: sourceScope, viewId: 'real-inline-source-view', label: 'source-child', transitionId: null, creation: { agentId: 'default' } }, () => {}), sourceDrafts = source.drafts(() => {}); await sourceDrafts.load(sourceScope); await sourceDrafts.save({ version: 3, scope: sourceScope, draft: 'Source child exact unsent bytes', draftRevision: 1, outbox: [], frontendSends: [], image: null }); const sourceBefore = await sourceDrafts.load(sourceScope);
    let intent = { sourceScope, requestId: '1:real-inline-reclaim', action: { kind: 'open', scope, passive: true, carry: false }, target: null, result: null }, assignment = null, launches = 0, owner;
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'read-intent') return intent;
      if (command.kind === 'lookup') return { kind: 'closed', reservation: native };
      if (command.kind === 'assign-intent') { assignment = command; const b = command.currentBinding, fresh = b?.viewId === native.viewId && b.revision >= native.bindingRevision && b.writerGeneration >= native.writerGeneration && (b.revision > native.bindingRevision || b.writerGeneration > native.writerGeneration); intent = { ...intent, target: fresh ? { ...native, transitionId: 'fresh-inline-intent', phase: 'assigned' } : native }; return intent; }
      if (command.kind === 'complete-intent') { intent = { ...intent, result: command.result }; return { ok: true }; }
      if (command.kind === 'launch') { launches++; return null; }
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port), f = globalThis.controllerFixture({ placement: coordinator });
    f.storage.open = async onFailure => { owner = await S.claimEditor({ scope, viewId: native.viewId, label: 'main', transitionId: null, creation: null }, onFailure); await owner.saveView('host', { version: 2, route: scope, pendingCreation: null }); return owner; };
    f.behavior.continuation = async input => ({ predecessor: null, carried: null, closure: null, successor: input.scope.conversationId === sourceScope.conversationId ? { kind: 'confirmed', scope } : null });
    try { await f.app.start(); const before = await f.app.getSnapshot().active.store.captureDraft(), currentBinding = owner.editorBinding();
      const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, controller: f.app, coordinator, port, snapshot: { placementNotice: null }, listeners: new Set(), async syncDraftCarries() {} });
      await runtime.processIntent(intent); return { receipt: intent.result, assignment, currentBinding, active: f.app.getSnapshot().active?.scope, before, after: await f.app.getSnapshot().active.store.captureDraft(), sourceBefore, sourceAfter: await sourceDrafts.load(sourceScope), launches, sent: f.submitted.length, created: f.created.length };
    } finally { await f.app.dispose(); await source.close(); }
  });
  assert.deepEqual(result.receipt, { kind: 'inline', scope: { hostId: 'host', conversationId: 'real-inline-reclaim' } }); assert.deepEqual(result.active, result.receipt.scope); assert.deepEqual(result.assignment.currentBinding, result.currentBinding);
  assert.deepEqual(result.after, result.before); assert.equal(result.after.text, 'Exact target draft before reclaim'); assert.deepEqual(result.sourceAfter, result.sourceBefore); assert.equal(result.sourceAfter.draft, 'Source child exact unsent bytes'); assert.equal(result.launches, 0); assert.equal(result.sent, 0); assert.equal(result.created, 0);
});


for (const failure of ['binding-read', 'runtime-track', 'placement-guard', 'focus']) test(`observed native Ready survives a later ${failure} failure and unavailable recheck`, async t => {
  const page = await fixture(t), result = await page.evaluate(async failure => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'observed-ready-target' }, child = await S.claimEditor({ scope, viewId: 'observed-ready-view', label: 'observed-ready-child', transitionId: null, creation: { agentId: 'default' } }, () => {});
    const drafts = child.drafts(() => {}); await drafts.load(scope); await drafts.save({ version: 3, scope, draft: 'Exact completed native editor text', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    const binding = child.editorBinding(), reservation = { scope, viewId: child.viewId, label: 'observed-ready-child', transitionId: 'observed-ready-transition', creationAgentId: null, phase: 'target-ready', bindingRevision: binding.revision, writerGeneration: binding.writerGeneration }, calls = [], focuses = [];
    let readyObserved = false, armed = true, closedChild = Promise.resolve(), delivery = 'first', current = true, tracks = 0;
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) { calls.push(command.kind); if (command.kind === 'lookup') { if (readyObserved) throw new Error('Native lookup unavailable after completed Ready'); readyObserved = true; return { kind: 'ready', reservation }; } if (command.kind === 'launch') { focuses.push(command); if (!command.existingOnly) throw new Error('Closed Ready must not recreate a window'); throw new Error('Completed child closed before focus'); } throw new Error(command.kind); } };
    const coordinator = new globalThis.WindowCoordinator(port), ui = Object.create(globalThis.UiConnection.prototype);
    ui.reservePlacement = async () => { tracks++; };
    const runtime = Object.assign(new globalThis.WindowRuntime({ role: 'main', version: 1, label: 'main', brokerInstance: 'broker', documentIncarnation: 'main', viewId: 'catalog', reservation: null, liveRelay: true }), { coordinator, port, ui, controller: { getSnapshot: () => ({ host: { kind: 'ready', metadata: { hostId: 'host' } } }), pendingPlacements: () => [] }, confirmedPolicyDelivery: () => delivery, policyScope: scope, policyDelivery: 'first', placingPolicy: { scope, delivery: 'first', transitions: [{ slot: { transitionId: 'first-delivery-slot' } }] } });
    runtime.configurePlacementTracking();
    const originalGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(key) { const request = originalGet.call(this, key); if (armed && readyObserved && Array.isArray(key) && key[0] === 'editor-binding' && key[2] === scope.conversationId) { armed = false; request.addEventListener('success', () => { closedChild = child.close(); if (failure === 'binding-read') this.transaction.abort(); if (failure === 'runtime-track') delivery = 'second'; if (failure === 'placement-guard') current = false; }); } return request; };
    let placed;
    try { placed = await coordinator.withPlacementGuard(scope, () => current, () => coordinator.acquire({ scope, creation: false, agentId: 'default', agentLabel: 'Agent', carryFrom: null, initialDraft: null }, { storage: { viewId: 'catalog' }, holds: () => false, async quiesce() { throw new Error('No source quiesce'); }, async release() { throw new Error('No source release'); } })); }
    finally { IDBObjectStore.prototype.get = originalGet; await closedChild; }
    const recovery = await S.reopenForRecovery(child.viewId, () => {}); let text;
    try { text = (await recovery.drafts(() => {}).load(scope)).draft; } finally { await recovery.close(); }
    return { placed, calls, focuses, tracks, text, notice: runtime.getSnapshot().placementNotice, readyObserved };
  }, failure);
  assert.deepEqual(result.placed, { kind: 'detached', scope: { hostId: 'host', conversationId: 'observed-ready-target' }, label: 'observed-ready-child' });
  assert.equal(result.readyObserved, true); assert.equal(result.text, 'Exact completed native editor text'); if (failure === 'runtime-track' || failure === 'placement-guard') assert.equal(result.notice, null); else assert.ok(result.notice);
  assert.equal(result.calls.includes('reserve'), false); assert.equal(result.calls.filter(kind => kind === 'launch').length, failure === 'focus' ? 1 : 0);
  assert.ok(result.focuses.every(command => command.existingOnly === true));
  if (failure === 'runtime-track') assert.equal(result.tracks, 0);
});


test('one native wake settles an applied carry after the first host recovery page', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'z-ninth-source' }, targetScope = { hostId: 'host', conversationId: 'z-ninth-target' };
    const source = await S.claimEditor({ scope, viewId: 'ninth-source-view', label: 'old-source-child', transitionId: null, creation: { agentId: 'default' } }, () => {}), target = await S.claimEditor({ scope: targetScope, viewId: 'ninth-target-view', label: 'target-child', transitionId: null, creation: { agentId: 'default' } }, () => {});
    const make = (owner, selected) => globalThis.createConversationStore({ scope: selected, port: { scope: selected }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}) });
    const a = make(source, scope), b = make(target, targetScope); await Promise.all([a.ready, b.ready]); await a.setDraft('Ninth source exact unsent text'); await b.setDraft('Target original text');
    const requestId = '1:ninth-applied', expected = await a.captureDraft(); await c.offerDraftCarry({ source: scope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected }); await c.bindDraftCarry(scope, requestId, targetScope);
    await b.transferDraft(await b.captureDraft(), 'Ninth source exact unsent text\n\nTarget original text', { kind: 'receive', source: scope, requestId });
    await a.dispose(); await source.close();
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records'); for (let index = 0; index < 8; index++) { const source = { hostId: 'host', conversationId: `a-terminal-${index}` }, target = { hostId: 'host', conversationId: `a-terminal-target-${index}` }; store.put({ version: 1, kind: 'settled', source, sourceViewId: `terminal-${index}`, requestId: `1:terminal-${index}`, target, outcome: 'cleared' }, ['draft-carry', 'host', source.conversationId, `1:terminal-${index}`]); } tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
    const f = globalThis.controllerFixture(); f.storage.locate = async selected => (await S.locateEditor(selected)).binding?.viewId ?? null; f.storage.recoverClosedView = (viewId, failure) => S.reopenForRecovery(viewId, failure); await f.app.start();
    const runtime = Object.assign(new globalThis.WindowRuntime({ role: 'main', version: 1, label: 'main', brokerInstance: 'broker', documentIncarnation: 'main', viewId: 'catalog', reservation: null, liveRelay: true }), { controller: f.app, port: { async request(command) { if (command.kind === 'pending-intents') return []; throw new Error(command.kind); } }, recoveryDirty: false, confirmedPolicyDelivery: () => null });
    let drives = 0; const drive = runtime.drive.bind(runtime); runtime.drive = async () => { drives++; if (drives > 4) throw new Error('Carry paging must finish without a hot loop'); await drive(); };
    try { await runtime.drive(); const deadline = performance.now() + 3000; let carry, recovered; for (;;) { carry = (await c.sourceCarries(scope))[0]; if (carry?.kind === 'settled' && !runtime.processing && runtime.carrySettlementAfter === null) { recovered = await S.reopenForRecovery(source.viewId, () => {}); if (recovered) break; } if (performance.now() > deadline) throw new Error('Ninth transfer did not settle and release its source'); await new Promise(resolve => setTimeout(resolve, 5)); } let text; try { text = (await recovered.drafts(() => {}).load(scope)).draft; } finally { await recovered.close(); } return { drives, text, carry: (await c.sourceCarries(scope))[0], target: (await b.captureDraft()).text, notice: runtime.getSnapshot().placementNotice, sent: f.submitted.length }; }
    finally { runtime.closed = true; await f.app.dispose(); await b.dispose(); await target.close(); }
  });
  assert.equal(result.text, ''); assert.equal(result.carry.kind, 'settled'); assert.equal(result.carry.outcome, 'cleared'); assert.equal(result.target, 'Ninth source exact unsent text\n\nTarget original text'); assert.equal(result.drives, 2); assert.equal(result.sent, 0);
});


test('registration and event close reads for one attempt do not retry saving after its failure', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const scope = { hostId: 'host', conversationId: 'duplicate-close-source' }, context = { role: 'chat', version: 1, label: 'duplicate-child', brokerInstance: 'broker', documentIncarnation: 'duplicate-document', viewId: 'original-view', reservation: { scope }, liveRelay: true }, f = globalThis.controllerFixture({ fixedScope: scope });
    f.views.set('original-view/host', { version: 2, route: scope, pendingCreation: null }); await f.app.start(); await f.app.getSnapshot().active.store.setDraft('Exact repeated close source bytes');
    const handlers = new Map(), capturedReads = [], tasks = []; let pending = 'attempt-A', prepares = 0, disposes = 0; const commands = [], prepare = f.app.prepareClose.bind(f.app), dispose = f.app.dispose.bind(f.app);
    f.app.prepareClose = async () => { prepares++; await prepare(); if (pending !== 'attempt-B') throw new Error('First attempt save refused'); }; f.app.dispose = async () => { disposes++; await dispose(); };
    const port = { context, async listen(event, handler) { handlers.set(event, handler); return () => {}; }, async request(command) { if (command.kind === 'read-close') { const captured = { pending: pending !== null, attemptId: pending }; return new Promise(resolve => capturedReads.push(() => resolve(captured))); } commands.push({ kind: command.kind, attemptId: command.attemptId }); if (command.kind === 'close-cancelled') { if (command.attemptId !== pending) throw new Error('close-request-cancelled'); pending = null; return { ok: true }; } if (command.kind === 'close-ready') { if (command.attemptId !== pending) throw new Error('close-request-cancelled'); pending = null; return { ok: true }; } throw new Error(command.kind); } };
    const runtime = Object.assign(new globalThis.WindowRuntime(context), { controller: f.app, port, ui: { subscribe: () => () => {}, start() {} }, uiChanged() {}, drive: async () => {} });
    const closeWake = runtime.closeWake.bind(runtime); runtime.closeWake = () => { const task = closeWake(); tasks.push(task); return task; };
    const wait = async predicate => { for (let n = 0; n < 100 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 5)); if (!predicate()) throw new Error('Close registration boundary did not arrive'); };
    try { runtime.start(); await wait(() => capturedReads.length === 1); handlers.get('openpane-close-requested')(); await wait(() => capturedReads.length === 2); capturedReads[0](); await tasks[0]; const afterFirst = { prepares, disposes, pending, closing: runtime.getSnapshot().closing }; capturedReads[1](); await tasks[1]; const afterDuplicate = { prepares, disposes, pending, closing: runtime.getSnapshot().closing };
      pending = 'attempt-B'; handlers.get('openpane-close-requested')(); await wait(() => capturedReads.length === 3); capturedReads[2](); await tasks[2]; return { afterFirst, afterDuplicate, prepares, disposes, pending, commands, draft: f.drafts.get('original-view/host/duplicate-close-source')?.draft }; }
    finally { await f.app.dispose(); }
  });
  assert.deepEqual(result.afterFirst, { prepares: 1, disposes: 0, pending: null, closing: false }); assert.deepEqual(result.afterDuplicate, result.afterFirst); assert.equal(result.prepares, 2); assert.equal(result.disposes, 1); assert.equal(result.pending, null); assert.deepEqual(result.commands, [{ kind: 'close-cancelled', attemptId: 'attempt-A' }, { kind: 'close-ready', attemptId: 'attempt-B' }]); assert.equal(result.draft, 'Exact repeated close source bytes');
});


for (const mode of ['empty', 'malformed-pages', 'read-aborted', 'closed-after-first-page', 'busy-after-first-page']) test(`host carry page progress stops safely at ${mode}`, async t => {
  const page = await fixture(t), result = await page.evaluate(async mode => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onupgradeneeded = () => r.result.createObjectStore('records'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    if (mode !== 'empty') await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); for (let n = 0; n < 9; n++) tx.objectStore('records').put({ damaged: 'Preserve unreadable transfer' }, ['draft-carry', 'host', `b-row-${n}`, `1:row-${n}`]); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
    const context = { role: 'main', version: 1, label: 'main', brokerInstance: 'broker', documentIncarnation: 'main', viewId: 'catalog', reservation: null, liveRelay: true }; let busy = false, reads = 0, drives = 0;
    const runtime = Object.assign(new globalThis.WindowRuntime(context), { controller: { getSnapshot: () => ({ busy, host: { kind: 'ready', metadata: { hostId: 'host' } }, active: null, saved: { pendingCreation: null } }) }, recoveryDirty: false, confirmedPolicyDelivery: () => null });
    runtime.port.request = async command => { if (command.kind !== 'pending-intents') throw new Error(command.kind); if (mode === 'closed-after-first-page') runtime.closed = true; if (mode === 'busy-after-first-page') busy = true; return []; };
    if (mode === 'read-aborted') { runtime.carryHostId = 'host'; runtime.carrySettlementAfter = ['draft-carry', 'host', 'a-start', '1:start']; }
    const originalCursor = IDBObjectStore.prototype.openCursor;
    IDBObjectStore.prototype.openCursor = function(range, direction) { const request = originalCursor.call(this, range, direction); if (Array.isArray(range?.lower) && range.lower[0] === 'draft-carry') { reads++; if (mode === 'read-aborted') this.transaction.abort(); } return request; };
    const drive = runtime.drive.bind(runtime); runtime.drive = async () => { drives++; if (drives > 4) throw new Error('Unchanged transfer history caused a hot loop'); await drive(); };
    try { await runtime.drive(); await new Promise(resolve => setTimeout(resolve, 100)); return { reads, drives, notice: runtime.getSnapshot().placementNotice, cursor: runtime.carrySettlementAfter }; }
    finally { runtime.closed = true; IDBObjectStore.prototype.openCursor = originalCursor; }
  }, mode);
  assert.equal(result.reads, mode === 'malformed-pages' ? 2 : 1); assert.equal(result.drives, ['malformed-pages', 'busy-after-first-page'].includes(mode) ? 2 : 1);
  if (mode === 'read-aborted') { assert.match(result.notice, /transfer history could not be read/); assert.deepEqual(result.cursor, ['draft-carry', 'host', 'a-start', '1:start']); }
  if (mode === 'empty' || mode === 'malformed-pages') assert.equal(result.cursor, null);
});


test('a new close event while the earlier attempt is saving completes without another event', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const scope = { hostId: 'host', conversationId: 'busy-close-source' }, context = { role: 'chat', version: 1, label: 'busy-child', brokerInstance: 'broker', documentIncarnation: 'busy-document', viewId: 'original-view', reservation: { scope }, liveRelay: true }, f = globalThis.controllerFixture({ fixedScope: scope });
    f.views.set('original-view/host', { version: 2, route: scope, pendingCreation: null }); await f.app.start(); await f.app.getSnapshot().active.store.setDraft('Exact busy close source bytes');
    let pending = 'attempt-A', prepares = 0, release; const held = new Promise(resolve => { release = resolve; }), handlers = new Map(), tasks = [], commands = [], prepare = f.app.prepareClose.bind(f.app);
    f.app.prepareClose = async () => { prepares++; await prepare(); if (prepares === 1) { await held; throw new Error('Old attempt save refused'); } };
    const port = { context, async listen(event, handler) { handlers.set(event, handler); return () => {}; }, async request(command) { if (command.kind === 'read-close') return { pending: pending !== null, attemptId: pending }; commands.push({ kind: command.kind, attemptId: command.attemptId }); if (command.attemptId !== pending) throw new Error('close-request-cancelled'); pending = null; return { ok: true }; } };
    const runtime = Object.assign(new globalThis.WindowRuntime(context), { controller: f.app, port, ui: { subscribe: () => () => {}, start() {} }, uiChanged() {}, drive: async () => {} }); const closeWake = runtime.closeWake.bind(runtime); runtime.closeWake = () => { const task = closeWake(); tasks.push(task); return task; };
    const wait = async predicate => { for (let n = 0; n < 100 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 5)); if (!predicate()) throw new Error('Busy close boundary did not arrive'); };
    try { runtime.start(); await wait(() => prepares === 1); pending = 'attempt-B'; handlers.get('openpane-close-requested')(); await wait(() => tasks.length === 2); await tasks[1]; const whileBusy = { prepares, closing: runtime.getSnapshot().closing, pending }; release(); await tasks[0]; await new Promise(resolve => setTimeout(resolve, 100)); await Promise.all(tasks); return { whileBusy, prepares, pending, commands, draft: f.drafts.get('original-view/host/busy-close-source')?.draft }; }
    finally { release(); await f.app.dispose(); }
  });
  assert.deepEqual(result.whileBusy, { prepares: 1, closing: true, pending: 'attempt-B' }); assert.equal(result.prepares, 2); assert.equal(result.pending, null); assert.deepEqual(result.commands, [{ kind: 'close-cancelled', attemptId: 'attempt-A' }, { kind: 'close-ready', attemptId: 'attempt-B' }]); assert.equal(result.draft, 'Exact busy close source bytes');
});


test('a carry-applied wake invalidates an earlier host page until a fresh scan completes', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'a-offered-source' }, targetScope = { hostId: 'host', conversationId: 'a-offered-target' };
    const source = await S.claimEditor({ scope, viewId: 'invalidated-source-view', label: 'source-child', transitionId: null, creation: { agentId: 'default' } }, () => {}), target = await S.claimEditor({ scope: targetScope, viewId: 'invalidated-target-view', label: 'target-child', transitionId: null, creation: { agentId: 'default' } }, () => {});
    const make = (owner, selected) => globalThis.createConversationStore({ scope: selected, port: { scope: selected }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}) });
    const a = make(source, scope), b = make(target, targetScope); await Promise.all([a.ready, b.ready]); await a.setDraft('Applied after its first page was read'); await b.setDraft('Destination original bytes');
    const requestId = '1:invalidated-page'; await c.offerDraftCarry({ source: scope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected: await a.captureDraft() }); await c.bindDraftCarry(scope, requestId, targetScope); await a.dispose(); await source.close();
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); for (let n = 0; n < 8; n++) { const source = { hostId: 'host', conversationId: `b-terminal-${n}` }; tx.objectStore('records').put({ version: 1, kind: 'settled', source, sourceViewId: `terminal-${n}`, requestId: `1:terminal-${n}`, target: { hostId: 'host', conversationId: `terminal-target-${n}` }, outcome: 'cleared' }, ['draft-carry', 'host', source.conversationId, `1:terminal-${n}`]); } tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
    const f = globalThis.controllerFixture(); f.storage.locate = async selected => (await S.locateEditor(selected)).binding?.viewId ?? null; f.storage.recoverClosedView = (viewId, failure) => S.reopenForRecovery(viewId, failure); await f.app.start();
    const context = { role: 'main', version: 1, label: 'main', brokerInstance: 'broker', documentIncarnation: 'main', viewId: 'catalog', reservation: null, liveRelay: true }, handlers = new Map(), tasks = [];
    let reached, release, first = true, drives = 0, notifications = 0; const atBoundary = new Promise(resolve => { reached = resolve; }), held = new Promise(resolve => { release = resolve; });
    const port = { context, async listen(event, handler) { handlers.set(event, handler); return () => {}; }, async request(command) { if (command.kind === 'read-close') return { pending: false, attemptId: null }; if (command.kind === 'reservations') return []; if (command.kind === 'pending-intents') { if (first) { first = false; reached(); await held; } return []; } throw new Error(command.kind); } };
    const runtime = Object.assign(new globalThis.WindowRuntime(context), { controller: f.app, port, ui: { subscribe: () => () => {}, start() {}, getSnapshot: () => ({ state: {} }) }, uiChanged() {}, recoveryWake: async () => {}, confirmedPolicyDelivery: () => null, recoveryDirty: false });
    const drive = runtime.drive.bind(runtime); runtime.drive = () => { drives++; if (drives > 8) throw new Error('Invalidated history must reach a finite fixed point'); const task = drive(); tasks.push(task); return task; };
    const receiver = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat', reservation: { scope: targetScope } }, controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope: targetScope, viewId: target.viewId, store: b } }) }, port: { async request(command) { if (command.kind !== 'carry-applied') throw new Error(command.kind); notifications++; handlers.get('openpane-ui-wakeup')(); return { ok: true }; } } });
    let recovered;
    try { runtime.start(); let timer; try { await Promise.race([atBoundary, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('First carry page was not read')), 3000); })]); } finally { clearTimeout(timer); }
      const firstPage = { cursor: runtime.carrySettlementAfter, carry: (await c.sourceCarries(scope))[0].kind }; await receiver.syncDraftCarries(); release(); await Promise.all(tasks);
      const deadline = performance.now() + 2500; let carry; for (;;) { carry = (await c.sourceCarries(scope))[0]; if (carry.kind === 'settled' && !runtime.processing && runtime.carrySettlementAfter === null) { recovered = await S.reopenForRecovery(source.viewId, () => {}); if (recovered) break; } if (performance.now() > deadline) throw new Error(`Applied first-page carry was stranded: ${carry.kind}, drives=${drives}`); await new Promise(resolve => setTimeout(resolve, 5)); }
      const text = (await recovered.drafts(() => {}).load(scope)).draft; return { firstPage, carry, text, target: (await b.captureDraft()).text, notifications, drives, sent: f.submitted.length };
    } finally { release(); runtime.closed = true; await Promise.all(tasks); await recovered?.close(); await f.app.dispose(); await b.dispose(); await target.close(); }
  });
  assert.equal(result.firstPage.carry, 'offered'); assert.ok(result.firstPage.cursor); assert.equal(result.notifications, 1); assert.equal(result.carry.kind, 'settled'); assert.equal(result.carry.outcome, 'cleared'); assert.equal(result.text, ''); assert.equal(result.target, 'Applied after its first page was read\n\nDestination original bytes'); assert.ok(result.drives <= 6); assert.equal(result.sent, 0);
});


for (const retryFails of [false, true]) test(`a same-attempt wake retries only an undelivered close cancellation (retry fails ${retryFails})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async retryFails => {
    const scope = { hostId: 'host', conversationId: 'cancel-delivery-source' }, context = { role: 'chat', version: 1, label: 'cancel-child', brokerInstance: 'broker', documentIncarnation: 'cancel-document', viewId: 'original-view', reservation: { scope }, liveRelay: true }, f = globalThis.controllerFixture({ fixedScope: scope });
    f.views.set('original-view/host', { version: 2, route: scope, pendingCreation: null }); await f.app.start(); await f.app.getSnapshot().active.store.setDraft('Undelivered cancellation keeps exact text');
    const handlers = new Map(), tasks = []; let pending = 'attempt-A', prepares = 0, cancellations = 0, disposes = 0; const prepare = f.app.prepareClose.bind(f.app), dispose = f.app.dispose.bind(f.app);
    f.app.prepareClose = async () => { prepares++; await prepare(); throw new Error('Draft save refused'); }; f.app.dispose = async () => { disposes++; };
    const port = { context, async listen(event, handler) { handlers.set(event, handler); return () => {}; }, async request(command) { if (command.kind === 'read-close') return { pending: pending !== null, attemptId: pending }; if (command.kind === 'close-cancelled') { cancellations++; if (cancellations === 1 || retryFails) throw new Error('IPC failed before native cancellation delivery'); if (command.attemptId !== pending) throw new Error('close-request-cancelled'); pending = null; return { ok: true }; } throw new Error(command.kind); } };
    const runtime = Object.assign(new globalThis.WindowRuntime(context), { controller: f.app, port, ui: { subscribe: () => () => {}, start() {} }, uiChanged() {}, drive: async () => {} }); const closeWake = runtime.closeWake.bind(runtime); runtime.closeWake = () => { const task = closeWake(); tasks.push(task); return task; };
    const wait = async predicate => { for (let n = 0; n < 100 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 5)); if (!predicate()) throw new Error('Cancellation retry boundary did not arrive'); };
    try { runtime.start(); await wait(() => tasks.length === 1); await tasks[0]; const before = { pending, prepares, cancellations, disposes }; handlers.get('openpane-close-requested')(); await wait(() => tasks.length === 2); await tasks[1]; await new Promise(resolve => setTimeout(resolve, 25)); return { before, pending, prepares, cancellations, disposes, tasks: tasks.length, draft: f.drafts.get('original-view/host/cancel-delivery-source')?.draft }; }
    finally { await dispose(); }
  }, retryFails);
  assert.deepEqual(result.before, { pending: 'attempt-A', prepares: 1, cancellations: 1, disposes: 0 }); assert.equal(result.prepares, 1); assert.equal(result.disposes, 0); assert.equal(result.cancellations, 2); assert.equal(result.tasks, 2); assert.equal(result.pending, retryFails ? 'attempt-A' : null); assert.equal(result.draft, 'Undelivered cancellation keeps exact text');
});


test('a supported metadata host change starts settlement in the new host history', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'aa-new', conversationId: 'new-host-source' }, targetScope = { hostId: 'aa-new', conversationId: 'new-host-target' };
    const source = await S.claimEditor({ scope, viewId: 'new-host-source-view', label: 'closed-source-child', transitionId: null, creation: { agentId: 'default' } }, () => {}), target = await S.claimEditor({ scope: targetScope, viewId: 'new-host-target-view', label: 'closed-target-child', transitionId: null, creation: { agentId: 'default' } }, () => {});
    const make = (owner, selected) => globalThis.createConversationStore({ scope: selected, port: { scope: selected }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}) });
    const a = make(source, scope), b = make(target, targetScope); await Promise.all([a.ready, b.ready]); await a.setDraft('New host source exact saved bytes'); const requestId = '1:new-host-transfer'; await c.offerDraftCarry({ source: scope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected: await a.captureDraft() }); await c.bindDraftCarry(scope, requestId, targetScope); await b.transferDraft(await b.captureDraft(), 'New host source exact saved bytes', { kind: 'receive', source: scope, requestId }); await Promise.all([a.dispose(), b.dispose()]); await Promise.all([source.close(), target.close()]);
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); for (let n = 0; n < 9; n++) { const source = { hostId: 'zz-old', conversationId: `old-source-${n}` }; tx.objectStore('records').put({ version: 1, kind: 'settled', source, sourceViewId: `old-view-${n}`, requestId: `1:old-${n}`, target: { hostId: 'zz-old', conversationId: `old-target-${n}` }, outcome: 'cleared' }, ['draft-carry', 'zz-old', source.conversationId, `1:old-${n}`]); } tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
    const f = globalThis.controllerFixture(); f.storage.locate = async selected => (await S.locateEditor(selected)).binding?.viewId ?? null; f.storage.recoverClosedView = (viewId, failure) => S.reopenForRecovery(viewId, failure); f.host('zz-old'); await f.app.start();
    const runtime = Object.assign(new globalThis.WindowRuntime({ role: 'main', version: 1, label: 'main', brokerInstance: 'broker', documentIncarnation: 'main', viewId: 'catalog', reservation: null, liveRelay: true }), { controller: f.app, port: { async request(command) { if (command.kind === 'pending-intents' || command.kind === 'reservations') return []; throw new Error(command.kind); } }, recoveryDirty: false, confirmedPolicyDelivery: () => null });
    try { await runtime.syncDraftCarries(); const oldCursor = runtime.carrySettlementAfter; runtime.carryRecoveryAfter = oldCursor; f.host('aa-new'); await f.app.reconnect(); const newHost = f.app.getSnapshot().host; await runtime.drive(); const carry = (await c.sourceCarries(scope))[0]; const sourceRead = await S.reopenForRecovery(source.viewId, () => {}), targetRead = await S.reopenForRecovery(target.viewId, () => {}); let sourceText, targetText; try { sourceText = (await sourceRead.drafts(() => {}).load(scope)).draft; targetText = (await targetRead.drafts(() => {}).load(targetScope)).draft; } finally { await sourceRead.close(); await targetRead.close(); } return { sourceText, targetText, history: runtime.getSnapshot().recovery, oldCursor, cursor: runtime.carrySettlementAfter, newHost: newHost.kind === 'ready' ? newHost.metadata.hostId : newHost.kind, carry: carry.kind, notice: runtime.getSnapshot().placementNotice }; }
    finally { runtime.closed = true; await f.app.dispose(); }
  });
  assert.equal(result.newHost, 'aa-new'); assert.ok(result.oldCursor); assert.equal(result.carry, 'settled'); assert.equal(result.cursor, null); assert.equal(result.notice, null); assert.equal(result.sourceText, ''); assert.equal(result.targetText, 'New host source exact saved bytes'); assert.equal(result.history.kind, 'main'); assert.equal(result.history.carriesFirstPage, true); assert.ok(result.history.carries.length > 0); assert.ok(result.history.carries.every(carry => carry.source.hostId === 'aa-new'));
});


for (const mode of ['empty', 'malformed', 'failed-read', 'busy']) test(`invalidated carry scans remain finite with ${mode} history`, async t => {
  const page = await fixture(t), result = await page.evaluate(async mode => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onupgradeneeded = () => r.result.createObjectStore('records'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    if (mode !== 'empty') await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); for (let n = 0; n < 9; n++) tx.objectStore('records').put({ unreadable: 'Keep this original record' }, ['draft-carry', 'host', `source-${n}`, `1:row-${n}`]); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
    const context = { role: 'main', version: 1, label: 'main', brokerInstance: 'broker', documentIncarnation: 'main', viewId: 'catalog', reservation: null, liveRelay: true }, handlers = new Map(), tasks = []; let enter, release, first = true, busy = false, fail = false, drives = 0, reads = 0;
    const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
    const controller = { pendingPlacements: () => [], getSnapshot: () => ({ busy, host: { kind: 'ready', metadata: { hostId: 'host' } }, active: null, saved: { pendingCreation: null } }), subscribe: () => () => {}, async start() {}, async refreshCatalog() {} };
    const port = { context, async listen(event, handler) { handlers.set(event, handler); return () => {}; }, async request(command) { if (command.kind === 'read-close') return { pending: false, attemptId: null }; if (command.kind === 'reservations') return []; if (command.kind === 'pending-intents') { if (first) { first = false; enter(); await held; } return []; } throw new Error(command.kind); } };
    const runtime = Object.assign(new globalThis.WindowRuntime(context), { controller, port, ui: { subscribe: () => () => {}, start() {}, getSnapshot: () => ({ state: {} }) }, uiChanged() {}, recoveryWake: async () => {}, confirmedPolicyDelivery: () => null, recoveryDirty: false });
    const originalCursor = IDBObjectStore.prototype.openCursor; IDBObjectStore.prototype.openCursor = function(range, direction) { const request = originalCursor.call(this, range, direction); if (Array.isArray(range?.lower) && range.lower[0] === 'draft-carry') { reads++; if (fail) this.transaction.abort(); } return request; };
    const drive = runtime.drive.bind(runtime); runtime.drive = () => { drives++; if (drives > 8) throw new Error('Invalidation caused an unbounded retry'); const task = drive(); tasks.push(task); return task; };
    try { runtime.start(); let timer; try { await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Missing first-page boundary')), 3000); })]); } finally { clearTimeout(timer); } fail = mode === 'failed-read'; handlers.get('openpane-ui-wakeup')(); if (mode === 'busy') busy = true; release();
      const deadline = performance.now() + 3000; let consumed = 0; for (;;) { const count = tasks.length; await Promise.all(tasks.slice(consumed)); consumed = count; await new Promise(resolve => setTimeout(resolve, 0)); if (consumed === tasks.length && !runtime.processing) break; if (performance.now() > deadline) throw new Error('Invalidated scan did not become idle'); }
      return { drives, reads, cursor: runtime.carrySettlementAfter, dirty: runtime.carrySettlementDirty, notice: runtime.getSnapshot().placementNotice };
    } finally { release(); runtime.closed = true; IDBObjectStore.prototype.openCursor = originalCursor; }
  }, mode);
  assert.ok(result.drives <= 6, JSON.stringify(result)); assert.ok(result.reads <= 6, JSON.stringify(result)); if (mode === 'empty' || mode === 'malformed') { assert.equal(result.cursor, null, JSON.stringify(result)); assert.equal(result.dirty, false); } else assert.ok(result.cursor);
});


for (const channel of ['settlement', 'recovery']) test(`an old-host ${channel} page cannot replace new-host state after reconnect`, async t => {
  const page = await fixture(t), result = await page.evaluate(async channel => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onupgradeneeded = () => r.result.createObjectStore('records'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); for (const hostId of ['zz-old', 'aa-new']) for (let n = 0; n < 9; n++) { const source = { hostId, conversationId: `source-${n}` }; tx.objectStore('records').put({ version: 1, kind: 'settled', source, sourceViewId: `${hostId}-view-${n}`, requestId: `1:row-${n}`, target: { hostId, conversationId: `target-${n}` }, outcome: 'cleared' }, ['draft-carry', hostId, source.conversationId, `1:row-${n}`]); } tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
    const f = globalThis.controllerFixture(); f.host('zz-old'); await f.app.start(); const runtime = Object.assign(new globalThis.WindowRuntime({ role: 'main', version: 1, label: 'main', brokerInstance: 'broker', documentIncarnation: 'main', viewId: 'catalog', reservation: null, liveRelay: true }), { controller: f.app, port: { async request(command) { if (command.kind === 'reservations') return []; throw new Error(command.kind); } } });
    const originalOpen = IDBFactory.prototype.open; let armed = true, enter, release; const entered = new Promise(resolve => { enter = resolve; });
    IDBFactory.prototype.open = function(...args) { const request = originalOpen.apply(this, args); if (armed && args[0] === 'openpane-browser-views') { armed = false; request.addEventListener('success', event => { event.stopImmediatePropagation(); release = () => request.onsuccess?.call(request, event); enter(); }); } return request; };
    const read = () => channel === 'settlement' ? runtime.syncDraftCarries() : runtime.refreshRecovery(); let old;
    try { old = read(); let timer; try { await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Old-host page was not held')), 3000); })]); } finally { clearTimeout(timer); } IDBFactory.prototype.open = originalOpen; f.host('aa-new'); await f.app.reconnect(); if (channel === 'recovery') { release(); await old; if (runtime.getSnapshot().recovery.kind !== 'none') throw new Error('Old host recovery published after reconnect'); } await read(); const current = channel === 'settlement' ? runtime.carrySettlementAfter : runtime.getSnapshot().recovery; if (channel === 'settlement') { release(); await old; } return { current, after: channel === 'settlement' ? runtime.carrySettlementAfter : runtime.getSnapshot().recovery, owner: runtime.carryHostId, host: f.app.getSnapshot().host.metadata.hostId }; }
    finally { IDBFactory.prototype.open = originalOpen; release?.(); await old; await f.app.dispose(); }
  }, channel);
  assert.equal(result.host, 'aa-new'); assert.equal(result.owner, 'aa-new'); assert.deepEqual(result.after, result.current); if (channel === 'settlement') assert.equal(result.after[1], 'aa-new'); else { assert.equal(result.after.carriesFirstPage, true); assert.ok(result.after.carries.every(carry => carry.source.hostId === 'aa-new')); }
});


test('a source opening uses exact historical Ready while its native carry intent remains recoverable', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'ready-carry-source' }, targetScope = { hostId: 'host', conversationId: 'ready-carry-target' };
    const target = await S.claimEditor({ scope: targetScope, viewId: 'ready-carry-target-view', label: 'historical-ready-child', transitionId: null, creation: { agentId: 'default' } }, () => {}), td = target.drafts(() => {}); await td.load(targetScope); await td.save({ version: 3, scope: targetScope, draft: 'Original historical target bytes', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    const binding = target.editorBinding(), reservation = { scope: targetScope, viewId: target.viewId, label: 'historical-ready-child', transitionId: 'historical-ready-attempt', creationAgentId: null, phase: 'target-ready', bindingRevision: binding.revision, writerGeneration: binding.writerGeneration }; await target.close();
    const context = { role: 'chat', version: 1, label: 'source-child', brokerInstance: 'broker', documentIncarnation: 'source', viewId: 'ready-carry-source-view', reservation: { scope }, liveRelay: true }; let saved, owner, continued = false, completions = 0; const focuses = [];
    const port = { context, async request(command) { if (command.kind === 'intent-context') return { epoch: 1, pendingCarryRequests: [] }; if (command.kind === 'placement-intent') { saved = { sourceScope: scope, requestId: command.requestId, action: command.action, target: reservation, result: null }; return saved; } if (command.kind === 'read-intent') return saved; if (command.kind === 'own-intents') return { epoch: 1, pending: saved.result === null ? [saved] : [], items: saved.result === null ? [] : [saved], after: null }; if (command.kind === 'launch') { focuses.push(command); return null; } if (command.kind === 'complete-intent') { completions++; saved = { ...saved, result: command.result }; return { ok: true }; } throw new Error(command.kind); } };
    const coordinator = new globalThis.WindowCoordinator(port), f = globalThis.controllerFixture({ fixedScope: scope, placement: coordinator }); f.storage.open = async failure => { owner = await S.claimEditor({ scope, viewId: context.viewId, label: context.label, transitionId: null, creation: { agentId: 'default' } }, failure); await owner.saveView('host', { version: 2, route: scope, pendingCreation: null }); return owner; };
    const none = { predecessor: null, carried: null, closure: 'cancelled', successor: null }; f.behavior.continuation = async input => { if (input.scope.conversationId !== scope.conversationId) return { ...none, closure: null }; if (input.action === 'start') continued = true; return { ...none, successor: continued ? { kind: 'confirmed', scope: targetScope } : null }; };
    await f.app.start(); const active = f.app.getSnapshot().active; await active.store.setDraft('Exact source capture survives transient binding failure');
    const source = Object.assign(new globalThis.WindowRuntime(context), { controller: f.app, coordinator, port, childOwner: owner }); source.configurePlacementTracking();
    for (let n = 0; n < 100 && !f.app.getSnapshot().continuation?.view; n++) await new Promise(resolve => setTimeout(resolve, 5)); await f.app.conversationActions(active).continueConversation();
    const pending = f.app.getSnapshot().lastPlacement, main = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, port, controller: { getSnapshot: () => ({ host: { kind: 'ready', metadata: { hostId: 'host' } }, active: null }) }, snapshot: { placementNotice: null }, listeners: new Set() });
    const originalGet = IDBObjectStore.prototype.get; let fail = true; IDBObjectStore.prototype.get = function(key) { const request = originalGet.call(this, key); if (fail && Array.isArray(key) && key[0] === 'draft-carry' && key[3] === saved.requestId) { fail = false; request.addEventListener('success', () => this.transaction.abort()); } return request; };
    try { await main.processIntent(saved); IDBObjectStore.prototype.get = originalGet; await source.readRecovery(); const during = { placement: f.app.getSnapshot().lastPlacement, native: saved, carry: (await c.sourceCarries(scope))[0], draft: (await active.store.captureDraft()).text, completions, focuses: [...focuses] };
      await main.processIntent(saved); const after = { native: saved, carry: (await c.sourceCarries(scope))[0], completions, focuses: [...focuses] }; return { pending, during, after, exactTarget: reservation, sent: f.submitted.length };
    } finally { IDBObjectStore.prototype.get = originalGet; await f.app.dispose(); }
  });
  assert.equal(result.pending.kind, 'pending'); assert.deepEqual(result.during.placement, { kind: 'detached', scope: result.exactTarget.scope, label: result.exactTarget.label }); assert.equal(result.during.native.result, null); assert.deepEqual(result.during.native.target, result.exactTarget); assert.equal(result.during.carry.kind, 'offered'); assert.equal(result.during.carry.target, null); assert.equal(result.during.draft, 'Exact source capture survives transient binding failure'); assert.equal(result.during.completions, 0); assert.equal(result.during.focuses.length, 0);
  assert.equal(result.after.native.result.kind, 'detached'); assert.deepEqual(result.after.native.target, result.exactTarget); assert.deepEqual(result.after.carry.target, result.exactTarget.scope); assert.equal(result.after.completions, 1); assert.equal(result.after.focuses.length, 1); assert.equal(result.after.focuses[0].existingOnly, true); assert.equal(result.sent, 0);
});


test('passive separate placement creates a fresh native transition after actual inline handoff recovery', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'inline-recovered-separate' }, viewId = 'inline-recovered-view';
    let source = await S.claimEditor({ scope, viewId, label: 'main', transitionId: null, creation: { agentId: 'default' } }, () => {});
    const drafts = source.drafts(() => {}); await drafts.load(scope); await drafts.save({ version: 3, scope, draft: 'Recovered inline exact bytes', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    await source.reserveHandoff({ scope, sourceViewId: viewId, targetViewId: viewId, expectedBinding: source.editorBinding(), targetLabel: 'failed-child', transitionId: 'failed-attempt' }); await source.close();
    const grant = { scope, viewId, nativeLabel: 'failed-child', fromTransitionId: 'failed-attempt', transitionId: 'inline:failed-attempt', targetLabel: 'main', creationAgentId: null };
    await S.recoverClosed(grant); source = await S.claimEditor({ scope, viewId, label: 'main', transitionId: grant.transitionId, creation: null }, () => {});
    let native = { scope, viewId, label: 'failed-child', transitionId: grant.transitionId, creationAgentId: null, phase: 'inline-ready', bindingRevision: null, writerGeneration: null }, fresh = false, released = false, child;
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return { kind: 'closed', reservation: native };
      if (command.kind === 'reserve') { fresh = command.newTransition; if (fresh) native = { ...native, transitionId: 'fresh-native-attempt', phase: 'requested' }; return native; }
      if (command.kind === 'phase') { native = { ...native, phase: command.phase }; return {}; }
      if (command.kind === 'launch') { if (native.transitionId.startsWith('inline:')) throw new Error('inline-recovery-cannot-launch'); child = await S.claimEditor({ scope, viewId, label: native.label, transitionId: native.transitionId, creation: null }, () => {}); return { kind: 'detached', scope, label: native.label }; }
      throw new Error(command.kind);
    } });
    coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    try {
      const placed = await coordinator.acquire({ scope, creation: false, carryFrom: null, initialDraft: null, agentId: 'default', agentLabel: 'Default', purpose: 'passive' }, { storage: source, holds: id => id === viewId, async quiesce() {}, async release() { released = true; await source.close(); } });
      const text = child ? (await child.drafts(() => {}).load(scope)).draft : (await (await S.reopenForRecovery(viewId, () => {}))?.drafts(() => {}).load(scope))?.draft;
      return { placed, fresh, released, text, binding: (await S.locateEditor(scope)).binding };
    } finally { await child?.close(); await source.close(); }
  });
  assert.equal(result.placed.kind, 'detached', JSON.stringify(result)); assert.equal(result.fresh, true); assert.equal(result.released, true); assert.equal(result.text, 'Recovered inline exact bytes'); assert.equal(result.binding.kind, 'editing');
});
