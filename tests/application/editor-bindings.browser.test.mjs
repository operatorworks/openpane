import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t) {
  const bundle = await build({ stdin: { contents: `import { BrowserViewStorage } from './apps/desktop/src/application/browser-storage.ts';
    import { transferEditor, readEditorBinding } from './apps/desktop/src/application/editor-bindings.ts';
    import { windowContext } from './tests/application/window-context-fixture.mjs';
    import { WindowCoordinator } from './apps/desktop/src/application/window-coordinator.ts';
    import { createConversationStore } from '@openpane/client';
    import { transcriptProjection } from '@openpane/contracts/conversation';
    import { WindowRuntime } from './apps/desktop/src/application/window-runtime.ts';
    import { createFrontendRecovery } from './apps/desktop/src/application/frontend-recovery.ts';
    import { createViewLeasePool } from './apps/desktop/src/application/view-leases.ts';
    import * as carries from './apps/desktop/src/application/draft-carry.ts';
    Object.assign(globalThis, { windowContext, BrowserViewStorage, WindowCoordinator, WindowRuntime, transferEditor, readEditorBinding, createConversationStore, transcriptProjection, carries, createFrontendRecovery, createViewLeasePool });`, resolveDir: root }, bundle: true, write: false, format: 'iife' });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Editor ownership</title>' }));
  await page.goto('http://localhost/editor'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return page;
}

for (const boundary of ['reserve', 'quiesce']) test(`a superseded native placement preserves the source editor after ${boundary}`, { timeout: 15000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async boundary => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'guarded' };
    const source = await S.claimEditor({ scope, viewId: 'guarded-source', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const drafts = source.drafts(() => {}); await drafts.load(scope);
    await drafts.save({ version: 3, scope, draft: 'Keep the guarded draft', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    let release, entered, current = true, launched = 0, released = false;
    const held = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { entered = resolve; });
    const reservation = { scope, viewId: source.viewId, label: 'child', transitionId: 'guarded-move', creationAgentId: null, phase: 'requested', bindingRevision: null, writerGeneration: null };
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return { kind: 'absent' };
      if (command.kind === 'reserve') { if (boundary === 'reserve') { entered(); await held; } return reservation; }
      if (command.kind === 'phase') return {};
      if (command.kind === 'launch') { launched++; return { kind: 'pending', scope, reason: 'Opening' }; }
      throw new Error(command.kind);
    } });
    coordinator.setPresentation({ chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const pending = coordinator.withPlacementGuard(scope, () => current, () => coordinator.acquire({ scope, agentId: 'agent', agentLabel: 'Agent', creation: false, carryFrom: null, initialDraft: null }, {
      storage: source, holds: id => id === source.viewId, async quiesce() { if (boundary === 'quiesce') { entered(); await held; } }, async release() { released = true; await source.close(); },
    }));
    await Promise.race([began, pending.then(() => { throw new Error('Placement settled before the guarded boundary'); })]);
    current = false; release(); const placed = await pending;
    const binding = (await S.locateEditor(scope)).binding, saved = await drafts.load(scope); await source.close();
    return { kind: placed.kind, binding: binding.kind, viewId: binding.viewId, text: saved.draft, launched, released };
  }, boundary);
  assert.deepEqual(result, { kind: 'refused', binding: 'editing', viewId: 'guarded-source', text: 'Keep the guarded draft', launched: 0, released: false });
});

test('a main carry resumes its saved unbound snapshot without recapturing later source edits', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, sourceScope = { hostId: 'host', conversationId: 'carry-source' }, scope = { ...sourceScope, conversationId: 'carry-target' };
    const source = await S.claimEditor({ scope: sourceScope, viewId: 'carry-source-view', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    await c.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId: '1:main-carry-move', writerGeneration: source.editorBinding().writerGeneration, emptyOnly: true, expected: { text: 'Original offered text', revision: 1 } });
    const reservation = { scope, viewId: 'carry-target-view', label: 'child', transitionId: 'carry-move', creationAgentId: null, phase: 'requested', bindingRevision: null, writerGeneration: null };
    let captures = 0;
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return { kind: 'opening', reservation };
      if (command.kind === 'intent-context') return { epoch: 1, pendingCarryRequests: [] };
      if (command.kind === 'launch') return { kind: 'pending', scope, reason: 'Opening' };
      throw new Error(command.kind);
    } });
    coordinator.captureCarry(async () => { captures++; throw new Error('Later source text must not replace a saved offer'); });
    const placed = await coordinator.acquire({ scope, creation: false, carryFrom: sourceScope, initialDraft: null, agentId: 'agent', agentLabel: 'Agent' }, { storage: source, holds: () => false, async quiesce() {}, async release() {} });
    const [carry] = await c.targetCarries(scope); await source.close();
    return { kind: placed.kind, captures, text: carry?.expected.text, requestId: carry?.requestId };
  });
  assert.deepEqual(result, { kind: 'pending', captures: 0, text: 'Original offered text', requestId: '1:main-carry-move' });
});

test('saved transfer recovery can return to its first page after reaching the last page', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries;
    for (let n = 0; n < 9; n++) {
      const scope = { hostId: 'host', conversationId: `paged-${n}` }, source = await S.claimEditor({ scope, viewId: `paged-view-${n}`, label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
      await c.offerDraftCarry({ source: scope, sourceViewId: source.viewId, requestId: `1:page-${n}`, writerGeneration: source.editorBinding().writerGeneration, expected: { text: `Saved ${n}`, revision: 1 } });
      await c.cancelDraftCarry((await c.sourceCarries(scope))[0]); await source.close();
    }
    const runtime = new globalThis.WindowRuntime({ version: 1, role: 'main', label: 'main', brokerInstance: 'broker', documentIncarnation: 'main', viewId: 'catalog', liveRelay: true, reservation: null });
    runtime.controller.getSnapshot = () => ({ host: { kind: 'ready', metadata: { hostId: 'host' } }, lastPlacement: null });
    runtime.port.request = async command => { if (command.kind === 'reservations') return []; throw new Error(command.kind); };
    await runtime.refreshRecovery(); const first = runtime.getSnapshot().recovery.carries.map(carry => carry.requestId);
    await runtime.moreSavedTransfers(); const last = runtime.getSnapshot().recovery;
    await runtime.firstSavedTransfers(); const restored = runtime.getSnapshot().recovery; runtime.close();
    return { first, restored: restored.carries.map(carry => carry.requestId), lastCount: last.carries.length, lastAfter: last.carriesAfter, firstPage: restored.carriesFirstPage };
  });
  assert.equal(result.first.length, 8); assert.equal(result.lastCount, 1); assert.equal(result.lastAfter, null); assert.equal(result.firstPage, true); assert.deepEqual(result.restored, result.first);
});

test('scoped legacy moves preserve independent drafts, images, outboxes and unrelated active routes', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage;
    const a = { hostId: 'host', conversationId: 'A' }, b = { hostId: 'host', conversationId: 'B' };
    const source = await Storage.reopen('legacy', () => {}), port = source.drafts(() => {});
    await source.saveView('host', { version: 2, route: a, pendingCreation: { scope: b, agentId: 'agent-B' } });
    const records = scope => ({ scope, draft: `Draft ${scope.conversationId}`, outbox: [{ originalCommand: scope.conversationId }], frontendSends: [{ retained: scope.conversationId }] });
    await port.save(records(a), { put: { selectionId: 'a-image', bytes: new Uint8Array([1, 2]) } });
    await port.save(records(b), { put: { selectionId: 'b-image', bytes: new Uint8Array([3, 4]) } });
    await source.close();
    const plan = (scope, view, transition) => ({ scope, sourceViewId: 'legacy', targetViewId: view, transitionId: transition, targetLabel: view, expectedBinding: null });
    const movedB = await Storage.transferClosed(plan(b, 'dedicated-B', 'move-B'));
    const legacy = await Storage.reopen('legacy', () => {});
    const afterB = await legacy.readView('host');
    const oldA = await legacy.drafts(() => {}).load(a);
    const stale = await legacy.drafts(() => {}).save(records(b)).then(() => 'written', error => error.name);
    await legacy.close();
    const movedA = await Storage.transferClosed(plan(a, 'dedicated-A', 'move-A'));
    const ownerA = await Storage.claimEditor({ scope: a, viewId: movedA.viewId, label: 'dedicated-A', creation: null, transitionId: 'move-A' }, () => {});
    const ownerB = await Storage.claimEditor({ scope: b, viewId: movedB.viewId, label: 'dedicated-B', creation: null, transitionId: 'move-B' }, () => {});
    const aPort = ownerA.drafts(() => {}), bPort = ownerB.drafts(() => {});
    const aRecords = await aPort.load(a), bRecords = await bPort.load(b);
    const images = [[...await aPort.loadImage(a, 'a-image')], [...await bPort.loadImage(b, 'b-image')], await aPort.loadImage(a, 'b-image')];
    const pendingB = await ownerB.readView('host');
    await ownerA.close(); await ownerB.close();
    return { afterB, oldA, stale, aRecords, bRecords, images, pendingB };
  });
  assert.deepEqual(result.afterB, { version: 2, route: { hostId: 'host', conversationId: 'A' }, pendingCreation: null });
  assert.equal(result.oldA.draft, 'Draft A'); assert.equal(result.stale, 'SupersededDrafts');
  assert.equal(result.aRecords.draft, 'Draft A'); assert.equal(result.bRecords.draft, 'Draft B');
  assert.deepEqual(result.aRecords.outbox, [{ originalCommand: 'A' }]); assert.deepEqual(result.bRecords.outbox, [{ originalCommand: 'B' }]);
  assert.deepEqual(result.images, [[1, 2], [3, 4], null]);
  assert.deepEqual(result.pendingB.pendingCreation, { scope: { hostId: 'host', conversationId: 'B' }, agentId: 'agent-B' });
});

test('dedicated handoff fences old ports and reacquires the same keys without deleting queued work', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'dedicated' };
    const claim = { scope, viewId: 'stable-view', label: 'main', creation: { agentId: 'agent' }, transitionId: null };
    const failures = [], source = await Storage.claimEditor(claim, error => failures.push(error.message));
    const port = source.drafts(error => failures.push(error.message)); await port.load(scope);
    await port.save({ scope, draft: 'Keep', outbox: [{ id: 'one-command' }] }, { put: { selectionId: 'image', bytes: new Uint8Array([8]) } });
    const opening = indexedDB.open('openpane-browser-views', 1), db = await new Promise(resolve => { opening.onsuccess = () => resolve(opening.result); });
    const original = await globalThis.readEditorBinding(db, scope);
    const plan = { scope, sourceViewId: claim.viewId, targetViewId: claim.viewId, transitionId: 'handoff', targetLabel: 'chat', expectedBinding: original };
    const reserved = await source.reserveHandoff(plan);
    const refused = await port.save({ scope, draft: 'Late' }, { remove: ['image'] }).then(() => null, error => error.name);
    const gap = await Storage.claimEditor({ ...claim, label: 'intruder', creation: null, transitionId: null }, () => {}).then(() => 'owned', error => error.message);
    await source.close();
    const wrong = await Storage.claimEditor({ ...claim, label: 'wrong', creation: null, transitionId: 'handoff' }, () => {}).then(() => 'owned', error => error.message);
    const target = await Storage.claimEditor({ ...claim, label: 'chat', creation: null, transitionId: 'handoff' }, () => {});
    const targetPort = target.drafts(() => {}), retained = await targetPort.load(scope), image = [...await targetPort.loadImage(scope, 'image')];
    const active = await globalThis.readEditorBinding(db, scope); await target.close();
    const inline = await Storage.claimEditor({ ...claim, creation: null }, () => {}), again = await inline.drafts(() => {}).load(scope);
    await inline.close(); db.close(); return { original, reserved, active, refused, gap, wrong, retained, image, again, failures };
  });
  assert.equal(result.reserved.writerGeneration, result.original.writerGeneration + 1);
  assert.equal(result.active.writerGeneration, result.reserved.writerGeneration + 1);
  assert.equal(result.refused, 'SupersededDrafts'); assert.match(result.gap, /already has an editor/); assert.match(result.wrong, /reserved/);
  assert.equal(result.retained.draft, 'Keep'); assert.deepEqual(result.retained.outbox, [{ id: 'one-command' }]);
  assert.deepEqual(result.image, [8]); assert.deepEqual(result.again, result.retained); assert.deepEqual(result.failures, []);
});

test('locked sources, occupied destinations and CAS conflicts retain all source records', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'scope' };
    const source = await Storage.reopen('legacy', () => {});
    await source.drafts(() => {}).save({ scope, draft: 'Original', outbox: [{ id: 'original' }] });
    const plan = { scope, sourceViewId: 'legacy', targetViewId: 'target', transitionId: 'move', targetLabel: 'target', expectedBinding: null };
    const locked = await Storage.transferClosed(plan).then(() => null, error => error.message); await source.close();
    const target = await Storage.reopen('target', () => {});
    await target.drafts(() => {}).save({ scope: { ...scope, conversationId: 'other' }, draft: 'Independent work' }); await target.close();
    const occupied = await Storage.transferClosed(plan).then(() => null, error => error.message);
    const conflict = await Storage.transferClosed({ ...plan, targetViewId: 'empty', expectedBinding: { schemaVersion: 1, scope, viewId: 'legacy', kind: 'editing', revision: 1, writerGeneration: 1 } }).then(() => null, error => error.message);
    const read = await Storage.reopen('legacy', () => {}), retained = await read.drafts(() => {}).load(scope); await read.close();
    return { locked, occupied, conflict, retained };
  });
  assert.match(result.locked, /already open/); assert.match(result.occupied, /already contains work/); assert.match(result.conflict, /binding changed/);
  assert.deepEqual(result.retained, { scope: { hostId: 'host', conversationId: 'scope' }, draft: 'Original', outbox: [{ id: 'original' }] });
});

test('interrupted migration aborts images, draft, route and binding together; replay reuses committed reservation', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'scope' };
    const source = await Storage.reopen('legacy', () => {});
    await source.saveView('host', { version: 2, route: scope, pendingCreation: null });
    await source.drafts(() => {}).save({ scope, draft: 'Original' }, { put: { selectionId: 'image', bytes: new Uint8Array([1]) } }); await source.close();
    const plan = { scope, sourceViewId: 'legacy', targetViewId: 'target', transitionId: 'move', targetLabel: 'chat', expectedBinding: null };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) { const request = put.call(this, value, key); if (key[0] === 'editor-binding') request.onsuccess = () => this.transaction.abort(); return request; };
    const interrupted = await Storage.transferClosed(plan).then(() => null, error => error.message); IDBObjectStore.prototype.put = put;
    const retained = await Storage.reopen('legacy', () => {}), port = retained.drafts(() => {});
    const before = { view: await retained.readView('host'), draft: await port.load(scope), image: [...await port.loadImage(scope, 'image')] }; await retained.close();
    const committed = await Storage.transferClosed(plan), replay = await Storage.transferClosed(plan);
    const conflict = await Storage.transferClosed({ ...plan, targetLabel: 'another' }).then(() => null, error => error.message);
    return { interrupted, before, committed, replay, conflict };
  });
  assert.match(result.interrupted, /interrupted/); assert.equal(result.before.draft.draft, 'Original'); assert.deepEqual(result.before.image, [1]); assert.equal(result.before.view.route.conversationId, 'scope');
  assert.deepEqual(result.replay, result.committed); assert.match(result.conflict, /Conflicting editor handoff replay/);
});

test('a persisted migration rejects late legacy saves and images in their own transaction', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'scope' }, failures = [];
    const owner = await Storage.reopen('legacy', () => {}), port = owner.drafts(error => failures.push(error.message));
    await port.load(scope); await port.save({ scope, draft: 'Before', outbox: [{ id: 'original' }] }, { put: { selectionId: 'image', bytes: new Uint8Array([6]) } });
    const opening = indexedDB.open('openpane-browser-views', 1), db = await new Promise(resolve => { opening.onsuccess = () => resolve(opening.result); });
    // Commit authority changes while this old instance still exists, as it can after a handoff boundary.
    await globalThis.transferEditor(db, { scope, sourceViewId: 'legacy', targetViewId: 'target', expectedBinding: null, transitionId: 'move', targetLabel: 'chat' });
    const late = await port.save({ scope, draft: 'Late' }, { remove: ['image'] }).then(() => 'written', error => error.name);
    const staleRoute = await owner.saveView('host', { version: 2, route: scope, pendingCreation: null }).then(() => 'written', error => error.name);
    await owner.close(); db.close();
    const child = await Storage.claimEditor({ scope, viewId: 'target', label: 'chat', creation: null, transitionId: 'move' }, () => {}), childPort = child.drafts(() => {});
    const retained = await childPort.load(scope), bytes = [...await childPort.loadImage(scope, 'image')]; await child.close();
    return { late, staleRoute, retained, bytes, failures };
  });
  assert.equal(result.late, 'SupersededDrafts'); assert.equal(result.staleRoute, 'SupersededDrafts'); assert.equal(result.retained.draft, 'Before');
  assert.deepEqual(result.retained.outbox, [{ id: 'original' }]); assert.deepEqual(result.bytes, [6]); assert.deepEqual(result.failures, []);
});

test('discovery reports independent legacy view IDs and never silently selects one', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'scope' };
    for (const viewId of ['1:first', '1:second']) { const owner = await Storage.reopen(viewId, () => {}); await owner.drafts(() => {}).save({ scope, draft: viewId }); await owner.close(); }
    return Storage.locateEditor(scope);
  });
  assert.equal(result.binding, null); assert.deepEqual(result.legacyViewIds, ['1:first', '1:second']);
});

for (const changed of [false, true]) test(`durable carry ${changed ? 'preserves a newer source draft' : 'clears only its captured source draft'} without replaying outboxes or copying images`, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async changed => {
    const Storage = globalThis.BrowserViewStorage, carries = globalThis.carries;
    const sourceScope = { hostId: 'host', conversationId: 'source' }, targetScope = { hostId: 'host', conversationId: 'target' }, failures = [], submitted = [];
    const claim = scope => ({ scope, viewId: scope.conversationId, label: scope.conversationId, creation: { agentId: 'agent' }, transitionId: null });
    let source = await Storage.claimEditor(claim(sourceScope), error => failures.push(error.message));
    const makeStore = (owner, scope) => globalThis.createConversationStore({ scope, drafts: owner.drafts(error => failures.push(error.message)), projection: globalThis.transcriptProjection,
      createCommandId: () => 'never-submit', port: { scope, async receipt() { return null; }, async submit(command) { submitted.push(command); throw new Error('No send was requested'); }, watch() { return { close() {}, ended: new Promise(() => {}) }; } } });
    let sourceStore = makeStore(source, sourceScope); await sourceStore.ready; await sourceStore.setDraft('Queued original'); await sourceStore.dispose();
    const seed = source.drafts(() => {}), saved = await seed.load(sourceScope);
    const image = { selectionId: 'source-image', uploadId: '22222222-2222-4222-8222-222222222222', name: 'image.png', byteLength: 2, attachment: null };
    await seed.save({ ...saved, outbox: [{ command: { version: 1, scope: sourceScope, clientCommandId: 'original-command', body: { kind: 'send', text: 'Queued original' } }, draftRevision: saved.draftRevision }], image },
      { put: { selectionId: image.selectionId, bytes: new Uint8Array([7, 8]) } });
    sourceStore = makeStore(source, sourceScope); await sourceStore.ready; await sourceStore.setDraft('Carry me');
    const expected = await sourceStore.captureDraft(), binding = source.editorBinding();
    await carries.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId: '1:carry-request', writerGeneration: binding.writerGeneration, expected });
    const duplicate = await carries.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId: '1:different-request', writerGeneration: binding.writerGeneration, expected }).then(() => 'offered', error => error.message);
    await carries.bindDraftCarry(sourceScope, '1:carry-request', targetScope);
    const conflict = await carries.bindDraftCarry(sourceScope, '1:carry-request', { ...targetScope, conversationId: 'other' }).then(() => 'bound', error => error.message);
    const target = await Storage.claimEditor(claim(targetScope), () => {}), targetStore = makeStore(target, targetScope); await targetStore.ready; await targetStore.setDraft('Already typed');
    const [offer] = await carries.targetCarries(targetScope);
    const current = await targetStore.captureDraft();
    await targetStore.transferDraft(current, `${offer.expected.text}\n\n${current.text}`, { kind: 'receive', source: offer.source, requestId: offer.requestId });
    // A lost success reply leaves both the destination text and applied marker committed together.
    const [replayed] = await carries.targetCarries(targetScope);
    if (replayed.kind !== 'applied') throw new Error('Applied transfer was not durable');
    await sourceStore.dispose(); await source.close();
    source = await Storage.claimEditor({ ...claim(sourceScope), creation: null }, () => {}); sourceStore = makeStore(source, sourceScope); await sourceStore.ready;
    if (changed) await sourceStore.setDraft('Changed while the target opens');
    const [applied] = await carries.sourceCarries(sourceScope), cleared = await sourceStore.transferDraft(applied.expected, '', { kind: 'release', source: applied.source, requestId: applied.requestId }) === 'committed';
    const sourceRead = source.drafts(() => {}), sourceRecords = await sourceRead.load(sourceScope), sourceImage = [...await sourceRead.loadImage(sourceScope, image.selectionId)];
    const targetRecords = await target.drafts(() => {}).load(targetScope), settled = await carries.sourceCarries(sourceScope), remaining = await carries.targetCarries(targetScope);
    await sourceStore.dispose(); await targetStore.dispose(); await source.close(); await target.close();
    return { duplicate, conflict, sourceRecords, sourceImage, targetRecords, settled, remaining, failures, submitted, cleared };
  }, changed);
  assert.match(result.duplicate, /unresolved carry/); assert.match(result.conflict, /already fixed/);
  assert.equal(result.cleared, !changed); assert.equal(result.sourceRecords.draft, changed ? 'Changed while the target opens' : '');
  assert.equal(result.sourceRecords.outbox.length, 1); assert.equal(result.sourceRecords.outbox[0].command.body.text, 'Queued original');
  assert.deepEqual(result.sourceImage, [7, 8]); assert.equal(result.targetRecords.image, null); assert.deepEqual(result.targetRecords.outbox, []);
  assert.equal(result.targetRecords.draft, 'Carry me\n\nAlready typed'); assert.equal(result.settled[0].kind, 'settled'); assert.equal('expected' in result.settled[0], false);
  assert.deepEqual(result.remaining, []); assert.deepEqual(result.failures, []); assert.deepEqual(result.submitted, []);
});

test('a closed failed native handoff can return to main using the same binding and pending creation', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'recover' };
    const source = await Storage.claimEditor({ scope, viewId: 'stable', label: 'main', transitionId: null, creation: { agentId: 'original-agent' } }, () => {});
    const port = source.drafts(() => {}); await port.load(scope); await port.save({ scope, draft: 'Retain', outbox: [{ original: true }] }, { put: { selectionId: 'image', bytes: new Uint8Array([3]) } });
    const binding = source.editorBinding();
    const reserved = await source.reserveHandoff({ scope, sourceViewId: 'stable', targetViewId: 'stable', transitionId: 'native', targetLabel: 'native-child', expectedBinding: binding });
    const grant = { scope, viewId: 'stable', nativeLabel: 'native-child', fromTransitionId: 'native', transitionId: 'inline:native', targetLabel: 'main', creationAgentId: 'original-agent' };
    const liveRefusal = await Storage.recoverClosed(grant).then(() => 'recovered', error => error.message); await source.close();
    const wrong = await Storage.recoverClosed({ ...grant, fromTransitionId: 'wrong' }).then(() => 'recovered', error => error.message);
    const recovered = await Storage.recoverClosed(grant), replay = await Storage.recoverClosed(grant);
    const childRefusal = await Storage.claimEditor({ scope, viewId: 'stable', label: 'native-child', transitionId: 'native', creation: null }, () => {}).then(() => 'owned', error => error.message);
    const main = await Storage.claimEditor({ scope, viewId: 'stable', label: 'main', transitionId: grant.transitionId, creation: null }, () => {});
    const read = main.drafts(() => {}), saved = await read.load(scope), image = [...await read.loadImage(scope, 'image')], pending = await main.readView('host');
    const foreign = await main.drafts(() => {}).load({ ...scope, conversationId: 'another' }).then(() => 'loaded', error => error.name);
    await main.close(); return { reserved, recovered, replay, liveRefusal, wrong, childRefusal, saved, image, pending, foreign };
  });
  assert.match(result.liveRefusal, /still has an editor/); assert.match(result.wrong, /different handoff/); assert.match(result.childRefusal, /reserved/);
  assert.equal(result.recovered.writerGeneration, result.reserved.writerGeneration + 1); assert.deepEqual(result.recovered, result.replay);
  assert.equal(result.saved.draft, 'Retain'); assert.deepEqual(result.saved.outbox, [{ original: true }]); assert.deepEqual(result.image, [3]);
  assert.equal(result.pending.pendingCreation.agentId, 'original-agent'); assert.equal(result.foreign, 'SupersededDrafts');
});


test('native restoration keeps separate policy, live windows and foreign handoffs out of the main editor', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const scope = { hostId: 'host', conversationId: 'restore' }, Storage = globalThis.BrowserViewStorage;
    let live = false;
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', label: 'main', liveRelay: true }, async request(command) { if (command.kind !== 'lookup') throw new Error('Unexpected native command'); return live ? { kind: 'opening', reservation: { scope, viewId: 'restore-editor', label: 'child', transitionId: 'transition', creationAgentId: null, phase: 'source-released', bindingRevision: null, writerGeneration: null } } : { kind: 'absent' }; } });
    const initial = await coordinator.restoresInline(scope);
    live = true; const active = await coordinator.restoresInline(scope); live = false;
    coordinator.setPresentation({ chats: 'separate' }); const separate = await coordinator.restoresInline(scope); coordinator.setPresentation(null);
    const source = await Storage.claimEditor({ scope, viewId: 'restore-editor', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    await source.saveView('host', { version: 2, route: scope, pendingCreation: { scope, agentId: 'agent' } });
    const plan = { scope, sourceViewId: source.viewId, targetViewId: source.viewId, transitionId: 'handoff', targetLabel: 'child', expectedBinding: source.editorBinding() };
    await source.reserveHandoff(plan); await source.close();
    const reserved = await coordinator.restoresInline(scope);
    return { initial, active, separate, reserved, browser: await new globalThis.WindowCoordinator(null).restoresInline(scope) };
  });
  assert.deepEqual(result, { initial: true, active: false, separate: false, reserved: false, browser: true });
});

for (const timing of ['before-receive', 'before-clear', 'after-clear']) test(`Keep draft and destination/source writes commit atomically (${timing})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async timing => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, sourceScope = { hostId: 'host', conversationId: 'source' }, targetScope = { hostId: 'host', conversationId: 'target' };
    const claim = scope => ({ scope, viewId: scope.conversationId, label: scope.conversationId, creation: { agentId: 'agent' }, transitionId: null });
    const source = await S.claimEditor(claim(sourceScope), () => {}), target = await S.claimEditor(claim(targetScope), () => {}), port = target.drafts(() => {});
    let release, entered; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    const make = (owner, scope, drafts = owner.drafts(() => {})) => globalThis.createConversationStore({ scope, drafts, projection: globalThis.transcriptProjection, port: { scope } });
    const a = make(source, sourceScope), b = make(target, targetScope, { ...port, async commitTransfer(records, transfer) { if (timing === 'before-receive') { entered(); await gate; } return port.commitTransfer(records, transfer); } });
    let receiving;
    try {
      await Promise.all([a.ready, b.ready]); await a.setDraft('Carry this'); await b.setDraft('Existing');
      const expected = await a.captureDraft(); await c.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId: '1:atomic', writerGeneration: source.editorBinding().writerGeneration, expected }); await c.bindDraftCarry(sourceScope, '1:atomic', targetScope);
      const [carry] = await c.sourceCarries(sourceScope), before = await b.captureDraft();
      receiving = b.transferDraft(before, `Carry this\n\n${before.text}`, { kind: 'receive', source: sourceScope, requestId: carry.requestId });
      let kept;
      if (timing === 'before-receive') { await Promise.race([started, receiving.then(() => { throw new Error('Receive ended before the held commit'); })]); kept = await c.cancelDraftCarry(carry); release(); }
      const received = await receiving;
      if (timing === 'before-clear') kept = await c.cancelDraftCarry((await c.sourceCarries(sourceScope))[0]);
      const cleared = await a.transferDraft(expected, '', { kind: 'release', source: sourceScope, requestId: carry.requestId });
      if (timing === 'after-clear') kept = await c.cancelDraftCarry((await c.sourceCarries(sourceScope))[0]);
      return { kept, received, cleared, sourceSaved: await source.drafts(() => {}).load(sourceScope), targetSaved: await target.drafts(() => {}).load(targetScope) };
    } finally { release(); if (receiving) await receiving.catch(() => {}); await Promise.all([a.dispose(), b.dispose()]); await Promise.all([source.close(), target.close()]); }
  }, timing);
  assert.equal(result.kept, timing !== 'after-clear'); assert.equal(result.received, timing === 'before-receive' ? 'cancelled' : 'committed'); assert.equal(result.cleared, timing === 'after-clear' ? 'committed' : 'cancelled');
  assert.equal(result.sourceSaved.draft, timing === 'after-clear' ? '' : 'Carry this'); assert.equal(result.targetSaved.draft, timing === 'before-receive' ? 'Existing' : 'Carry this\n\nExisting');
  assert.deepEqual(result.sourceSaved.outbox, []); assert.deepEqual(result.targetSaved.outbox, []);
});

test('carry history frees terminal capacity at a native epoch boundary and preserves unresolved work', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, carries = globalThis.carries;
    const scope = { hostId: 'host', conversationId: 'source' }, pendingScope = { hostId: 'host', conversationId: 'pending' };
    const claim = scope => ({ scope, viewId: scope.conversationId, label: scope.conversationId, creation: { agentId: 'agent' }, transitionId: null });
    const owner = await Storage.claimEditor(claim(scope), () => {}), pendingOwner = await Storage.claimEditor(claim(pendingScope), () => {});
    const opening = indexedDB.open('openpane-browser-views', 1), db = await new Promise(resolve => { opening.onsuccess = () => resolve(opening.result); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite'), records = tx.objectStore('records');
      for (let n = 0; n < 1023; n++) records.put({ version: 1, kind: 'cancelled', source: scope, sourceViewId: owner.viewId, requestId: `1:retired-${n}`, target: null, outcome: 'kept-at-source' }, ['draft-carry',scope.hostId,scope.conversationId,`1:retired-${n}`]);
      records.put({ version: 1, kind: 'offered', source: pendingScope, sourceViewId: pendingOwner.viewId, requestId: '1:pending', target: null, expected: { text: 'Unresolved text', revision: 1 } }, ['draft-carry',pendingScope.hostId,pendingScope.conversationId,'1:pending']);
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    }); db.close();
    const input = requestId => ({ source: scope, sourceViewId: owner.viewId, writerGeneration: owner.editorBinding().writerGeneration, requestId, expected: { text: 'New text', revision: 1 } });
    const before = await carries.pruneDraftCarryHistory(1);
    const full = await carries.offerDraftCarry(input('1:new')).then(() => 'accepted', error => error.message);
    const after = await carries.pruneDraftCarryHistory(2);
    const retired = await carries.offerDraftCarry(input('1:retired-0')).then(() => 'accepted', error => error.message);
    await carries.offerDraftCarry(input('2:new'));
    const pending = await carries.sourceCarries(pendingScope);
    await Promise.all([owner.close(), pendingOwner.close()]);
    const persisted = await carries.pruneDraftCarryHistory(2);
    return { before, full, after, retired, pending, persisted };
  });
  assert.equal(result.before, 1024); assert.match(result.full, /history is full/); assert.equal(result.after, 1);
  assert.match(result.retired, /epoch expired/); assert.equal(result.pending[0].expected.text, 'Unresolved text'); assert.equal(result.persisted, 2);
});

test('a detached creation saves its launch text and pending creation in the assigned editor before launch', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, sourceScope = { hostId: 'host', conversationId: 'source' }, scope = { hostId: 'host', conversationId: 'new' };
    const source = await Storage.claimEditor({ scope: sourceScope, viewId: 'source', label: 'main', creation: { agentId: 'agent' }, transitionId: null }, () => {});
    const sourceDrafts = source.drafts(() => {}); await sourceDrafts.load(sourceScope);
    const original = { version: 3, scope: sourceScope, draft: 'Leave the active editor alone', draftRevision: 1, image: null, outbox: [], frontendSends: [] }; await sourceDrafts.save(original);
    const reservation = { scope, viewId: 'new-view', label: 'chat-new', transitionId: 'new-transition', creationAgentId: 'agent', phase: 'requested', bindingRevision: null, writerGeneration: null };
    let atLaunch, launches = 0;
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(request) {
      if (request.kind === 'lookup') return { kind: 'absent' };
      if (request.kind === 'reserve') return reservation;
      if (request.kind === 'launch') {
        launches++;
        const target = await Storage.claimEditor({ scope, viewId: reservation.viewId, label: reservation.label, creation: { agentId: 'agent' }, transitionId: reservation.transitionId }, () => {});
        atLaunch = { view: await target.readView(scope.hostId), draft: await target.drafts(() => {}).load(scope) }; await target.close();
        return { kind: 'detached', scope, label: reservation.label };
      }
      throw new Error('Unexpected native request');
    } };
    const coordinator = new globalThis.WindowCoordinator(port);
    coordinator.setPresentation({ navigation: 'rail', chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const placement = await coordinator.acquire({ scope, agentId: 'agent', agentLabel: 'Agent', creation: true, carryFrom: null, initialDraft: 'First launch text' },
      { storage: source, holds: () => true, quiesce: async () => { throw new Error('Unrelated editor quiesced'); }, release: async () => { throw new Error('Unrelated editor released'); } });
    const sourceAfter = await sourceDrafts.load(sourceScope); await source.close();
    return { placement, atLaunch, sourceAfter, original, launches };
  });
  assert.equal(result.placement.kind, 'detached'); assert.equal(result.launches, 1);
  assert.equal(result.atLaunch.view.pendingCreation.scope.conversationId, 'new'); assert.equal(result.atLaunch.view.pendingCreation.agentId, 'agent');
  assert.equal(result.atLaunch.draft.scope.conversationId, 'new'); assert.equal(result.atLaunch.draft.draft, 'First launch text');
  assert.deepEqual(result.atLaunch.draft.outbox, []); assert.equal(result.atLaunch.draft.image, null); assert.deepEqual(result.sourceAfter, result.original);
});


test('an explicitly opened third legacy view selects its own saved draft without changing the other two', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'three' };
    for (const viewId of ['first', 'second', 'third']) { const owner = await Storage.reopen(viewId, () => {}); await owner.drafts(() => {}).save({ scope, draft: viewId }); await owner.close(); }
    const source = await Storage.reopen('third', () => {}), coordinator = new globalThis.WindowCoordinator(null);
    const result = await coordinator.acquire({ scope, creation: false, carryFrom: null, agentId: 'agent', agentLabel: 'Agent' }, { storage: source, holds: () => false, async quiesce() {}, release: () => source.close() });
    if (result.kind !== 'inline' || result.view.kind !== 'acquired') return { kind: result.kind, reason: result.reason };
    const target = result.view.storage, chosen = await target.drafts(() => {}).load(scope); await target.close();
    const other = [];
    for (const viewId of ['first','second']) other.push((await Storage.readLegacyDraft(viewId, 'host', scope)).text);
    return { kind: result.kind, chosen: chosen.draft, other };
  });
  assert.deepEqual(result, { kind: 'inline', chosen: 'third', other: ['first','second'] });
});

test('a committed destination carry retries a missed source notification without copying text twice', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, carries = globalThis.carries;
    const sourceScope = { hostId: 'host', conversationId: 'source' }, targetScope = { hostId: 'host', conversationId: 'target' };
    const claim = scope => ({ scope, viewId: scope.conversationId, label: scope.conversationId, creation: { agentId: 'agent' }, transitionId: null });
    const source = await Storage.claimEditor(claim(sourceScope), () => {}), target = await Storage.claimEditor(claim(targetScope), () => {});
    const make = (owner, scope) => globalThis.createConversationStore({ scope, drafts: owner.drafts(() => {}), projection: globalThis.transcriptProjection,
      port: { scope, async receipt() { return null; }, async submit() { throw new Error('No send requested'); }, watch() { return { close() {}, ended: new Promise(() => {}) }; } } });
    const sourceStore = make(source, sourceScope), targetStore = make(target, targetScope); await Promise.all([sourceStore.ready,targetStore.ready]);
    await sourceStore.setDraft('Carried once'); await targetStore.setDraft('Existing');
    const expected = await sourceStore.captureDraft();
    await carries.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId: '1:lost-notification', writerGeneration: source.editorBinding().writerGeneration, expected });
    await carries.bindDraftCarry(sourceScope, '1:lost-notification', targetScope);
    let fail = true, notifications = 0;
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'browser' } });
    runtime.controller = { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope: targetScope, viewId: target.viewId, store: targetStore } }) };
    runtime.port = { async request(command) {
      if (command.kind !== 'carry-applied') throw new Error('Unexpected native command'); notifications++;
      if (fail) { fail = false; throw new Error('Source notification lost'); }
      const carry = (await carries.sourceCarries(sourceScope)).find(row => row.requestId === command.requestId);
      await sourceStore.transferDraft(carry.expected, '', { kind: 'release', source: sourceScope, requestId: command.requestId });
    } };
    const first = await runtime.syncDraftCarries().then(() => 'not-failed', error => error.message);
    const savedBefore = targetStore.getSnapshot().draft, sourceBeforeRetry = sourceStore.getSnapshot().draft;
    const committedBeforeRetry = (await carries.sourceCarries(sourceScope)).find(row => row.requestId === '1:lost-notification')?.kind;
    await runtime.syncDraftCarries(); await runtime.syncDraftCarries();
    const sourceText = sourceStore.getSnapshot().draft, targetText = targetStore.getSnapshot().draft;
    await sourceStore.setDraft('Another carry');
    await carries.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId: '1:next', writerGeneration: source.editorBinding().writerGeneration, expected: await sourceStore.captureDraft() });
    await Promise.all([sourceStore.dispose(), targetStore.dispose()]); await Promise.all([source.close(),target.close()]);
    return { first,savedBefore,sourceBeforeRetry,committedBeforeRetry,sourceText,targetText,notifications };
  });
  assert.deepEqual(result, { first:'not-failed',savedBefore:'Carried once\n\nExisting',sourceBeforeRetry:'Carried once',committedBeforeRetry:'applied',sourceText:'',targetText:'Carried once\n\nExisting',notifications:2 });
});


for (const lookupFails of [false,true]) test(`a lost placement reply preserves its carried text when lookup ${lookupFails ? 'also fails' : 'finds admission'}`, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async lookupFails => {
    const Storage = globalThis.BrowserViewStorage, carries = globalThis.carries, scope = { hostId:'host',conversationId:'source' }, targetScope = { hostId:'host',conversationId:'target' };
    const source = await Storage.claimEditor({ scope,viewId:'source',label:'child',creation:{agentId:'agent'},transitionId:null },()=>{});
    const target = await Storage.claimEditor({ scope:targetScope,viewId:'target',label:'target',creation:{agentId:'agent'},transitionId:null },()=>{});
    const make = (owner, scope) => globalThis.createConversationStore({ scope,drafts:owner.drafts(()=>{}),projection:globalThis.transcriptProjection,port:{scope,async receipt(){return null;},async submit(){throw new Error('No send requested');},watch(){return {close(){},ended:new Promise(()=>{})};}} });
    const sourceStore = make(source,scope), targetStore = make(target,targetScope);await Promise.all([sourceStore.ready,targetStore.ready]);await sourceStore.setDraft('Carry requested');
    let admitted, cancelled=0;
    const coordinator = new globalThis.WindowCoordinator({ context:{role:'chat',reservation:{scope}},async request(command){
      if(command.kind==='intent-context')return {epoch:1,pendingCarryRequests:[]};
      if(command.kind==='placement-intent'){admitted={sourceScope:scope,requestId:command.requestId,action:command.action,target:null,result:null};throw new Error('Reply lost');}
      if(command.kind==='read-intent'){if(lookupFails)throw new Error('Bridge unavailable');return admitted;}
      throw new Error('Unexpected native command');
    }});
    coordinator.captureCarry(async requestId=>{await carries.offerDraftCarry({source:scope,sourceViewId:source.viewId,requestId,writerGeneration:source.editorBinding().writerGeneration,expected:await sourceStore.captureDraft()});return {async cancel(){cancelled++;await carries.cancelDraftCarry((await carries.sourceCarries(scope))[0]);}};});
    const placement = await coordinator.delegateCreate('agent',true);
    await carries.bindDraftCarry(scope,admitted.requestId,targetScope);
    const received=await targetStore.transferDraft(await targetStore.captureDraft(),'Carry requested',{kind:'receive',source:scope,requestId:admitted.requestId});
    const text=targetStore.getSnapshot().draft;
    await Promise.all([sourceStore.dispose(),targetStore.dispose()]);await Promise.all([source.close(),target.close()]);
    return {kind:placement.kind,received,text,cancelled};
  },lookupFails);
  assert.deepEqual(result,{kind:'pending',received:'committed',text:'Carry requested',cancelled:0});
});

for (const removed of [false,true]) test(`a carried phrase is copied as a whole and source cleanup ${removed ? 'preserves it after destination removal' : 'requires the retained copy'}`,async t=>{
  const page=await fixture(t),result=await page.evaluate(async removed=>{
    const Storage=globalThis.BrowserViewStorage,carries=globalThis.carries,sourceScope={hostId:'host',conversationId:'source'},targetScope={hostId:'host',conversationId:'target'};
    const claim=scope=>({scope,viewId:scope.conversationId,label:scope.conversationId,creation:{agentId:'agent'},transitionId:null});
    const source=await Storage.claimEditor(claim(sourceScope),()=>{}),target=await Storage.claimEditor(claim(targetScope),()=>{});
    const make=(owner,scope)=>globalThis.createConversationStore({scope,drafts:owner.drafts(()=>{}),projection:globalThis.transcriptProjection,port:{scope,async receipt(){return null;},async submit(){throw new Error('No send requested');},watch(){return{close(){},ended:new Promise(()=>{})};}}});
    const sourceStore=make(source,sourceScope),targetStore=make(target,targetScope);await Promise.all([sourceStore.ready,targetStore.ready]);await sourceStore.setDraft('note');await targetStore.setDraft('notebook');
    const expected=await sourceStore.captureDraft();await carries.offerDraftCarry({source:sourceScope,sourceViewId:source.viewId,requestId:'1:whole-phrase',writerGeneration:source.editorBinding().writerGeneration,expected});await carries.bindDraftCarry(sourceScope,'1:whole-phrase',targetScope);
    const runtime=Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'browser' } });runtime.controller={getSnapshot:()=>({host:{kind:'unavailable'},active:{scope:targetScope,viewId:target.viewId,store:targetStore}})};runtime.port={async request(){return{ok:true};}};
    await runtime.syncDraftCarries();const copied=targetStore.getSnapshot().draft;if(removed)await targetStore.setDraft('');
    const release=await sourceStore.transferDraft(expected,'',{kind:'release',source:sourceScope,requestId:'1:whole-phrase'}),sourceText=sourceStore.getSnapshot().draft;
    let nextCarry = null;
    if (removed) {
      await carries.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId: '1:next-copy', writerGeneration: source.editorBinding().writerGeneration, expected: await sourceStore.captureDraft() });
      nextCarry = (await carries.sourceCarries(sourceScope)).find(carry => carry.requestId === '1:next-copy')?.kind;
    }
    await Promise.all([sourceStore.dispose(),targetStore.dispose()]);await Promise.all([source.close(),target.close()]);return{copied,release,sourceText,nextCarry};
  },removed);
  assert.deepEqual(result,{copied:'note\n\nnotebook',release:removed?'cancelled':'committed',sourceText:removed?'note':'',nextCarry:removed?'offered':null});
});

test('an opening child registers the same authoritative handoff against a later appearance delivery',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const Storage=globalThis.BrowserViewStorage,scope={hostId:'host',conversationId:'opening'},source=await Storage.claimEditor({scope,viewId:'source',label:'main',creation:{agentId:'agent'},transitionId:null},()=>{});
    const drafts=source.drafts(()=>{});await drafts.load(scope);await drafts.save({version:3,scope,draft:'Preserve opening draft',draftRevision:1,outbox:[],frontendSends:[],image:null});
    const binding=await source.reserveHandoff({scope,sourceViewId:'source',targetViewId:'child-view',transitionId:'transition',targetLabel:'child',expectedBinding:source.editorBinding()});await source.close();
    const reservation={scope,viewId:'child-view',label:'child',transitionId:'transition',creationAgentId:null,phase:'source-released',bindingRevision:null,writerGeneration:null},calls=[];
    const coordinator=new globalThis.WindowCoordinator({context:{role:'main',label:'main',liveRelay:true},async request(command){if(command.kind==='lookup')return{kind:'opening',reservation};if(command.kind==='launch')return{kind:'pending',scope,reason:'Window is opening'};throw new Error('Unexpected mutation');}});
    let delivery=1;coordinator.trackPlacement(async(target,owned)=>calls.push({delivery,transition:target.transitionId,revision:owned.revision}));
    const owner=await Storage.reopen('catalog',()=>{}),request={scope,creation:false,carryFrom:null,agentId:'agent',agentLabel:'Agent'},port={storage:owner,holds:()=>false,async quiesce(){throw new Error('Already handed off');},async release(){throw new Error('Already handed off');}};
    const first=await coordinator.acquire(request,port), child=await Storage.claimEditor({scope,viewId:'child-view',label:'child',transitionId:'transition',creation:null},()=>{});delivery=2;const second=await coordinator.acquire(request,port);await child.close();await owner.close();return{first:first.kind,second:second.kind,calls,revision:binding.revision};
  });
  assert.deepEqual(result.calls,[{delivery:1,transition:'transition',revision:result.revision},{delivery:2,transition:'transition',revision:result.revision}]);assert.equal(result.first,'pending');assert.equal(result.second,'pending');
});

test('retired request results stop waiting while later main-owned completions retain their own identity',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const Storage=globalThis.BrowserViewStorage,scope={hostId:'host',conversationId:'source'},target={hostId:'host',conversationId:'main-target'},source=await Storage.claimEditor({scope,viewId:'source',label:'child',creation:{agentId:'agent'},transitionId:null},()=>{});
    const store=globalThis.createConversationStore({scope,drafts:source.drafts(()=>{}),projection:globalThis.transcriptProjection,port:{scope,async receipt(){return null;},async submit(){throw new Error('No submit requested');},watch(){return{close(){},ended:new Promise(()=>{})};}}});await store.ready;await store.setDraft('Still recoverable');
    await globalThis.carries.offerDraftCarry({source:scope,sourceViewId:source.viewId,requestId:'1:retired',writerGeneration:source.editorBinding().writerGeneration,expected:await store.captureDraft()});
    const older={kind:'pending',scope:target,reason:'Older request'},latest={kind:'pending',scope:target,reason:'Latest request'},settled=[],calls=[];
    const saved={sourceScope:scope,requestId:'2:latest',action:{kind:'create',agentId:'agent',carry:false},target:{scope:target,viewId:'main-view',label:'future-child',transitionId:'allocated',creationAgentId:'agent',phase:'assigned',bindingRevision:null,writerGeneration:null},result:{kind:'inline',scope:target}};
    const runtime=Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'browser' } });Object.assign(runtime,{context:{role:'chat',reservation:{scope}},historyEpoch:1,requestHistory:new Map(),historyAfter:null,historyExtended:false,pendingIntents:new Map([['1:retired',older],['2:latest',latest]]),pendingIntent:{requestId:'2:latest',result:latest},snapshot:{recovery:{kind:'chat',pending:[],history:[],after:null,carries:[]},placementNotice:'Waiting',catalogOnly:false,capabilityNotice:null},listeners:new Set(),controller:{settlePlacement(expected,value){settled.push({which:expected===older?'older':'latest',value});return true;}},port:{async request(command){calls.push(command.kind);if(command.kind==='own-intents')return{epoch:2,pending:[],items:[saved],after:null};if(command.kind==='read-intent')return null;throw new Error('No allocation permitted');}}});
    await runtime.refreshRecovery();const snapshot=runtime.snapshot,text=store.getSnapshot().draft,pending=runtime.pendingIntents.size;await store.dispose();await source.close();return{snapshot,text,pending,settled,calls};
  });
  assert.equal(result.pending,0);assert.equal(result.text,'Still recoverable');assert.equal(result.snapshot.recovery.carries.length,1);assert.equal(result.snapshot.recovery.carries[0].kind,'refused');assert.equal(result.settled[0].value.kind,'refused');assert.match(result.settled[0].value.reason,/expired/);assert.deepEqual(result.settled[1],{which:'latest',value:{kind:'detached',scope:{hostId:'host',conversationId:'main-target'},label:'main'}});assert.deepEqual(result.calls,['own-intents','read-intent']);
});

test('a refused carry retries its original snapshot while explicit Keep and competing carries stay authoritative', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, carries = globalThis.carries;
    const sourceScope = { hostId: 'host', conversationId: 'retry-source' }, targetScope = { hostId: 'host', conversationId: 'retry-target' };
    const source = await Storage.claimEditor({ scope: sourceScope, viewId: 'retry-source-view', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const target = await Storage.claimEditor({ scope: targetScope, viewId: 'retry-target-view', label: 'target', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const makeStore = (owner, scope) => globalThis.createConversationStore({ scope, port: { scope }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}), createCommandId: () => crypto.randomUUID() });
    const sourceStore = makeStore(source, sourceScope), targetStore = makeStore(target, targetScope);
    await Promise.all([sourceStore.ready, targetStore.ready]); await sourceStore.setDraft('Original requested text');
    const offer = async requestId => carries.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected: await sourceStore.captureDraft() });
    await offer('1:retry'); await carries.bindDraftCarry(sourceScope, '1:retry', targetScope);
    await carries.refuseDraftCarry((await carries.sourceCarries(sourceScope))[0]);
    const refused = (await carries.sourceCarries(sourceScope))[0], targetEmpty = await carries.targetCarries(targetScope);
    await sourceStore.setDraft('Newer source text'); await offer('1:competing');
    const competing = await carries.retryDraftCarry(sourceScope, '1:retry', source.viewId, source.editorBinding().writerGeneration).then(() => 'revived', error => error.message);
    await carries.cancelDraftCarry((await carries.sourceCarries(sourceScope)).find(item => item.requestId === '1:competing'));
    await carries.retryDraftCarry(sourceScope, '1:retry', source.viewId, source.editorBinding().writerGeneration);
    if ((await carries.targetCarries(targetScope)).length !== 0) throw new Error('Retry must wait for admitted main processing');
    await carries.bindDraftCarry(sourceScope, '1:retry', targetScope);
    const carry = (await carries.targetCarries(targetScope))[0];
    const received = await targetStore.transferDraft(await targetStore.captureDraft(), carry.expected.text, { kind: 'receive', source: sourceScope, requestId: carry.requestId });
    const released = await sourceStore.transferDraft(carry.expected, '', { kind: 'release', source: sourceScope, requestId: carry.requestId });
    await offer('1:kept'); await carries.cancelDraftCarry((await carries.sourceCarries(sourceScope)).find(item => item.requestId === '1:kept'));
    const kept = await carries.retryDraftCarry(sourceScope, '1:kept', source.viewId, source.editorBinding().writerGeneration).then(() => 'revived', error => error.message);
    const sourceText = (await sourceStore.captureDraft()).text, targetText = (await targetStore.captureDraft()).text;
    await sourceStore.dispose(); await targetStore.dispose(); await source.close(); await target.close();
    return { refused, targetEmpty, competing, received, released, kept, sourceText, targetText };
  });
  assert.equal(result.refused.kind, 'refused'); assert.equal(result.refused.expected.text, 'Original requested text'); assert.deepEqual(result.targetEmpty, []);
  assert.match(result.competing, /Another draft carry/); assert.equal(result.received, 'committed'); assert.equal(result.released, 'changed');
  assert.equal(result.sourceText, 'Newer source text'); assert.equal(result.targetText, 'Original requested text'); assert.match(result.kept, /explicitly kept/);
});

test('closed-view recovery preserves writer generation and yields to live editors', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'recover-journal' };
    const claim = { scope, viewId: 'recover-journal-view', label: 'main', transitionId: null, creation: { agentId: 'agent' } };
    const active = await Storage.claimEditor(claim, () => {}), before = active.editorBinding();
    const busy = await Storage.reopenForRecovery(active.viewId, () => {}); await active.close();
    const recovery = await Storage.reopenForRecovery(claim.viewId, () => {}), during = recovery.editorBinding();
    await recovery.drafts(() => {}).load(scope); await recovery.close();
    const after = await Storage.bindingForView(claim.viewId), reopened = await Storage.claimEditor({ ...claim, creation: null }, () => {});
    const next = reopened.editorBinding(); await reopened.close(); return { busy, before, during, after, next };
  });
  assert.equal(result.busy, null); assert.deepEqual(result.before, result.during); assert.deepEqual(result.before, result.after);
  assert.equal(result.next.writerGeneration, result.before.writerGeneration + 1);
});

test('a fresh browser recovers a dead tab handoff and preserves its unsent text and images', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'dead-tab' };
    const catalog = await Storage.reopen('dead-catalog', () => {}), original = await Storage.claimEditor({ scope, viewId: 'dead-view', label: 'browser:dead-catalog', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const port = original.drafts(() => {}); await port.load(scope); await port.save({ scope, draft: 'Interrupted browser move', outbox: [{ id: 'queued' }] }, { put: { selectionId: 'image', bytes: new Uint8Array([4, 5]) } });
    const reserved = await original.reserveHandoff({ scope, sourceViewId: original.viewId, targetViewId: original.viewId, transitionId: 'interrupted', targetLabel: 'browser:dead-catalog', expectedBinding: original.editorBinding() });
    await original.close();
    const live = await Storage.recoverBrowserHandoff(reserved, 'browser:fresh-catalog').then(() => 'stolen', error => error.message);
    await catalog.close(); const fresh = await Storage.reopen('fresh-catalog', () => {});
    const coordinator = new globalThis.WindowCoordinator(null, () => 'browser:fresh-catalog');
    const placed = await coordinator.acquire({ scope, creation: false, carryFrom: null, agentId: 'agent', agentLabel: 'Agent' }, { storage: fresh, holds: () => false, async quiesce() {}, async release() { await fresh.close(); } });
    if (placed.kind !== 'inline' || placed.view.kind !== 'acquired') throw new Error(JSON.stringify(placed));
    const owner = placed.view.storage, read = owner.drafts(() => {}), saved = await read.load(scope), image = [...await read.loadImage(scope, 'image')];
    await owner.close(); await fresh.close(); return { live, saved, image };
  });
  assert.match(result.live, /original browser tab/); assert.equal(result.saved.draft, 'Interrupted browser move');
  assert.deepEqual(result.saved.outbox, [{ id: 'queued' }]); assert.deepEqual(result.image, [4, 5]);
});

test('Keep draft tombstones survive an epoch change while their native request is still pending', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, carries = globalThis.carries, scope = { hostId: 'host', conversationId: 'kept-pending' };
    const owner = await Storage.claimEditor({ scope, viewId: 'kept-pending-view', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    await carries.offerDraftCarry({ source: scope, sourceViewId: owner.viewId, requestId: '1:still-pending', writerGeneration: owner.editorBinding().writerGeneration, expected: { text: 'Keep here', revision: 1 } });
    await carries.cancelDraftCarry((await carries.sourceCarries(scope))[0]);
    await carries.pruneDraftCarryHistory(2, ['1:still-pending']);
    const retained = (await carries.sourceCarries(scope))[0];
    const target = { ...scope, conversationId: 'kept-target' }; await carries.bindDraftCarry(scope, retained.requestId, target);
    const copies = await carries.targetCarries(target); await carries.pruneDraftCarryHistory(2, []);
    const retired = await carries.sourceCarries(scope); await owner.close(); return { retained, copies, retired };
  });
  assert.equal(result.retained.kind, 'cancelled'); assert.deepEqual(result.copies, []); assert.equal(result.retired[0].retainedText, 'Keep here');
});

test('independent recovery can open other saved work without erasing its drafts or pending creation', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, a = { hostId: 'host', conversationId: 'legacy-a' }, b = { hostId: 'host', conversationId: 'legacy-b' };
    const legacy = await Storage.reopen('legacy-other-work', () => {});
    await legacy.saveView('host', { version: 2, route: a, pendingCreation: { scope: b, agentId: 'agent-b' } });
    await legacy.drafts(() => {}).save({ scope: a, draft: '', outbox: [] }); await legacy.drafts(() => {}).save({ scope: b, draft: 'Pending B draft', outbox: [] }); await legacy.close();
    const aOwner = await Storage.claimEditor({ scope: a, viewId: 'authoritative-a', label: 'main', transitionId: null, creation: { agentId: 'agent-a' } }, () => {}); await aOwner.close();
    const recovery = await Storage.readLegacyDraft('legacy-other-work', 'host', a);
    const remaining = await Storage.reopen('legacy-other-work', () => {}); await remaining.openRemainingWork('host');
    const saved = await remaining.readView('host'), bDraft = await remaining.drafts(() => {}).load(b); await remaining.close();
    const secondRecovery = await Storage.readLegacyDraft('legacy-other-work', 'host', a);
    return { recovery, saved, bDraft, secondRecovery };
  });
  assert.equal(result.recovery.kind, 'independent'); assert.equal(result.recovery.text, '');
  assert.equal(result.saved.route, null); assert.equal(result.saved.pendingCreation.scope.conversationId, 'legacy-b'); assert.equal(result.bDraft.draft, 'Pending B draft');
  assert.deepEqual(result.secondRecovery, result.recovery);
});

for (const occupied of [false, true]) test(`opening a successor in a native child ${occupied ? 'preserves an occupied target and the source' : 'carries the predecessor draft once'} without sending`, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async occupied => {
    const Storage = globalThis.BrowserViewStorage, carries = globalThis.carries;
    const sourceScope = { hostId: 'host', conversationId: 'predecessor' }, targetScope = { hostId: 'host', conversationId: 'successor' };
    const source = await Storage.claimEditor({ scope: sourceScope, viewId: 'predecessor-view', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const target = await Storage.claimEditor({ scope: targetScope, viewId: 'successor-view', label: 'child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const make = (owner, scope) => globalThis.createConversationStore({ scope, port: { scope }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}), createCommandId: () => crypto.randomUUID() });
    const sourceStore = make(source, sourceScope), targetStore = make(target, targetScope); await Promise.all([sourceStore.ready, targetStore.ready]);
    await sourceStore.setDraft('Predecessor unsent text'); if (occupied) await targetStore.setDraft('Already in the successor');
    const reservation = { scope: targetScope, viewId: target.viewId, label: 'child', transitionId: 'successor-transition', creationAgentId: null, phase: 'target-ready', bindingRevision: 1, writerGeneration: 1 };
    let launches = 0;
    const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return { kind: 'ready', reservation };
      if (command.kind === 'intent-context') return { epoch: 1, pendingCarryRequests: [] };
      if (command.kind === 'launch') { launches++; return { kind: 'detached', scope: targetScope, label: 'child' }; }
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port);
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'browser' } });
    Object.assign(runtime, { context: port.context, coordinator, controller: { getSnapshot: () => ({ host: { kind: 'ready', metadata: { hostId: 'host' } } }), pendingPlacements: () => [], async capturePlacementDraft(scope) { if (scope.conversationId !== sourceScope.conversationId) throw new Error('Wrong source'); return { viewId: source.viewId, ...await sourceStore.captureDraft() }; } } });
    runtime.configurePlacementTracking();
    const request = { scope: targetScope, creation: false, carryFrom: sourceScope, agentId: 'agent', agentLabel: 'Agent' };
    const owner = { storage: source, holds: () => true, async quiesce() { throw new Error('Unexpected handoff'); }, async release() { throw new Error('Unexpected handoff'); } };
    const placement = await coordinator.acquire(request, owner); await coordinator.acquire(request, owner);
    const before = await carries.targetCarries(targetScope);
    Object.assign(runtime, { controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope: targetScope, viewId: target.viewId, store: targetStore } }) }, port: { async request() { throw new Error('Native notification temporarily unavailable'); } } });
    await runtime.syncDraftCarries(); await runtime.syncDraftCarries();
    Object.assign(runtime, { controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope: sourceScope, viewId: source.viewId, store: sourceStore } }) } });
    await runtime.syncDraftCarries();
    const sourceText = (await sourceStore.captureDraft()).text, targetText = (await targetStore.captureDraft()).text, history = await carries.sourceCarries(sourceScope);
    const outboxes = [sourceStore.getSnapshot().outbox.length, targetStore.getSnapshot().outbox.length];
    await sourceStore.dispose(); await targetStore.dispose(); await source.close(); await target.close();
    return { placement, launches, count: before.length, sourceText, targetText, history, outboxes };
  }, occupied);
  assert.equal(result.placement.kind, 'detached'); assert.equal(result.count, 1); assert.equal(result.launches, 2);
  assert.equal(result.sourceText, occupied ? 'Predecessor unsent text' : ''); assert.equal(result.targetText, occupied ? 'Already in the successor' : 'Predecessor unsent text');
  assert.equal(result.history[0].kind, occupied ? 'refused' : 'settled'); assert.deepEqual(result.outboxes, [0, 0]);
});

for (const moveDuringScan of [false, true]) test(`other saved work remains writable when a duplicate draft belongs elsewhere (move during scan ${moveDuringScan})`, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async moveDuringScan => {
    const Storage = globalThis.BrowserViewStorage, a = { hostId: 'host', conversationId: 'a-duplicate' }, b = { hostId: 'host', conversationId: 'b-remaining' };
    const legacy = await Storage.reopen('remaining-work', () => {});
    await legacy.saveView('host', { version: 2, route: a, pendingCreation: { scope: b, agentId: 'agent-b' } });
    for (const [scope, draft] of [[a, 'Independent A text'], [b, 'Keep B text']]) await legacy.drafts(() => {}).save({ version: 3, scope, draft, draftRevision: 1, outbox: [], frontendSends: [], image: null });
    await legacy.close();
    const moveA = async () => { const owner = await Storage.claimEditor({ scope: a, viewId: 'authoritative-a', label: 'main', transitionId: null, creation: { agentId: 'agent-a' } }, () => {}); await owner.close(); };
    if (!moveDuringScan) await moveA();
    const remaining = await Storage.reopen('remaining-work', () => {});
    await remaining.openRemainingWork('host');
    if (moveDuringScan) {
      const listing = remaining.draftScopes.bind(remaining); let moved = false;
      remaining.draftScopes = async (...args) => { const page = await listing(...args); if (!moved) { moved = true; await moveA(); } return page; };
    }
    const failures = [], stores = new Map(); let submitted = 0;
    const pool = globalThis.createViewLeasePool({ failed(_storage, error) { failures.push(error.name); }, createStore(storage, scope) {
      const store = globalThis.createConversationStore({ scope, drafts: storage.drafts(error => failures.push(error.name)), projection: globalThis.transcriptProjection,
        port: { scope, async receipt() { return null; }, async submit() { submitted++; throw new Error('Recovery must not send'); }, watch() { throw new Error('Recovery must not connect'); } } });
      stores.set(scope.conversationId, store); return store;
    } });
    const lease = pool.adopt(remaining), recovery = globalThis.createFrontendRecovery();
    recovery.retarget({ pool, lease, metadata: { hostId: 'host' }, frontend: { needsRecovery() { return false; }, async recover() { throw new Error('No frontend sends exist'); } } });
    await Promise.resolve(); await recovery.drained();
    const text = stores.get(b.conversationId)?.getSnapshot().draft ?? null;
    recovery.retarget(null); lease.release(); await pool.dispose();
    const original = await Storage.readLegacyDraft('remaining-work', 'host', a);
    const reopened = await Storage.reopen('remaining-work', () => {}); const savedB = await reopened.drafts(() => {}).load(b); await reopened.close();
    return { failures, text, savedB: savedB.draft, original: original?.text, submitted };
  }, moveDuringScan);
  assert.deepEqual(result, { failures: [], text: 'Keep B text', savedB: 'Keep B text', original: 'Independent A text', submitted: 0 });
});

for (const lookupFails of [false, true]) test(`a refused native intent releases its carry only after confirmed absence (lookup fails ${lookupFails})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async lookupFails => {
    const scope = { hostId: 'host', conversationId: 'source' }, Storage = globalThis.BrowserViewStorage, carries = globalThis.carries;
    const source = await Storage.claimEditor({ scope, viewId: 'source', label: 'source', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const store = globalThis.createConversationStore({ scope, drafts: source.drafts(() => {}), projection: globalThis.transcriptProjection,
      port: { scope, async receipt() { return null; }, async submit() { throw new Error('No send'); }, watch() { throw new Error('No connection'); } } });
    await store.ready; await store.setDraft('Kept unsent text'); let cancels = 0;
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'chat', reservation: { scope } }, async request(command) {
      if (command.kind === 'intent-context') return { epoch: 1, pendingCarryRequests: [] };
      if (command.kind === 'placement-intent') throw new Error('native-intent-capacity');
      if (command.kind === 'read-intent') { if (lookupFails) throw new Error('Transport unavailable'); return null; }
      throw new Error(command.kind);
    } });
    coordinator.captureCarry(async requestId => {
      await carries.offerDraftCarry({ source: scope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected: await store.captureDraft() });
      return { async cancel() { cancels++; await carries.refuseDraftCarry((await carries.sourceCarries(scope))[0]); } };
    });
    const placement = await coordinator.delegateCreate('agent', true), kind = (await carries.sourceCarries(scope))[0].kind, text = store.getSnapshot().draft;
    await store.dispose(); await source.close(); return { placement: placement.kind, kind, text, cancels };
  }, lookupFails);
  assert.deepEqual(result, { placement: lookupFails ? 'pending' : 'refused', kind: lookupFails ? 'offered' : 'refused', text: 'Kept unsent text', cancels: lookupFails ? 0 : 1 });
});

test('native placement policy waits until the appearance generation has painted', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const runtime = new globalThis.WindowRuntime({ version: 1, role: 'main', label: 'main', brokerInstance: 'broker', documentIncarnation: 'main', viewId: 'catalog', liveRelay: true, reservation: null });
    let confirmedGeneration = null, localBuiltin = false, builtinPainted = false;
    const state = { selection: { deliveryGeneration: 2, revision: 4 }, transitions: [], bundle: { digest: 'a'.repeat(64), manifest: { presentation: { navigation: 'rail', chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } } } } };
    runtime.ui.getSnapshot = () => ({ state, localBuiltin, deliveryContext: globalThis.windowContext('document'), validatedVisual: builtinPainted ? { kind: 'local-builtin' } : confirmedGeneration === null ? { kind: 'none' } : { kind: 'delivery', context: globalThis.windowContext('document'), generation: confirmedGeneration, revision: 4, digest: 'a'.repeat(64) }, confirmedGeneration });
    runtime.recoveryWake = async () => {}; runtime.drive = async () => {};
    runtime.controller.getSnapshot = () => ({ host: { kind: 'ready', metadata: { hostId: 'host' } }, active: null });
    runtime.uiChanged(); const staging = runtime.getSnapshot().catalogOnly;
    confirmedGeneration = 2; runtime.uiChanged(); const committed = runtime.getSnapshot().catalogOnly;
    localBuiltin = true; runtime.uiChanged(); const deferredRestore = runtime.getSnapshot().catalogOnly;
    builtinPainted = true; runtime.uiChanged(); const restored = runtime.getSnapshot().catalogOnly;
    return { staging, committed, deferredRestore, restored };
  });
  assert.deepEqual(result, { staging: false, committed: true, deferredRestore: true, restored: false });
});


test('failed and changed transfers retain their original text through pruning and explicit removal', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, sourceScope = { hostId: 'host', conversationId: 'retained-source' }, targetScope = { ...sourceScope, conversationId: 'retained-target' };
    const source = await S.claimEditor({ scope: sourceScope, viewId: 'retain-source', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const target = await S.claimEditor({ scope: targetScope, viewId: 'retain-target', label: 'child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const make = (owner, scope) => globalThis.createConversationStore({ scope, drafts: owner.drafts(() => {}), port: { scope }, projection: globalThis.transcriptProjection });
    const a = make(source, sourceScope), b = make(target, targetScope); await Promise.all([a.ready, b.ready]);
    await a.setDraft('Original snapshot'); const expected = await a.captureDraft();
    await c.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId: '1:retained', writerGeneration: source.editorBinding().writerGeneration, expected });
    await c.bindDraftCarry(sourceScope, '1:retained', targetScope); await b.transferDraft(await b.captureDraft(), expected.text, { kind: 'receive', source: sourceScope, requestId: '1:retained' });
    await a.setDraft('New source edit'); await b.setDraft('New target edit');
    await a.transferDraft(expected, '', { kind: 'release', source: sourceScope, requestId: '1:retained' });
    await c.pruneDraftCarryHistory(2, []); const retained = (await c.sourceCarries(sourceScope))[0];
    const saved = await c.hostCarries('host'); await c.removeRetainedCarry(retained); const removed = await c.sourceCarries(sourceScope);
    const texts = [a.getSnapshot().draft, b.getSnapshot().draft]; await a.dispose(); await b.dispose(); await source.close(); await target.close();
    return { retained, saved: saved.carries[0].retainedText, removed, texts };
  });
  assert.equal(result.retained.kind, 'settled'); assert.equal(result.retained.retainedText, 'Original snapshot'); assert.equal(result.saved, 'Original snapshot');
  assert.deepEqual(result.removed, []); assert.deepEqual(result.texts, ['New source edit', 'New target edit']);
});

test('main Keep decisions survive history retirement without consuming the transfer quota', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'kept-source' }, target = { ...scope, conversationId: 'kept-target' };
    const owner = await S.claimEditor({ scope, viewId: 'kept-source-view', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    await c.offerDraftCarry({ source: scope, sourceViewId: owner.viewId, requestId: '1:main-transition-old', writerGeneration: owner.editorBinding().writerGeneration, expected: { text: 'Kept original', revision: 1 } });
    await c.bindDraftCarry(scope, '1:main-transition-old', target); await c.cancelDraftCarry((await c.sourceCarries(scope))[0]);
    await c.removeRetainedCarry((await c.sourceCarries(scope))[0]); const count = await c.pruneDraftCarryHistory(2, []), kept = await c.keptDraft(scope, target);
    await c.offerDraftCarry({ source: scope, sourceViewId: owner.viewId, requestId: '2:fresh-target', writerGeneration: owner.editorBinding().writerGeneration, expected: { text: 'Later new chat text', revision: 2 } });
    const next = (await c.sourceCarries(scope))[0]; await owner.close(); return { count, kept, kind: next.kind };
  });
  assert.deepEqual(result, { count: 0, kept: true, kind: 'offered' });
});

test('one unreadable saved view cannot block another unbound chat', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const request = indexedDB.open('openpane-browser-views', 1); request.onupgradeneeded = () => request.result.createObjectStore('records');
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const original = { version: 999, route: { hostId: 'host', conversationId: 'broken' }, pendingCreation: [] };
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(original, ['view', 'broken-view', 'host']); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
    const healthy = await globalThis.BrowserViewStorage.locateEditor({ hostId: 'host', conversationId: 'healthy' });
    const preferred = await globalThis.BrowserViewStorage.locateEditor({ hostId: 'host', conversationId: 'healthy' }, 'broken-view');
    const broken = await globalThis.BrowserViewStorage.locateEditor(original.route).then(() => 'opened', error => error.message);
    return { healthy, preferred, broken };
  });
  assert.deepEqual(result.healthy, { binding: null, legacyViewIds: [] }); assert.deepEqual(result.preferred, result.healthy); assert.match(result.broken, /unreadable.*preserved/);
});

test('legacy recovery finds its duplicate draft after navigation changes and exposes saved images without sending', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, a = { hostId: 'host', conversationId: 'legacy-hidden-a' }, b = { ...a, conversationId: 'legacy-other-b' };
    const legacy = await S.reopen('legacy-hidden', () => {}), port = legacy.drafts(() => {});
    await legacy.saveView('host', { version: 2, route: a, pendingCreation: null });
    await port.save({ scope: a, draft: 'Independent old text', outbox: [], image: { selectionId: 'saved-image', name: 'original.png' } }, { put: { selectionId: 'saved-image', bytes: new Uint8Array([4, 5, 6]) } });
    await port.save({ scope: b, draft: 'Other saved work', outbox: [] }); await legacy.close();
    const bound = await S.claimEditor({ scope: a, viewId: 'authoritative-a', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {}); await bound.close();
    const remaining = await S.reopen('legacy-hidden', () => {});
    try { await remaining.openRemainingWork('host'); } finally { await remaining.close(); }
    const first = await S.readLegacyDraft('legacy-hidden', 'host', { hostId: 'host', conversationId: 'unrelated' });
    const selected = await S.readLegacyDraft('legacy-hidden', 'host', b);
    return { kind: first.kind, text: first.text, scopes: first.scopes, bytes: [...first.image.bytes], selected: selected.text };
  });
  assert.equal(result.kind, 'independent'); assert.equal(result.text, 'Independent old text'); assert.deepEqual(result.bytes, [4, 5, 6]);
  assert.equal(result.scopes.length, 2); assert.equal(result.selected, 'Other saved work');
});

test('concurrent local draft recovery shares one physical owner and preserves both borrows', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'shared-recovery' };
    const original = await S.claimEditor({ scope, viewId: 'shared-view', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const store = globalThis.createConversationStore({ scope, drafts: original.drafts(() => {}), port: { scope }, projection: globalThis.transcriptProjection });
    await store.ready; await store.setDraft('Original shared draft'); await store.dispose(); await original.close();
    const pool = globalThis.createViewLeasePool({ createStore(storage, scope) { return globalThis.createConversationStore({ scope, drafts: storage.drafts(() => {}), port: { scope }, projection: globalThis.transcriptProjection }); }, failed(error) { throw error; } });
    let opens = 0, closes = 0;
    const load = async () => { opens++; const storage = await S.reopenForRecovery('shared-view', () => {}); const close = storage.close.bind(storage); storage.close = () => { closes++; return close(); }; return storage; };
    const [one, two] = await Promise.all([pool.open('shared-view', load), pool.open('shared-view', load, { interested: false })]);
    const [first, second] = await Promise.all([pool.recovery(one, scope), pool.recovery(two, scope)]);
    const sameOwner = one.storage === two.storage, sameStore = first.store === second.store, text = (await first.store.captureDraft()).text;
    first.release(); one.release(); await second.store.setDraft('Still owned by the other reader');
    const beforeLastRelease = closes; second.release(); two.release(); await pool.closed('shared-view'); await pool.dispose();
    return { opens, closes, beforeLastRelease, sameOwner, sameStore, text };
  });
  assert.deepEqual(result, { opens: 1, closes: 1, beforeLastRelease: 0, sameOwner: true, sameStore: true, text: 'Original shared draft' });
});

test('the first retry completes a fresh handoff from a prior source-released reservation', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'retry-before-ready' };
    const source = await S.claimEditor({ scope, viewId: 'retry-source-view', label: 'old-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const sourcePort = source.drafts(() => {}); await sourcePort.load(scope); await sourcePort.save({ scope, draft: 'Exact interrupted draft', outbox: [] }); await source.close();
    const catalog = await S.reopen('retry-catalog', () => {}), phases = [];
    const reservation = { scope, viewId: 'retry-source-view', label: 'child', transitionId: 'retry-transition', creationAgentId: null, phase: 'source-released', bindingRevision: null, writerGeneration: null };
    let phase = reservation.phase, child;
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
      if (command.kind === 'lookup') return { kind: 'closed', reservation };
      if (command.kind === 'reserve') return reservation;
      if (command.kind === 'phase') { phases.push(command.phase); phase = command.phase; return { ok: true }; }
      if (command.kind === 'launch') { if (phase !== 'source-released') throw new Error('source-not-released'); child = await S.claimEditor({ scope, viewId: reservation.viewId, label: reservation.label, transitionId: reservation.transitionId, creation: null }, () => {}); return { kind: 'detached', scope, label: 'child' }; }
      throw new Error(command.kind);
    } });
    coordinator.setPresentation({ navigation: 'rail', chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
    const placed = await coordinator.acquire({ scope, creation: false, carryFrom: null, initialDraft: null, agentId: 'agent', agentLabel: 'Agent' }, { storage: catalog, holds: () => false, async quiesce() {}, async release() {} });
    if (!child) throw new Error('The native launch did not acquire its actual committed handoff');
    const saved = await child.drafts(() => {}).load(scope); await child.close(); await catalog.close();
    return { placed, phases, text: saved.draft };
  });
  assert.equal(result.placed.kind, 'detached'); assert.deepEqual(result.phases, ['source-saved', 'transfer-committed', 'source-released']); assert.equal(result.text, 'Exact interrupted draft');
});

test('keeping a draft permits placement retry without reactivating its transfer', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'kept-retry-source' }, target = { ...scope, conversationId: 'kept-retry-target' };
    const source = await S.claimEditor({ scope, viewId: 'kept-retry-view', label: 'child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const sourcePort = source.drafts(() => {}); await sourcePort.load(scope); await sourcePort.save({ scope, draft: 'Keep exact original', outbox: [] });
    const requestId = '1:kept-native-request'; await c.offerDraftCarry({ source: scope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected: { text: 'Keep exact original', revision: 1 } });
    await c.bindDraftCarry(scope, requestId, target); await c.cancelDraftCarry((await c.sourceCarries(scope))[0]);
    const reservation = { scope, viewId: source.viewId, label: 'child', transitionId: 'source-transition', creationAgentId: null, phase: 'target-ready', bindingRevision: 1, writerGeneration: 1 };
    const runtime = new globalThis.WindowRuntime({ version: 1, role: 'chat', label: 'child', brokerInstance: 'broker', documentIncarnation: 'child-document', viewId: source.viewId, liveRelay: true, reservation });
    const intent = { sourceScope: scope, requestId, action: { kind: 'create', agentId: 'agent', carry: true }, target: null, result: { kind: 'refused', reason: 'Try again later' } }, commands = [];
    runtime.port.request = async command => { commands.push(command); if (command.kind === 'retry-intent') return { ...intent, result: null }; if (command.kind === 'own-intents') return { epoch: 1, pending: [], items: [intent], after: null }; return { ok: true }; };
    await runtime.retryIntent(intent);
    const carry = (await c.sourceCarries(scope))[0], copies = await c.targetCarries(target), text = (await source.drafts(() => {}).load(scope)).draft;
    await source.close(); return { commands, kind: carry.kind, copies, text };
  });
  assert.equal(result.commands[0].kind, 'retry-intent'); assert.equal(result.commands[0].requestId, '1:kept-native-request');
  assert.equal(result.kind, 'cancelled'); assert.deepEqual(result.copies, []); assert.equal(result.text, 'Keep exact original');
});

test('an older automatic handoff cannot reserve or fail a newer unpainted delivery', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const runtime = new globalThis.WindowRuntime({ version: 1, role: 'main', label: 'main', brokerInstance: 'broker', documentIncarnation: 'main', viewId: 'catalog', liveRelay: true, reservation: null });
    const scope = { hostId: 'host', conversationId: 'one' }, reserved = [], failed = [];
    const delivery = generation => ({ selection: { deliveryGeneration: generation, revision: generation }, bundle: { digest: String(generation).repeat(64), manifest: { presentation: { chats: 'separate' } } }, transitions: [{ envelope: { requestId: `${generation}:test`, deliveryGeneration: generation }, slot: { transitionId: `t${generation}`, target: null } }] });
    let state = delivery(2), validated = { kind: 'delivery', context: globalThis.windowContext('main'), generation: 2, revision: 2, digest: '2'.repeat(64) };
    runtime.ui.getSnapshot = () => ({ state, validatedVisual: validated, deliveryContext: globalThis.windowContext('main'), confirmedGeneration: 2, localBuiltin: false });
    runtime.ui.reservePlacement = async transition => { reserved.push(transition.envelope.deliveryGeneration); };
    runtime.ui.failPlacement = async transition => { failed.push(transition.envelope.deliveryGeneration); };
    runtime.recoveryWake = runtime.refreshRecovery = runtime.syncDraftCarries = async () => {};
    runtime.port.request = async () => [];
    runtime.controller.getSnapshot = () => ({ busy: false, host: { kind: 'ready', metadata: { hostId: 'host' } }, active: { scope }, saved: { pendingCreation: null }, lastPlacement: null });
    let track, resume, started;
    runtime.coordinator.trackPlacement = callback => { track = callback; }; runtime.configurePlacementTracking();
    const began = new Promise(resolve => { started = resolve; });
    const paused = new Promise(resolve => { resume = resolve; });
    runtime.controller.openReserved = async () => { started(); await paused; await track({ scope, viewId: 'one', label: 'one', transitionId: 'native-A' }, { revision: 3 }); return { kind: 'refused', scope, reason: 'A failed' }; };
    runtime.processing = true; runtime.uiChanged(); runtime.processing = false;
    const attempt = runtime.drive(); await began;
    state = delivery(3); validated = { kind: 'none' }; runtime.uiChanged();
    resume(); await attempt;
    return { reserved, failed, transition: state.transitions[0].slot.transitionId, notice: runtime.getSnapshot().placementNotice };
  });
  assert.deepEqual(result, { reserved: [], failed: [], transition: 't3', notice: null });
});

test('saved draft inspection carries its matching pending creation identity', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'unconfirmed' }, pendingCreation = { scope, agentId: 'original-agent' };
    const owner = await Storage.reopen('closed-unconfirmed', () => {});
    await owner.saveView('host', { version: 2, route: null, pendingCreation });
    const drafts = owner.drafts(() => {}); await drafts.load(scope); await drafts.save({ version: 3, scope, draft: 'Saved before confirmation', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    await owner.close(); return { recovery: await Storage.readLegacyDraft('closed-unconfirmed', 'host'), pendingCreation };
  });
  assert.deepEqual(result.recovery.pendingCreation, result.pendingCreation); assert.equal(result.recovery.text, 'Saved before confirmation');
});


test('a distinct-view handoff removes only its matching source ownership marker', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'reverse-index' };
    const source = await S.claimEditor({ scope, viewId: 'reverse-source', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    await source.reserveHandoff({ scope, sourceViewId: source.viewId, targetViewId: 'reverse-target', expectedBinding: source.editorBinding(), transitionId: 'reverse-move', targetLabel: 'child' });
    await source.close();
    const old = await S.bindingForView('reverse-source'), target = await S.bindingForView('reverse-target');
    return { old, targetView: target.viewId, targetScope: target.scope };
  });
  assert.deepEqual(result, { old: null, targetView: 'reverse-target', targetScope: { hostId: 'host', conversationId: 'reverse-index' } });
});

test('an unreadable third legacy view is checked after two matching drafts', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'legacy-scan' };
    const storage = await S.reopen('scan-bootstrap', () => {}); await storage.close();
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('openpane-browser-views', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records');
      for (const view of ['scan-a', 'scan-b']) store.put({ scope, draft: view, outbox: [] }, ['draft', view, 'host', scope.conversationId]);
      store.put({ version: 9, route: scope, pendingCreation: null }, ['view', 'scan-z', 'host']); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
    try { await S.locateEditor(scope, 'scan-a'); return null; } catch (error) { return String(error); }
  });
  assert.match(result, /saved editor.*unreadable/i);
});

test('closing a source waits for its live handoff transaction before releasing ownership', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'close-transfer' };
    const source = await S.claimEditor({ scope, viewId: 'close-transfer-source', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    let entered, released = false, held = true, closed = false;
    const began = new Promise(resolve => { entered = resolve; }), original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args);
      if (args[1] === 'readwrite') { const store = tx.objectStore('records'); const keepAlive = () => { if (held) { const request = store.get('test-handoff-barrier'); request.onsuccess = keepAlive; } }; keepAlive(); entered(); }
      return tx;
    };
    try {
      const transfer = source.reserveHandoff({ scope, sourceViewId: source.viewId, targetViewId: source.viewId, expectedBinding: source.editorBinding(), transitionId: 'close-transfer', targetLabel: 'child' });
      await began; const closing = source.close().then(() => { closed = true; }); await new Promise(resolve => setTimeout(resolve, 25));
      const closedBeforeCommit = closed; held = false; await transfer; await closing; released = closed;
      return { closedBeforeCommit, released };
    } finally { held = false; IDBDatabase.prototype.transaction = original; await source.close(); }
  });
  assert.deepEqual(result, { closedBeforeCommit: false, released: true });
});

for (const state of ['bound', 'applied']) test(`an identical draft offer replay preserves its ${state} destination`, async t => {
  const page = await fixture(t), result = await page.evaluate(async state => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries;
    const sourceScope = { hostId: 'host', conversationId: 'replay-source' }, targetScope = { hostId: 'host', conversationId: 'replay-target' };
    const source = await S.claimEditor({ scope: sourceScope, viewId: 'replay-source', label: 'source', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const input = { source: sourceScope, sourceViewId: source.viewId, requestId: '1:replay', writerGeneration: source.editorBinding().writerGeneration, expected: { text: 'Offered once', revision: 1 } };
    await c.offerDraftCarry(input); await c.bindDraftCarry(sourceScope, input.requestId, targetScope);
    let target;
    if (state === 'applied') {
      target = await S.claimEditor({ scope: targetScope, viewId: 'replay-target', label: 'target', transitionId: null, creation: { agentId: 'agent' } }, () => {});
      const drafts = target.drafts(() => {}); await drafts.load(targetScope);
      await drafts.commitTransfer({ version: 3, scope: targetScope, draft: input.expected.text, draftRevision: 1, outbox: [], frontendSends: [], image: null }, { source: sourceScope, requestId: input.requestId, outcome: 'received' });
    }
    const replayed = await c.offerDraftCarry(input).then(() => true, error => error.message);
    const conflicting = await c.offerDraftCarry({ ...input, expected: { text: 'Different input', revision: 2 } }).then(() => false, error => error.message);
    const [carry] = await c.sourceCarries(sourceScope); await source.close(); await target?.close();
    return { replayed, conflicting, kind: carry.kind, target: carry.target };
  }, state);
  assert.equal(result.replayed, true); assert.match(result.conflicting, /different input/);
  assert.equal(result.kind, state === 'applied' ? 'applied' : 'offered'); assert.equal(result.target.conversationId, 'replay-target');
});

for (const changed of [false, true]) test(`a moved source settles its applied carry and ${changed ? 'retains later text' : 'clears the captured text'}`, async t => {
  const page = await fixture(t), result = await page.evaluate(async changed => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, failures = [];
    const sourceScope = { hostId: 'host', conversationId: 'moved-source' }, targetScope = { hostId: 'host', conversationId: 'moved-target' };
    const claim = (scope, viewId, label) => ({ scope, viewId, label, transitionId: null, creation: { agentId: 'agent' } });
    let source = await S.claimEditor(claim(sourceScope, 'old-source', 'main'), error => failures.push(error.message));
    const makeStore = (owner, scope) => globalThis.createConversationStore({ scope, drafts: owner.drafts(error => failures.push(error.message)), projection: globalThis.transcriptProjection,
      port: { scope, async receipt() { return null; }, async submit() { throw new Error('No send'); }, watch() { return { close() {}, ended: new Promise(() => {}) }; } } });
    let store = makeStore(source, sourceScope); await store.ready; await store.setDraft('Carry this text'); const expected = await store.captureDraft();
    await c.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId: '1:moved', writerGeneration: source.editorBinding().writerGeneration, expected });
    await c.bindDraftCarry(sourceScope, '1:moved', targetScope);
    const target = await S.claimEditor(claim(targetScope, 'moved-target', 'target'), () => {}), targetStore = makeStore(target, targetScope); await targetStore.ready;
    await targetStore.transferDraft(await targetStore.captureDraft(), expected.text, { kind: 'receive', source: sourceScope, requestId: '1:moved' });
    await store.dispose(); const handoff = await source.reserveHandoff({ scope: sourceScope, sourceViewId: source.viewId, targetViewId: 'new-source', transitionId: 'move-source', targetLabel: 'child', expectedBinding: source.editorBinding() });
    await source.close(); source = await S.claimEditor({ scope: sourceScope, viewId: handoff.viewId, label: 'child', transitionId: 'move-source', creation: null }, error => failures.push(error.message));
    store = makeStore(source, sourceScope); await store.ready; if (changed) await store.setDraft('Later local text');
    const [carry] = await c.sourceCarries(sourceScope);
    const outcome = carry.sourceViewId === source.viewId ? await store.transferDraft(carry.expected, '', { kind: 'release', source: sourceScope, requestId: carry.requestId }) : 'source-view-mismatch';
    const text = (await store.captureDraft()).text, [settled] = await c.sourceCarries(sourceScope);
    await store.dispose(); await targetStore.dispose(); await source.close(); await target.close();
    return { outcome, text, settled, failures };
  }, changed);
  assert.equal(result.outcome, changed ? 'changed' : 'committed'); assert.equal(result.text, changed ? 'Later local text' : '');
  assert.equal(result.settled.kind, 'settled'); assert.equal(result.settled.sourceViewId, 'new-source'); assert.deepEqual(result.failures, []);
});

test('binding lookup stays coherent when a distinct-view move commits immediately after its read', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'lookup-race' };
    const source = await S.claimEditor({ scope, viewId: 'lookup-old', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('openpane-browser-views', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const original = IDBDatabase.prototype.transaction; let queued = false, moving;
    IDBDatabase.prototype.transaction = function(...args) {
      const tx = original.apply(this, args);
      if (!queued && (args[1] === undefined || args[1] === 'readonly')) {
        queued = true;
        tx.addEventListener('complete', () => { moving = globalThis.transferEditor(db, { scope, sourceViewId: 'lookup-old', targetViewId: 'lookup-new', transitionId: 'lookup-move', targetLabel: 'child', expectedBinding: source.editorBinding() }); }, { once: true });
      }
      return tx;
    };
    let lookup;
    try { lookup = await S.bindingForView('lookup-old').then(value => value?.viewId ?? null, error => error.message); await moving; }
    finally { IDBDatabase.prototype.transaction = original; db.close(); await source.close(); }
    return { lookup, queued, current: (await S.bindingForView('lookup-new')).viewId };
  });
  assert.equal(result.lookup, 'lookup-old'); assert.equal(result.queued, true); assert.equal(result.current, 'lookup-new');
});

test('recovery declines a new handoff created between an absent binding read and view-lock acquisition', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'late-bound' }, original = navigator.locks.request.bind(navigator.locks); let inserted = false;
    navigator.locks.request = async (name, ...args) => {
      if (name === 'openpane-view:late-target' && !inserted) {
        inserted = true;
        await S.prepareCreationDraft({ scope, viewId: 'late-target', label: 'child', transitionId: 'late-handoff', agentId: 'agent' }, 'Preserved initial text');
      }
      return original(name, ...args);
    };
    let recovery;
    try { recovery = await S.reopenForRecovery('late-target', () => {}); }
    finally { navigator.locks.request = original; }
    const declined = recovery === null; await recovery?.close();
    const child = await S.claimEditor({ scope, viewId: 'late-target', label: 'child', transitionId: 'late-handoff', creation: null }, () => {});
    const saved = await child.drafts(() => {}).load(scope); await child.close(); return { declined, inserted, text: saved.draft };
  });
  assert.deepEqual(result, { declined: true, inserted: true, text: 'Preserved initial text' });
});

for (const timing of ['before capture', 'during capture', 'before queued commit']) test(`an empty-target carry preserves destination text entered ${timing}`, async t => {
  const page = await fixture(t), result = await page.evaluate(async timing => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries;
    const sourceScope = { hostId: 'host', conversationId: 'empty-only-source' }, targetScope = { hostId: 'host', conversationId: 'empty-only-target' };
    const claim = scope => ({ scope, viewId: scope.conversationId, label: scope.conversationId, transitionId: null, creation: { agentId: 'agent' } });
    const source = await S.claimEditor(claim(sourceScope), () => {}), target = await S.claimEditor(claim(targetScope), () => {});
    const make = (owner, scope) => globalThis.createConversationStore({ scope, drafts: owner.drafts(() => {}), projection: globalThis.transcriptProjection,
      port: { scope, async receipt() { return null; }, async submit() { throw new Error('No send requested'); }, watch() { return { close() {}, ended: new Promise(() => {}) }; } } });
    const sourceStore = make(source, sourceScope), targetStore = make(target, targetScope); await Promise.all([sourceStore.ready, targetStore.ready]);
    await sourceStore.setDraft('Original source');
    await c.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId: '1:empty-only', writerGeneration: source.editorBinding().writerGeneration, emptyOnly: true, expected: await sourceStore.captureDraft() });
    await c.bindDraftCarry(sourceScope, '1:empty-only', targetScope);
    if (timing === 'before capture') await targetStore.setDraft('Destination text');
    else if (timing === 'during capture') {
      const capture = targetStore.captureDraft.bind(targetStore); let first = true;
      targetStore.captureDraft = async () => { if (first) { first = false; await targetStore.setDraft('Destination text'); } return capture(); };
    } else {
      const transfer = targetStore.transferDraft.bind(targetStore); let first = true;
      targetStore.transferDraft = (...args) => { if (first) { first = false; void targetStore.setDraft('Destination text'); } return transfer(...args); };
    }
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'browser' }, port: null,
      controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope: targetScope, viewId: target.viewId, store: targetStore } }) } });
    await runtime.syncDraftCarries();
    const [carry] = await c.sourceCarries(sourceScope), remaining = await c.targetCarries(targetScope), sourceText = (await sourceStore.captureDraft()).text, targetText = (await targetStore.captureDraft()).text;
    await sourceStore.dispose(); await targetStore.dispose(); await source.close(); await target.close();
    return { kind: carry.kind, remaining, sourceText, targetText };
  }, timing);
  assert.deepEqual(result, { kind: 'refused', remaining: [], sourceText: 'Original source', targetText: 'Destination text' });
});

for (const state of ['offered', 'refused', 'applied']) test(`a historical ${state} carry from a pre-fix handoff follows the authoritative editor to its next view`, async t => {
  const page = await fixture(t), result = await page.evaluate(async state => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, failures = [];
    const scope = { hostId: 'host', conversationId: 'historical-source' }, targetScope = { ...scope, conversationId: 'historical-target' };
    const claim = (scope, viewId, label, transitionId = null, creation = { agentId: 'agent' }) => ({ scope, viewId, label, transitionId, creation });
    let source = await S.claimEditor(claim(scope, 'historical-A', 'main'), error => failures.push(error.message));
    const drafts = source.drafts(() => {}); await drafts.load(scope);
    await drafts.save({ version: 3, scope, draft: 'Original historical draft', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    const requestId = '1:historical', expected = { text: 'Original historical draft', revision: 1 };
    await c.offerDraftCarry({ source: scope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected });
    await c.bindDraftCarry(scope, requestId, targetScope);
    let target;
    if (state === 'refused') await c.refuseDraftCarry((await c.sourceCarries(scope))[0]);
    if (state === 'applied') {
      target = await S.claimEditor(claim(targetScope, 'historical-target', 'target'), () => {});
      const targetDrafts = target.drafts(() => {}); await targetDrafts.load(targetScope);
      await targetDrafts.commitTransfer({ version: 3, scope: targetScope, draft: expected.text, draftRevision: 1, outbox: [], frontendSends: [], image: null }, { source: scope, requestId, outcome: 'received' });
    }
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('openpane-browser-views', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const firstPlan = { scope, sourceViewId: source.viewId, targetViewId: 'historical-B', transitionId: 'historical-A-B', targetLabel: 'child-B', expectedBinding: source.editorBinding() };
    await source.reserveHandoff(firstPlan);
    await source.close(); source = await S.claimEditor(claim(scope, 'historical-B', 'child-B', 'historical-A-B', null), error => failures.push(error.message));
    // Persist the unresolved row shape left by the older A-to-B handoff.
    const [savedCarry] = await c.sourceCarries(scope);
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put({ ...savedCarry, sourceViewId: 'historical-A' }, ['draft-carry', scope.hostId, scope.conversationId, requestId]); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const before = (await c.sourceCarries(scope))[0].sourceViewId;
    if (state === 'refused') {
      await c.retryDraftCarry(scope, requestId, source.viewId, source.editorBinding().writerGeneration);
      const [retried] = await c.sourceCarries(scope);
      if (retried.kind !== 'offered' || retried.sourceViewId !== 'historical-B') throw new Error('Retry must use the current editor before another handoff');
    }
    await source.reserveHandoff({ scope, sourceViewId: source.viewId, targetViewId: 'historical-C', transitionId: 'historical-B-C', targetLabel: 'child-C', expectedBinding: source.editorBinding() });
    await source.close(); source = await S.claimEditor(claim(scope, 'historical-C', 'child-C', 'historical-B-C', null), error => failures.push(error.message));
    const [moved] = await c.sourceCarries(scope);
    if (state === 'refused') await c.retryDraftCarry(scope, requestId, source.viewId, source.editorBinding().writerGeneration);
    const after = (await c.sourceCarries(scope))[0], text = (await source.drafts(() => {}).load(scope)).draft;
    db.close(); await source.close(); await target?.close(); return { before, movedView: moved.sourceViewId, afterKind: after.kind, text, failures };
  }, state);
  assert.deepEqual(result, { before: 'historical-A', movedView: 'historical-C', afterKind: state === 'refused' ? 'offered' : state, text: 'Original historical draft', failures: [] });
});

for (const corrupt of ['scope', 'request ID']) test(`handoff preserves its source when a carry has an inconsistent ${corrupt}`, async t => {
  const page = await fixture(t), result = await page.evaluate(async corrupt => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'inconsistent-carry' };
    const source = await S.claimEditor({ scope, viewId: 'identity-source', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const draft = source.drafts(() => {}); await draft.load(scope); await draft.save({ version: 3, scope, draft: 'Keep source text', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    await c.offerDraftCarry({ source: scope, sourceViewId: source.viewId, requestId: '1:identity', writerGeneration: source.editorBinding().writerGeneration, expected: { text: 'Keep source text', revision: 1 } });
    const [carry] = await c.sourceCarries(scope), changed = corrupt === 'scope' ? { ...carry, source: { ...scope, conversationId: 'foreign-source' } } : { ...carry, requestId: '1:different-identity' };
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('openpane-browser-views', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(changed, ['draft-carry', scope.hostId, scope.conversationId, '1:identity']); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const outcome = await source.reserveHandoff({ scope, sourceViewId: source.viewId, targetViewId: 'identity-target', transitionId: 'identity-handoff', targetLabel: 'child', expectedBinding: source.editorBinding() }).then(() => 'moved', () => 'refused');
    const binding = (await S.locateEditor(scope)).binding, text = outcome === 'refused' ? (await draft.load(scope)).draft : null;
    const saved = await new Promise((resolve, reject) => { const tx = db.transaction('records'), read = tx.objectStore('records').get(['draft-carry', scope.hostId, scope.conversationId, '1:identity']); tx.oncomplete = () => resolve(read.result); tx.onabort = () => reject(tx.error); });
    db.close(); await source.close(); return { outcome, viewId: binding.viewId, kind: binding.kind, text, preserved: JSON.stringify(saved) === JSON.stringify(changed) };
  }, corrupt);
  assert.deepEqual(result, { outcome: 'refused', viewId: 'identity-source', kind: 'editing', text: 'Keep source text', preserved: true });
});

for (const condition of ['unchanged source', 'newer source edit', 'destination copy removed']) test(`historical applied carry settles while current source stays in B with ${condition}`, async t => {
  const page = await fixture(t), result = await page.evaluate(async condition => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, sourceScope = { hostId: 'host', conversationId: 'stay-B-source' }, targetScope = { ...sourceScope, conversationId: 'stay-B-target' };
    const claim = (scope, viewId, label, transitionId = null, creation = { agentId: 'agent' }) => ({ scope, viewId, label, transitionId, creation });
    let source = await S.claimEditor(claim(sourceScope, 'stay-A', 'main'), () => {});
    const target = await S.claimEditor(claim(targetScope, 'stay-target', 'target'), () => {});
    const make = (owner, scope) => globalThis.createConversationStore({ scope, drafts: owner.drafts(() => {}), projection: globalThis.transcriptProjection,
      port: { scope, async receipt() { return null; }, async submit() { throw new Error('No send requested'); }, watch() { return { close() {}, ended: new Promise(() => {}) }; } } });
    let sourceStore = make(source, sourceScope); const targetStore = make(target, targetScope); await Promise.all([sourceStore.ready, targetStore.ready]);
    await sourceStore.setDraft('Original applied source'); const expected = await sourceStore.captureDraft(), requestId = '1:stay-B';
    await c.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected });
    await c.bindDraftCarry(sourceScope, requestId, targetScope);
    await targetStore.transferDraft(await targetStore.captureDraft(), expected.text, { kind: 'receive', source: sourceScope, requestId });
    await sourceStore.dispose();
    await source.reserveHandoff({ scope: sourceScope, sourceViewId: source.viewId, targetViewId: 'stay-B', transitionId: 'stay-A-B', targetLabel: 'child-B', expectedBinding: source.editorBinding() });
    await source.close(); source = await S.claimEditor(claim(sourceScope, 'stay-B', 'child-B', 'stay-A-B', null), () => {});
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('openpane-browser-views', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const [current] = await c.sourceCarries(sourceScope);
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put({ ...current, sourceViewId: 'stay-A' }, ['draft-carry', sourceScope.hostId, sourceScope.conversationId, requestId]); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    sourceStore = make(source, sourceScope); await sourceStore.ready;
    if (condition === 'newer source edit') await sourceStore.setDraft('New source edit retained');
    if (condition === 'destination copy removed') await targetStore.setDraft('Destination replacement retained');
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'browser' }, port: null,
      controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope: sourceScope, viewId: source.viewId, store: sourceStore } }) } });
    await runtime.syncDraftCarries();
    const [settled] = await c.sourceCarries(sourceScope), sourceText = (await sourceStore.captureDraft()).text, targetText = (await targetStore.captureDraft()).text;
    let freshOffer = false;
    if (settled.kind === 'settled') {
      await sourceStore.setDraft('Fresh offer from current B');
      await c.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId: '1:fresh-B', writerGeneration: source.editorBinding().writerGeneration, expected: await sourceStore.captureDraft() });
      freshOffer = (await c.sourceCarries(sourceScope)).some(row => row.requestId === '1:fresh-B' && row.kind === 'offered');
    }
    db.close(); await sourceStore.dispose(); await targetStore.dispose(); await source.close(); await target.close();
    return { kind: settled.kind, sourceViewId: settled.sourceViewId, outcome: settled.outcome, retainedText: settled.retainedText, sourceText, targetText, freshOffer };
  }, condition);
  assert.equal(result.kind, 'settled'); assert.equal(result.sourceViewId, 'stay-B');
  assert.equal(result.sourceText, condition === 'unchanged source' ? '' : condition === 'newer source edit' ? 'New source edit retained' : 'Original applied source');
  assert.equal(result.targetText, condition === 'destination copy removed' ? 'Destination replacement retained' : 'Original applied source');
  assert.equal(result.outcome, condition === 'unchanged source' ? 'cleared' : 'changed');
  if (condition !== 'unchanged source') assert.equal(result.retainedText, 'Original applied source');
  assert.equal(result.freshOffer, true);
});


for (const action of ['continuation', 'new-chat']) test(`unreadable global carry history preserves unrelated native ${action} drafts`, async t => {
  const page = await fixture(t), result = await page.evaluate(async action => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries;
    const sourceScope = { hostId: 'host', conversationId: 'healthy-source' }, targetScope = { ...sourceScope, conversationId: 'healthy-target' };
    const brokenScope = { ...sourceScope, conversationId: 'broken-source' }, historyScope = { ...sourceScope, conversationId: 'old-history' };
    const source = await S.claimEditor({ scope: sourceScope, viewId: 'healthy-view', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const drafts = source.drafts(() => {}); await drafts.load(sourceScope);
    await drafts.save({ version: 3, scope: sourceScope, draft: 'Unsent healthy text', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    const opening = indexedDB.open('openpane-browser-views', 1), db = await new Promise(resolve => { opening.onsuccess = () => resolve(opening.result); });
    const brokenKey = ['draft-carry', 'host', brokenScope.conversationId, '1:broken'], broken = { version: 1, kind: 'offered', unreadable: 'Preserve this exact row' };
    await new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records');
      store.put(broken, brokenKey);
      for (const requestId of ['1:retired', '1:pending']) store.put({ version: 1, kind: 'cancelled', source: historyScope, sourceViewId: 'old-view', requestId, target: requestId === '1:retired' ? targetScope : null, outcome: 'kept-at-source' }, ['draft-carry', 'host', historyScope.conversationId, requestId]);
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    });
    const reservation = { scope: targetScope, viewId: 'target-view', label: 'target-child', transitionId: 'healthy-transition', creationAgentId: null, phase: 'target-ready', bindingRevision: 1, writerGeneration: 1 };
    let captured = 0, submitted = 0;
    const coordinator = new globalThis.WindowCoordinator({ context: action === 'continuation' ? { role: 'main', liveRelay: true } : { role: 'chat', reservation: { scope: sourceScope } }, async request(command) {
      if (command.kind === 'lookup') return { kind: 'ready', reservation };
      if (command.kind === 'intent-context') return { epoch: 2, pendingCarryRequests: ['1:pending'] };
      if (command.kind === 'launch') return { kind: 'detached', scope: targetScope, label: reservation.label };
      if (command.kind === 'placement-intent') { submitted++; return { sourceScope, requestId: command.requestId, action: command.action, target: null, result: null }; }
      throw new Error(command.kind);
    } });
    coordinator.captureCarry(async requestId => {
      captured++; const saved = await drafts.load(sourceScope);
      await c.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, writerGeneration: source.editorBinding().writerGeneration, requestId, expected: { text: saved.draft, revision: saved.draftRevision } });
      return { async cancel() { await c.cancelDraftCarry((await c.sourceCarries(sourceScope))[0]); } };
    });
    const placement = action === 'continuation'
      ? await coordinator.acquire({ scope: targetScope, creation: false, agentId: 'agent', agentLabel: 'Agent', carryFrom: sourceScope, initialDraft: null }, { storage: source, holds: () => false, async quiesce() {}, async release() {} })
      : await coordinator.delegateCreate('agent', true);
    if (placement.kind !== (action === 'continuation' ? 'detached' : 'pending')) throw new Error(`Unrelated native ${action} failed: ${JSON.stringify(placement)}`);
    const read = key => new Promise((resolve, reject) => { const tx = db.transaction('records'), request = tx.objectStore('records').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const carry = (await c.sourceCarries(sourceScope))[0], remaining = await c.pruneDraftCarryHistory(2, ['1:pending']);
    const corruptRead = await c.sourceCarries(brokenScope).then(() => false, () => true);
    const corruptMutation = await c.bindDraftCarry(brokenScope, '1:broken', targetScope).then(() => false, () => true);
    const staleEpoch = await c.pruneDraftCarryHistory(1).then(() => 'accepted', error => error.message);
    const result = { placement: placement.kind, captured, submitted, carry, remaining, corruptRead, corruptMutation, staleEpoch,
      kept: await read(['draft-carry-kept', 'host', historyScope.conversationId, targetScope.conversationId]),
      broken: await read(brokenKey), retired: await read(['draft-carry', 'host', historyScope.conversationId, '1:retired']),
      pending: await read(['draft-carry', 'host', historyScope.conversationId, '1:pending']), sourceText: (await drafts.load(sourceScope)).draft };
    db.close(); await source.close(); return result;
  }, action);
  assert.equal(result.placement, action === 'continuation' ? 'detached' : 'pending');
  assert.equal(result.captured, 1); assert.equal(result.submitted, action === 'continuation' ? 0 : 1);
  assert.equal(result.carry.kind, 'offered'); assert.equal(result.carry.expected.text, 'Unsent healthy text');
  assert.equal(result.carry.target?.conversationId ?? null, action === 'continuation' ? 'healthy-target' : null);
  assert.equal(result.remaining, 3); assert.equal(result.kept, true); assert.equal(result.retired, undefined); assert.equal(result.pending.requestId, '1:pending');
  assert.equal(result.sourceText, 'Unsent healthy text'); assert.equal(result.corruptRead, true); assert.equal(result.corruptMutation, true);
  assert.match(result.staleEpoch, /epoch advanced/);
  assert.deepEqual(result.broken, { version: 1, kind: 'offered', unreadable: 'Preserve this exact row' });
});

test('unreadable global carries count toward capacity and do not hide a corrupt epoch floor', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'healthy-capacity-source' };
    const source = await S.claimEditor({ scope, viewId: 'capacity-view', label: 'main', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const opening = indexedDB.open('openpane-browser-views', 1), db = await new Promise(resolve => { opening.onsuccess = () => resolve(opening.result); });
    const write = operation => new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); operation(tx.objectStore('records')); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    await write(store => { for (let n = 0; n < 1024; n++) store.put({ broken: n }, ['draft-carry', 'host', 'broken-capacity', `1:${n}`]); });
    const retained = await c.pruneDraftCarryHistory(2);
    const full = await c.offerDraftCarry({ source: scope, sourceViewId: source.viewId, writerGeneration: source.editorBinding().writerGeneration, requestId: '2:healthy', expected: { text: 'Keep at source', revision: 1 } }).then(() => 'accepted', error => error.message);
    await write(store => store.put({ broken: 'overflow' }, ['draft-carry', 'host', 'broken-capacity', '1:overflow']));
    const overflow = await c.pruneDraftCarryHistory(3).then(() => 'accepted', error => error.message);
    await write(store => { store.delete(['draft-carry', 'host', 'broken-capacity', '1:overflow']); store.put('unreadable epoch', ['draft-carry-epoch']); });
    const corruptFloor = await c.pruneDraftCarryHistory(3).then(() => false, () => true);
    db.close(); await source.close(); return { retained, full, overflow, corruptFloor };
  });
  assert.equal(result.retained, 1024); assert.match(result.full, /history is full/); assert.match(result.overflow, /history exceeds limits/); assert.equal(result.corruptFloor, true);
});


for (const decision of ['kept', 'malformed']) test(`binding a newly captured carry atomically checks its pair Keep decision (${decision})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async decision => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, source = { hostId: 'host', conversationId: 'atomic-keep-source' }, target = { ...source, conversationId: 'atomic-keep-target' };
    const owner = await S.claimEditor({ scope: source, viewId: 'atomic-keep-view', label: 'child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const drafts = owner.drafts(() => {}); await drafts.load(source); await drafts.save({ version: 3, scope: source, draft: 'Keep every captured byte', draftRevision: 1, image: null, outbox: [], frontendSends: [] });
    const expected = { text: 'Keep every captured byte', revision: 1 }, writerGeneration = owner.editorBinding().writerGeneration;
    await c.offerDraftCarry({ source, sourceViewId: owner.viewId, requestId: '1:old-before-keep', writerGeneration, expected }); await c.bindDraftCarry(source, '1:old-before-keep', target);
    const preflight = await c.keptDraft(source, target);
    await c.cancelDraftCarry((await c.sourceCarries(source))[0]);
    await c.offerDraftCarry({ source, sourceViewId: owner.viewId, requestId: '1:new-after-preflight', writerGeneration, expected });
    if (decision === 'malformed') {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put('corrupt', ['draft-carry-kept', 'host', source.conversationId, target.conversationId]); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
    }
    const error = await c.bindDraftCarry(source, '1:new-after-preflight', target).then(() => null, error => error.message);
    const carry = (await c.sourceCarries(source)).find(carry => carry.requestId === '1:new-after-preflight'), indexed = await c.targetCarries(target), saved = await drafts.load(source);
    await owner.close(); return { preflight, error, carry, indexed: indexed.length, draft: saved.draft };
  }, decision);
  assert.equal(result.preflight, false); assert.equal(result.draft, 'Keep every captured byte'); assert.equal(result.indexed, 0);
  if (decision === 'kept') { assert.equal(result.error, null); assert.equal(result.carry.kind, 'cancelled'); assert.equal(result.carry.retainedText, 'Keep every captured byte'); assert.equal(result.carry.target.conversationId, 'atomic-keep-target'); }
  else { assert.match(result.error, /Keep decision is unreadable/); assert.equal(result.carry.kind, 'offered'); assert.equal(result.carry.target, null); }
});

for (const state of ['offered', 'applied']) test(`pruning a miskeyed terminal payload preserves the canonical ${state} carry and index`, async t => {
  const page = await fixture(t), result = await page.evaluate(async state => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, sourceScope = { hostId: 'host', conversationId: 'keyed-source' }, targetScope = { ...sourceScope, conversationId: 'keyed-target' };
    const source = await S.claimEditor({ scope: sourceScope, viewId: 'keyed-source-view', label: 'source', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const requestId = '1:canonical', expected = { text: 'Captured authoritative text', revision: 1 }; await c.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected }); await c.bindDraftCarry(sourceScope, requestId, targetScope);
    let target;
    if (state === 'applied') { target = await S.claimEditor({ scope: targetScope, viewId: 'keyed-target-view', label: 'target', transitionId: null, creation: { agentId: 'agent' } }, () => {}); const drafts = target.drafts(() => {}); await drafts.load(targetScope); await drafts.commitTransfer({ version: 3, scope: targetScope, draft: expected.text, draftRevision: 1, outbox: [], frontendSends: [], image: null }, { source: sourceScope, requestId, outcome: 'received' }); }
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open('openpane-browser-views', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const read = key => new Promise((resolve, reject) => { const tx = db.transaction('records'), get = tx.objectStore('records').get(key); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); });
    const canonicalKey = ['draft-carry', 'host', sourceScope.conversationId, requestId], indexKey = ['draft-carry-target', 'host', targetScope.conversationId, 'host', sourceScope.conversationId, requestId], miskey = ['draft-carry', 'host', 'misplaced', '1:misplaced'];
    const original = await read(canonicalKey), index = await read(indexKey), spoofed = { version: 1, kind: 'settled', source: sourceScope, sourceViewId: source.viewId, requestId, target: targetScope, outcome: 'cleared' };
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(spoofed, miskey); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const retained = await c.pruneDraftCarryHistory(2); const after = { canonical: await read(canonicalKey), index: await read(indexKey), misplaced: await read(miskey), floor: await read(['draft-carry-epoch']) }; db.close(); await source.close(); await target?.close(); return { retained, original, index, spoofed, after };
  }, state);
  assert.equal(result.retained, 2); assert.deepEqual(result.after.canonical, result.original); assert.deepEqual(result.after.index, result.index); assert.deepEqual(result.after.misplaced, result.spoofed); assert.equal(result.after.floor, 2);
});

test('pruning retains invalid request epochs while removing healthy expired history and advancing its floor', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries; const owner = await S.reopen('epoch-test-view', () => {}); await owner.close();
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open('openpane-browser-views', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const rows = ['9007199254740992:unsafe', 'not-an-epoch', '1:eligible'].map(requestId => ({ version: 1, kind: 'settled', source: { hostId: 'host', conversationId: 'epoch-source' }, sourceViewId: 'old-view', requestId, target: { hostId: 'host', conversationId: 'epoch-target' }, outcome: 'cleared' }));
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records'); for (const row of rows) store.put(row, ['draft-carry', 'host', 'epoch-source', row.requestId]); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const error = await c.pruneDraftCarryHistory(2).then(retained => ({ retained }), error => ({ error: error.message }));
    const read = key => new Promise((resolve, reject) => { const tx = db.transaction('records'), get = tx.objectStore('records').get(key); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); });
    const after = await Promise.all(rows.map(row => read(['draft-carry', 'host', 'epoch-source', row.requestId]))), floor = await read(['draft-carry-epoch']); db.close(); return { error, after, rows, floor };
  });
  assert.deepEqual(result.error, { retained: 2 }); assert.deepEqual(result.after[0], result.rows[0]); assert.deepEqual(result.after[1], result.rows[1]); assert.equal(result.after[2], undefined); assert.equal(result.floor, 2);
});

for (const marker of ['absent', 'malformed']) test(`an unreadable source history does not fabricate a Keep decision for an empty child draft (${marker})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async marker => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, sourceScope = { hostId: 'host', conversationId: 'source-noise' }, targetScope = { ...sourceScope, conversationId: 'healthy-successor' };
    const source = await S.claimEditor({ scope: sourceScope, viewId: 'noise-view', label: 'source-child', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open('openpane-browser-views', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const broken = { broken: 'preserve exact source row' }, brokenKey = ['draft-carry', 'host', sourceScope.conversationId, '1:broken'], markerKey = ['draft-carry-kept', 'host', sourceScope.conversationId, targetScope.conversationId];
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records'); store.put(broken, brokenKey); if (marker === 'malformed') store.put('unreadable Keep marker', markerKey); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    let captured = 0, submitted = 0, carryFlag;
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'chat', reservation: { scope: sourceScope }, viewId: source.viewId, label: 'source-child' }, async request(command) {
      if (command.kind === 'intent-context') return { epoch: 1, pendingCarryRequests: [] };
      if (command.kind === 'placement-intent') { submitted++; carryFlag = command.action.carry; return { sourceScope, requestId: command.requestId, action: command.action, target: null, result: null }; }
      throw new Error(command.kind);
    } }); coordinator.captureCarry(async () => { captured++; return null; });
    const placed = await coordinator.acquire({ scope: targetScope, creation: false, agentId: 'agent', agentLabel: 'Agent', carryFrom: sourceScope, initialDraft: null }, { storage: source, holds: () => false, async quiesce() {}, async release() {} });
    const read = key => new Promise((resolve, reject) => { const tx = db.transaction('records'), get = tx.objectStore('records').get(key); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); });
    const kept = await c.keptDraft(sourceScope, targetScope).then(value => ({ value }), error => ({ error: error.message })); const after = await read(brokenKey), savedMarker = await read(markerKey); db.close(); await source.close(); return { placed, captured, submitted, carryFlag, kept, after, broken, savedMarker };
  }, marker);
  assert.deepEqual(result.after, result.broken);
  if (marker === 'absent') { assert.equal(result.placed.kind, 'pending'); assert.equal(result.captured, 1); assert.equal(result.submitted, 1); assert.equal(result.carryFlag, false); assert.deepEqual(result.kept, { value: false }); }
  else { assert.equal(result.placed.kind, 'refused'); assert.match(result.placed.reason, /Keep decision is unreadable/); assert.equal(result.captured, 0); assert.equal(result.submitted, 0); assert.equal(result.savedMarker, 'unreadable Keep marker'); }
});

test('binding a pending delegated offer honors legacy bound Keep without a pair marker', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, sourceScope = { hostId: 'host', conversationId: 'legacy-kept-source' }, targetScope = { ...sourceScope, conversationId: 'legacy-kept-target' };
    const source = await S.claimEditor({ scope: sourceScope, viewId: 'legacy-kept-view', label: 'source-child', transitionId: null, creation: { agentId: 'agent' } }, () => {}), drafts = source.drafts(() => {});
    await drafts.load(sourceScope); await drafts.save({ version: 3, scope: sourceScope, draft: 'New source text remains here', draftRevision: 2, outbox: [], frontendSends: [], image: null });
    const writerGeneration = source.editorBinding().writerGeneration, oldId = '1:legacy-cancelled', newId = '1:pending-delegated';
    await c.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId: oldId, writerGeneration, expected: { text: 'Earlier kept text', revision: 1 } }); await c.bindDraftCarry(sourceScope, oldId, targetScope); await c.cancelDraftCarry((await c.sourceCarries(sourceScope))[0]);
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open('openpane-browser-views', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const markerKey = ['draft-carry-kept', 'host', sourceScope.conversationId, targetScope.conversationId]; await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').delete(markerKey); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    await c.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId: newId, writerGeneration, expected: { text: 'New source text remains here', revision: 2 } });
    await c.bindDraftCarry(sourceScope, newId, targetScope);
    const read = key => new Promise((resolve, reject) => { const tx = db.transaction('records'), get = tx.objectStore('records').get(key); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); });
    const carry = await read(['draft-carry', 'host', sourceScope.conversationId, newId]), marker = await read(markerKey), indexes = await c.targetCarries(targetScope), sourceText = (await drafts.load(sourceScope)).draft; db.close(); await source.close(); return { carry, marker, indexes, sourceText };
  });
  assert.equal(result.carry.kind, 'cancelled'); assert.equal(result.carry.retainedText, 'New source text remains here'); assert.equal(result.marker, true); assert.equal(result.indexes.length, 0); assert.equal(result.sourceText, 'New source text remains here');
});


test('removing retained text before target allocation preserves Keep until its pending request binds', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, sourceScope = { hostId: 'host', conversationId: 'unbound-kept-source' }, targetScope = { ...sourceScope, conversationId: 'unbound-kept-target' };
    const owner = await S.claimEditor({ scope: sourceScope, viewId: 'unbound-kept-view', label: 'source-child', transitionId: null, creation: { agentId: 'agent' } }, () => {}), drafts = owner.drafts(() => {});
    await drafts.load(sourceScope); await drafts.save({ version: 3, scope: sourceScope, draft: 'Kept source bytes', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    const input = { source: sourceScope, sourceViewId: owner.viewId, writerGeneration: owner.editorBinding().writerGeneration, expected: { text: 'Kept source bytes', revision: 1 } }, requestId = '1:awaiting-assignment';
    await c.offerDraftCarry({ ...input, requestId }); await c.cancelDraftCarry((await c.sourceCarries(sourceScope))[0]); await c.removeRetainedCarry((await c.sourceCarries(sourceScope))[0]);
    const removed = await c.sourceCarries(sourceScope), retained = await c.pruneDraftCarryHistory(2, [requestId]); await c.bindDraftCarry(sourceScope, requestId, targetScope);
    const known = await c.keptDraft(sourceScope, targetScope); await c.offerDraftCarry({ ...input, requestId: '2:later-follow' }); await c.bindDraftCarry(sourceScope, '2:later-follow', targetScope);
    const later = (await c.sourceCarries(sourceScope)).find(row => row.requestId === '2:later-follow'), indexes = await c.targetCarries(targetScope), text = (await drafts.load(sourceScope)).draft; await owner.close(); return { removed, retained, known, later, indexes, text };
  });
  assert.equal(result.removed.length, 1); assert.equal(result.removed[0].kind, 'cancelled'); assert.equal(result.removed[0].target, null); assert.equal(result.removed[0].retainedText, undefined); assert.equal(result.retained, 1); assert.equal(result.known, true); assert.equal(result.later.kind, 'cancelled'); assert.equal(result.indexes.length, 0); assert.equal(result.text, 'Kept source bytes');
});


test('miskeyed applied snapshots cannot clear newer uncopied text from the current source editor', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, sourceScope = { hostId: 'host', conversationId: 'snapshot-key-source' }, targetScope = { ...sourceScope, conversationId: 'snapshot-key-target' };
    const claim = (scope, viewId, label, transitionId = null, creation = { agentId: 'agent' }) => ({ scope, viewId, label, transitionId, creation });
    let source = await S.claimEditor(claim(sourceScope, 'snapshot-source-A', 'main'), () => {}); const target = await S.claimEditor(claim(targetScope, 'snapshot-target', 'target'), () => {});
    const make = (owner, scope) => globalThis.createConversationStore({ scope, drafts: owner.drafts(() => {}), projection: globalThis.transcriptProjection, port: { scope, async receipt() { return null; }, async submit() { throw new Error('No send requested'); }, watch() { return { close() {}, ended: new Promise(() => {}) }; } } });
    let a = make(source, sourceScope); const b = make(target, targetScope); await Promise.all([a.ready, b.ready]); await a.setDraft('OLD text copied to destination');
    const expected = await a.captureDraft(), requestId = '1:canonical-snapshot'; await c.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected }); await c.bindDraftCarry(sourceScope, requestId, targetScope); await b.transferDraft(await b.captureDraft(), expected.text, { kind: 'receive', source: sourceScope, requestId });
    await a.dispose(); await source.reserveHandoff({ scope: sourceScope, sourceViewId: source.viewId, targetViewId: 'snapshot-source-B', transitionId: 'snapshot-A-B', targetLabel: 'child-B', expectedBinding: source.editorBinding() }); await source.close(); source = await S.claimEditor(claim(sourceScope, 'snapshot-source-B', 'child-B', 'snapshot-A-B', null), () => {});
    a = make(source, sourceScope); await a.ready; await a.setDraft('NEW uncopied source text'); const newer = await a.captureDraft(), original = (await c.sourceCarries(sourceScope))[0], spoofed = { ...original, expected: newer };
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open('openpane-browser-views', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const spoofKey = ['draft-carry', 'host', sourceScope.conversationId, '1:000-miskeyed']; await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(spoofed, spoofKey); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const host = await c.hostCarries('host');
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'browser' }, port: null, controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope: sourceScope, viewId: source.viewId, store: a } }) } });
    const error = await runtime.syncDraftCarries().then(() => null, error => error.message);
    const read = key => new Promise((resolve, reject) => { const tx = db.transaction('records'), request = tx.objectStore('records').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const canonical = await read(['draft-carry', 'host', sourceScope.conversationId, requestId]), rawSpoof = await read(spoofKey), sourceText = (await a.captureDraft()).text, targetText = (await b.captureDraft()).text;
    db.close(); await a.dispose(); await b.dispose(); await source.close(); await target.close(); return { error, canonical, original, rawSpoof, spoofed, sourceText, targetText, host };
  });
  assert.equal(result.sourceText, 'NEW uncopied source text'); assert.equal(result.targetText, 'OLD text copied to destination'); assert.match(result.error, /identity|saved key/); assert.deepEqual(result.canonical, result.original); assert.deepEqual(result.rawSpoof, result.spoofed);
  assert.equal(result.host.unreadable, 1); assert.deepEqual(result.host.carries, [result.original]);
});

for (const floorKind of ['null', 'undefined']) for (const operation of ['prune', 'offer', 'retry']) test(`a persisted ${floorKind} epoch floor rejects ${operation} without overwriting any saved row`, async t => {
  const page = await fixture(t), result = await page.evaluate(async ({ operation, floorKind }) => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'null-floor-source' }, target = { ...scope, conversationId: 'null-floor-target' };
    const owner = await S.claimEditor({ scope, viewId: 'null-floor-view', label: 'source', transitionId: null, creation: { agentId: 'agent' } }, () => {}), drafts = owner.drafts(() => {}); await drafts.load(scope); await drafts.save({ version: 3, scope, draft: 'Preserved source bytes', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    const requestId = operation === 'offer' ? '2:new-offer' : '1:existing', input = { source: scope, sourceViewId: owner.viewId, requestId, writerGeneration: owner.editorBinding().writerGeneration, expected: { text: 'Preserved source bytes', revision: 1 } };
    if (operation === 'retry') { await c.offerDraftCarry(input); await c.bindDraftCarry(scope, requestId, target); await c.refuseDraftCarry((await c.sourceCarries(scope))[0]); }
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open('openpane-browser-views', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const rowKey = ['draft-carry', 'host', scope.conversationId, requestId], floorKey = ['draft-carry-epoch'];
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records'); store.put(floorKind === 'null' ? null : undefined, floorKey); if (operation === 'prune') store.put({ version: 1, kind: 'settled', source: scope, sourceViewId: owner.viewId, requestId, target, outcome: 'cleared' }, rowKey); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const read = key => new Promise((resolve, reject) => { const tx = db.transaction('records'), request = tx.objectStore('records').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); const before = await read(rowKey);
    const present = () => new Promise((resolve, reject) => { const tx = db.transaction('records'), request = tx.objectStore('records').getKey(floorKey); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); const presentBefore = await present();
    const action = operation === 'prune' ? () => c.pruneDraftCarryHistory(2) : operation === 'offer' ? () => c.offerDraftCarry(input) : () => c.retryDraftCarry(scope, requestId, owner.viewId, owner.editorBinding().writerGeneration);
    const error = await action().then(() => null, error => error.message), after = await read(rowKey), floor = await read(floorKey), presentAfter = await present(), sourceText = (await drafts.load(scope)).draft;
    db.close(); await owner.close(); return { error, before, after, floor, sourceText, presentBefore, presentAfter };
  }, { operation, floorKind });
  assert.equal(typeof result.error, 'string'); assert.deepEqual(result.after, result.before); assert.equal(result.floor, floorKind === 'null' ? null : undefined); assert.deepEqual(result.presentBefore, ['draft-carry-epoch']); assert.deepEqual(result.presentAfter, result.presentBefore); assert.equal(result.sourceText, 'Preserved source bytes');
});


for (const requestId of ['not-an-epoch', '9007199254740992:overflow']) test(`canonical indexed carry with invalid request epoch cannot change destination text (${requestId})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async requestId => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, sourceScope = { hostId: 'host', conversationId: 'invalid-point-source' }, scope = { ...sourceScope, conversationId: 'invalid-point-target' };
    const target = await S.claimEditor({ scope, viewId: 'invalid-point-view', label: 'target', transitionId: null, creation: { agentId: 'agent' } }, () => {});
    const store = globalThis.createConversationStore({ scope, drafts: target.drafts(() => {}), projection: globalThis.transcriptProjection, port: { scope } }); await store.ready; await store.setDraft('Existing destination bytes');
    const carry = { version: 1, kind: 'offered', source: sourceScope, sourceViewId: 'old-source-view', requestId, target: scope, expected: { text: 'Unreadable transfer text', revision: 1 } }, rowKey = ['draft-carry', 'host', sourceScope.conversationId, requestId], indexKey = ['draft-carry-target', 'host', scope.conversationId, 'host', sourceScope.conversationId, requestId], reference = { source: sourceScope, requestId };
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open('openpane-browser-views', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'), records = tx.objectStore('records'); records.put(carry, rowKey); records.put(reference, indexKey); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'browser' }, port: null, controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope, viewId: target.viewId, store } }) } });
    const read = key => new Promise((resolve, reject) => { const tx = db.transaction('records'), get = tx.objectStore('records').get(key); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); });
    const before = await store.captureDraft(), error = await runtime.syncDraftCarries().then(() => null, error => error.message), after = await store.captureDraft(), raw = await read(rowKey), index = await read(indexKey);
    const cancelled = await c.cancelDraftCarry({ source: sourceScope, requestId }).then(() => true, () => false);
    db.close(); await store.dispose(); await target.close(); return { error, before, after, raw, carry, index, reference, cancelled };
  }, requestId);
  assert.equal(typeof result.error, 'string'); assert.deepEqual(result.after, result.before); assert.deepEqual(result.raw, result.carry); assert.deepEqual(result.index, result.reference); assert.equal(result.cancelled, false);
});

for (const row of ['absent', 'undefined', 'malformed', 'settled', 'offered']) test(`stale Keep selection distinguishes an absent carry from saved damage (${row})`, { timeout: 15000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async row => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, source = { hostId: 'host', conversationId: 'selected-source' }, target = { ...source, conversationId: 'selected-target' }, requestId = '1:selected';
    const owner = await S.claimEditor({ scope: source, viewId: 'selected-view', label: 'source', transitionId: null, creation: { agentId: 'agent' } }, () => {}), drafts = owner.drafts(() => {});
    await drafts.load(source); const original = { version: 3, scope: source, draft: 'Original selected bytes', draftRevision: 1, outbox: [], frontendSends: [], image: null }; await drafts.save(original);
    await c.offerDraftCarry({ source, sourceViewId: owner.viewId, requestId, writerGeneration: owner.editorBinding().writerGeneration, expected: { text: original.draft, revision: 1 } }); await c.bindDraftCarry(source, requestId, target);
    const selected = (await c.sourceCarries(source))[0], db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const key = ['draft-carry', 'host', source.conversationId, requestId];
    if (row === 'absent') { await c.cancelDraftCarry(selected); await c.removeRetainedCarry((await c.sourceCarries(source))[0]); }
    else if (row !== 'offered') await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(row === 'undefined' ? undefined : row === 'malformed' ? { broken: 'preserve this row' } : { version: 1, kind: 'settled', source, sourceViewId: owner.viewId, requestId, target, outcome: 'cleared' }, key); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const inspect = () => new Promise((resolve, reject) => { const tx = db.transaction('records'), store = tx.objectStore('records'), value = store.get(key), found = store.getKey(key); tx.oncomplete = () => resolve({ present: found.result !== undefined, value: value.result }); tx.onabort = () => reject(tx.error); });
    const before = await inspect(), outcome = await c.cancelDraftCarry(selected).then(value => ({ value }), error => ({ error: error.message })), after = await inspect(), saved = await drafts.load(source); db.close(); await owner.close(); return { before, outcome, after, saved, original };
  }, row);
  assert.deepEqual(result.saved, result.original);
  if (row === 'undefined' || row === 'malformed') { assert.equal(typeof result.outcome.error, 'string'); assert.deepEqual(result.after, result.before); }
  else { assert.deepEqual(result.outcome, { value: row === 'offered' }); if (row === 'offered') { assert.equal(result.after.value.kind, 'cancelled'); assert.equal(result.after.value.retainedText, result.original.draft); } else assert.deepEqual(result.after, result.before); }
});

for (const marker of ['absent', 'legacy', 'kept', 'undefined', 'malformed']) test(`Keep marker lookup distinguishes absent authority from saved damage (${marker})`, { timeout: 15000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async marker => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, source = { hostId: 'host', conversationId: 'marker-source' }, target = { ...source, conversationId: 'marker-target' }, requestId = '1:new-marker';
    const owner = await S.claimEditor({ scope: source, viewId: 'marker-view', label: 'source', transitionId: null, creation: { agentId: 'agent' } }, () => {}), input = { source, sourceViewId: owner.viewId, writerGeneration: owner.editorBinding().writerGeneration, expected: { text: 'Marker guarded bytes', revision: 1 } };
    if (marker === 'legacy') { await c.offerDraftCarry({ ...input, requestId: '1:legacy-marker' }); await c.bindDraftCarry(source, '1:legacy-marker', target); await c.cancelDraftCarry((await c.sourceCarries(source))[0]); }
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }), markerKey = ['draft-carry-kept', 'host', source.conversationId, target.conversationId];
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records'); if (marker === 'legacy') store.delete(markerKey); else if (marker !== 'absent') store.put(marker === 'kept' ? true : marker === 'undefined' ? undefined : 'broken marker', markerKey); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    await c.offerDraftCarry({ ...input, requestId }); const before = (await c.sourceCarries(source)).find(carry => carry.requestId === requestId);
    const lookup = await c.keptDraft(source, target).then(value => ({ value }), error => ({ error: error.message })), bound = await c.bindDraftCarry(source, requestId, target).then(() => 'bound', error => error.message), after = (await c.sourceCarries(source)).find(carry => carry.requestId === requestId);
    const savedMarker = await new Promise((resolve, reject) => { const tx = db.transaction('records'), store = tx.objectStore('records'), value = store.get(markerKey), key = store.getKey(markerKey); tx.oncomplete = () => resolve({ present: key.result !== undefined, value: value.result }); tx.onabort = () => reject(tx.error); });
    db.close(); await owner.close(); return { lookup, bound, before, after, savedMarker };
  }, marker);
  if (marker === 'undefined' || marker === 'malformed') { assert.match(result.lookup.error, /Keep decision is unreadable/); assert.match(result.bound, /Keep decision is unreadable/); assert.deepEqual(result.after, result.before); assert.deepEqual(result.savedMarker, { present: true, value: marker === 'undefined' ? undefined : 'broken marker' }); }
  else { assert.deepEqual(result.lookup, { value: marker !== 'absent' }); assert.equal(result.bound, 'bound'); assert.equal(result.after.kind, marker === 'absent' ? 'offered' : 'cancelled'); }
});

for (const timing of ['before-receive', 'before-clear', 'other-pair', 'no-keep']) test(`an older refused carry Keep fences a newer bound transfer (${timing})`, { timeout: 15000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async timing => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, source = { hostId: 'host', conversationId: 'late-keep-source' }, target = { ...source, conversationId: 'late-keep-target' }, other = { ...source, conversationId: 'other-target' };
    const claim = scope => ({ scope, viewId: scope.conversationId, label: scope.conversationId, transitionId: null, creation: { agentId: 'agent' } }), sourceOwner = await S.claimEditor(claim(source), () => {}), targetOwner = await S.claimEditor(claim(target), () => {});
    const sourcePort = sourceOwner.drafts(() => {}), targetPort = targetOwner.drafts(() => {}), make = (drafts, scope) => globalThis.createConversationStore({ scope, drafts, projection: globalThis.transcriptProjection, port: { scope } }), a = make(sourcePort, source), b = make(targetPort, target);
    await Promise.all([a.ready, b.ready]); await a.setDraft('Exact new source bytes'); await b.setDraft('Existing destination bytes'); const expected = await a.captureDraft(), input = { source, sourceViewId: sourceOwner.viewId, writerGeneration: sourceOwner.editorBinding().writerGeneration, expected };
    await c.offerDraftCarry({ ...input, requestId: '1:older-refused' }); await c.bindDraftCarry(source, '1:older-refused', timing === 'other-pair' ? other : target); await c.refuseDraftCarry((await c.sourceCarries(source))[0]); const older = (await c.sourceCarries(source))[0];
    await c.offerDraftCarry({ ...input, requestId: '1:newer-bound' }); await c.bindDraftCarry(source, '1:newer-bound', target); const newer = (await c.sourceCarries(source)).find(carry => carry.requestId === '1:newer-bound');
    if (timing === 'before-receive' || timing === 'other-pair') await c.cancelDraftCarry(older);
    const received = await b.transferDraft(await b.captureDraft(), `${expected.text}\n\nExisting destination bytes`, { kind: 'receive', source, requestId: newer.requestId });
    const beforeKeep = (await c.sourceCarries(source)).find(carry => carry.requestId === newer.requestId);
    if (timing === 'before-clear') await c.cancelDraftCarry(older);
    const cleared = await a.transferDraft(expected, '', { kind: 'release', source, requestId: newer.requestId });
    const after = (await c.sourceCarries(source)).find(carry => carry.requestId === newer.requestId), sourceSaved = await sourcePort.load(source), targetSaved = await targetPort.load(target), indexedAfter = await c.targetCarries(target);
    const notifications = [], runtime = (scope, owner, store) => Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'browser' }, port: { async request(command) { notifications.push(command.kind); } }, controller: { getSnapshot: () => ({ host: { kind: 'unavailable' }, active: { scope, viewId: owner.viewId, store } }) } });
    const targetRuntime = runtime(target, targetOwner, b), sourceRuntime = runtime(source, sourceOwner, a);
    await targetRuntime.syncDraftCarries(); await sourceRuntime.syncDraftCarries(); await targetRuntime.syncDraftCarries(); await sourceRuntime.syncDraftCarries();
    await a.setDraft('Fresh draft for an unrelated destination'); const third = { ...source, conversationId: 'third-next-target' };
    const next = await c.offerDraftCarry({ ...input, requestId: '1:next-after-keep', expected: await a.captureDraft() }).then(async () => { await c.bindDraftCarry(source, '1:next-after-keep', third); return (await c.targetCarries(third))[0]; }, error => ({ error: error.message }));
    await Promise.all([a.dispose(), b.dispose()]); await Promise.all([sourceOwner.close(), targetOwner.close()]); return { received, cleared, newer, beforeKeep, after, sourceSaved, targetSaved, indexedAfter, notifications, next };
  }, timing);
  const kept = timing === 'before-receive' || timing === 'before-clear'; assert.equal(result.received, timing === 'before-receive' ? 'cancelled' : 'committed'); assert.equal(result.cleared, kept ? 'cancelled' : 'committed');
  assert.equal(result.sourceSaved.draft, kept ? 'Exact new source bytes' : ''); assert.equal(result.targetSaved.draft, timing === 'before-receive' ? 'Existing destination bytes' : 'Exact new source bytes\n\nExisting destination bytes');
  assert.equal(result.next.error, undefined, 'The next carry must not remain blocked');
  if (kept) assert.deepEqual(result.after, { version: 1, kind: 'cancelled', source: result.newer.source, sourceViewId: result.newer.sourceViewId, requestId: result.newer.requestId, target: result.newer.target, outcome: 'kept-at-source', retainedText: result.newer.expected.text }); else assert.equal(result.after.kind, 'settled');
  assert.deepEqual(result.indexedAfter, []); assert.deepEqual(result.notifications, []); assert.equal(result.next.kind, 'offered'); assert.equal(result.next.target.conversationId, 'third-next-target'); assert.equal(result.next.expected.text, 'Fresh draft for an unrelated destination');
  assert.deepEqual(result.sourceSaved.outbox, []); assert.deepEqual(result.targetSaved.outbox, []); assert.equal(result.sourceSaved.image, null); assert.equal(result.targetSaved.image, null);
});

test('a stale runtime Keep reports changed status without claiming its text was copied', { timeout: 15000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, source = { hostId: 'host', conversationId: 'stale-runtime-keep' }, target = { ...source, conversationId: 'never-copied-target' }, requestId = '1:stale-runtime';
    const owner = await S.claimEditor({ scope: source, viewId: 'stale-runtime-view', label: 'source', transitionId: null, creation: { agentId: 'agent' } }, () => {}), drafts = owner.drafts(() => {}); await drafts.load(source); await drafts.save({ version: 3, scope: source, draft: 'Never copied original draft', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    await c.offerDraftCarry({ source, sourceViewId: owner.viewId, requestId, writerGeneration: owner.editorBinding().writerGeneration, expected: { text: 'Never copied original draft', revision: 1 } }); await c.bindDraftCarry(source, requestId, target); await c.cancelDraftCarry((await c.sourceCarries(source))[0]); await c.removeRetainedCarry((await c.sourceCarries(source))[0]);
    let refreshed = 0; const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, controller: { getSnapshot: () => ({ host: { kind: 'ready', metadata: { hostId: 'host' } } }) }, snapshot: { placementNotice: null }, listeners: new Set(), async refreshRecovery() { refreshed++; } });
    const before = await drafts.load(source); await runtime.keepDraft(requestId, source); const after = await drafts.load(source), carries = await c.sourceCarries(source), destination = await c.targetCarries(target); await owner.close(); return { before, after, carries, destination, notice: runtime.snapshot.placementNotice, refreshed };
  });
  assert.deepEqual(result.after, result.before); assert.deepEqual(result.carries, []); assert.deepEqual(result.destination, []); assert.equal(result.refreshed, 1); assert.match(result.notice, /changed|current status/i); assert.doesNotMatch(result.notice, /completed|available in the destination/i);
});

for (const phase of ['receive', 'clear']) for (const damage of ['undefined', 'malformed']) test(`a damaged Keep marker aborts carry ${phase} without terminalizing it (${damage})`, { timeout: 15000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async ({ phase, damage }) => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, source = { hostId: 'host', conversationId: 'corrupt-keep-source' }, target = { ...source, conversationId: 'corrupt-keep-target' }, requestId = '1:strict-terminal';
    const claim = scope => ({ scope, viewId: scope.conversationId, label: scope.conversationId, transitionId: null, creation: { agentId: 'agent' } }), sourceOwner = await S.claimEditor(claim(source), () => {}), targetOwner = await S.claimEditor(claim(target), () => {});
    const make = (owner, scope) => globalThis.createConversationStore({ scope, drafts: owner.drafts(() => {}), projection: globalThis.transcriptProjection, port: { scope } }), a = make(sourceOwner, source), b = make(targetOwner, target);
    await Promise.all([a.ready, b.ready]); await a.setDraft('Strict source bytes'); await b.setDraft('Strict destination bytes'); const expected = await a.captureDraft(), destination = await b.captureDraft();
    await c.offerDraftCarry({ source, sourceViewId: sourceOwner.viewId, requestId, writerGeneration: sourceOwner.editorBinding().writerGeneration, expected }); await c.bindDraftCarry(source, requestId, target);
    if (phase === 'clear') await b.transferDraft(destination, `${expected.text}\n\n${destination.text}`, { kind: 'receive', source, requestId });
    const before = { source: await a.captureDraft(), target: await b.captureDraft(), carries: await c.sourceCarries(source), index: await c.targetCarries(target) }, db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }), markerKey = ['draft-carry-kept', 'host', source.conversationId, target.conversationId];
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(damage === 'undefined' ? undefined : 'unreadable terminal decision', markerKey); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const error = await (phase === 'receive' ? b.transferDraft(destination, `${expected.text}\n\n${destination.text}`, { kind: 'receive', source, requestId }) : a.transferDraft(expected, '', { kind: 'release', source, requestId })).then(() => null, error => error.message);
    const after = { source: await a.captureDraft(), target: await b.captureDraft(), carries: await c.sourceCarries(source), index: await c.targetCarries(target) };
    const marker = await new Promise((resolve, reject) => { const tx = db.transaction('records'), store = tx.objectStore('records'), value = store.get(markerKey), found = store.getKey(markerKey); tx.oncomplete = () => resolve({ present: found.result !== undefined, value: value.result }); tx.onabort = () => reject(tx.error); });
    db.close(); await Promise.all([a.dispose(), b.dispose()]); await Promise.all([sourceOwner.close(), targetOwner.close()]); return { before, after, error, marker };
  }, { phase, damage });
  assert.match(result.error, /Keep decision is unreadable/); assert.deepEqual(result.after, result.before); assert.deepEqual(result.marker, { present: true, value: damage === 'undefined' ? undefined : 'unreadable terminal decision' });
});

for (const row of ['absent', 'undefined', 'malformed', 'offered']) test(`delegated carry binding distinguishes missing history from saved damage (${row})`, { timeout: 15000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async row => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, source = { hostId: 'host', conversationId: 'strict-bind-source' }, target = { ...source, conversationId: 'strict-bind-target' }, requestId = '1:strict-bind';
    const owner = await S.claimEditor({ scope: source, viewId: 'strict-bind-source-view', label: 'source', transitionId: null, creation: { agentId: 'agent' } }, () => {}), drafts = owner.drafts(() => {}); await drafts.load(source); await drafts.save({ version: 3, scope: source, draft: 'Strict binding original bytes', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    await c.offerDraftCarry({ source, sourceViewId: owner.viewId, requestId, writerGeneration: owner.editorBinding().writerGeneration, expected: { text: 'Strict binding original bytes', revision: 1 } });
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('openpane-browser-views', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }), rowKey = ['draft-carry', 'host', source.conversationId, requestId];
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'), records = tx.objectStore('records'); if (row === 'absent') records.delete(rowKey); else if (row !== 'offered') records.put(row === 'undefined' ? undefined : { unreadable: 'preserve exact bind row' }, rowKey); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const inspect = () => new Promise((resolve, reject) => { const tx = db.transaction('records'), records = tx.objectStore('records'), value = records.get(rowKey), found = records.getKey(rowKey); tx.oncomplete = () => resolve({ present: found.result !== undefined, value: value.result }); tx.onabort = () => reject(tx.error); }), before = await inspect(), sourceBefore = await drafts.load(source);
    const reservation = { scope: target, viewId: 'strict-bind-target-view', label: 'target', transitionId: 'strict-bind-attempt', creationAgentId: null, phase: 'assigned', bindingRevision: null, writerGeneration: null }; let completed = null, placements = 0;
    const intent = { sourceScope: source, requestId, action: { kind: 'open', scope: target, carry: true }, target: reservation, result: null };
    const runtime = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'main' }, snapshot: { placementNotice: null }, listeners: new Set(), async syncDraftCarries() {}, controller: { getSnapshot: () => ({ busy: false, host: { kind: 'ready', metadata: { hostId: 'host' } }, saved: { pendingCreation: null } }), async inspectConversation() { return { agent: { id: 'agent' }, continuation: { successor: { kind: 'confirmed', scope: target } } }; }, async openReserved() { placements++; return { kind: 'inline', scope: target }; } }, port: { async request(command) { if (command.kind === 'read-intent') return intent; if (command.kind === 'lookup') return { kind: 'closed', reservation }; if (command.kind === 'complete-intent') { completed = command.result; return {}; } throw new Error(command.kind); } } });
    await runtime.processIntent(intent); const after = await inspect(), sourceAfter = await drafts.load(source), index = await c.targetCarries(target); db.close(); await owner.close(); return { before, after, sourceBefore, sourceAfter, index, completed, placements, notice: runtime.snapshot.placementNotice };
  }, row);
  assert.deepEqual(result.sourceAfter, result.sourceBefore);
  if (row === 'undefined' || row === 'malformed') { assert.equal(result.placements, 0); assert.equal(result.completed, null); assert.deepEqual(result.after, result.before); assert.deepEqual(result.index, []); assert.equal(typeof result.notice, 'string'); }
  else { assert.equal(result.placements, 1); assert.equal(result.completed.kind, 'inline'); if (row === 'absent') { assert.deepEqual(result.after, result.before); assert.deepEqual(result.index, []); } else { assert.equal(result.after.value.target.conversationId, 'strict-bind-target'); assert.equal(result.index.length, 1); } }
});

for (const invalid of ['source', 'foreign']) test(`Keep validates a late ${invalid} target without damaging its saved carry`, async t => {
  const page = await fixture(t), result = await page.evaluate(async invalid => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, source = { hostId:'host',conversationId:'kept-late-source' }, target = { hostId:'host',conversationId:'kept-late-target' };
    const owner = await S.claimEditor({ scope:source,viewId:'kept-late-view',label:'main',transitionId:null,creation:{agentId:'default'} }, () => {});
    const store = globalThis.createConversationStore({ scope:source,port:{scope:source},projection:globalThis.transcriptProjection,drafts:owner.drafts(() => {}) });
    try {
      await store.ready; await store.setDraft('Exact kept source text');
      await c.offerDraftCarry({ source,sourceViewId:owner.viewId,writerGeneration:owner.editorBinding().writerGeneration,requestId:'1:late-keep',emptyOnly:true,expected:await store.captureDraft() });
      await c.cancelDraftCarry((await c.sourceCarries(source))[0]);
      const before = (await c.sourceCarries(source))[0];
      const refused = await c.bindDraftCarry(source,'1:late-keep',invalid === 'source' ? source : {...target,hostId:'foreign'}).then(() => false, () => true);
      const after = (await c.sourceCarries(source))[0], unrelatedMarker = await c.keptDraft(source,target);
      await c.bindDraftCarry(source,'1:late-keep',target);
      return { refused,before,after,unrelatedMarker,final:(await c.sourceCarries(source))[0],text:(await store.captureDraft()).text,kept:await c.keptDraft(source,target) };
    } finally { await store.dispose(); await owner.close(); }
  }, invalid);
  assert.equal(result.refused,true); assert.deepEqual(result.after,result.before); assert.equal(result.unrelatedMarker,false);
  assert.equal(result.final.kind,'cancelled'); assert.equal(result.final.emptyOnly,true); assert.equal(result.kept,true); assert.equal(result.text,'Exact kept source text');
});

for (const action of ['save-cleared-view', 'open-remaining-work']) test(`catalog navigation clears through ${action}`, async t => {
  const page = await fixture(t), result = await page.evaluate(async action => {
    const S = globalThis.BrowserViewStorage, scope = { hostId:'host',conversationId:'catalog-clear' };
    const catalog = await S.open(() => {}, 'openpane.catalogViewId'); let editor;
    try {
      editor = await S.claimEditor({ scope,viewId:'catalog-clear-editor',label:'main',transitionId:null,creation:{agentId:'default'} }, () => {});
      await catalog.saveNavigation('host',scope);
      const before = (await catalog.readView('host')).route, binding = (await S.locateEditor(scope)).binding;
      if (action === 'save-cleared-view') await catalog.saveView('host',{version:2,route:null,pendingCreation:null});
      else await catalog.openRemainingWork('host');
      return { before, expected: scope, route:(await catalog.readView('host')).route,binding:(await S.locateEditor(scope)).binding, originalBinding:binding };
    } finally { await editor?.close(); await catalog.close(); }
  }, action);
  assert.deepEqual(result.before,result.expected); assert.equal(result.route,null); assert.deepEqual(result.binding,result.originalBinding); assert.equal(result.binding.viewId,'catalog-clear-editor');
});
