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
    import * as carries from './apps/desktop/src/application/draft-carry.ts';
    Object.assign(globalThis, { BrowserViewStorage, WindowCoordinator, transferEditor, readEditorBinding, createConversationStore, transcriptProjection, carries });`, resolveDir: root }, bundle: true, write: false, format: 'iife' });
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
    await targetStore.transferDraft(current, `${offer.expected.text}${current.text}`, { kind: 'receive', source: offer.source, requestId: offer.requestId });
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
  assert.equal(result.targetRecords.draft, 'Carry meAlready typed'); assert.equal(result.settled[0].kind, 'settled'); assert.equal('expected' in result.settled[0], false);
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
    const receiving = targetStore.transferDraft(before, `Carry this${before.text}`, { kind: 'receive', source: sourceScope, requestId: first.requestId });
    await started; const keptBeforeWrite = await carries.cancelDraftCarry(first); release();
    const cancelled = await receiving, afterCancel = await targetStore.captureDraft();
    const second = await offer('1:second');
    const received = await targetStore.transferDraft(afterCancel, `Carry this${afterCancel.text}`, { kind: 'receive', source: sourceScope, requestId: second.requestId });
    const [applied] = (await carries.sourceCarries(sourceScope)).filter(carry => carry.requestId === '1:second');
    const keptBeforeClear = await carries.cancelDraftCarry(applied);
    const clearedAfterKeep = await sourceStore.transferDraft(applied.expected, '', { kind: 'release', source: sourceScope, requestId: applied.requestId });
    const sourceText = sourceStore.getSnapshot().draft;
    const third = await offer('1:third'), current = await targetStore.captureDraft();
    await targetStore.transferDraft(current, current.text, { kind: 'receive', source: sourceScope, requestId: third.requestId });
    const clearedFirst = await sourceStore.transferDraft(third.expected, '', { kind: 'release', source: sourceScope, requestId: third.requestId });
    const keptTooLate = await carries.cancelDraftCarry(third);
    const sourceSaved = await source.drafts(() => {}).load(sourceScope), targetSaved = await target.drafts(() => {}).load(targetScope);
    await Promise.all([sourceStore.dispose(), targetStore.dispose()]); await Promise.all([source.close(), target.close()]);
    return { keptBeforeWrite, cancelled, afterCancel, received, keptBeforeClear, clearedAfterKeep, sourceText, clearedFirst, keptTooLate, sourceSaved, targetSaved };
  });
  assert.equal(result.keptBeforeWrite, true); assert.equal(result.cancelled, 'cancelled'); assert.equal(result.afterCancel.text, 'Existing');
  assert.equal(result.received, 'committed'); assert.equal(result.keptBeforeClear, true); assert.equal(result.clearedAfterKeep, 'cancelled'); assert.equal(result.sourceText, 'Carry this');
  assert.equal(result.clearedFirst, 'committed'); assert.equal(result.keptTooLate, false);
  assert.equal(result.sourceSaved.draft, ''); assert.equal(result.targetSaved.draft, 'Carry thisExisting');
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
