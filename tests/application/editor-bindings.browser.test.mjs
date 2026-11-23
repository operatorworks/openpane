import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t) {
  const bundle = await build({ stdin: { contents: `import { BrowserViewStorage } from './apps/desktop/src/application/browser-storage.ts';
    import { transferEditor, readEditorBinding } from './apps/desktop/src/application/editor-bindings.ts';
    import { WindowCoordinator } from './apps/desktop/src/application/window-coordinator.ts';
    import { createConversationStore } from '@openpane/client';
    import { transcriptProjection } from '@openpane/contracts/conversation';
    import { WindowRuntime } from './apps/desktop/src/application/window-runtime.ts';
    import * as carries from './apps/desktop/src/application/draft-carry.ts';
    Object.assign(globalThis, { BrowserViewStorage, WindowCoordinator, WindowRuntime, transferEditor, readEditorBinding, createConversationStore, transcriptProjection, carries });`, resolveDir: root }, bundle: true, write: false, format: 'iife' });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Editor ownership</title>' }));
  await page.goto('http://localhost/editor'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return page;
}

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
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', label: 'main', liveRelay: true }, async request(command) { if (command.kind !== 'lookup') throw new Error('Unexpected native command'); return { reservation: null, live }; } });
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

test('Keep draft and destination/source writes each commit against the current carry state atomically', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const Storage = globalThis.BrowserViewStorage, carries = globalThis.carries;
    const sourceScope = { hostId: 'host', conversationId: 'source' }, targetScope = { hostId: 'host', conversationId: 'target' };
    const claim = scope => ({ scope, viewId: scope.conversationId, label: scope.conversationId, creation: { agentId: 'agent' }, transitionId: null });
    const source = await Storage.claimEditor(claim(sourceScope), () => {}), target = await Storage.claimEditor(claim(targetScope), () => {});
    const port = target.drafts(() => {}); let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    const make = (owner, scope, drafts = owner.drafts(() => {})) => globalThis.createConversationStore({ scope, drafts, projection: globalThis.transcriptProjection,
      port: { scope, async receipt() { return null; }, async submit() { throw new Error('No send requested'); }, watch() { return { close() {}, ended: new Promise(() => {}) }; } } });
    const sourceStore = make(source, sourceScope), targetStore = make(target, targetScope, { ...port, async commitTransfer(records, transfer) { entered(); await gate; return port.commitTransfer(records, transfer); } });
    await Promise.all([sourceStore.ready, targetStore.ready]); await sourceStore.setDraft('Carry this'); await targetStore.setDraft('Existing');
    const offer = async requestId => {
      const expected = await sourceStore.captureDraft();
      await carries.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId, writerGeneration: source.editorBinding().writerGeneration, expected });
      await carries.bindDraftCarry(sourceScope, requestId, targetScope); return (await carries.sourceCarries(sourceScope)).find(carry => carry.requestId === requestId);
    };
    const first = await offer('1:first'), before = await targetStore.captureDraft();
    const receiving = targetStore.transferDraft(before, `Carry this\n\n${before.text}`, { kind: 'receive', source: sourceScope, requestId: first.requestId });
    await started; const keptBeforeWrite = await carries.cancelDraftCarry(first); release();
    const cancelled = await receiving, afterCancel = await targetStore.captureDraft();
    const second = await offer('1:second');
    const received = await targetStore.transferDraft(afterCancel, `Carry this\n\n${afterCancel.text}`, { kind: 'receive', source: sourceScope, requestId: second.requestId });
    const [applied] = (await carries.sourceCarries(sourceScope)).filter(carry => carry.requestId === '1:second');
    const keptBeforeClear = await carries.cancelDraftCarry(applied);
    const clearedAfterKeep = await sourceStore.transferDraft(applied.expected, '', { kind: 'release', source: sourceScope, requestId: applied.requestId });
    const sourceText = sourceStore.getSnapshot().draft;
    const third = await offer('1:third'), current = await targetStore.captureDraft();
    await targetStore.transferDraft(current, `Carry this\n\n${current.text}`, { kind: 'receive', source: sourceScope, requestId: third.requestId });
    const clearedFirst = await sourceStore.transferDraft(third.expected, '', { kind: 'release', source: sourceScope, requestId: third.requestId });
    const keptTooLate = await carries.cancelDraftCarry(third);
    const sourceSaved = await source.drafts(() => {}).load(sourceScope), targetSaved = await target.drafts(() => {}).load(targetScope);
    await Promise.all([sourceStore.dispose(), targetStore.dispose()]); await Promise.all([source.close(), target.close()]);
    return { keptBeforeWrite, cancelled, afterCancel, received, keptBeforeClear, clearedAfterKeep, sourceText, clearedFirst, keptTooLate, sourceSaved, targetSaved };
  });
  assert.equal(result.keptBeforeWrite, true); assert.equal(result.cancelled, 'cancelled'); assert.equal(result.afterCancel.text, 'Existing');
  assert.equal(result.received, 'committed'); assert.equal(result.keptBeforeClear, true); assert.equal(result.clearedAfterKeep, 'cancelled'); assert.equal(result.sourceText, 'Carry this');
  assert.equal(result.clearedFirst, 'committed'); assert.equal(result.keptTooLate, false);
  assert.equal(result.sourceSaved.draft, ''); assert.equal(result.targetSaved.draft, 'Carry this\n\nCarry this\n\nExisting');
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
      if (request.kind === 'lookup') return { reservation: null, live: false };
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
    const runtime = Object.create(globalThis.WindowRuntime.prototype);
    runtime.controller = { getSnapshot: () => ({ active: { scope: targetScope, viewId: target.viewId, store: targetStore } }) };
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
    const runtime=Object.create(globalThis.WindowRuntime.prototype);runtime.controller={getSnapshot:()=>({active:{scope:targetScope,viewId:target.viewId,store:targetStore}})};runtime.port={async request(){return{ok:true};}};
    await runtime.syncDraftCarries();const copied=targetStore.getSnapshot().draft;if(removed)await targetStore.setDraft('');
    const release=await sourceStore.transferDraft(expected,'',{kind:'release',source:sourceScope,requestId:'1:whole-phrase'}),sourceText=sourceStore.getSnapshot().draft;
    await Promise.all([sourceStore.dispose(),targetStore.dispose()]);await Promise.all([source.close(),target.close()]);return{copied,release,sourceText};
  },removed);
  assert.deepEqual(result,{copied:'note\n\nnotebook',release:removed?'cancelled':'committed',sourceText:removed?'note':''});
});

test('an opening child registers the same authoritative handoff against a later appearance delivery',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const Storage=globalThis.BrowserViewStorage,scope={hostId:'host',conversationId:'opening'},source=await Storage.claimEditor({scope,viewId:'source',label:'main',creation:{agentId:'agent'},transitionId:null},()=>{});
    const drafts=source.drafts(()=>{});await drafts.load(scope);await drafts.save({version:3,scope,draft:'Preserve opening draft',draftRevision:1,outbox:[],frontendSends:[],image:null});
    const binding=await source.reserveHandoff({scope,sourceViewId:'source',targetViewId:'child-view',transitionId:'transition',targetLabel:'child',expectedBinding:source.editorBinding()});await source.close();
    const reservation={scope,viewId:'child-view',label:'child',transitionId:'transition',creationAgentId:null,phase:'source-released',bindingRevision:null,writerGeneration:null},calls=[];
    const coordinator=new globalThis.WindowCoordinator({context:{role:'main',label:'main',liveRelay:true},async request(command){if(command.kind==='lookup')return{reservation,live:true};if(command.kind==='launch')return{kind:'pending',scope,reason:'Window is opening'};throw new Error('Unexpected mutation');}});
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
    const runtime=Object.create(globalThis.WindowRuntime.prototype);Object.assign(runtime,{context:{role:'chat',reservation:{scope}},historyEpoch:1,requestHistory:new Map(),historyAfter:null,historyExtended:false,pendingIntents:new Map([['1:retired',older],['2:latest',latest]]),pendingIntent:{requestId:'2:latest',result:latest},snapshot:{recovery:{kind:'chat',pending:[],history:[],after:null,carries:[]},placementNotice:'Waiting',catalogOnly:false,capabilityNotice:null},listeners:new Set(),controller:{settlePlacement(expected,value){settled.push({which:expected===older?'older':'latest',value});return true;}},port:{async request(command){calls.push(command.kind);if(command.kind==='own-intents')return{epoch:2,pending:[],items:[saved],after:null};if(command.kind==='read-intent')return null;throw new Error('No allocation permitted');}}});
    await runtime.refreshRecovery();const snapshot=runtime.snapshot,text=store.getSnapshot().draft,pending=runtime.pendingIntents.size;await store.dispose();await source.close();return{snapshot,text,pending,settled,calls};
  });
  assert.equal(result.pending,0);assert.equal(result.text,'Still recoverable');assert.equal(result.snapshot.recovery.carries.length,1);assert.equal(result.settled[0].value.kind,'refused');assert.match(result.settled[0].value.reason,/expired/);assert.deepEqual(result.settled[1],{which:'latest',value:{kind:'detached',scope:{hostId:'host',conversationId:'main-target'},label:'main'}});assert.deepEqual(result.calls,['own-intents','read-intent']);
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
  assert.equal(result.retained.kind, 'cancelled'); assert.deepEqual(result.copies, []); assert.deepEqual(result.retired, []);
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
    await Storage.openRemainingWork('legacy-other-work', 'host'); const remaining = await Storage.reopen('legacy-other-work', () => {});
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
      if (command.kind === 'lookup') return { reservation, live: true };
      if (command.kind === 'intent-context') return { epoch: 1, pendingCarryRequests: [] };
      if (command.kind === 'launch') { launches++; return { kind: 'detached', scope: targetScope, label: 'child' }; }
      throw new Error(command.kind);
    } };
    const coordinator = new globalThis.WindowCoordinator(port);
    const runtime = Object.create(globalThis.WindowRuntime.prototype);
    Object.assign(runtime, { context: port.context, coordinator, controller: { async capturePlacementDraft(scope) { if (scope.conversationId !== sourceScope.conversationId) throw new Error('Wrong source'); return { viewId: source.viewId, ...await sourceStore.captureDraft() }; } } });
    runtime.configurePlacementTracking();
    const request = { scope: targetScope, creation: false, carryFrom: sourceScope, agentId: 'agent', agentLabel: 'Agent' };
    const owner = { storage: source, holds: () => true, async quiesce() { throw new Error('Unexpected handoff'); }, async release() { throw new Error('Unexpected handoff'); } };
    const placement = await coordinator.acquire(request, owner); await coordinator.acquire(request, owner);
    const before = await carries.targetCarries(targetScope);
    Object.assign(runtime, { controller: { getSnapshot: () => ({ active: { scope: targetScope, viewId: target.viewId, store: targetStore } }) }, port: { async request() { throw new Error('Native notification temporarily unavailable'); } } });
    await runtime.syncDraftCarries(); await runtime.syncDraftCarries();
    Object.assign(runtime, { controller: { getSnapshot: () => ({ active: { scope: sourceScope, viewId: source.viewId, store: sourceStore } }) } });
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
