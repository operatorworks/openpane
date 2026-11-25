import assert from 'node:assert/strict';
import test from 'node:test';
import { scope, empty, fixture } from './controller-fixture.mjs';

for (const kind of ['detached', 'pending']) test(`recovered existing creation clears its marker after ${kind} placement`, async t => {
  const f = fixture({ placement: { async acquire(request) {
    return kind === 'pending' ? { kind, scope: request.scope, reason: 'Waiting for native editor' }
      : { kind, scope: request.scope, label: 'existing-created-chat' };
  } } });
  t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), pendingCreation: { scope, agentId: 'default' } });
  await f.app.start();
  const result = await f.app.recoverCreation();
  assert.equal(result.kind, kind);
  if (kind === 'pending') {
    assert.ok(f.app.pendingPlacements().includes(result));
    assert.equal(f.app.settlePlacement(result, { kind: 'detached', scope, label: 'confirmed-existing-chat' }), true);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.views.get('original-view/host').pendingCreation, null);
  assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
  assert.deepEqual(f.created, [], 'confirmed existing creation is not replayed');
});

test('workspace pagination rejects a repeated full page cursor', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); await f.app.start();
  const page = Array.from({ length: 100 }, (_, index) => ({ scope: { ...scope, conversationId: `workspace-${index}` }, preview: null,
    provider: { namespace: 'workspace', installationId: 'fixture', providerAgentId: 'desk' } }));
  f.behavior.workspaceCatalog = async () => page;
  await f.app.loadWorkspace('workspace'); await f.app.moreWorkspace('workspace');
  assert.match(f.app.getSnapshot().error, /did not advance/);
  assert.equal(f.app.getSnapshot().workspaces.workspace.loading, false);
  assert.equal(f.app.getSnapshot().workspaces.workspace.entries.length, 100);
});

test('an explicit inline open commits catalog navigation once', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.storage.catalogViewId = 'original-view'; await f.app.start();
  let writes = 0;
  f.behavior.navigation = async () => { if (++writes > 1) throw new Error('Duplicate catalog navigation write'); };
  const result = await f.app.open(scope);
  assert.equal(result.kind, 'inline'); assert.equal(writes, 1);
  assert.deepEqual(f.app.getSnapshot().active.scope, scope);
  assert.deepEqual(f.views.get('original-view/host').route, scope);
  assert.equal(f.app.getSnapshot().storageFailure, '');
});

test('an explicit reconnect can retry after a completed teardown failure', async t => {
  const f = fixture(); t.after(() => f.app.dispose().catch(() => {})); await f.app.start();
  f.leases[0].failure(new Error('Local storage interrupted'));
  let closes = 0;
  f.behavior.close = () => { if (++closes === 1) throw new Error('First close failed'); };
  await f.app.reconnect(); assert.match(f.app.getSnapshot().storageFailure, /First close failed/);
  await f.app.reconnect();
  assert.equal(f.app.getSnapshot().storageFailure, '');
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.equal(f.leases.length, 2);
  assert.equal(f.leases[0].closed, true);
  assert.equal(f.leases[1].closed, false);
});

test('a later open of the same successor retains the original continuation placement identity', async t => {
  let separate = false;
  const successor = { ...scope, conversationId: 'successor' };
  const f = fixture({ placement: { async acquire(request, owner) {
    return separate ? { kind: 'pending', scope: request.scope, reason: 'Waiting for successor editor' }
      : { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
  } } });
  t.after(() => f.app.dispose()); f.views.set('original-view/host', { ...empty(), route: scope }); await f.app.start();
  const source = f.app.getSnapshot().active; separate = true;
  f.behavior.continuation = async ({ scope: selected }) => ({ predecessor: null, carried: null, closure: 'cancelled',
    successor: selected.conversationId === scope.conversationId ? { kind: 'confirmed', scope: successor } : null });
  await f.app.conversationActions(source).checkContinuation();
  const original = f.app.getSnapshot().lastPlacement;
  assert.equal(original.kind, 'pending');
  const later = await f.app.openReserved(successor);
  assert.notEqual(later, original);
  assert.ok(f.app.pendingPlacements().includes(original), 'the native recovery loop can still find its admitted result');
  assert.ok(f.app.pendingPlacements().includes(later));
  assert.equal(f.app.settlePlacement(original, { kind: 'detached', scope: successor, label: 'confirmed-successor' }), true);
});

test('immediate creation reuses the catalog navigation already committed for recovery', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.storage.catalogViewId = 'original-view'; await f.app.start();
  let writes = 0;
  f.behavior.navigation = async () => { if (++writes > 1) throw new Error('Duplicate creation route write'); };
  const result = await f.app.create();
  assert.equal(result.kind, 'inline'); assert.equal(writes, 1); assert.equal(f.created.length, 1);
  assert.equal(f.app.getSnapshot().storageFailure, ''); assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
});

test('one reconnect recovers a session started during a failing prior disposal', async t => {
  const f = fixture(); t.after(() => f.app.dispose().catch(() => {})); await f.app.start();
  let reject, entered; const closing = new Promise((_, no) => { reject = no; }), started = new Promise(yes => { entered = yes; });
  let closes = 0;
  f.behavior.close = () => { if (++closes === 1) { entered(); return closing; } };
  const disposed = assert.rejects(f.app.dispose(), /Held close failed/); await started;
  const starting = f.app.start(); reject(new Error('Held close failed')); await disposed; await starting;
  assert.match(f.app.getSnapshot().storageFailure, /Held close failed/);
  await f.app.reconnect(); assert.equal(f.app.getSnapshot().storageFailure, ''); assert.equal(f.app.getSnapshot().host.kind, 'ready');
});

test('known detached creation survives a source restoration failure and clears after reconnect', async t => {
  let f, placements = 0;
  f = fixture({ placement: { async acquire(request, source) {
    if (!request.creation) return { kind: 'inline', view: { kind: 'owned', viewId: source.storage.viewId } };
    placements++; await source.release();
    f.behavior.reopen = async () => { throw new Error('Recorded source restoration failure'); };
    return { kind: 'detached', scope: request.scope, label: 'confirmed-created-editor' };
  } } });
  t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), pendingCreation: { scope, agentId: 'default' } }); await f.app.start();
  const result = await f.app.recoverCreation();
  assert.equal(result.kind, 'detached'); assert.match(f.app.getSnapshot().storageFailure, /source restoration failure/);
  assert.ok(f.views.get('original-view/host').pendingCreation);
  f.behavior.reopen = async () => {}; await f.app.reconnect();
  assert.equal(f.app.getSnapshot().saved.pendingCreation, null); assert.equal(f.views.get('original-view/host').pendingCreation, null);
  assert.equal(placements, 1); assert.deepEqual(f.created, []);
});

test('a failed unrelated recovery acquisition cannot refuse a foreground open', { timeout: 5000 }, async t => {
  let f, entered, reject;
  const opening = new Promise(yes => { entered = yes; }), held = new Promise((_, no) => { reject = no; });
  f = fixture({ placement: { async acquire(_request, owner) { return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } }; } } });
  t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.views.set('unrelated-view/host', { ...empty(), route: { ...scope, conversationId: 'unrelated' } });
  let listUnrelated = false;
  f.behavior.listing = async () => ({ ids: listUnrelated ? ['unrelated-view'] : [], after: null, unreadable: 0 });
  f.storage.recoverClosedView = async () => { entered(); return held; };
  await f.app.start(); listUnrelated = true; await f.app.refreshMetadata(); await opening;
  const selecting = f.app.open({ ...scope, conversationId: 'foreground' });
  await new Promise(resolve => setImmediate(resolve));
  reject(new Error('Unrelated saved view unavailable')); const result = await selecting;
  assert.equal(result.kind, 'inline'); assert.equal(f.app.getSnapshot().active.scope.conversationId, 'foreground');
  assert.equal(f.views.get('unrelated-view/host').route.conversationId, 'unrelated');
});

test('foreground busy toggles preserve completed recovery discovery', async t => {
  const f = fixture({ placement: { async acquire(_request, owner) { return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } }; } } }); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope }); let discoveries = 0;
  f.behavior.listing = async () => { discoveries++; return { ids: [], after: null, unreadable: 0 }; };
  f.storage.recoverClosedView = (id, failed) => f.storage.reopen(id, failed);
  await f.app.start(); await new Promise(resolve => setImmediate(resolve)); const before = discoveries;
  for (let n = 0; n < 3; n++) { await f.app.refreshCatalog(); await new Promise(resolve => setImmediate(resolve)); }
  await f.app.open(scope); await new Promise(resolve => setImmediate(resolve));
  assert.equal(discoveries, before, 'resuming or reopening the same physical editor does not enumerate saved views again');
});

test('a retired placement cannot suspend or resume recovery owned by its restarted session', { timeout: 5000 }, async t => {
  let releaseOld, releaseNew, enteredOld, enteredNew, restart = false, acquisitions = 0, placements = 0;
  const old = new Promise(yes => { releaseOld = yes; }), next = new Promise(yes => { releaseNew = yes; });
  const oldEntered = new Promise(yes => { enteredOld = yes; }), nextEntered = new Promise(yes => { enteredNew = yes; });
  const f = fixture({ placement: { async acquire(_request, owner) {
    const number = ++placements; if (number === 1) { enteredOld(); await old; } else { enteredNew(); await next; }
    return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
  } } });
  t.after(async () => { releaseOld(); releaseNew(); await f.app.dispose(); });
  f.behavior.listing = async () => ({ ids: restart ? ['other-saved'] : [], after: null, unreadable: 0 });
  f.storage.recoverClosedView = async (id, failure) => { acquisitions++; return f.storage.reopen(id, failure); };
  await f.app.start(); const first = f.app.open(scope); await oldEntered;
  await f.app.dispose(); restart = true; await f.app.start();
  for (let n = 0; n < 100 && acquisitions === 0; n++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(acquisitions > 0, 'new session recovery runs without waiting for its retired placement');
  const second = f.app.open({ ...scope, conversationId: 'new-session-chat' }); await nextEntered;
  const before = acquisitions; releaseOld(); await first; await f.app.refreshMetadata();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(acquisitions, before, 'the old completion cannot resume recovery during the new placement');
  releaseNew(); assert.equal((await second).kind, 'inline');
});

test('a retired creation cannot enter placement and pause its restarted session', { timeout: 5000 }, async t => {
  let release, entered, discover = false, recovered = 0;
  const held = new Promise(yes => { release = yes; }), delegated = new Promise(yes => { entered = yes; });
  const f = fixture({ placement: { async delegateCreate() { entered(); await held; return null; }, async acquire(_request, owner) { return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } }; } } });
  t.after(async () => { release(); await f.app.dispose(); });
  f.behavior.listing = async () => ({ ids: discover ? ['saved-other'] : [], after: null, unreadable: 0 });
  f.storage.recoverClosedView = async (id, failure) => { recovered++; return f.storage.reopen(id, failure); };
  await f.app.start(); const creating = f.app.create(); await delegated;
  await f.app.dispose(); await f.app.start(); release(); assert.equal((await creating).kind, 'refused');
  discover = true; await f.app.refreshMetadata();
  for (let n = 0; n < 100 && recovered === 0; n++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(recovered > 0, 'retired placement entry cannot pause the current recovery owner');
});
