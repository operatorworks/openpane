import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t) {
  const bundle = await build({ stdin: { contents: `import { BrowserViewStorage } from './apps/desktop/src/application/browser-storage.ts';
    import { transferEditor, readEditorBinding } from './apps/desktop/src/application/editor-bindings.ts';
    import { createConversationStore } from '@openpane/client';
    import { transcriptProjection } from '@openpane/contracts/conversation';
    import * as carries from './apps/desktop/src/application/draft-carry.ts';
    Object.assign(globalThis, { BrowserViewStorage, transferEditor, readEditorBinding, createConversationStore, transcriptProjection, carries });`, resolveDir: root }, bundle: true, write: false, format: 'iife' });
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
    for (const viewId of ['first', 'second']) { const owner = await Storage.reopen(viewId, () => {}); await owner.drafts(() => {}).save({ scope, draft: viewId }); await owner.close(); }
    return Storage.locateEditor(scope);
  });
  assert.equal(result.binding, null); assert.deepEqual(result.legacyViewIds, ['first', 'second']);
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
    await carries.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId: 'carry-request', writerGeneration: binding.writerGeneration, expected });
    const duplicate = await carries.offerDraftCarry({ source: sourceScope, sourceViewId: source.viewId, requestId: 'different-request', writerGeneration: binding.writerGeneration, expected }).then(() => 'offered', error => error.message);
    await carries.bindDraftCarry(sourceScope, 'carry-request', targetScope);
    const conflict = await carries.bindDraftCarry(sourceScope, 'carry-request', { ...targetScope, conversationId: 'other' }).then(() => 'bound', error => error.message);
    const target = await Storage.claimEditor(claim(targetScope), () => {}), targetStore = makeStore(target, targetScope); await targetStore.ready; await targetStore.setDraft('Already typed');
    const [offer] = await carries.targetCarries(targetScope);
    // The target's durable save can finish just before its process crashes, leaving the offer unacknowledged.
    await targetStore.setDraft(`${offer.expected.text}${targetStore.getSnapshot().draft}`);
    const [replayed] = await carries.targetCarries(targetScope), current = await targetStore.captureDraft();
    if (!current.text.includes(replayed.expected.text)) await targetStore.replaceDraft(current, `${replayed.expected.text}${current.text}`);
    await carries.updateDraftCarry(replayed, 'applied');
    await sourceStore.dispose(); await source.close();
    source = await Storage.claimEditor({ ...claim(sourceScope), creation: null }, () => {}); sourceStore = makeStore(source, sourceScope); await sourceStore.ready;
    if (changed) await sourceStore.setDraft('Changed while the target opens');
    const [applied] = await carries.sourceCarries(sourceScope), cleared = await sourceStore.replaceDraft(applied.expected, '');
    await carries.updateDraftCarry(applied, cleared ? 'cleared' : 'changed');
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
