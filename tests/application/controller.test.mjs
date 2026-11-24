import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendToolGeneration } from '@openpane/sdk/tools';
import { ServiceError } from '@openpane/contracts/service';
import { ServiceConnectionLost } from '@openpane/client/service';
import { CLAUDE_SDK_RUNTIMES, CODEX_RUNTIME, CODEX_SDK_RUNTIME, PI_RUNTIME, RECORDED_RUNTIME } from '@openpane/contracts/compatibility';
import { applicationEnabled } from '../../apps/desktop/dist/application/application-controller.js';
import { scope, empty, deferred, fixture } from './controller-fixture.mjs';
import { WindowCoordinator } from '../../apps/desktop/dist/application/window-coordinator.js';

test('a refused assigned child creation retries its original scope without delegating another chat', async t => {
  const commands = [];
  const placement = new WindowCoordinator({ context: { role: 'chat', viewId: 'original-view', reservation: { scope } }, async request(command) { commands.push(command); throw new Error('Assigned creation must stay in its child'); } });
  const f = fixture({ placement, fixedScope: scope }); t.after(() => f.app.dispose());
  await f.app.start();
  f.behavior.create = async () => { throw new ServiceError('create-rejected', 'Creation refused'); };
  await f.app.createReserved(scope, 'default');
  assert.deepEqual(f.created, [scope]);
  f.behavior.create = async () => {};
  assert.equal((await f.app.createReserved(scope, 'default')).kind, 'inline');
  assert.deepEqual(f.created, [scope, scope]);
  assert.deepEqual(commands, []);
});

test('background search leaves active state usable and rejects stale, foreign and nonadvancing pages', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const active = f.app.getSnapshot().active;
  await active.store.setDraft('Unsent during search');
  const gate = deferred(), signal = new AbortController();
  f.behavior.search = () => gate.promise;
  const pending = f.app.search('garden', null, signal.signal);
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  assert.equal(f.app.getSnapshot().active, active);
  signal.abort();
  gate.resolve({ items: [], after: 'last-scanned' });
  await assert.rejects(pending, /Search connection changed/);
  const live = new AbortController().signal;
  f.behavior.search = async () => ({ items: [], after: 'a' });
  await assert.rejects(f.app.search('garden', 'a', live), /did not advance/);
  f.behavior.search = async () => ({ items: [], after: '😀' });
  assert.deepEqual(await f.app.search('garden', '\uE000', live), { items: [], after: '😀' });
  f.behavior.search = async () => ({ items: [{ scope: { ...scope, hostId: 'foreign' }, preview: null, excerpt: null }], after: null });
  await assert.rejects(f.app.search('garden', null, live), /another host/);
  const replaced = deferred();
  f.behavior.search = () => replaced.promise;
  const outdated = f.app.search('garden', null, live);
  f.host('new-host');
  await f.app.reconnect();
  replaced.resolve({ items: [], after: null });
  await assert.rejects(outdated, /Search connection changed/);
  f.behavior.search = async () => { throw new ServiceError('unavailable', 'Host offline'); };
  await assert.rejects(f.app.search('garden', null, live), /Host offline/);
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.equal(f.drafts.get('original-view/host/conversation').draft, 'Unsent during search');
});

test('creation recovery persists and reuses the original identity before sending', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  await f.app.start();
  f.behavior.create = async () => {
    assert.deepEqual(f.views.get('original-view/host').pendingCreation, { scope: f.created.at(-1), agentId: f.selected.at(-1) });
    throw new Error('Create reply lost');
  };
  await f.app.create();
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, { scope: { hostId: 'host', conversationId: 'id-1' }, agentId: 'default' });
  await f.app.create();
  assert.equal(f.created.length, 1);
  f.behavior.create = async () => {};
  await f.app.recoverCreation();
  assert.deepEqual(f.created, [f.created[0], f.created[0]]);
  assert.equal(f.app.getSnapshot().active.scope.conversationId, 'id-1');
  assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
});

test('pending creation keeps the host failure that explains why confirmation is needed', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); await f.app.start();
  f.behavior.create = async () => { throw new ServiceError('unavailable', 'Host is still applying this creation'); };
  assert.equal((await f.app.create()).kind, 'pending');
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.equal(f.app.getSnapshot().error, 'Host is still applying this creation');
});

for (const kind of ['inline', 'detached']) test(`confirmed creation clears its persisted reservation after pending placement settles ${kind}`, async t => {
  let separate = false, pending;
  const f = fixture({ placement: { async acquire(request, owner) {
    if (request.creation || !separate) return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
    pending = { kind: 'pending', scope: request.scope, reason: 'Waiting for assigned creation editor' }; return pending;
  } } });
  t.after(() => f.app.dispose()); f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start(); separate = true;
  const result = await f.app.create(); assert.equal(result, pending);
  assert.deepEqual(f.views.get('original-view/host').pendingCreation.scope, result.scope);
  assert.equal(f.app.settlePlacement(result, kind === 'inline' ? { kind, scope: result.scope } : { kind, scope: result.scope, label: 'confirmed-child' }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.views.get('original-view/host').pendingCreation, null);
  assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
  separate = false; await f.app.reconnect(); assert.deepEqual(f.app.getSnapshot().active.scope, scope);
  assert.equal((await f.app.create()).kind, 'inline'); assert.equal(f.created.length, 2);
});

test('successful placement cannot clear a creation that the host has not confirmed', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); await f.app.start();
  f.behavior.create = async () => { throw new ServiceError('unavailable', 'Creation has not been confirmed'); };
  const pending = await f.app.create();
  assert.equal(f.app.settlePlacement(pending, { kind: 'detached', scope: pending.scope, label: 'unconfirmed-child' }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.views.get('original-view/host').pendingCreation.scope, pending.scope);
});

test('accepted new-chat creation survives lookup failure and restart with its source draft', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.behavior.observation = async () => ({ kind: 'concluded', cause: 'cancelled' });
  f.behavior.continuation = async () => ({ predecessor: null, carried: null, closure: 'cancelled', successor: null });
  await f.app.start();
  const source = f.app.getSnapshot().active;
  await source.store.setDraft('Carry only this unsent source text');
  f.behavior.agentLookup = async selected => {
    if (selected.conversationId !== scope.conversationId) throw new Error('Created-agent lookup interrupted');
    return f.descriptor();
  };
  await f.app.conversationActions(source).startNewChat();
  const createdScope = f.created[0];
  assert.notDeepEqual(createdScope, scope);
  await f.app.dispose();
  const restored = fixture(); t.after(() => restored.app.dispose());
  for (const [key, value] of f.views) restored.views.set(key, structuredClone(value));
  for (const [key, value] of f.drafts) restored.drafts.set(key, structuredClone(value));
  await restored.app.start();
  await restored.app.recoverCreation();
  const active = restored.app.getSnapshot().active;
  assert.deepEqual(active.scope, createdScope, 'recovery opens the already accepted unrelated chat');
  assert.equal(active.store.getSnapshot().draft, 'Carry only this unsent source text');
  assert.equal(restored.drafts.get('original-view/host/conversation').draft, '');
  assert.deepEqual(restored.views.get('original-view/host'), { version: 2, route: createdScope, pendingCreation: null });
  assert.equal(f.created.length, 1, 'the first controller requested one creation');
  assert.deepEqual(restored.created, [createdScope], 'recovery repeats only the original idempotent create request');
  assert.deepEqual([...f.submitted, ...restored.submitted], []);
});

test('workspace pagination reaches every namespace page after later global pages arrive', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const entries = Array.from({ length: 350 }, (_, n) => ({ scope: { ...scope, conversationId: `w-${String(n).padStart(3, '0')}` }, preview: null,
    provider: { namespace: 'ledger', installationId: 'books', providerAgentId: 'desk' } }));
  const page = after => entries.slice(after === null ? 0 : entries.findIndex(entry => entry.scope.conversationId === after) + 1,
    (after === null ? 0 : entries.findIndex(entry => entry.scope.conversationId === after) + 1) + 100);
  const agent = { ...f.descriptor('provider-agent'), kind: 'provider', namespace: 'ledger', installationId: 'books', providerAgentId: 'desk' };
  f.behavior.agents = [agent]; f.behavior.defaultId = agent.id; f.behavior.agentLookup = async () => agent;
  f.behavior.catalogEntries = page;
  f.behavior.workspaceCatalog = page;
  await f.app.start(); await f.app.moreConversations();
  await f.app.loadWorkspace('ledger'); await f.app.moreConversations();
  await f.app.create();
  const created = { ...entries[0], scope: f.created[0] };
  await f.app.moreWorkspace('ledger'); await f.app.moreWorkspace('ledger'); await f.app.moreWorkspace('ledger');
  assert.deepEqual(f.app.getSnapshot().workspaces.ledger.entries, [created, ...entries], 'browsing both catalogs never skips or reorders namespace conversations and keeps the new chat first');
  assert.equal(f.app.getSnapshot().workspaces.ledger.hasMore, false);
});

test('a synchronous storage failure blocks actions captured before failure', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const actions = f.app.conversationActions(f.app.getSnapshot().active);
  let commands = 0;
  f.leases[0].failure(new Error('Storage unavailable'));
  assert.equal(applicationEnabled(f.app.getSnapshot()), false);
  await actions.submit(async () => { commands++; return { kind: 'rejected', reason: 'should not run' }; });
  await f.app.create();
  await f.app.reconnect();
  assert.equal(commands, 0);
  assert.equal(f.created.length, 0);
  assert.equal(f.metadataCalls(), 2);
  assert.equal(f.app.getSnapshot().storageFailure, '');
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  await actions.submit(async () => { commands++; return { kind: 'rejected', reason: 'old actions stay invalid after recovery' }; });
  assert.equal(commands, 0);
});

test('late writes from a replaced storage owner cannot poison the reopened view', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.views.set('restored-view/host', { ...empty(), route: scope });
  await f.app.start();
  const old = f.app.getSnapshot().active;
  const gate = deferred(), entered = deferred();
  f.behavior.write = async () => { entered.resolve(); await gate.promise; };
  const pending = old.store.setDraft('Old edit');
  const failed = assert.rejects(pending, /Old write failed/);
  await entered.promise;
  await f.app.reopenView('restored-view');
  gate.reject(new Error('Old write failed'));
  await failed;
  assert.equal(f.app.getSnapshot().storageFailure, '');
  assert.equal(f.app.getSnapshot().active.viewId, 'restored-view');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.leases[0].closed, true);
  f.behavior.write = async () => {};
  await f.app.getSnapshot().active.store.setDraft('New edit');
  assert.equal(f.drafts.get('restored-view/host/conversation').draft, 'New edit');
});

test('disposal closes admission and feeds immediately, and restart waits for the same drain promise', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const old = f.app.getSnapshot().active;
  const actions = f.app.conversationActions(old);
  const drain = deferred();
  let closes = 0, settled = false;
  f.behavior.close = () => { closes++; return drain.promise; };
  const closing = f.app.dispose();
  assert.equal(f.app.dispose(), closing);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1);
  assert.equal(f.leases[0].closed, true);
  assert.equal(old.store.getSnapshot().connection.kind, 'disconnected');
  assert.equal(f.feedCloses(), 1);
  void closing.then(() => { settled = true; });
  await assert.rejects(actions.commands.send('Closed session'), /application has closed/);
  await assert.rejects(f.app.search('closed', null, new AbortController().signal), /application has closed/);
  const restart = f.app.start();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(f.leases.length, 1);
  const interruptedRestart = f.app.dispose();
  assert.equal(f.app.dispose(), interruptedRestart);
  const finalRestart = f.app.start();
  await Promise.resolve();
  assert.equal(f.leases.length, 1);
  drain.resolve();
  await Promise.all([closing, restart, interruptedRestart, finalRestart]);
  assert.equal(settled, true);
  assert.equal(f.leases.length, 2);
  assert.equal(f.app.getSnapshot().active.viewId, 'original-view');
  assert.deepEqual(f.submitted, []);
});

test('reopening an owned view reuses its original store and exclusive storage lease', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const old = f.app.getSnapshot().active;
  f.behavior.reopen = async () => { throw new Error('Must reuse original lease'); };
  await f.app.reopenView('original-view');
  assert.equal(f.leases.length, 1);
  assert.equal(f.leases[0].closed, false);
  assert.equal(f.app.getSnapshot().active.store, old.store);
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
});

test('failed replacement acquisition leaves the selected owner and saved records usable', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const saved = { ...empty(), route: scope };
  f.views.set('original-view/host', saved);
  await f.app.start();
  const active = f.app.getSnapshot().active;
  f.behavior.reopen = async () => { throw new Error('Saved view is already open'); };
  await f.app.reopenView('other-view');
  assert.equal(f.app.getSnapshot().active, active);
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.match(f.app.getSnapshot().error, /already open/);
  assert.equal(f.leases[0].closed, false);
  assert.deepEqual(f.views.get('original-view/host'), saved);
  await active.store.setDraft('Still writable');
});

test('disposal during an existing same-view handover still awaits its admitted storage drain', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const drain = deferred(); let disposed = false;
  f.behavior.close = () => drain.promise;
  const reopening = f.app.reopenView('original-view');
  const closing = f.app.dispose(); void closing.then(() => { disposed = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(disposed, false);
  drain.resolve(); await Promise.all([reopening, closing]);
  assert.equal(disposed, true); assert.deepEqual(f.submitted, []);
});

test('busy actions are ignored and original commands and newer drafts survive reopening', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  let active = f.app.getSnapshot().active;
  await active.store.setDraft('Original message');
  const gate = deferred(), entered = deferred();
  f.behavior.submit = async command => {
    assert.equal(f.drafts.get('original-view/host/conversation').outbox[0].command.clientCommandId, command.clientCommandId);
    entered.resolve(); await gate.promise;
  };
  const actions = f.app.conversationActions(active);
  const sending = actions.submit(() => active.store.send());
  await entered.promise;
  await actions.submit(() => active.store.send());
  await active.store.setDraft('Newer draft');
  gate.reject(new Error('Reply lost'));
  await sending;
  assert.equal(f.submitted.length, 1);
  const original = f.submitted[0];
  f.app.dispose();
  await f.app.start();
  active = f.app.getSnapshot().active;
  assert.equal(active.viewId, 'original-view');
  assert.equal(active.store.getSnapshot().draft, 'Newer draft');
  assert.deepEqual(active.store.getSnapshot().outbox[0].command, original);
  f.behavior.submit = async () => ({ kind: 'rejected', reason: 'Still unknown' });
  await f.app.conversationActions(active).submit(() => active.store.retry(original.clientCommandId));
  assert.deepEqual(f.submitted[1], original);
  assert.equal(active.store.getSnapshot().outbox.length, 1);
  assert.match(f.app.getSnapshot().error, /Still unknown/);
});

test('listing corrupt foreign views remains nonfatal and pagination reads the current cursor', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.listing = async () => ({ ids: ['good-view'], unreadable: 1, after: null });
  await f.app.start();
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  assert.match(f.app.getSnapshot().savedViewNotice, /1 saved views/);
  await f.app.moreConversations();
  await f.app.moreConversations();
  assert.deepEqual(f.cursors, [null, 'c-99']);
  assert.equal(f.app.getSnapshot().catalog.items.length, 100);
  f.behavior.listing = async () => { throw new Error('Unreadable listing'); };
  await f.app.reconnect();
  assert.equal(f.app.getSnapshot().storageFailure, '');
  assert.match(f.app.getSnapshot().savedViewNotice, /could not be listed/);
});

test('own corrupt view blocks commands; a new host clears the old active conversation', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const old = f.app.getSnapshot().active;
  f.host('replacement-host');
  await f.app.reconnect();
  assert.equal(f.app.getSnapshot().active, null);
  assert.equal(old.store.getSnapshot().connection.kind, 'disconnected');
  f.behavior.read = async () => { throw new Error('Own saved view corrupt'); };
  await f.app.reconnect();
  assert.match(f.app.getSnapshot().storageFailure, /Own saved view corrupt/);
  await f.app.create();
  assert.equal(f.created.length, 0);
});

test('a disposed startup releases its late storage lease', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const gate = deferred();
  f.behavior.acquire = () => gate.promise;
  const firstStart = f.app.start();
  f.app.dispose();
  f.behavior.acquire = async () => {};
  await f.app.start();
  gate.resolve();
  await firstStart;
  assert.equal(f.leases[0].closed, false);
  assert.equal(f.leases[1].closed, true);
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
});

test('failed reopening refuses view mutations and reconnect preserves creation recovery', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const original = { ...empty(), route: scope };
  const restored = { ...empty(), pendingCreation: { scope: { hostId: 'host', conversationId: 'pending-restored' }, agentId: 'default' } };
  f.views.set('original-view/host', original);
  f.views.set('restored-view/host', restored);
  f.behavior.listing = async () => ({ ids: ['restored-view'], unreadable: 1, after: 'next-page' });
  await f.app.start();
  f.behavior.metadata = async () => { throw new Error('Metadata temporarily unavailable'); };
  await f.app.reopenView('restored-view');
  assert.match(f.app.getSnapshot().error, /Metadata temporarily unavailable/);
  assert.equal(applicationEnabled(f.app.getSnapshot()), false);
  assert.deepEqual(f.app.getSnapshot().saved, empty());
  assert.deepEqual(f.app.getSnapshot().catalog, { items: [], after: null });
  assert.deepEqual(f.app.getSnapshot().savedViews, { items: [], after: null });
  assert.equal(f.app.getSnapshot().savedViewNotice, '');
  assert.equal(f.app.getSnapshot().active, null);
  for (const action of [() => f.app.open(scope), () => f.app.create(), () => f.app.recoverCreation()]) {
    await action();
    assert.notEqual(f.app.getSnapshot().error, '');
    assert.deepEqual(f.views.get('restored-view/host'), restored);
    assert.deepEqual(f.views.get('original-view/host'), original);
    assert.equal(f.created.length, 0);
  }
  f.behavior.metadata = async () => {};
  await f.app.reconnect();
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  assert.deepEqual(f.app.getSnapshot().saved, restored);
  await f.app.recoverCreation();
  assert.deepEqual(f.created, [restored.pendingCreation.scope]);
  assert.equal(f.app.getSnapshot().active.viewId, 'restored-view');
  assert.deepEqual(f.app.getSnapshot().active.scope, restored.pendingCreation.scope);
  assert.equal(f.views.get('restored-view/host').pendingCreation, null);
});

test('a host change without an active conversation replaces the loaded recovery record', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const original = { ...empty(), pendingCreation: { scope, agentId: 'default' } };
  f.views.set('original-view/host', original);
  f.behavior.listing = async () => ({ ids: ['old-host-view'], unreadable: 1, after: 'old-page' });
  await f.app.start();
  assert.equal(f.app.getSnapshot().active, null);
  f.host('replacement-host');
  const entered = deferred(), loading = deferred();
  f.behavior.read = async () => { entered.resolve(); await loading.promise; };
  const reconnecting = f.app.reconnect();
  await entered.promise;
  try {
    assert.equal(applicationEnabled(f.app.getSnapshot()), false);
    assert.deepEqual(f.app.getSnapshot().saved, empty());
    assert.deepEqual(f.app.getSnapshot().savedViews, { items: [], after: null });
    assert.equal(f.app.getSnapshot().savedViewNotice, '');
  } finally { loading.resolve(); await reconnecting; }
  await f.app.recoverCreation();
  assert.equal(f.created.length, 0);
  await f.app.create();
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].hostId, 'replacement-host');
  assert.deepEqual(f.views.get('original-view/host'), original);
});

test('a storage acquisition failure stops the loading status and blocks commands', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.acquire = async () => { throw new Error('Storage cannot be owned'); };
  await f.app.start();
  assert.equal(f.app.getSnapshot().host.kind, 'unavailable');
  assert.equal(applicationEnabled(f.app.getSnapshot()), false);
  assert.match(f.app.getSnapshot().storageFailure, /Storage cannot be owned/);
});

test('a startup catalog failure keeps the ready host enabled and reconnect clears the error', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.catalog = async () => { throw new Error('Catalog temporarily unavailable'); };
  await f.app.start();
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  assert.match(f.app.getSnapshot().error, /Catalog temporarily unavailable/);
  f.behavior.catalog = async () => {};
  await f.app.reconnect();
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  assert.equal(f.app.getSnapshot().error, '');
  assert.equal(f.app.getSnapshot().catalog.items.length, 100);
});

for (const entry of ['start', 'reconnect', 'reopenView']) {
  test(`a saved-view read failure during ${entry} ends loading and blocks commands`, async t => {
    const f = fixture(); t.after(() => f.app.dispose());
    if (entry !== 'start') await f.app.start();
    f.behavior.read = async () => { throw new Error('Saved view cannot be read'); };
    await f.app[entry]('restored-view');
    assert.equal(f.app.getSnapshot().host.kind, 'unavailable');
    assert.equal(applicationEnabled(f.app.getSnapshot()), false);
    assert.match(f.app.getSnapshot().storageFailure, /Saved view cannot be read/);
    await f.app.create();
    assert.equal(f.created.length, 0);
  });
}

test('a late saved-view read failure cannot change a replacement session', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  await f.app.start();
  const entered = deferred(), reading = deferred();
  f.behavior.read = async () => { entered.resolve(); await reading.promise; };
  const refreshing = f.app.reconnect();
  await entered.promise;
  f.app.dispose();
  f.behavior.read = async () => {};
  await f.app.start();
  const replacement = f.app.getSnapshot();
  reading.reject(new Error('Old saved view cannot be read'));
  await refreshing;
  assert.strictEqual(f.app.getSnapshot(), replacement);
  assert.equal(applicationEnabled(replacement), true);
  assert.equal(replacement.storageFailure, '');
  assert.equal(replacement.error, '');
});

test('confirmed creation preserves expanded catalog pages and later paging does not duplicate it', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const pages = Array.from({ length: 210 }, (_, index) => ({ hostId: 'host', conversationId: `c-${String(index).padStart(3, '0')}` }));
  f.behavior.catalog = async after => after === null ? pages.slice(0, 100)
    : after === 'c-099' ? pages.slice(100, 200) : [...pages.slice(200), f.created[0]];
  await f.app.start();
  await f.app.moreConversations();
  assert.equal(f.app.getSnapshot().catalog.items.length, 200);
  const cursor = f.app.getSnapshot().catalog.after;
  await f.app.create();
  assert.equal(f.app.getSnapshot().catalog.items.length, 201);
  assert.equal(f.app.getSnapshot().catalog.items[0].scope.conversationId, f.created[0].conversationId);
  assert.equal(f.app.getSnapshot().catalog.after, cursor);
  assert.deepEqual(f.cursors, [null, 'c-099']);
  await f.app.moreConversations();
  assert.equal(f.app.getSnapshot().catalog.items.length, 211);
  assert.equal(f.app.getSnapshot().catalog.items.filter(entry => entry.scope.conversationId === f.created[0].conversationId).length, 1);
  assert.equal(f.app.getSnapshot().catalog.after, null);
});


test('an initial metadata failure ends loading without enabling commands', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.metadata = async () => { throw new Error('Host cannot be reached'); };
  await f.app.start();
  assert.equal(f.app.getSnapshot().host.kind, 'unavailable');
  assert.equal(f.app.getSnapshot().error, 'Host cannot be reached');
  assert.equal(applicationEnabled(f.app.getSnapshot()), false);
  assert.equal(f.app.getSnapshot().busy, false);
});

test('a native rejected receipt is explained to the user without repeating the request', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.behavior.submit = async command => ({ kind: 'receipt', receipt: { scope,
    clientCommandId: command.clientCommandId, hostOperationId: 'native-refusal', sequence: 1,
    state: { kind: 'rejected', reason: 'Codex requires login before this request can start.' } } });
  await f.app.start();
  const target = f.app.getSnapshot().active;
  await target.store.setDraft('My first message');
  await f.app.conversationActions(target).submit(() => target.store.send());
  assert.match(f.app.getSnapshot().error, /Codex requires login/);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.app.getSnapshot().busy, false);
});

async function openCommands(t, runtime = RECORDED_RUNTIME) {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.runtime = runtime;
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  await deliver(f);
  const target = f.app.getSnapshot().active;
  return { ...f, target, actions: f.app.conversationActions(target) };
}
async function deliver(f, domain = { messages: [], currentRun: null }) {
  const feed = f.feeds.at(-1);
  await feed.receive({ kind: 'snapshot', snapshot: { scope: feed.scope, projectionVersion: 4,
    cursor: (f.app.getSnapshot().active.store.getSnapshot().cursor ?? -1) + 1,
    document: { domain, decisions: {}, receipts: {} } } });
  assert.equal(f.app.getSnapshot().active.store.getSnapshot().connection.kind, 'connected');
}
function resultFor(command, state) {
  return { kind: 'receipt', receipt: { scope: command.scope, clientCommandId: command.clientCommandId,
    hostOperationId: 'operation', sequence: 1, state } };
}

for (const outcome of ['admission-rejected', 'rejected', 'uncertain', 'accepted', 'completed', 'pending', 'not-dispatched']) {
  test(`SDK commands return actual ${outcome} outcome and retain the composer draft`, async t => {
    const f = await openCommands(t);
    await f.target.store.setDraft('review prompt');
    let expected;
    f.behavior.submit = async command => {
      expected = outcome === 'admission-rejected' ? { kind: 'rejected', reason: 'Admission refused' }
        : resultFor(command, ['rejected', 'uncertain', 'not-dispatched'].includes(outcome) ? { kind: outcome, reason: 'Host reason' } : { kind: outcome });
      return expected;
    };
    assert.deepEqual(await f.actions.commands.send('review prompt'), expected);
    assert.deepEqual(f.submitted[0].body, { kind: 'send', text: 'review prompt' });
    assert.equal(f.target.store.getSnapshot().draft, 'review prompt');
    assert.equal(f.app.getSnapshot().error, outcome === 'admission-rejected' ? 'Admission refused' : outcome === 'rejected' ? 'Host reason' : '');
    assert.equal(f.app.getSnapshot().busy, false);
  });
}

test('a lost native connection during a command disables the app until an explicit reconnect', async t => {
  const f = await openCommands(t);
  const failure = new ServiceConnectionLost('A different OpenPane host is answering on this Mac. Reconnect to switch to it.');
  f.behavior.submit = async () => { f.connectionLost(failure); throw failure; };
  await assert.rejects(f.actions.commands.send('prompt'), error => error === failure);
  const snapshot = f.app.getSnapshot();
  assert.equal(snapshot.host.kind, 'unavailable');
  assert.match(snapshot.error, /different OpenPane host/);
  assert.equal(applicationEnabled(snapshot), false);
  assert.equal(f.target.store.getSnapshot().connection.kind, 'disconnected');
  assert.equal(f.target.store.getSnapshot().outbox.length, 1);
  f.connectionLost(new ServiceConnectionLost('The local host connection changed. Reconnect before continuing.'));
  assert.match(f.app.getSnapshot().error, /different OpenPane host/);
  await f.app.reconnect();
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
});

test('a connection loss seen by a background request that ignores its own errors still disables the app', async t => {
  const f = await openCommands(t);
  f.connectionLost(new ServiceConnectionLost('The local host connection changed. Reconnect before continuing.'));
  assert.equal(f.app.getSnapshot().host.kind, 'unavailable');
  assert.match(f.app.getSnapshot().error, /host connection changed/);
  assert.equal(applicationEnabled(f.app.getSnapshot()), false);
  assert.equal(f.target.store.getSnapshot().connection.kind, 'disconnected');
  await f.app.reconnect();
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
});

test('SDK rejects transport failures while the UI submission stays caught', async t => {
  for (const sdk of [true, false]) {
    const f = await openCommands(t);
    const failure = new Error('Transport lost');
    f.behavior.submit = async () => { throw failure; };
    if (sdk) await assert.rejects(f.actions.commands.send('prompt'), error => error === failure);
    else { await f.target.store.setDraft('prompt'); await f.actions.submit(() => f.target.store.send()); }
    assert.match(f.app.getSnapshot().error, /Transport lost/);
    assert.equal(f.app.getSnapshot().busy, false);
    assert.equal(f.submitted.length, 1);
    assert.equal(f.target.store.getSnapshot().outbox.length, 1);
    assert.equal(f.app.getSnapshot().host.kind, 'ready');
  }
});

test('a closed conversation refusal is shown as a sentence while SDK commands keep the reason', async t => {
  const f = await openCommands(t);
  f.behavior.submit = async () => ({ kind: 'rejected', reason: 'conversation-closed' });
  assert.deepEqual(await f.actions.commands.send('after closure'), { kind: 'rejected', reason: 'conversation-closed' });
  assert.equal(f.app.getSnapshot().error, 'This conversation ended. Start a new chat to keep going.');
});

test('a send refused behind an unconfirmed earlier send names the recovery actions while SDK commands keep the reason', async t => {
  const f = await openCommands(t);
  f.behavior.submit = async () => ({ kind: 'rejected', reason: 'send-awaiting-confirmation' });
  assert.deepEqual(await f.actions.commands.send('behind an unconfirmed send'), { kind: 'rejected', reason: 'send-awaiting-confirmation' });
  assert.equal(f.app.getSnapshot().error, 'An earlier message has not been confirmed yet, so this one was not sent. Your draft is kept. '
    + 'Use Reconcile command under Command recovery, or Check pending command under Pending commands, to check it. '
    + 'If it stays unconfirmed, use Stop waiting beside that button to send new messages here; '
    + 'the earlier message may or may not have run.');
  const abandoned = [], receipt = state => ({ scope: f.target.scope, clientCommandId: 'earlier-send', hostOperationId: 'operation', sequence: 2, state });
  f.behavior.abandon = async (selected, id) => { abandoned.push([selected, id]); return receipt({ kind: 'abandoned' }); };
  await f.actions.abandon('earlier-send');
  assert.equal(f.app.getSnapshot().error, '');
  for (const result of [null, receipt({ kind: 'completed' }), receipt({ kind: 'pending' })]) {
    f.behavior.abandon = async (selected, id) => { abandoned.push([selected, id]); return result; };
    await f.actions.abandon('earlier-send');
    assert.equal(f.app.getSnapshot().error, 'Nothing to stop waiting on: this command is not holding up new messages.');
  }
  assert.deepEqual(abandoned, Array(4).fill([f.target.scope, 'earlier-send']));
});


test('SDK busy refusal does not persist another command or release the running operation', async t => {
  const f = await openCommands(t), entered = deferred(), reply = deferred();
  f.behavior.submit = async command => { entered.resolve(); await reply.promise; return resultFor(command, { kind: 'accepted' }); };
  const sending = f.actions.commands.send('first');
  await entered.promise;
  await assert.rejects(f.actions.commands.send('second'), /operation is in progress/);
  assert.equal(f.app.getSnapshot().busy, true);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.target.store.getSnapshot().outbox.length, 1);
  reply.resolve(); await sending;
  assert.equal(f.app.getSnapshot().busy, false);
});

for (const replacement of ['conversation', 'view', 'session']) {
  test(`SDK captured commands refuse a replacement ${replacement} before storage or dispatch`, async t => {
    const f = await openCommands(t);
    if (replacement === 'conversation') await f.app.open({ ...scope, conversationId: 'other' });
    if (replacement === 'view') { f.views.set('restored-view/host', { ...empty(), route: scope }); await f.app.reopenView('restored-view'); }
    if (replacement === 'session') { f.app.dispose(); await f.app.start(); }
    const replacementState = f.app.getSnapshot();
    const records = structuredClone([...f.drafts]);
    for (const invoke of [() => f.actions.commands.send('old'), () => f.actions.commands.approve('decision', 'accept'), () => f.actions.commands.cancel('run')]) {
      await assert.rejects(invoke());
      assert.strictEqual(f.app.getSnapshot(), replacementState);
    }
    assert.deepEqual([...f.drafts], records);
    assert.equal(f.submitted.length, 0);
    assert.equal(f.target.store.getSnapshot().outbox.length, 0);
  });
}

for (const blocked of ['disconnected', 'feed-ended', 'storage', 'incompatible']) {
  test(`SDK ${blocked} refusal persists and sends nothing`, async t => {
    const f = await openCommands(t);
    if (blocked === 'disconnected') f.target.store.disconnect();
    if (blocked === 'feed-ended') { f.feeds.at(-1).finish({ kind: 'failed', reason: 'Lost feed' }); await Promise.resolve(); }
    if (blocked === 'storage') f.leases[0].failure(new Error('Storage unavailable'));
    if (blocked === 'incompatible') { f.behavior.runtime = { engine: 'unknown', version: '1', format: 'unknown' }; await f.app.reconnect(); }
    const records = structuredClone([...f.drafts]);
    for (const invoke of [() => f.actions.commands.send('blocked'), () => f.actions.commands.approve('decision', 'accept'), () => f.actions.commands.cancel('run')]) {
      await assert.rejects(invoke());
    }
    assert.deepEqual([...f.drafts], records);
    assert.equal(f.submitted.length, 0);
    assert.equal(f.app.getSnapshot().busy, false);
  });
}

for (const runtime of [CODEX_RUNTIME, CODEX_SDK_RUNTIME, CLAUDE_SDK_RUNTIMES.sonnet, PI_RUNTIME]) {
  for (const state of ['running', 'stopping', 'incomplete']) {
    test(`SDK ${runtime.engine} ${state} response blocks send while approval and cancel stay usable`, async t => {
      const f = await openCommands(t, runtime);
      const currentRun = state === 'incomplete' ? null : state === 'running' ? { kind: 'running', runId: 'run' }
        : { kind: 'stopping', runId: 'run', clientCommandId: 'cancel-id' };
      await deliver(f, { currentRun, messages: state === 'incomplete' ? [{ messageId: 'partial', revision: 1, role: 'assistant', text: 'partial', complete: false }] : [] });
      f.behavior.submit = async command => resultFor(command, { kind: 'accepted' });
      await assert.rejects(f.actions.commands.send('wait'), /current response/);
      assert.equal(f.drafts.size, 0);
      await f.actions.commands.approve('pending', 'accept');
      await f.actions.commands.cancel('run');
      assert.deepEqual(f.submitted.map(command => command.body), [
        { kind: 'approve', pendingId: 'pending', choiceId: 'accept' }, { kind: 'cancel', runId: 'run' },
      ]);
      await deliver(f, { currentRun: { kind: 'ended', runId: 'run', outcome: 'completed' }, messages: [] });
      await f.actions.commands.send('next');
      assert.deepEqual(f.submitted.at(-1).body, { kind: 'send', text: 'next' });
    });
  }
}

test('UI recovery can retry a retained command while disconnected', async t => {
  const f = await openCommands(t);
  await assert.rejects(f.actions.commands.send('retained'), /Reply lost/);
  const [entry] = f.target.store.getSnapshot().outbox;
  f.target.store.disconnect();
  f.behavior.submit = async command => resultFor(command, { kind: 'accepted' });
  await f.actions.submit(() => f.target.store.retry(entry.command.clientCommandId));
  assert.deepEqual(f.submitted, [entry.command, entry.command]);
  assert.deepEqual(f.target.store.getSnapshot().outbox, []);
});

test('SDK send refuses missing and non-string text without submitting the composer draft', async t => {
  const f = await openCommands(t);
  await f.target.store.setDraft('Private unfinished draft');
  const records = structuredClone([...f.drafts]);
  await assert.rejects(f.actions.commands.send(), /explicit message/);
  for (const text of [undefined, null, 42, {}, '']) await assert.rejects(f.actions.commands.send(text));
  assert.deepEqual([...f.drafts], records);
  assert.equal(f.target.store.getSnapshot().draft, 'Private unfinished draft');
  assert.deepEqual(f.target.store.getSnapshot().outbox, []);
  assert.equal(f.submitted.length, 0);
});

test('lost selected creation survives reload and changed default without choosing a new agent', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  await f.app.start();
  f.behavior.create = async () => { throw new Error('Create reply lost'); };
  await f.app.create('other');
  const pending = f.app.getSnapshot().saved.pendingCreation;
  assert.equal(pending.agentId, 'other');
  f.app.dispose();
  f.behavior.defaultId = 'new-default';
  f.behavior.create = async () => {};
  await f.app.start();
  await f.app.recoverCreation();
  assert.deepEqual(f.selected, ['other', 'other']);
  assert.deepEqual(f.created, [pending.scope, pending.scope]);
  assert.equal(f.app.getSnapshot().active.agent.id, 'other');
});

test('legacy pending creation queries the saved scope and never silently selects the default', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), pendingCreation: { scope, agentId: null } });
  let lookedUp;
  f.behavior.agentLookup = async value => { lookedUp = value; return null; };
  await f.app.start();
  await f.app.recoverCreation();
  assert.deepEqual(lookedUp, scope);
  assert.equal(f.created.length, 0);
  assert.equal(f.app.getSnapshot().saved.pendingCreation.agentId, null);
  assert.match(f.app.getSnapshot().error, /Choose an agent explicitly/);
  f.behavior.agentLookup = async () => f.descriptor('original-agent', CODEX_RUNTIME);
  await f.app.recoverCreation();
  assert.deepEqual(f.selected, ['original-agent']);
  assert.equal(f.app.getSnapshot().active.agent.id, 'original-agent');
});

test('legacy absent creation accepts only an explicit selection and persists it before request', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), pendingCreation: { scope, agentId: null } });
  f.behavior.agentLookup = async () => null;
  f.behavior.create = async () => {
    assert.deepEqual(f.views.get('original-view/host').pendingCreation, { scope, agentId: 'other' });
    throw new Error('Reply lost again');
  };
  await f.app.start();
  await f.app.recoverCreation('other');
  assert.deepEqual(f.selected, ['other']);
  f.behavior.defaultId = 'replacement';
  await f.app.recoverCreation();
  assert.deepEqual(f.selected, ['other', 'other']);
});

test('absent pending creation never replaces its saved agent with an explicit choice', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const pending = { scope, agentId: 'default' };
  f.views.set('original-view/host', { ...empty(), pendingCreation: pending });
  f.behavior.agentLookup = async value => f.captured.get(value.conversationId) ?? null;
  await f.app.start();
  f.behavior.defaultId = 'replacement';
  f.behavior.create = async () => {
    if (f.selected.at(-1) === 'default') {
      f.captured.delete(scope.conversationId);
      throw new ServiceError('invalid', 'Choose a configured agent.');
    }
    assert.fail('Recovery must not create with a replacement agent');
  };
  await f.app.recoverCreation();
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, pending);
  assert.equal(f.app.getSnapshot().active, null);
  await f.app.recoverCreation('replacement');
  assert.deepEqual(f.selected, ['default']);
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, pending);
  assert.equal(f.app.getSnapshot().active, null);
  assert.match(f.app.getSnapshot().error, /saved agent/);
  await f.app.recoverCreation();
  assert.deepEqual(f.selected, ['default', 'default']);
  assert.deepEqual(f.created, [scope, scope]);
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, pending);
});

test('invalid or unavailable recovery choices preserve legacy pending intents', async t => {
  for (const agentId of [null]) {
    const f = fixture(); t.after(() => f.app.dispose());
    const pending = { scope, agentId };
    f.views.set('original-view/host', { ...empty(), pendingCreation: pending });
    f.behavior.agentLookup = async value => f.captured.get(value.conversationId) ?? null;
    await f.app.start();
    f.behavior.agents = [f.descriptor('other'), { ...f.descriptor(), availability: { kind: 'unavailable', reason: 'Agent offline' } }];
    f.behavior.create = async () => {
      if (f.selected.at(-1) !== 'other') {
        f.captured.delete(scope.conversationId);
        throw new ServiceError('unavailable', 'Choose an available agent.');
      }
    };
    for (const selected of ['unknown', 'default']) {
      await f.app.recoverCreation(selected);
      assert.deepEqual(f.views.get('original-view/host').pendingCreation, pending);
      assert.deepEqual(f.created, []);
      assert.match(f.app.getSnapshot().error, /available agent/);
    }
    await f.app.recoverCreation('other');
    assert.equal(f.app.getSnapshot().active.agent.id, 'other');
    assert.deepEqual(f.created, [scope]);
  }
});

test('a different host scope owner cannot replace a saved provider creation or its route and draft', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const pending = { scope: { ...scope, conversationId: 'pending-provider' }, agentId: 'original-provider' };
  const saved = { ...empty(), route: scope, pendingCreation: pending };
  f.views.set('original-view/host', saved);
  f.behavior.agentLookup = async () => f.descriptor('native-agent');
  await f.app.start();
  const active = f.app.getSnapshot().active;
  await active.store.setDraft('Keep my draft');
  for (const selected of [undefined, 'other']) {
    await f.app.recoverCreation(selected);
    assert.deepEqual(f.selected, []);
    assert.deepEqual(f.created, []);
    assert.deepEqual(f.app.getSnapshot().saved, saved);
    assert.deepEqual(f.views.get('original-view/host'), saved);
    assert.equal(f.app.getSnapshot().active, active);
    assert.equal(f.drafts.get('original-view/host/conversation').draft, 'Keep my draft');
    assert.match(f.app.getSnapshot().error, /different agent/);
  }
});

test('active descriptors override default controls and unavailable history stays readable', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.behavior.runtime = { engine: 'unsupported-default', version: '99', format: 'unknown' };
  f.behavior.agentLookup = async () => ({ ...f.descriptor('sdk', CODEX_SDK_RUNTIME), commands: ['send', 'cancel'] });
  await f.app.start(); await deliver(f);
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  let target = f.app.getSnapshot().active;
  assert.deepEqual(target.agent.runtime, CODEX_SDK_RUNTIME);
  await assert.rejects(f.app.conversationActions(target).commands.approve('decision', 'yes'), /does not support/);
  f.behavior.agentLookup = async () => ({ ...f.descriptor('sdk', CODEX_SDK_RUNTIME), availability: { kind: 'unavailable', reason: 'Agent removed' } });
  await f.app.reconnect(); await deliver(f, { messages: [{ messageId: 'saved', revision: 1, role: 'assistant', text: 'Saved response', complete: true }], currentRun: null });
  target = f.app.getSnapshot().active;
  assert.equal(target.store.getSnapshot().document.domain.messages[0].text, 'Saved response');
  await assert.rejects(f.app.conversationActions(target).commands.send('hello'), /Agent removed/);
  let effects = 0;
  await f.app.conversationActions(target).submit(async () => { effects++; });
  await f.app.conversationActions(target).reconcile('old-command');
  assert.equal(effects, 0);
  assert.equal(f.submitted.length, 0);
});

test('definitive creation refusal releases only its current pending scope and preserves the previous route and draft', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  await f.app.getSnapshot().active.store.setDraft('Keep this original draft');
  f.behavior.create = async () => { throw new ServiceError('create-rejected', 'Provider refused creation'); };
  await f.app.create('other');
  assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
  assert.deepEqual(f.app.getSnapshot().saved.route, scope);
  assert.equal(f.drafts.get('original-view/host/conversation').draft, 'Keep this original draft');
  await f.app.create('other');
  assert.equal(f.created.length, 2);
  const pending = deferred();
  f.behavior.create = () => pending.promise;
  const creating = f.app.create('other');
  await new Promise(resolve => setImmediate(resolve));
  const originalPending = f.views.get('original-view/host').pendingCreation;
  await f.app.dispose();
  await f.app.start();
  pending.reject(new ServiceError('create-rejected', 'Late refusal'));
  await creating;
  assert.deepEqual(f.views.get('original-view/host').pendingCreation, originalPending);
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, originalPending);
});

test('legacy pending recovery keeps host-recorded provider identity despite a different selected agent', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: null, pendingCreation: { scope, agentId: null } });
  const original = { id: 'original-provider', kind: 'provider', label: 'Provider', namespace: 'example', protocolVersion: '1', commands: [], availability: { kind: 'ready' } };
  f.behavior.agentLookup = async () => original;
  f.behavior.create = async () => { throw new ServiceError('unavailable', 'Original creation is unknown'); };
  await f.app.start();
  await f.app.recoverCreation('other');
  assert.deepEqual(f.selected, ['original-provider']);
  assert.equal(f.app.getSnapshot().saved.pendingCreation.agentId, 'original-provider');
  await f.app.recoverCreation();
  assert.deepEqual(f.selected, ['original-provider', 'original-provider']);
});

test('observation reads are serial, preserve active identity, and native not-applicable ends polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  const gate = deferred(), calls = [];
  f.behavior.observation = input => { calls.push(input); return gate.promise; };
  await f.app.start(); const active = f.app.getSnapshot().active;
  t.mock.timers.tick(10_000); assert.equal(calls.length, 1);
  gate.resolve({ kind: 'observing' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.getSnapshot().active, active);
  assert.deepEqual(f.app.getSnapshot().observation, { status: { kind: 'observing' }, retrying: false });
  f.behavior.observation = async input => { calls.push(input); return { kind: 'not-applicable' }; };
  t.mock.timers.tick(2000); await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10_000); assert.equal(calls.length, 2);
});

test('observation retry stays local, joins duplicate clicks, and ignores late selection and disposed results', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  const retry = deferred(), calls = [];
  f.behavior.observation = input => {
    calls.push(input);
    return input.action === 'retry' ? retry.promise : Promise.resolve(input.scope.conversationId === scope.conversationId
      ? { kind: 'stopped', reason: 'provider-disconnected' } : { kind: 'not-applicable' });
  };
  await f.app.start(); const active = f.app.getSnapshot().active;
  await active.store.setDraft('Retain draft');
  const actions = f.app.conversationActions(active), first = actions.retryObservation(), second = actions.retryObservation();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(applicationEnabled(f.app.getSnapshot()), true); assert.equal(f.app.getSnapshot().observation.retrying, true);
  assert.equal(calls.filter(value => value.action === 'retry').length, 1);
  await f.app.open({ ...scope, conversationId: 'other' });
  retry.resolve({ kind: 'observing' }); await Promise.all([first, second]);
  assert.equal(f.app.getSnapshot().active.scope.conversationId, 'other');
  assert.equal(f.app.getSnapshot().observation.status.kind, 'not-applicable');
  assert.equal(f.drafts.get('original-view/host/conversation').draft, 'Retain draft');
  assert.deepEqual(f.submitted, []);
  const read = deferred(); f.behavior.observation = () => read.promise;
  await f.app.open(scope); await f.app.dispose(); const disposed = f.app.getSnapshot();
  read.resolve({ kind: 'stopped', reason: 'cleanup-failed' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.getSnapshot(), disposed);
});

test('observation failures are local unknown status and keep the host connected', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.behavior.observation = async () => { throw new Error('SECRET_STATUS_TRANSPORT'); };
  await f.app.start(); const active = f.app.getSnapshot().active;
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.deepEqual(f.app.getSnapshot().observation, { status: { kind: 'unknown' }, retrying: false });
  assert.equal(f.app.getSnapshot().error, ''); assert.equal(f.app.getSnapshot().active, active);
  f.behavior.observation = async () => { throw new ServiceError('unavailable', 'Host offline'); };
  t.mock.timers.tick(2000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.deepEqual(f.app.getSnapshot().observation, { status: { kind: 'unknown' }, retrying: false });
  assert.equal(f.app.getSnapshot().error, '');
});

test('empty provider hosts reject create before saving and retain original pending creation recovery', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.agents = []; f.behavior.runtime = null; f.behavior.defaultId = null;
  await f.app.start();
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  const before = structuredClone(f.app.getSnapshot().saved);
  await f.app.create();
  assert.match(f.app.getSnapshot().error, /No agent is available/);
  assert.deepEqual(f.app.getSnapshot().saved, before);
  assert.equal(f.created.length, 0);
  const original = { scope, agentId: 'original-provider' };
  f.views.set('original-view/host', { ...empty(), pendingCreation: original });
  f.behavior.agentLookup = async () => ({ id: 'original-provider', kind: 'provider', label: 'Original',
    namespace: 'original', protocolVersion: '1', commands: [], availability: { kind: 'unavailable', reason: 'Removed' } });
  f.behavior.create = async () => { throw new ServiceError('unavailable', 'Original provider unavailable'); };
  await f.app.reconnect();
  await f.app.recoverCreation('replacement-provider');
  assert.equal(f.created.length, 0);
  await f.app.recoverCreation();
  assert.deepEqual(f.selected, ['original-provider']);
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, original);
  assert.match(f.app.getSnapshot().error, /Original provider unavailable/);
});

test('module permission reads reject stale conversation results and revoke retains exact confirmed scope', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const active = f.app.getSnapshot().active, actions = f.app.conversationActions(active), read = deferred();
  f.behavior.permissions = value => { assert.deepEqual(value, scope); return read.promise; };
  const pending = actions.permissions.read();
  await f.app.open({ ...scope, conversationId: 'other' });
  read.resolve({ kind: 'available', observedAt: new Date().toISOString(), permissions: [] });
  await assert.rejects(pending, /conversation/);
  await assert.rejects(actions.commands.revokePermission('permission', 'agent'), /conversation/);
  assert.deepEqual(f.submitted, []);
  f.behavior.permissions = async () => ({ kind: 'available', observedAt: new Date().toISOString(),
    permissions: [{ permissionId: 'permission', scope: 'agent', actionLabel: 'Work items', detail: 'All conversations' }] });
  await f.app.open(scope);
  const current = f.app.getSnapshot().active;
  await f.app.conversationActions(current).permissions.read();
  await current.store.setDraft('Keep my draft');
  await assert.rejects(f.app.conversationActions(current).commands.revokePermission('permission', 'agent'), /Reply lost/);
  assert.deepEqual(f.submitted[0].body, { kind: 'revoke-permission', permissionId: 'permission', scope: 'agent' });
  assert.deepEqual(current.store.getSnapshot().outbox[0].command, f.submitted[0]);
  assert.equal(current.store.getSnapshot().draft, 'Keep my draft');
});

test('permission freshness follows opening, failed commands, reconnect and newer reads', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  const listing = { kind: 'available', observedAt: '2026-11-16T01:00:00Z',
    permissions: [{ permissionId: 'grant', scope: 'conversation', actionLabel: 'Work items', detail: 'This conversation' }] };
  let reads = 0;
  f.behavior.permissions = async () => { reads++; return listing; };
  await f.app.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.getSnapshot().permissionState.kind, 'fresh');
  assert(reads > 0);
  let actions = f.app.conversationActions(f.app.getSnapshot().active);
  const old = deferred();
  f.behavior.permissions = () => old.promise;
  const pending = actions.permissions.read();
  assert.equal(f.app.getSnapshot().permissionState.kind, 'loading');
  await assert.rejects(actions.commands.revokePermission('grant', 'conversation'), /Refresh permissions/);
  f.behavior.permissions = async () => ({ ...listing, permissions: [] });
  await actions.permissions.read();
  old.resolve(listing); await pending;
  assert.deepEqual(f.app.getSnapshot().permissionState.listing.permissions, []);
  f.behavior.permissions = async () => { throw new Error('List unavailable'); };
  await assert.rejects(actions.permissions.read(), /List unavailable/);
  assert.equal(f.app.getSnapshot().permissionState.kind, 'stale');
  assert.equal(f.app.getSnapshot().permissionState.listing.observedAt, listing.observedAt);
  await assert.rejects(actions.commands.revokePermission('grant', 'conversation'), /Refresh permissions/);
  f.behavior.permissions = async () => { reads++; return listing; };
  const before = reads;
  await f.app.reconnect(); await new Promise(resolve => setImmediate(resolve));
  assert(reads > before);
  actions = f.app.conversationActions(f.app.getSnapshot().active);
  await actions.permissions.read();
  await assert.rejects(actions.commands.revokePermission('grant', 'conversation'), /Reply lost/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.getSnapshot().permissionState.kind, 'fresh');
  assert.equal(f.submitted.length, 1);
  assert.equal(f.app.getSnapshot().active.store.getSnapshot().outbox.length, 1);
});

test('a conversation that does not report permissions stays unsupported across reads and reconnects', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.behavior.permissions = async () => ({ kind: 'unsupported', reason: 'This conversation does not report permissions.' });
  await f.app.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.getSnapshot().permissionState.kind, 'unsupported');
  const held = deferred(), kinds = [];
  const stop = f.app.subscribe(() => kinds.push(f.app.getSnapshot().permissionState.kind));
  f.behavior.permissions = () => held.promise;
  const pending = f.app.conversationActions(f.app.getSnapshot().active).permissions.read();
  held.resolve({ kind: 'unsupported', reason: 'This conversation does not report permissions.' }); await pending;
  const active = f.app.getSnapshot().active;
  await active.store.setDraft('A command marks permissions for refresh');
  await f.app.conversationActions(active).submit(() => active.store.send()).catch(() => {});
  await f.app.reconnect(); await new Promise(resolve => setImmediate(resolve));
  stop();
  assert.deepEqual([...new Set(kinds)], ['unsupported']);
});

test('permission reads from a disposed session cannot populate its replacement', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const old = deferred(), actions = f.app.conversationActions(f.app.getSnapshot().active);
  f.behavior.permissions = () => old.promise;
  const pending = actions.permissions.read();
  await f.app.dispose();
  f.behavior.permissions = async () => ({ kind: 'available', observedAt: new Date().toISOString(), permissions: [] });
  await f.app.start(); await new Promise(resolve => setImmediate(resolve));
  old.resolve({ kind: 'available', observedAt: '2026-11-16T00:00:00Z', permissions: [
    { permissionId: 'old', scope: 'agent', actionLabel: 'Old', detail: 'Old session' }] });
  await assert.rejects(pending, /closed/);
  assert.deepEqual(f.app.getSnapshot().permissionState.listing.permissions, []);
});

test('original physical store and storage survive navigation and principal changes while old notification remains pending', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.views.set('other-view/host', empty());
  const disposed = [], source = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'A', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'Original' }, decodeInput: x => x, async execute() { throw new Error('No effects'); } }); return { dispose() { disposed.push('A'); } }; } });
  const token = {}; f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [source.generation] });
  await f.app.start(); const original = f.app.getSnapshot().active.store;
  f.behavior.submit = async command => ({ kind: 'receipt', receipt: { scope, clientCommandId: command.clientCommandId, hostOperationId: 'operation', sequence: 1, state: { kind: 'completed' } } });
  await original.send('A message');
  assert.equal(original.getSnapshot().outbox.length, 0);
  const retiring = source.generation.retire();
  await f.app.reopenView('other-view');
  assert.equal(f.leases[0].closed, false);
  await f.app.reopenView('original-view');
  assert.equal(f.app.getSnapshot().active.store, original); assert.equal(f.leases.filter(lease => lease.viewId === 'original-view').length, 1);
  f.behavior.principalId = 'replacement';
  await f.app.reconnect(); await retiring;
  assert.equal(f.app.getSnapshot().active.store, original);
  assert.deepEqual(disposed, ['A']);
  assert.equal(f.drafts.get('original-view/host/conversation').frontendSends[0].ownerId, 'principal');
  assert.equal(f.drafts.get('original-view/host/conversation').frontendSends[0].state, 'unavailable-pending');
  await original.setDraft('New principal draft');
  assert.equal(f.drafts.get('original-view/host/conversation').draft, 'New principal draft');
  await assert.rejects(original.retry(f.submitted[0].clientCommandId), /outbox|unavailable/);
});

test('a failed background storage close blocks commands and disposal joins the same close without retrying it', async () => {
  const f = fixture(); let closes = 0;
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  f.behavior.close = owner => { if (owner.viewId === 'original-view') { closes++; throw new Error('Storage close failed'); } };
  await f.app.reopenView('other-view'); await new Promise(resolve => setImmediate(resolve));
  assert.match(f.app.getSnapshot().storageFailure, /Storage close failed/);
  await f.app.create(); assert.deepEqual(f.created, []);
  await assert.rejects(f.app.dispose(), /Storage close failed/); assert.equal(closes, 1);
});

test('a newly acquired view already owns its selected lease when another capture changes during selection', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  f.views.set('original-view/host', { ...empty(), route: scope });
  const source = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'A', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'Original' }, decodeInput: x => x, async execute() { throw new Error('No effects'); } }); return { dispose() {} }; } });
  const token = {}; f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [source.generation] });
  await f.app.start();
  await assert.rejects(f.app.getSnapshot().active.store.send('Pending'), /Reply lost/);
  const key = f.app.getSnapshot().capturedSends[0].key;
  f.behavior.select = () => { void f.app.releaseCapturedSend(key); };
  await f.app.reopenView('new-view'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.leases.find(lease => lease.viewId === 'new-view').closed, false);
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  await source.generation.retire();
});

const journalRecord = (selected, count = 1) => ({ version: 3, image: null, scope: selected, draft: 'Preserved', draftRevision: 1, outbox: [],
  frontendSends: Array.from({ length: count }, (_, index) => ({ ownerId: 'principal', state: 'retained', command: { version: 2, scope: selected,
    clientCommandId: `${selected.conversationId}-${index}`, body: { kind: 'send', text: 'Original', frontend: { platform: 'desktop', tools: [{ activationId: 'old', definition: { name: 'fixture__echo', description: 'Original' } }] } } } })) });
const eventually = async predicate => { for (let attempt = 0; attempt < 500; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Recovery did not reach its durable state'); };

test('foreign pending history never republishes or replaces the current owner row on later passes', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const record = journalRecord(scope, 33), requests = [];
  for (const reference of record.frontendSends.slice(0, 32)) reference.ownerId = 'foreign';
  f.drafts.set('original-view/host/conversation', record);
  f.behavior.binding = async request => { requests.push(request); throw new Error('Notification offline'); };
  await f.app.start();
  await eventually(() => requests.length === 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  const saved = f.drafts.get('original-view/host/conversation');
  assert.ok(saved.frontendSends.every(row => row.state === 'unavailable-pending'));
  const rows = f.app.getSnapshot().capturedSends;
  assert.deepEqual(rows.map(row => row.command.clientCommandId), ['conversation-32']);
  let publications = 0;
  const unsubscribe = f.app.subscribe(() => { publications++; }); t.after(unsubscribe);
  await eventually(() => requests.length === 2);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(publications, 0);
  assert.equal(f.app.getSnapshot().capturedSends, rows);
  assert.equal(f.app.getSnapshot().capturedSends[0], rows[0]);
  assert.ok(requests.every(request => request.id === 'conversation-32' && request.action === 'unavailable'));
  assert.equal(f.drafts.get('original-view/host/conversation'), saved);
  assert.deepEqual(saved.frontendSends.map(({ command, ownerId }) => ({ command, ownerId })), record.frontendSends.map(({ command, ownerId }) => ({ command, ownerId })));
});

for (const count of [1, 40]) test(`${count} own pending notifications keep captured keys and row identities stable across two failed passes`, async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const record = journalRecord(scope, count), requests = [];
  f.drafts.set('original-view/host/conversation', record);
  f.behavior.binding = async request => { requests.push(request); throw new Error('Notification offline'); };
  await f.app.start();
  await eventually(() => requests.length === count);
  await new Promise(resolve => setTimeout(resolve, 20));
  const rows = f.app.getSnapshot().capturedSends, keys = rows.map(row => row.key);
  assert.deepEqual(rows.map(row => row.command.clientCommandId), Array.from({ length: Math.min(count, 32) }, (_, index) => `conversation-${index + Math.max(0, count - 32)}`));
  const saved = f.drafts.get('original-view/host/conversation');
  assert.ok(saved.frontendSends.every(row => row.state === 'unavailable-pending'));
  let publications = 0;
  const unsubscribe = f.app.subscribe(() => { publications++; }); t.after(unsubscribe);
  for (const pass of [2, 3]) {
    await eventually(() => requests.length === count * pass);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(publications, 0);
    assert.equal(f.app.getSnapshot().capturedSends, rows);
    assert.deepEqual(f.app.getSnapshot().capturedSends.map(row => row.key), keys);
    for (let index = 0; index < rows.length; index++) assert.equal(f.app.getSnapshot().capturedSends[index], rows[index]);
    assert.equal(f.drafts.get('original-view/host/conversation'), saved);
  }
  assert.ok(requests.every(request => request.action === 'unavailable'));
  assert.deepEqual(saved.frontendSends.map(row => row.command), record.frontendSends.map(row => row.command));
});

test('settled history beyond 32 references keeps captured rows stable without another recovery pass', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.drafts.set('original-view/host/conversation', journalRecord(scope, 40));
  const requests = [];
  f.behavior.binding = async request => { requests.push(request); return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' }; };
  await f.app.start();
  await eventually(() => f.drafts.get('original-view/host/conversation').frontendSends.every(row => row.state === 'unavailable-confirmed'));
  await new Promise(resolve => setTimeout(resolve, 20));
  const rows = f.app.getSnapshot().capturedSends, order = rows.map(row => row.command.clientCommandId);
  assert.deepEqual(order, Array.from({ length: 32 }, (_, index) => `conversation-${index + 8}`));
  assert.equal(requests.length, 40);
  const loads = f.loads.length;
  let publications = 0;
  const unsubscribe = f.app.subscribe(() => { publications++; }); t.after(unsubscribe);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let index = 0; index < 3; index++) { t.mock.timers.tick(2_000); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(f.loads.length, loads);
  assert.equal(publications, 0);
  assert.equal(f.app.getSnapshot().capturedSends, rows);
  assert.deepEqual(f.app.getSnapshot().capturedSends.map(row => row.command.clientCommandId), order);
  assert.equal(requests.length, 40);
});

for (const route of [null, scope]) test(`owned-view sweep reaches more than 100 scopes and 32 references with route ${route?.conversationId ?? 'null'}`, async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route });
  for (let index = 0; index < 105; index++) {
    const selected = { ...scope, conversationId: `a-${String(index).padStart(3, '0')}` };
    f.drafts.set(`original-view/host/${selected.conversationId}`, { version: 1, scope: selected, draft: 'Preserved', draftRevision: 1, outbox: [] });
  }
  const last = { ...scope, conversationId: 'z-last' }, record = journalRecord(last, 70), requests = [], lookedUp = [];
  for (let index = 0; index < 35; index++) record.frontendSends[index].ownerId = 'foreign';
  record.frontendSends[35].state = 'unavailable-confirmed';
  f.drafts.set('original-view/host/z-last', record);
  f.behavior.agentLookup = selected => { lookedUp.push(selected); return selected.conversationId === scope.conversationId ? f.descriptor() : null; };
  f.behavior.binding = async request => { requests.push(request); if (request.id === 'z-last-36') throw new Error('Lost reply'); return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' }; };
  await f.app.start();
  await eventually(() => f.drafts.get('original-view/host/z-last').frontendSends[69].state === 'unavailable-confirmed');
  assert.deepEqual(lookedUp, route ? [scope] : []);
  assert.deepEqual(f.feeds.map(feed => feed.scope), route ? [scope] : []); assert.deepEqual(f.submitted, []);
  assert.equal(f.drafts.get('original-view/host/z-last').frontendSends[36].state, 'unavailable-pending');
  assert.ok(requests.every(request => request.action === 'unavailable' && Number(request.id.split('-').at(-1)) >= 36));
  assert.equal(f.app.getSnapshot().capturedSends.length, 32);
  assert.deepEqual(f.drafts.get('original-view/host/z-last').frontendSends.map(row => row.command), record.frontendSends.map(row => row.command));
});

test('recovery and visible install share one writer and gain eligibility from the actual conversation agent', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const held = deferred(), entered = deferred();
  f.drafts.set('original-view/host/conversation', journalRecord(scope));
  const actual = { ...f.descriptor('actual'), frontendOffers: 'ag-ui-capture-and-bind' };
  f.behavior.agents = [f.descriptor()]; f.behavior.agentLookup = () => actual;
  f.behavior.binding = async request => { entered.resolve(); await held.promise; return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' }; };
  const source = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'new', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'New' }, decodeInput: x => x, async execute() { throw new Error('No execution'); } }); return { dispose() {} }; } });
  const token = {}; f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [source.generation] });
  t.after(() => source.generation.retire());
  await f.app.start(); await entered.promise;
  await f.app.open(scope);
  const store = f.app.getSnapshot().active.store;
  const writing = deferred(), writingEntered = deferred();
  f.behavior.write = async () => { writingEntered.resolve(); await writing.promise; };
  const draft = store.setDraft('Concurrent draft'); await writingEntered.promise;
  f.behavior.submit = async command => ({ kind: 'receipt', receipt: { scope, clientCommandId: command.clientCommandId, hostOperationId: 'operation', sequence: 1, state: { kind: 'completed' } } });
  const sending = store.send('Explicit send'); held.resolve();
  await Promise.resolve(); writing.resolve(); await Promise.all([draft, sending]);
  await eventually(() => f.drafts.get('original-view/host/conversation').frontendSends[0].state === 'unavailable-confirmed');
  assert.equal(f.loads.filter(key => key === 'original-view/host/conversation').length, 1);
  assert.equal(f.submitted[0].version, 2); assert.equal(f.drafts.get('original-view/host/conversation').draft, 'Concurrent draft');
  assert.equal(f.drafts.get('original-view/host/conversation').outbox.length, 0);
});

for (const failed of [false, true]) test(`inactive view release ${failed ? 'reports its pinned save failure' : 'drains then defers notification until reopening'}`, async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope }); f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  const source = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'A', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'A' }, decodeInput: x => x, async execute() { throw new Error('No execution'); } }); return { dispose() {} }; } });
  const token = {}; f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [source.generation] });
  await f.app.start(); await assert.rejects(f.app.getSnapshot().active.store.send('Original'), /Reply lost/);
  const key = f.app.getSnapshot().capturedSends[0].key;
  await f.app.reopenView('other-view'); assert.equal(f.leases[0].closed, false);
  const entered = deferred(), write = deferred(), requests = [];
  f.behavior.binding = async request => { requests.push(request); return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' }; };
  f.behavior.write = async () => { entered.resolve(); await write.promise; };
  const release = f.app.releaseCapturedSend(key); await entered.promise;
  assert.equal(f.leases[0].closed, false);
  if (failed) write.reject(new Error('Inactive release save failed')); else write.resolve();
  await release; await source.generation.retire();
  await eventually(() => f.leases[0].closed);
  if (failed) assert.match(f.app.getSnapshot().storageFailure, /Inactive release save failed/);
  else {
    assert.equal(f.drafts.get('original-view/host/conversation').frontendSends[0].state, 'unavailable-pending'); assert.deepEqual(requests, []);
    f.behavior.write = async () => {};
    await f.app.reopenView('original-view');
    await eventually(() => f.drafts.get('original-view/host/conversation').frontendSends[0].state === 'unavailable-confirmed');
    assert.equal(f.leases.filter(lease => lease.viewId === 'original-view').length, 2);
    assert.equal(f.submitted.length, 1);
  }
});

test('owned-view discovery preserves corrupt journal bytes and blocks admission without agent lookup', async t => {
  const f = fixture(); t.after(() => f.app.dispose().catch(() => {}));
  const corrupt = { ...journalRecord(scope), version: 99 }; f.drafts.set('original-view/host/conversation', corrupt);
  f.behavior.agentLookup = () => { assert.fail('Recovery must not resolve an agent'); };
  await f.app.start(); await eventually(() => Boolean(f.app.getSnapshot().storageFailure));
  assert.match(f.app.getSnapshot().storageFailure, /Unsupported local storage version/);
  assert.equal(f.drafts.get('original-view/host/conversation'), corrupt);
  assert.deepEqual(f.submitted, []); assert.deepEqual(f.feeds, []);
});

test('navigating inactive scopes closes their handles while retaining the selected store', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); await f.app.start();
  const stores = [];
  for (let index = 0; index < 40; index++) {
    await f.app.open({ ...scope, conversationId: `visited-${index}` }); stores.push(f.app.getSnapshot().active.store);
  }
  for (const old of stores.slice(0, -1)) await assert.rejects(old.setDraft('Stale handle'), /closed/);
  await stores.at(-1).setDraft('Current draft');
  assert.equal(f.drafts.get('original-view/host/visited-39').draft, 'Current draft');
  assert.equal(f.app.getSnapshot().storageFailure, '');
});

for (const replacement of ['view', 'same-principal reconnect']) test(`recovery cancellation starts ${replacement} work before the old notification replies`, async t => {
  const f = fixture(), oldReply = deferred(), nextReply = deferred(), requests = [];
  t.after(async () => { oldReply.resolve(); nextReply.resolve(); await f.app.dispose(); });
  f.drafts.set('original-view/host/conversation', journalRecord(scope));
  f.drafts.set('other-view/host/conversation', journalRecord(scope));
  f.behavior.binding = async request => {
    requests.push(request);
    await (requests.length === 1 ? oldReply.promise : nextReply.promise);
    return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' };
  };
  await f.app.start(); await eventually(() => requests.length === 1);
  if (replacement === 'view') await f.app.reopenView('other-view'); else await f.app.reconnect();
  await eventually(() => requests.length === 2);
  if (replacement === 'view') {
    await eventually(() => f.leases[0].closed);
    assert.equal(f.drafts.get('original-view/host/conversation').frontendSends[0].state, 'unavailable-pending');
  }
  const before = structuredClone([...f.drafts]);
  oldReply.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...f.drafts], before);
  assert.equal(f.app.getSnapshot().storageFailure, '');
  nextReply.resolve();
  const key = `${replacement === 'view' ? 'other-view' : 'original-view'}/host/conversation`;
  await eventually(() => f.drafts.get(key).frontendSends[0].state === 'unavailable-confirmed');
  assert.equal(requests.length, 2);
});

test('canceling a notification keeps live captures and drains their admitted release before closing the old view', async t => {
  const f = fixture(), oldReply = deferred(), requests = [];
  t.after(async () => { oldReply.resolve(); await f.app.dispose(); });
  f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  f.views.set('original-view/host', { ...empty(), route: scope });
  const lost = { ...scope, conversationId: 'a-lost' };
  f.drafts.set('original-view/host/a-lost', journalRecord(lost));
  f.drafts.set('other-view/host/conversation', journalRecord(scope));
  f.behavior.binding = async request => {
    requests.push(request);
    if (request.scope.conversationId === 'a-lost') await oldReply.promise;
    return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' };
  };
  const source = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'live', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'Live' }, decodeInput: x => x, async execute() { throw new Error('No execution'); } }); return { dispose() {} }; } });
  t.after(() => source.generation.retire());
  const token = {}; f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [source.generation] });
  await f.app.start(); await eventually(() => requests.length === 1);
  await assert.rejects(f.app.getSnapshot().active.store.send('Live original'), /Reply lost/);
  const live = f.app.getSnapshot().capturedSends.find(row => row.status === 'waiting');
  await f.app.reopenView('other-view');
  await eventually(() => requests.length === 2);
  assert.equal(f.leases[0].closed, false);
  assert.equal(f.app.getSnapshot().capturedSends.find(row => row.key === live.key).status, 'waiting');
  const entered = deferred(), write = deferred();
  f.behavior.write = async () => { entered.resolve(); await write.promise; };
  const release = f.app.releaseCapturedSend(live.key); await entered.promise;
  assert.equal(f.leases[0].closed, false);
  write.resolve(); await release;
  await eventually(() => f.leases[0].closed);
  const before = structuredClone([...f.drafts]);
  oldReply.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...f.drafts], before);
  assert.equal(f.app.getSnapshot().storageFailure, '');
});

test('canceling during the admitted unavailable save drains it before releasing the old lease', async t => {
  const f = fixture(), entered = deferred(), write = deferred(), requests = [];
  t.after(async () => { write.resolve(); await f.app.dispose(); });
  f.drafts.set('original-view/host/conversation', journalRecord(scope));
  f.drafts.set('other-view/host/conversation', journalRecord(scope));
  let first = true;
  f.behavior.write = async () => { if (first) { first = false; entered.resolve(); await write.promise; } };
  f.behavior.binding = async request => { requests.push(request); return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' }; };
  await f.app.start(); await entered.promise;
  await f.app.reopenView('other-view');
  assert.equal(f.leases[0].closed, false); assert.deepEqual(requests, []);
  write.resolve(); await eventually(() => f.leases[0].closed && requests.length === 1);
  assert.equal(f.drafts.get('original-view/host/conversation').frontendSends[0].state, 'unavailable-pending');
  assert.equal(f.app.getSnapshot().storageFailure, '');
});

for (const ending of ['storage failure', 'disposal']) test(`recovery cancellation handles ${ending} before a held reply`, async t => {
  const f = fixture(), gate = deferred(), entered = deferred();
  t.after(async () => { gate.resolve(); await f.app.dispose(); });
  f.drafts.set('original-view/host/conversation', journalRecord(scope));
  f.behavior.binding = async request => { entered.resolve(); await gate.promise; return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' }; };
  await f.app.start(); await entered.promise;
  if (ending === 'storage failure') f.leases[0].failure(new Error('Injected storage failure'));
  let disposed = false;
  const closing = f.app.dispose().then(() => { disposed = true; });
  await eventually(() => disposed); await closing;
  assert.equal(f.leases[0].closed, true);
  const before = structuredClone([...f.drafts]);
  gate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...f.drafts], before);
  assert.equal(f.app.getSnapshot().storageFailure, ending === 'storage failure' ? 'Injected storage failure' : '');
});


for (const destination of ['other-view', 'original-view']) test(`a rejected ${destination} selection preserves the original loaded view and recovery pass`, async t => {
  const f = fixture(), gate = deferred(), requests = [];
  t.after(async () => { gate.resolve(); await f.app.dispose(); });
  f.drafts.set('original-view/host/conversation', journalRecord(scope));
  f.behavior.binding = async request => {
    requests.push(request);
    if (requests.length === 1) await gate.promise;
    return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' };
  };
  await f.app.start(); await eventually(() => requests.length === 1);
  f.behavior.select = () => { throw new Error('Selection failed'); };
  await f.app.reopenView(destination);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  if (destination === 'other-view') assert.equal(f.leases[1].closed, true);
  else assert.equal(f.leases.length, 1);
  gate.resolve();
  assert.match(f.app.getSnapshot().error, /Selection failed/);
  assert.equal(f.leases[0].closed, false);
  await eventually(() => f.drafts.get('original-view/host/conversation').frontendSends[0].state === 'unavailable-confirmed');
  assert.equal(requests.length, 1);
});

test('reconnect cancels the previous pass while metadata is held and starts only after refresh finishes', async t => {
  const f = fixture(), oldReply = deferred(), metadata = deferred(), entered = deferred(), requests = [];
  t.after(async () => { oldReply.resolve(); metadata.resolve(); await f.app.dispose(); });
  f.drafts.set('original-view/host/conversation', journalRecord(scope));
  f.behavior.binding = async request => {
    requests.push(request);
    if (requests.length === 1) await oldReply.promise;
    return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' };
  };
  await f.app.start(); await eventually(() => requests.length === 1);
  f.behavior.metadata = async () => { entered.resolve(); await metadata.promise; };
  const refreshing = f.app.reconnect(); await entered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.getSnapshot().host.kind, 'loading'); assert.equal(requests.length, 1);
  metadata.resolve(); await refreshing;
  await eventually(() => requests.length === 2);
  await eventually(() => f.drafts.get('original-view/host/conversation').frontendSends[0].state === 'unavailable-confirmed');
});

for (const ending of ['navigation', 'disposal']) test(`a corrupt pending load releases its physical lease after ${ending}`, async () => {
  const f = fixture(), gate = deferred(), entered = deferred(), corrupt = { version: 99, scope };
  f.drafts.set('original-view/host/conversation', corrupt);
  f.behavior.load = async (_scope, id) => { if (id === 'original-view') { entered.resolve(); await gate.promise; } };
  try {
    await f.app.start(); await entered.promise;
    if (ending === 'navigation') await f.app.reopenView('other-view');
    const closing = ending === 'disposal' ? f.app.dispose() : null;
    gate.reject(new Error('Corrupt draft load'));
    if (closing) await closing;
    await eventually(() => f.leases[0].closed);
    assert.equal(f.app.getSnapshot().storageFailure, '');
    assert.equal(f.drafts.get('original-view/host/conversation'), corrupt);
    assert.deepEqual(f.submitted, []);
  } finally { gate.resolve(); await f.app.dispose().catch(() => {}); }
});

test('disposal waits for every physical close before rejecting the first close failure', async t => {
  const f = fixture(), gate = deferred(), entered = deferred(), closes = [];
  t.after(async () => { gate.resolve(); await f.app.dispose().catch(() => {}); });
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  f.behavior.close = owner => {
    closes.push(owner.viewId);
    if (owner.viewId === 'original-view') throw new Error('First physical close failed');
    entered.resolve(); return gate.promise;
  };
  await f.app.reopenView('other-view');
  await eventually(() => Boolean(f.app.getSnapshot().storageFailure));
  let settled = false;
  const closing = f.app.dispose();
  const rejected = assert.rejects(closing, /First physical close failed/).then(() => { settled = true; });
  await entered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  gate.resolve(); await rejected;
  assert.deepEqual(closes, ['original-view', 'other-view']);
  assert.equal(f.app.dispose(), closing);
});

test('an existing selection reserves its lease while a storage callback releases its last capture', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  f.views.set('original-view/host', { ...empty(), route: scope });
  const source = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'reserved', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'Original' }, decodeInput: x => x, async execute() { throw new Error('No effects'); } }); return { dispose() {} }; } });
  const token = {}; f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [source.generation] });
  await f.app.start();
  await assert.rejects(f.app.getSnapshot().active.store.send('Pending'), /Reply lost/);
  await f.app.reopenView('other-view');
  assert.equal(f.leases[0].closed, false);
  f.behavior.select = () => {
    f.leases[0].failure(new Error('Selection storage failed'));
    assert.equal(f.leases[0].closed, false);
  };
  await f.app.reopenView('original-view');
  assert.match(f.app.getSnapshot().storageFailure, /Selection storage failed/);
  assert.equal(f.leases[0].closed, false);
  await source.generation.retire();
});

for (const destination of ['original-view', 'fresh-view']) test(`disposal inside physical selection cannot install ${destination}`, async () => {
  const f = fixture();
  await f.app.start();
  let closing;
  f.behavior.select = () => { closing = f.app.dispose(); };
  await f.app.reopenView(destination); await closing;
  assert(f.leases.every(lease => lease.closed));
  assert.equal(f.metadataCalls(), 1);
});

test('a fresh rejected selection retains its failed physical close for disposal and drains the selected lease', async t => {
  const f = fixture(), gate = deferred(), entered = deferred(), closes = [];
  t.after(async () => { gate.resolve(); await f.app.dispose().catch(() => {}); });
  await f.app.start();
  f.behavior.select = () => { throw new Error('Candidate selection failed'); };
  f.behavior.close = owner => {
    closes.push(owner.viewId);
    if (owner.viewId === 'candidate-view') throw new Error('Candidate close failed');
    entered.resolve(); return gate.promise;
  };
  await f.app.reopenView('candidate-view');
  assert.match(f.app.getSnapshot().storageFailure, /Candidate close failed/);
  assert.match(f.app.getSnapshot().error, /Candidate selection failed/);
  assert.equal(f.leases[0].closed, false);
  assert.deepEqual(closes, ['candidate-view']);
  let settled = false;
  const closing = f.app.dispose();
  const rejected = assert.rejects(closing, /Candidate close failed/).then(() => { settled = true; });
  await entered.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  gate.resolve(); await rejected;
  assert.deepEqual(closes, ['candidate-view', 'original-view']);
  assert.equal(f.app.dispose(), closing);
});

test('old capture disposal save failure does not poison a restarted owner', async t => {
  const f=fixture(); f.behavior.frontendOffers='ag-ui-capture-and-bind';
  f.views.set('original-view/host',{...empty(),route:scope});
  const source=await createFrontendToolGeneration({namespace:'fixture',generation:'A',platform:'desktop',capture:()=>undefined,
    activate({frontendTools}){frontendTools.add({definition:{name:'echo',description:'Original'},decodeInput:x=>x,async execute(){throw Error('No execution');}});return{dispose(){}};}});
  const token={}; f.app.frontendGenerations.begin(token);f.app.frontendGenerations.publish(token,{kind:'ready',generations:[source.generation]});
  const gate=deferred(),entered=deferred();
  t.after(async()=>{gate.reject(new Error('Cleanup'));await f.app.dispose();await source.generation.retire();});
  await f.app.start();
  f.behavior.submit=async command=>({kind:'receipt',receipt:{scope,clientCommandId:command.clientCommandId,hostOperationId:'operation',sequence:1,state:{kind:'completed'}}});
  await f.app.getSnapshot().active.store.send('Original');
  const original=f.drafts.get('original-view/host/conversation').frontendSends[0];
  let held=true;
  f.behavior.write=async()=>{if(held){held=false;entered.resolve();await gate.promise;}};
  const closing=f.app.dispose();await entered.promise;
  const restarted=f.app.start();gate.reject(new Error('Only old capture save failed'));
  await Promise.all([closing,restarted]);
  const state=f.app.getSnapshot();
  assert.equal(state.storageFailure,'');assert.equal(state.host.kind,'ready');
  await state.active.store.setDraft('Healthy restarted draft');
  const saved=f.drafts.get('original-view/host/conversation');
  assert.equal(saved.draft,'Healthy restarted draft');assert.deepEqual(saved.frontendSends[0].command,original.command);assert.equal(saved.frontendSends[0].ownerId,original.ownerId);
});

test('image previews and uploads share one host transfer slot, reusing concurrent reads and retrying refused overlaps', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const active = f.app.getSnapshot().active;
  let busy = false, overlaps = 0;
  const reads = [], uploads = [];
  // Mirrors the host: one transfer per host, overlaps refused as unavailable.
  const transfer = async work => {
    if (busy) { overlaps++; throw new ServiceError('unavailable', 'Another image transfer is in progress. Try again.'); }
    busy = true;
    try { await new Promise(resolve => setTimeout(resolve, 5)); return work(); } finally { busy = false; }
  };
  let refuseFirstUpload = true;
  f.behavior.readImage = (_, imageId) => transfer(() => { reads.push(imageId); return { attachment: null, bytes: new Uint8Array([imageId.length]) }; });
  f.behavior.uploadImage = input => {
    if (refuseFirstUpload) { refuseFirstUpload = false; return Promise.reject(new ServiceError('unavailable', 'Another image transfer is in progress. Try again.')); }
    return transfer(() => { uploads.push(input.uploadId);
      return { imageId: '00000000-0000-4000-8000-aaaaaaaaaaaa', name: input.name, mediaType: 'image/png', byteLength: input.bytes.byteLength, width: 1, height: 1 }; });
  };
  f.behavior.uuids = true;
  const actions = f.app.conversationActions(active);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
  const previews = ['a', 'bb', 'a', 'ccc'].map(id => actions.readImage(id));
  const selecting = active.store.selectImage({ name: 'chart.png', bytes: png });
  assert.deepEqual((await Promise.all(previews)).map(bytes => [...bytes]), [[1], [2], [1], [3]]);
  await selecting;
  assert.equal(active.store.getSnapshot().image.status, 'ready');
  assert.deepEqual(reads, ['a', 'bb', 'ccc']);
  assert.equal(uploads.length, 1);
  assert.equal(overlaps, 0);
  let refusals = 0;
  f.behavior.readImage = async () => { refusals++; throw new ServiceError('unavailable', 'Busy'); };
  await assert.rejects(actions.readImage('d'), { kind: 'unavailable' });
  assert.equal(refusals, 3);
  f.behavior.readImage = async () => { refusals++; throw new ServiceError('image-scope', 'Elsewhere'); };
  await assert.rejects(actions.readImage('d'), { kind: 'image-scope' });
  assert.equal(refusals, 4);
  assert.equal(f.app.getSnapshot().error, '');
});

test('a workspace reload during an in-flight page load re-reads the first page and discards the superseded page', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  await f.app.start();
  const entry = n => ({ scope: { hostId: 'host', conversationId: `w-${String(n).padStart(3, '0')}` }, preview: null,
    provider: { namespace: 'ledger', installationId: 'books', providerAgentId: 'desk' } });
  f.behavior.workspaceCatalog = async () => Array.from({ length: 100 }, (_, n) => entry(n));
  await f.app.loadWorkspace('ledger');
  const gate = Promise.withResolvers();
  f.behavior.workspaceCatalog = async after => { if (after !== null) { await gate.promise; return [entry(100)]; } return [entry(500)]; };
  const more = f.app.moreWorkspace('ledger');
  assert.equal(f.app.getSnapshot().workspaces.ledger.loading, true);
  await f.app.loadWorkspace('ledger');
  assert.deepEqual(f.filters.slice(-2).map(item => item.after), ['w-099', null], 'the reload sent its own first-page request');
  gate.resolve();
  await more;
  const workspace = f.app.getSnapshot().workspaces.ledger;
  assert.deepEqual(workspace.entries.map(item => item.scope.conversationId), ['w-500']);
  assert.deepEqual([workspace.hasMore, workspace.loading], [false, false]);
  assert.equal(f.app.getSnapshot().error, '');
});

test('workspace lists page by namespace filter, refresh replaces metadata and extension calls forward once', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  await f.app.start();
  const entry = n => ({ scope: { hostId: 'host', conversationId: `w-${String(n).padStart(3, '0')}` }, preview: null,
    provider: { namespace: 'ledger', installationId: 'books', providerAgentId: 'desk' } });
  f.behavior.workspaceCatalog = async after => after === null ? Array.from({ length: 100 }, (_, n) => entry(n)) : [entry(100)];
  await f.app.loadWorkspace('ledger');
  let workspace = f.app.getSnapshot().workspaces.ledger;
  assert.deepEqual([workspace.entries.length, workspace.hasMore, workspace.loading], [100, true, false]);
  assert.deepEqual(f.filters.at(-1), { after: null, filter: { kind: 'namespace', namespace: 'ledger' } });
  await f.app.moreWorkspace('ledger');
  workspace = f.app.getSnapshot().workspaces.ledger;
  assert.deepEqual([workspace.entries.length, workspace.hasMore], [101, false]);
  assert.equal(f.filters.at(-1).after, 'w-099');
  await f.app.moreWorkspace('ledger');
  assert.equal(f.filters.length, 2, 'no request after the last page');
  f.behavior.workspaceCatalog = async () => [{ ...entry(1), provider: { ...entry(1).provider, namespace: 'other' } }];
  await f.app.loadWorkspace('ledger');
  assert.match(f.app.getSnapshot().error, /another namespace/);
  const before = f.metadataCalls();
  f.behavior.extensions = [{ namespace: 'ledger', state: 'active', operations: ['echo'], installations: [] }];
  await f.app.refreshMetadata();
  assert.equal(f.metadataCalls(), before + 1);
  assert.deepEqual(f.app.getSnapshot().host.metadata.extensions, f.behavior.extensions);
  assert.deepEqual(await f.app.extensionCall({ namespace: 'ledger', installationId: 'books', operation: 'echo', input: { a: 1 } }), { kind: 'ok', output: { a: 1 } });
  assert.equal(f.calls.length, 1);
});

test('a refreshMetadata reply superseded by a reconnect publishes nothing, and an incompatible reply runs the full handshake', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  await f.app.start();
  const older = [{ namespace: 'ledger', state: 'active', operations: [], installations: [] }];
  const newer = [{ namespace: 'ledger', state: 'active', operations: ['echo'], installations: [{ installationId: 'books', status: 'available' }] }];
  const gate = deferred();
  f.behavior.metadata = () => gate.promise;
  const stale = f.app.refreshMetadata();
  f.behavior.metadata = async () => {};
  f.behavior.extensions = newer;
  await f.app.reconnect();
  assert.deepEqual(f.app.getSnapshot().host.metadata.extensions, newer);
  // The superseded read now answers with what it saw before the reconnect.
  f.behavior.extensions = older;
  gate.resolve();
  await stale;
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.deepEqual(f.app.getSnapshot().host.metadata.extensions, newer, 'the stale reply did not overwrite the reconnect');
  assert.equal(f.app.getSnapshot().error, '');

  f.behavior.wireVersion = 'other-wire';
  await f.app.refreshMetadata();
  assert.equal(f.app.getSnapshot().host.kind, 'incompatible', 'an incompatible host blocks commands instead of staying ready');
});

for (const kind of ['refused', 'pending', 'detached']) test(`a ${kind} placement stays explicit without mounting or creating a hidden inline chat`, async t => {
  const f = fixture({ placement: { async acquire(request) {
    return kind === 'refused' ? { kind, reason: 'Window could not open' }
      : kind === 'pending' ? { kind, scope: request.scope, reason: 'Window is opening' }
        : { kind, scope: request.scope, label: 'chat-window' };
  } } });
  t.after(() => f.app.dispose()); await f.app.start();
  const result = await f.app.create();
  assert.equal(result.kind, kind); assert.equal(f.app.getSnapshot().lastPlacement, result);
  assert.equal(f.app.getSnapshot().active, null); assert.deepEqual(f.created, []);
  if (kind === 'refused') assert.equal(f.app.getSnapshot().error, 'Window could not open');
});


test('a catalog route assigned to a native chat leaves its editor untouched during startup', async t => {
  const placed = [], f = fixture({ placement: { async restoresInline() { return false; }, async acquire(request) { placed.push(request.scope); return { kind: 'detached', scope: request.scope, label: 'native-chat' }; } } });
  t.after(() => f.app.dispose());
  f.storage.catalogViewId = 'original-view';
  f.storage.locate = async () => 'child-owned-view';
  f.behavior.reopen = async () => { throw new Error('This saved view is reserved for its recorded chat window'); };
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  assert.deepEqual(placed, []); assert.equal(f.app.getSnapshot().lastPlacement, null);
  assert.equal(f.app.getSnapshot().error, ''); assert.equal(f.app.getSnapshot().active, null);
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  assert.equal((await f.app.create()).kind, 'detached', 'main can create another chat after skipping automatic route placement');
  assert.equal(placed.length, 1); assert.equal(f.leases.length, 1, 'the child editor was never acquired by main');
});


test('an uncommitted catalog route assigned to a native window leaves main ready for another chat', async t => {
  const f = fixture({ placement: { async restoresInline() { return false; }, async acquire(request) { return { kind: 'detached', scope: request.scope, label: 'native-chat' }; } } });
  t.after(() => f.app.dispose());
  f.storage.catalogViewId = 'original-view';
  f.storage.locate = async () => { throw new Error('Main must not locate the assigned editor'); };
  f.behavior.agentLookup = async () => null;
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  assert.equal(f.app.getSnapshot().host.kind, 'ready'); assert.equal(f.app.getSnapshot().active, null);
  assert.equal(f.app.getSnapshot().error, ''); assert.equal(f.app.getSnapshot().lastPlacement, null);
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  assert.equal((await f.app.create()).kind, 'detached');
});


test('terminal native placement resolves only its still-current pending outcome and cannot mount a chat', async t => {
  const f = fixture({ placement: { async acquire(request) { return { kind: 'pending', scope: request.scope, reason: 'Waiting for main' }; } } });
  t.after(() => f.app.dispose()); await f.app.start();
  const first = await f.app.create(), second = await f.app.create();
  assert.equal(first.kind, 'pending'); assert.equal(second.kind, 'pending');
  assert.equal(f.app.settlePlacement(first, { kind: 'refused', reason: 'Old failure' }), false);
  assert.equal(f.app.getSnapshot().lastPlacement, second);
  assert.equal(f.app.settlePlacement(second, { kind: 'detached', scope: second.scope, label: 'native-chat' }), true);
  assert.equal(f.app.getSnapshot().lastPlacement.kind, 'detached'); assert.equal(f.app.getSnapshot().active, null);
  await f.app.dispose(); assert.equal(f.app.settlePlacement(second, { kind: 'refused', reason: 'Late after close' }), false);
});

test('recovery asks the host to resolve a stored creation after its agent disappears', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { version: 2, route: null, pendingCreation: { scope, agentId: 'removed-agent' } });
  f.behavior.agentLookup = async () => null;
  f.behavior.create = async () => { throw new ServiceError('create-rejected', 'Agent removed; creation was not accepted'); };
  await f.app.start();
  await f.app.recoverCreation();
  assert.deepEqual(f.created, [scope]);
  assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
  assert.match(f.app.getSnapshot().error, /Agent removed/);
});

test('a catalog route owned by another document leaves the connected catalog usable', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.storage.catalogViewId = 'original-view'; f.storage.locate = async () => 'elsewhere';
  f.behavior.reopen = async () => { throw new Error('This editor is already open in another document'); };
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  assert.equal(f.app.getSnapshot().host.kind, 'ready'); assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  assert.equal(f.app.getSnapshot().active, null); assert.match(f.app.getSnapshot().error, /already open/);
  assert.equal((await f.app.create()).kind, 'inline');
});

test('confirmed creation releases its reservation even when final placement detaches', async t => {
  let f, pendingAtPlacement;
  const placement = { async acquire(request, owner) {
    if (!request.creation && request.scope.conversationId.startsWith('id-')) {
      pendingAtPlacement = f.app.getSnapshot().saved.pendingCreation;
      return { kind: 'detached', scope: request.scope, label: 'created-child' };
    }
    return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
  } };
  f = fixture({ placement }); t.after(() => f.app.dispose()); await f.app.start();
  const result = await f.app.create(); assert.equal(result.kind, 'detached');
  assert.deepEqual(pendingAtPlacement, { scope: f.created[0], agentId: 'default' }); assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
  assert.equal(f.app.getSnapshot().saved.route, null); assert.equal(f.created.length, 1);
  assert.equal((await f.app.create()).kind, 'detached'); assert.equal(f.created.length, 2);
});

test('a navigation failure after durable pending creation reports its same reserved scope for recovery', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); f.storage.catalogViewId = 'original-view';
  f.views.set('original-view/host', { ...empty(), route: scope }); await f.app.start();
  f.behavior.navigation = async () => { if (f.app.getSnapshot().saved.pendingCreation) throw new Error('Catalog navigation write failed'); };
  const result = await f.app.create(); assert.equal(result.kind, 'pending'); assert.deepEqual(result.scope, f.app.getSnapshot().saved.pendingCreation.scope);
  assert.equal(f.created.length, 0); assert.match(f.app.getSnapshot().storageFailure, /Catalog navigation/);
  const saved = [...f.views]; await f.app.dispose();
  const restored = fixture(); for (const entry of saved) restored.views.set(...entry); t.after(() => restored.app.dispose());
  await restored.app.start(); await restored.app.recoverCreation();
  assert.deepEqual(restored.created, [result.scope]); assert.deepEqual(restored.app.getSnapshot().active.scope, result.scope); assert.equal(restored.app.getSnapshot().saved.pendingCreation, null);
});

test('placement refusal remains within the native result contract when its source error is long', async t => {
  const { parseConversationOpenResult } = await import('@openpane/contracts');
  const f = fixture({ placement: { async acquire() { throw new Error('x'.repeat(1500)); } } }); t.after(() => f.app.dispose());
  await f.app.start(); const result = await f.app.open(scope);
  assert.equal(result.kind, 'refused'); assert.equal(result.reason.length, 1000); assert.deepEqual(parseConversationOpenResult(result), result);
});

test('a refused handoff restores the still-owned source editor with its exact saved draft', async t => {
  let moving = false;
  const f = fixture({ placement: { async acquire(_request, owner) {
    if (moving) { await owner.quiesce(); return { kind: 'refused', reason: 'Destination changed before commit' }; }
    return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
  } } });
  t.after(() => f.app.dispose()); f.views.set('original-view/host', { ...empty(), route: scope }); await f.app.start();
  await f.app.getSnapshot().active.store.setDraft('Survive refused handoff'); moving = true;
  const result = await f.app.openReserved(scope), active = f.app.getSnapshot().active;
  assert.equal(result.kind, 'refused'); assert.deepEqual(active.scope, scope); assert.equal(active.store.getSnapshot().draft, 'Survive refused handoff');
  assert.equal(f.app.getSnapshot().storageFailure, ''); assert.deepEqual(f.submitted, []);
  await active.store.setDraft('Still writable after refusal'); assert.equal(f.drafts.get('original-view/host/conversation').draft, 'Still writable after refusal');
});

test('a recovery lease acquired after disposal closes without losing the original saved draft', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); await f.app.start();
  const earlier = { hostId: 'host', conversationId: 'late-source' }; f.storage.locate = async () => 'late-source-view';
  f.drafts.set('late-source-view/host/late-source', { version: 3, scope: earlier, draft: 'Original closed text', draftRevision: 1, frontendSends: [], outbox: [], image: null });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.behavior.reopen = async () => { entered.resolve(); await release.promise; };
  const acquiring = f.app.capturePlacementDraft(earlier); await entered.promise; const closing = f.app.dispose(); release.resolve();
  await closing; assert.equal(await acquiring, null);
  assert.equal(f.leases.find(lease => lease.viewId === 'late-source-view').closed, true);
  assert.equal(f.drafts.get('late-source-view/host/late-source').draft, 'Original closed text'); assert.deepEqual(f.submitted, []);
});

test('an inline editor acquired after disposal is released instead of stranding its lease', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let moving = false, acquired;
  const f = fixture({ placement: { async acquire(_request, owner) {
    if (!moving) return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
    entered.resolve(); await release.promise; acquired = await f.storage.reopen('late-inline-view', () => {});
    return { kind: 'inline', view: { kind: 'acquired', storage: acquired } };
  } } });
  t.after(() => f.app.dispose()); await f.app.start(); moving = true;
  const opening = f.app.openReserved(scope); await entered.promise; await f.app.dispose(); release.resolve(); await opening;
  assert.equal(acquired.closed, true); assert.deepEqual(f.submitted, []);
});

test('an unreadable acquired inline editor preserves the working source and its restart route', async t => {
  let moving = false;
  const f = fixture({ placement: { async acquire(_request, owner) {
    if (!moving) return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
    const storage = await f.storage.reopen('unreadable-view', () => {});
    storage.readView = async () => { throw new Error('Unsupported destination view'); };
    return { kind: 'inline', view: { kind: 'acquired', storage } };
  } } });
  t.after(() => f.app.dispose()); f.storage.catalogViewId = 'original-view';
  f.views.set('original-view/host', { ...empty(), route: scope }); await f.app.start();
  const source = f.app.getSnapshot().active; await source.store.setDraft('Keep the working draft'); moving = true;
  assert.equal((await f.app.openReserved({ ...scope, conversationId: 'different' })).kind, 'refused');
  assert.equal(f.app.getSnapshot().active, source); assert.equal(f.app.getSnapshot().storageFailure, '');
  await source.store.setDraft('Still writable'); assert.equal(f.drafts.get('original-view/host/conversation').draft, 'Still writable');
  assert.deepEqual(f.views.get('original-view/host').route, scope);
  await eventually(() => f.leases.find(lease => lease.viewId === 'unreadable-view').closed);
});

test('a released source is restored when an inline owned result names an unavailable lease', async t => {
  let moving = false;
  const f = fixture({ placement: { async acquire(_request, owner) {
    if (moving) { await owner.release(); return { kind: 'inline', view: { kind: 'owned', viewId: 'unknown-view' } }; }
    return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
  } } });
  t.after(() => f.app.dispose()); f.views.set('original-view/host', { ...empty(), route: scope }); await f.app.start();
  await f.app.getSnapshot().active.store.setDraft('Restore after release'); moving = true;
  assert.equal((await f.app.openReserved(scope)).kind, 'refused');
  assert.equal(f.app.getSnapshot().active.store.getSnapshot().draft, 'Restore after release');
  assert.equal(f.app.getSnapshot().storageFailure, ''); moving = false; await f.app.reconnect();
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
});

for (const kind of ['refused', 'pending']) test(`saved route restoration publishes its ${kind} placement outcome`, async t => {
  const f = fixture({ placement: { async acquire(request) { return kind === 'refused' ? { kind, reason: 'Restore refused explicitly' } : { kind, scope: request.scope, reason: 'Restore still waiting' }; } } });
  t.after(() => f.app.dispose()); f.views.set('original-view/host', { ...empty(), route: scope }); await f.app.start();
  assert.equal(f.app.getSnapshot().lastPlacement.kind, kind); assert.equal(f.app.getSnapshot().host.kind, 'ready');
  if (kind === 'refused') assert.equal(f.app.getSnapshot().error, 'Restore refused explicitly');
  else assert.equal(f.app.settlePlacement(f.app.getSnapshot().lastPlacement, { kind: 'refused', reason: 'Restore eventually declined' }), true);
});

test('same-store reconnect restores preview and permission subscriptions', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); f.views.set('original-view/host', { ...empty(), route: scope });
  f.behavior.catalog = async () => [scope]; await f.app.start(); await deliver(f);
  const store = f.app.getSnapshot().active.store; f.connectionLost(new ServiceConnectionLost('Disconnected'));
  await f.app.reconnect(); assert.equal(f.app.getSnapshot().active.store, store);
  await deliver(f, { messages: [{ messageId: 'updated', revision: 1, role: 'user', text: 'New preview after reconnect', complete: true }], currentRun: null });
  assert.equal(f.app.getSnapshot().catalog.items[0].preview, 'New preview after reconnect');
  await eventually(() => f.app.getSnapshot().permissionState.kind === 'fresh');
  f.feeds.at(-1).finish({ kind: 'closed', cursor: 1, reason: 'Feed closed' });
  await eventually(() => f.app.getSnapshot().permissionState.kind === 'stale');
});

test('saved pending creation reopens its original editor before checking conversation availability', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); const pendingCreation = { scope, agentId: 'default' };
  f.storage.readLegacyDraft = async () => ({ kind: 'bound', viewId: 'pending-view', scope, text: 'Unsent pending draft', pendingCreation });
  f.views.set('pending-view/host', { ...empty(), pendingCreation }); f.drafts.set('pending-view/host/conversation', { version: 3, scope, draft: 'Unsent pending draft', draftRevision: 1, image: null, outbox: [], frontendSends: [] });
  f.behavior.agentLookup = async () => null; await f.app.start(); await f.app.reopenView('pending-view');
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, pendingCreation); assert.equal(f.app.getSnapshot().savedDraftRecovery, null);
  f.behavior.agentLookup = async () => f.descriptor(); await f.app.recoverCreation();
  assert.deepEqual(f.created, [scope]); assert.equal(f.app.getSnapshot().active.viewId, 'pending-view');
  assert.equal(f.app.getSnapshot().active.store.getSnapshot().draft, 'Unsent pending draft'); assert.deepEqual(f.submitted, []);
});

test('a definitively refused empty creation preserves the previous route without advertising nonexistent draft text', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); await f.app.start();
  f.behavior.create = async () => { throw new ServiceError('create-rejected', 'No creation accepted'); };
  await f.app.create(); assert.equal(f.app.getSnapshot().saved.route, null); assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
  assert.equal(f.app.getSnapshot().savedDraftRecovery, null);
});

test('empty placement errors remain valid native refusal results', async t => {
  const { parseConversationOpenResult } = await import('@openpane/contracts');
  const f = fixture({ placement: { async acquire() { throw new Error(); } } }); t.after(() => f.app.dispose()); await f.app.start();
  assert.deepEqual(parseConversationOpenResult(await f.app.openReserved(scope)).kind, 'refused');
});

test('metadata incompatibility observed during an operation blocks commands and completes its delayed handshake', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); await f.app.start(); const entered = deferred(), release = deferred();
  f.behavior.catalog = async () => { entered.resolve(); await release.promise; return []; };
  const reading = f.app.refreshCatalog(); await entered.promise; f.behavior.wireVersion = 'incompatible-wire';
  await f.app.refreshMetadata(); assert.equal(f.app.getSnapshot().host.kind, 'loading');
  assert.equal((await f.app.create()).kind, 'refused'); release.resolve(); await reading;
  await eventually(() => f.app.getSnapshot().host.kind === 'incompatible'); assert.equal(f.created.length, 0);
});

test('closed capture recovery releases editor locks before waiting on the host and retries only affected views', async t => {
  const f = fixture(), reply = deferred(), entered = deferred(), requests = [];
  t.after(async () => { reply.resolve(); await f.app.dispose(); });
  f.storage.recoverClosedView = f.storage.reopen;
  f.behavior.listing = async () => ({ ids: ['closed-capture', 'unrelated-empty'], unreadable: 0, after: null });
  f.drafts.set('closed-capture/host/conversation', journalRecord(scope));
  f.behavior.binding = async request => {
    requests.push(request);
    assert.ok(f.leases.filter(lease => lease.viewId === 'closed-capture').every(lease => lease.closed), 'closed editor has no lease during the host wait');
    entered.resolve(); await reply.promise; throw new Error('Host reply unavailable');
  };
  await f.app.start(); await entered.promise;
  assert.equal(f.app.getSnapshot().host.kind, 'ready'); reply.resolve();
  await eventually(() => f.leases.some(lease => lease.viewId === 'unrelated-empty' && lease.closed));
  await new Promise(resolve => setTimeout(resolve, 2_100));
  assert.ok(requests.length >= 2); assert.equal(f.leases.filter(lease => lease.viewId === 'unrelated-empty').length, 1);
  assert.equal(f.drafts.get('closed-capture/host/conversation').frontendSends[0].state, 'unavailable-pending');
});

test('release of an inactive capture wakes recovery for its original view without reopening it visibly', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); f.storage.recoverClosedView = f.storage.reopen;
  f.views.set('original-view/host', { ...empty(), route: scope }); f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  const source = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'wake', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'Retained' }, decodeInput: x => x, async execute() {} }); return { dispose() {} }; } });
  const token = {}; f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [source.generation] });
  t.after(() => source.generation.retire()); await f.app.start();
  await assert.rejects(f.app.getSnapshot().active.store.send('Retained send'), /Reply lost/); const key = f.app.getSnapshot().capturedSends[0].key;
  await f.app.reopenView('other-view'); await new Promise(resolve => setImmediate(resolve));
  const requests = []; f.behavior.binding = async request => { requests.push(request); return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' }; };
  await f.app.releaseCapturedSend(key);
  await eventually(() => f.drafts.get('original-view/host/conversation').frontendSends[0].state === 'unavailable-confirmed');
  assert.equal(requests[0].action, 'unavailable'); assert.equal(f.app.getSnapshot().active, null); assert.equal(f.submitted.length, 1);
});

test('a refused quiesce preserves the original captured tools and their journal', async t => {
  let moving = false;
  const f = fixture({ placement: { async acquire(_request, owner) {
    if (moving) { await owner.quiesce(); return { kind: 'refused', reason: 'Destination refused' }; }
    return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
  } } });
  t.after(() => f.app.dispose()); f.views.set('original-view/host', { ...empty(), route: scope }); f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  const source = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'quiesce', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'Original' }, decodeInput: x => x, async execute() {} }); return { dispose() {} }; } });
  const token = {}; f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [source.generation] });
  t.after(() => source.generation.retire()); await f.app.start(); const store = f.app.getSnapshot().active.store;
  await assert.rejects(store.send('Captured'), /Reply lost/); const row = f.app.getSnapshot().capturedSends[0]; moving = true;
  assert.equal((await f.app.openReserved(scope)).kind, 'refused'); assert.equal(f.app.getSnapshot().active.store, store);
  assert.equal(f.app.getSnapshot().capturedSends[0], row); assert.equal(f.drafts.get('original-view/host/conversation').frontendSends[0].state, 'retained');
  await assert.rejects(store.retry(row.command.clientCommandId), /Reply lost/); assert.equal(f.submitted.length, 2);
});

test('creation recovery preserves its reserved editor through a placement refusal and retry', async t => {
  let refused = true;
  const f = fixture({ placement: { async acquire(request, owner) {
    return request.creation || !refused ? { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } } : { kind: 'refused', reason: 'Confirmed editor refused' };
  } } });
  t.after(() => f.app.dispose()); f.views.set('original-view/host', { ...empty(), pendingCreation: { scope, agentId: 'default' } }); await f.app.start();
  await f.app.recoverCreation(); assert.equal(f.app.getSnapshot().lastPlacement.kind, 'refused'); assert.equal(f.app.getSnapshot().error, 'Confirmed editor refused');
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, { scope, agentId: 'default' });
  assert.deepEqual(f.views.get('original-view/host').pendingCreation, { scope, agentId: 'default' }, 'the refused placement remains recoverable after restart');
  refused = false; await f.app.recoverCreation();
  assert.deepEqual(f.app.getSnapshot().active.scope, scope);
  assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
  assert.deepEqual(f.created, [scope, scope]); assert.deepEqual(f.submitted, []);
});

test('an old pending refusal cannot add an error while a newer open is waiting', async t => {
  let first = true; const gate = deferred(), entered = deferred();
  const f = fixture({ placement: { async acquire(request, owner) {
    if (first) { first = false; return { kind: 'pending', scope: request.scope, reason: 'First placement waiting' }; }
    entered.resolve(); await gate.promise; return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
  } } });
  t.after(() => f.app.dispose()); await f.app.start(); const old = await f.app.openReserved(scope);
  const newer = f.app.openReserved({ ...scope, conversationId: 'newer' }); await entered.promise;
  f.app.settlePlacement(old, { kind: 'refused', reason: 'Old placement refused' }); assert.equal(f.app.getSnapshot().error, '');
  gate.resolve(); assert.equal((await newer).kind, 'inline'); assert.equal(f.app.getSnapshot().error, '');
});

test('global catalog pages preserve provider order and keep workspace entries beyond a refreshed first page', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const entry = id => ({ scope: { ...scope, conversationId: id }, preview: null, provider: { namespace: 'ledger', installationId: 'books', providerAgentId: 'desk' } });
  const first = Array.from({ length: 100 }, (_, index) => index === 0 ? entry('newer') : { ...entry(`native-${index}`), provider: null });
  f.behavior.catalogEntries = async after => after === null ? first : [entry('older')];
  f.behavior.workspaceCatalog = async () => [entry('newer'), entry('older'), entry('oldest')];
  await f.app.start(); await f.app.loadWorkspace('ledger'); await f.app.moreConversations();
  assert.equal(f.app.getSnapshot().catalog.items[0].scope.conversationId, 'newer');
  assert.deepEqual(f.app.getSnapshot().workspaces.ledger.entries.map(row => row.scope.conversationId), ['newer', 'older', 'oldest']);
  await f.app.refreshCatalog();
  assert.deepEqual(f.app.getSnapshot().workspaces.ledger.entries.map(row => row.scope.conversationId), ['newer', 'older', 'oldest']);
});

test('a valid constructor provider namespace creates before its workspace has loaded', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const agent = { ...f.descriptor('provider-agent'), kind: 'provider', namespace: 'constructor', installationId: 'books', providerAgentId: 'desk' };
  f.behavior.agents = [agent]; f.behavior.defaultId = agent.id; f.behavior.agentLookup = async () => agent;
  await f.app.start(); assert.equal((await f.app.create()).kind, 'inline'); assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
  assert.equal(Object.hasOwn(f.app.getSnapshot().workspaces, 'constructor'), false);
  f.behavior.workspaceCatalog = async () => []; await f.app.loadWorkspace('constructor');
  assert.equal(Object.hasOwn(f.app.getSnapshot().workspaces, 'constructor'), true);
});

test('a late missing-conversation draft lookup cannot publish a notice into a restarted session', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); await f.app.start();
  const gate = deferred(), entered = deferred(); f.behavior.agentLookup = async () => null;
  f.storage.locate = async () => { entered.resolve(); return gate.promise; };
  const opening = f.app.openReserved(scope); await entered.promise;
  await f.app.dispose(); f.storage.locate = async () => null; await f.app.start(); const replacement = f.app.getSnapshot();
  gate.resolve(null); await opening;
  assert.equal(f.app.getSnapshot(), replacement); assert.equal(f.app.getSnapshot().savedViewNotice, '');
});

test('a destination draft that cannot hydrate does not replace the catalog restart route', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); f.storage.catalogViewId = 'original-view';
  f.views.set('original-view/host', { ...empty(), route: scope }); await f.app.start();
  const unreadable = { ...scope, conversationId: 'unsupported-draft' };
  f.behavior.load = async selected => { if (selected.conversationId === unreadable.conversationId) throw new Error('Unsupported saved draft'); };
  assert.equal((await f.app.openReserved(unreadable)).kind, 'refused'); assert.deepEqual(f.views.get('original-view/host').route, scope);
});

test('Start a new chat passes its unsent source to separate placement', async t => {
  let separate = false; const requests = [];
  const f = fixture({ placement: { async acquire(request, owner) {
    requests.push(request); return separate ? { kind: 'pending', scope: request.scope, reason: 'Opening separate chat' } : { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
  } } });
  t.after(() => f.app.dispose()); f.views.set('original-view/host', { ...empty(), route: scope }); await f.app.start();
  const active = f.app.getSnapshot().active; await active.store.setDraft('Carry this text'); separate = true;
  await f.app.conversationActions(active).startNewChat();
  assert.deepEqual(requests.at(-1).carryFrom, scope); assert.equal(f.app.getSnapshot().lastPlacement.kind, 'pending'); assert.deepEqual(f.submitted, []);
});

for (const kind of ['independent', 'unavailable']) test(`reopening ${kind} saved text returns false even with a pre-existing active editor`, async t => {
  const f = fixture(); t.after(() => f.app.dispose()); f.views.set('original-view/host', { ...empty(), route: scope }); await f.app.start();
  const original = f.app.getSnapshot().active, selected = { ...scope, conversationId: 'closed-saved-text' };
  f.storage.readLegacyDraft = async () => ({ kind: kind === 'independent' ? 'independent' : 'bound', viewId: 'closed-view', scope: selected, text: 'Saved text to inspect' });
  f.behavior.agentLookup = async selected => selected.conversationId === scope.conversationId ? f.descriptor() : null;
  assert.equal(await f.app.reopenView('closed-view'), false); assert.equal(f.app.getSnapshot().active, original);
  assert.equal(f.app.getSnapshot().savedDraftRecovery.viewId, 'closed-view'); assert.equal(f.leases.length, 1);
});

test('reopenView returns true only after this request installs its requested inline editor', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); f.views.set('original-view/host', { ...empty(), route: scope });
  f.views.set('requested-view/host', { ...empty(), route: scope }); await f.app.start();
  assert.equal(await f.app.reopenView('requested-view'), true); assert.equal(f.app.getSnapshot().active.viewId, 'requested-view');
  assert.equal(await f.app.reopenView('requested-view'), true);
  const gate = deferred(), entered = deferred(); f.behavior.catalog = async () => { entered.resolve(); await gate.promise; return []; };
  const reading = f.app.refreshCatalog(); await entered.promise; assert.equal(await f.app.reopenView('requested-view'), false);
  gate.resolve(); await reading;
  f.views.set('empty-view/host', empty()); assert.equal(await f.app.reopenView('empty-view'), false); assert.equal(f.app.getSnapshot().active, null);
});

test('pending creation placement preserves the connection-loss guidance until an explicit reconnect', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); await f.app.start();
  const changed = new ServiceConnectionLost('A different OpenPane host answered. Reconnect explicitly to use it.');
  f.behavior.create = async () => { f.connectionLost(changed); throw changed; };
  assert.equal((await f.app.create()).kind, 'pending'); assert.equal(f.app.getSnapshot().host.kind, 'unavailable');
  assert.match(f.app.getSnapshot().error, /different OpenPane host.*Reconnect/);
  assert.equal((await f.app.create()).kind, 'refused'); assert.equal(f.created.length, 1);
});

test('confirmed creation settlement waits for the same editor to reconnect without replacing its disconnect error', async t => {
  let separate = false;
  const f = fixture({ placement: { async acquire(request, owner) {
    if (request.creation || !separate) return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
    return { kind: 'pending', scope: request.scope, reason: 'Waiting for assigned creation editor' };
  } } });
  t.after(() => f.app.dispose()); f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start(); separate = true;
  const pending = await f.app.create();
  f.connectionLost(new ServiceConnectionLost('Host disconnected while native lookup was in flight'));
  const before = f.app.getSnapshot().error;
  assert.match(before, /Host disconnected/);
  assert.equal(f.app.settlePlacement(pending, { kind: 'detached', scope: pending.scope, label: 'confirmed-reconnect-child' }), true);
  await new Promise(resolve => setImmediate(resolve));
  const errorWhileDown = f.app.getSnapshot().error;
  assert.deepEqual(f.views.get('original-view/host').pendingCreation.scope, pending.scope, 'cleanup waits while the host is unavailable');
  separate = false; await f.app.reconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.views.get('original-view/host').pendingCreation, null, 'the successful settlement is retained across reconnect');
  assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
  assert.equal(errorWhileDown, before, 'terminal native evidence does not replace the connection diagnostic');
  assert.equal((await f.app.create()).kind, 'inline');
  assert.equal(f.created.length, 2, 'no manual creation recovery was required');
});

test('confirmed creation background cleanup preserves an unrelated current error', async t => {
  const f = fixture({ placement: { async acquire(request, owner) {
    return request.creation ? { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } }
      : { kind: 'pending', scope: request.scope, reason: 'Waiting for assigned creation editor' };
  } } });
  t.after(() => f.app.dispose()); await f.app.start();
  const pending = await f.app.create();
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation.scope, pending.scope);
  assert.deepEqual(f.views.get('original-view/host').pendingCreation.scope, pending.scope);
  f.behavior.catalog = async () => { throw new Error('Unrelated catalog page could not load'); };
  await f.app.refreshCatalog();
  assert.equal(f.app.getSnapshot().error, 'Unrelated catalog page could not load');
  assert.equal(f.app.settlePlacement(pending, { kind: 'detached', scope: pending.scope, label: 'confirmed-error-child' }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.views.get('original-view/host').pendingCreation, null);
  assert.equal(f.app.getSnapshot().error, 'Unrelated catalog page could not load');
});

for (const outcome of ['detached', 'refused before commit']) test(`main retains a usable owner after a released editor is ${outcome}`, async t => {
  let moving = false, handedOff = false, f;
  const second = { ...scope, conversationId: 'second-native-chat' };
  const placement = { async acquire(request, owner) {
    if (!moving) return { kind: 'inline', view: { kind: 'acquired', storage: await f.storage.reopen('inline-editor', () => {}) } };
    assert.equal(owner.storage.closed, false, 'placement receives a current physical owner');
    if (request.scope.conversationId === scope.conversationId) {
      await owner.release();
      if (outcome === 'refused before commit') throw new Error('Native request refused before commit');
      handedOff = true;
    }
    return { kind: 'detached', scope: request.scope, label: `child-${request.scope.conversationId}` };
  } };
  f = fixture({ placement }); t.after(() => f.app.dispose()); f.storage.catalogViewId = 'original-view';
  f.behavior.reopen = async id => { if (handedOff && id === 'inline-editor') throw new Error('The editor belongs to its recorded child window'); };
  f.views.set('inline-editor/host', { ...empty(), route: scope });
  await f.app.start(); assert.equal((await f.app.openReserved(scope)).kind, 'inline');
  await f.app.getSnapshot().active.store.setDraft('Native draft one — keep this exact text'); moving = true;
  const result = await f.app.openReserved(scope);
  if (outcome === 'detached') {
    assert.equal(result.kind, 'detached'); assert.equal(f.app.getSnapshot().active, null);
    assert.equal((await f.app.openReserved(second)).kind, 'detached', 'main can still open the next catalog chat');
    assert.equal(f.app.getSnapshot().error, '');
  } else {
    assert.equal(result.kind, 'refused'); assert.deepEqual(f.app.getSnapshot().active.scope, scope);
    assert.equal(f.app.getSnapshot().active.store.getSnapshot().draft, 'Native draft one — keep this exact text');
    await f.app.getSnapshot().active.store.setDraft('Still writable after refusal');
  }
  assert.equal(f.app.getSnapshot().storageFailure, '');
  assert.equal(f.drafts.get('inline-editor/host/conversation').draft, outcome === 'detached' ? 'Native draft one — keep this exact text' : 'Still writable after refusal');
  assert.deepEqual(f.submitted, []);
});

test('a source activation failure after refused placement remains visible', async t => {
  let moving = false, f;
  const placement = { async acquire(request, owner) {
    if (!moving) return { kind: 'inline', view: { kind: 'acquired', storage: await f.storage.reopen('source-editor', () => {}) } };
    await owner.release();
    f.behavior.navigation = async () => { throw new Error('Source navigation could not be restored'); };
    throw new Error('Native placement refused');
  } };
  f = fixture({ placement }); f.storage.catalogViewId = 'original-view'; t.after(() => f.app.dispose());
  await f.app.start(); await f.app.openReserved(scope); moving = true;
  assert.equal((await f.app.openReserved(scope)).kind, 'refused');
  assert.match(f.app.getSnapshot().error, /Source navigation could not be restored/);
});

for (const native of ['refused', 'thrown']) test(`released-source read abort returns to catalog and retains ${native} placement guidance`, async t => {
  let moving=false, readSource=false, f;
  const guidance='Inspect saved window recovery before retrying: the native reservation could not be confirmed cancelled.';
  const second={...scope,conversationId:'catalog-after-read-abort'};
  const placement={async acquire(request,owner){
    assert.equal(owner.storage.closed,false,'placement receives a current lease');
    if(!moving)return{kind:'inline',view:{kind:'acquired',storage:await f.storage.reopen('read-abort-source',()=>{})}};
    if(request.scope.conversationId!==scope.conversationId)return{kind:'detached',scope:request.scope,label:'next-catalog-child'};
    await owner.release();
    if(native==='thrown')throw new Error(guidance);
    return{kind:'refused',reason:guidance};
  }};
  f=fixture({placement});f.storage.catalogViewId='original-view';t.after(()=>f.app.dispose());
  f.behavior.reopen=async id=>{if(moving&&id==='read-abort-source')readSource=true;};
  f.behavior.read=async()=>{if(readSource){readSource=false;throw new Error('Source saved-view transaction aborted');}};
  await f.app.start();await f.app.openReserved(scope);
  await f.app.getSnapshot().active.store.setDraft('Preserve source through a readonly load abort');moving=true;
  const result=await f.app.openReserved(scope);
  assert.equal(result.kind,'refused');assert.match(result.reason,/Inspect saved window recovery/);assert.match(result.reason,/Source saved-view transaction aborted/);
  assert.match(f.app.getSnapshot().error,/Inspect saved window recovery/);assert.match(f.app.getSnapshot().error,/Source saved-view transaction aborted/);
  assert.equal(f.app.getSnapshot().active,null);assert.equal(f.app.getSnapshot().storageFailure,'');
  assert.equal(f.app.getSnapshot().saved,f.views.get('original-view/host'),'the retained catalog is loaded');
  assert.equal((await f.app.openReserved(second)).kind,'detached','a subsequent catalog action remains usable');
  assert.equal(f.drafts.get('read-abort-source/host/conversation').draft,'Preserve source through a readonly load abort');
  assert.deepEqual(f.submitted,[]);
});

for(const native of ['refused','thrown'])test(`source activation failure keeps both ${native} native guidance and the restoration cause`,async t=>{
  let moving=false,f;
  const guidance='Inspect saved window recovery before retrying: cancellation is unconfirmed.';
  const placement={async acquire(_request,owner){
    if(!moving)return{kind:'inline',view:{kind:'acquired',storage:await f.storage.reopen('activation-source',()=>{})}};
    await owner.release();f.behavior.navigation=async()=>{throw new Error('Source navigation could not be restored');};
    if(native==='thrown')throw new Error(guidance);
    return{kind:'refused',reason:guidance};
  }};
  f=fixture({placement});f.storage.catalogViewId='original-view';t.after(()=>f.app.dispose());
  await f.app.start();await f.app.openReserved(scope);moving=true;
  const result=await f.app.openReserved(scope);
  assert.equal(result.kind,'refused');assert.match(result.reason,/Inspect saved window recovery/);assert.match(result.reason,/Source navigation could not be restored/);
  assert.match(f.app.getSnapshot().error,/Inspect saved window recovery/);assert.match(f.app.getSnapshot().error,/Source navigation could not be restored/);
  assert.equal(f.app.getSnapshot().saved,f.views.get('activation-source/host'),'activation failure is not hidden by a catalog fallback');
  assert.match(f.app.getSnapshot().storageFailure,/Source navigation could not be restored/);
  assert.equal(applicationEnabled(f.app.getSnapshot()),false);
});

test('a current pending native refusal preserves the unavailable-host reconnect diagnostic',async t=>{
  const f=fixture({placement:{async acquire(request){return{kind:'pending',scope:request.scope,reason:'Native request is pending'};}}});
  t.after(()=>f.app.dispose());await f.app.start();const pending=await f.app.openReserved(scope);
  f.connectionLost(new ServiceConnectionLost('Host disconnected. Reconnect before continuing.'));const before=f.app.getSnapshot().error;
  assert.equal(f.app.settlePlacement(pending,{kind:'refused',reason:'Native window refused after disconnect'}),true);
  assert.equal(f.app.getSnapshot().lastPlacement.kind,'refused');assert.equal(f.app.getSnapshot().lastPlacement.reason,'Native window refused after disconnect');
  assert.equal(f.app.getSnapshot().error,before);
});

for(const terminal of ['refused','thrown'])test(`an in-flight ${terminal} native response preserves unavailable-host guidance`,async t=>{
  const entered=deferred(),gate=deferred();
  const f=fixture({placement:{async acquire(){entered.resolve();return gate.promise;}}});
  t.after(()=>f.app.dispose());await f.app.start();const opening=f.app.openReserved(scope);await entered.promise;
  f.connectionLost(new ServiceConnectionLost('Connection lost. Reconnect to restore host access.'));const before=f.app.getSnapshot().error;
  if(terminal==='refused')gate.resolve({kind:'refused',reason:'Native request refused while host was away'});else gate.reject(new Error('Native request threw while host was away'));
  const result=await opening;assert.equal(result.kind,'refused');assert.match(result.reason,/Native request/);assert.equal(f.app.getSnapshot().lastPlacement,result);
  assert.equal(f.app.getSnapshot().error,before);
});

for(const kind of ['pending','detached'])test(`known ${kind} placement survives a failed main catalog read`,async t=>{
  let moving=false,abortCatalog=false,f,native;
  const placement={async acquire(request,owner){
    if(!moving)return{kind:'inline',view:{kind:'acquired',storage:await f.storage.reopen('known-placement-source',()=>{})}};
    if(owner.storage.viewId==='known-placement-source'){await owner.release();abortCatalog=true;}
    native??=kind==='pending'?{kind,scope:request.scope,reason:'Assigned child is still becoming ready'}:{kind,scope:request.scope,label:'known-child'};
    return native;
  }};
  f=fixture({placement});f.storage.catalogViewId='original-view';t.after(()=>f.app.dispose());
  f.behavior.read=async()=>{if(abortCatalog){abortCatalog=false;throw new Error('Retained main catalog read aborted');}};
  await f.app.start();await f.app.openReserved(scope);await f.app.getSnapshot().active.store.setDraft('Exact source before known handoff');moving=true;
  const result=await f.app.openReserved(scope);
  assert.equal(result,native,'local restoration cannot change a known native result');assert.equal(f.app.getSnapshot().lastPlacement,native);
  assert.match(f.app.getSnapshot().error,/Retained main catalog read aborted/);assert.equal(f.app.getSnapshot().active,null);
  assert.equal(applicationEnabled(f.app.getSnapshot()),false);assert.match(f.app.getSnapshot().storageFailure,/Retained main catalog read aborted/);
  const failedOwner=f.leases.find(lease=>lease.viewId==='original-view'&&!lease.closed);
  assert.equal(f.drafts.get('known-placement-source/host/conversation').draft,'Exact source before known handoff');
  await f.app.reconnect();assert.equal(f.app.getSnapshot().error,'');assert.equal(f.app.getSnapshot().storageFailure,'');assert.equal(applicationEnabled(f.app.getSnapshot()),true);assert.equal(f.app.getSnapshot().saved,f.views.get('original-view/host'));
  assert.equal(failedOwner.closed,true,'explicit reconnect releases the failed physical catalog owner');assert.ok(f.leases.some(lease=>lease!==failedOwner&&lease.viewId==='original-view'&&!lease.closed));
  await f.app.refreshCatalog();assert.ok(f.app.getSnapshot().catalog.items.length);assert.equal(f.drafts.get('known-placement-source/host/conversation').draft,'Exact source before known handoff');
});

for(const kind of ['pending','detached'])test(`confirmed creation keeps known ${kind} placement after main restoration fails`,async t=>{
  let abortCatalog=false,f,native;
  const placement={async acquire(request,owner){
    if(request.creation)return{kind:'inline',view:{kind:'acquired',storage:await f.storage.reopen('known-creation-source',()=>{})}};
    if(owner.storage.viewId!=='known-creation-source')return native;
    await owner.release();abortCatalog=true;
    native=kind==='pending'?{kind,scope:request.scope,reason:'Created child is becoming ready'}:{kind,scope:request.scope,label:'created-child'};return native;
  }};
  f=fixture({placement});f.storage.catalogViewId='original-view';t.after(()=>f.app.dispose());
  f.behavior.read=async()=>{if(abortCatalog){abortCatalog=false;throw new Error('Created chat main catalog read aborted');}};
  await f.app.start();const result=await f.app.create();
  assert.equal(result,native);assert.equal(f.app.getSnapshot().lastPlacement,native);assert.match(f.app.getSnapshot().error,/Created chat main catalog read aborted/);
  assert.deepEqual(f.created,[native.scope]);assert.deepEqual(f.views.get('known-creation-source/host').pendingCreation.scope,native.scope,'local uncertainty never erases the creation record');
  assert.equal(applicationEnabled(f.app.getSnapshot()),false);assert.match(f.app.getSnapshot().storageFailure,/Created chat main catalog read aborted/);const sourceSaved=structuredClone(f.views.get('known-creation-source/host'));
  await f.app.reconnect();assert.equal(f.app.getSnapshot().storageFailure,'');assert.equal(applicationEnabled(f.app.getSnapshot()),true);await f.app.refreshCatalog();assert.deepEqual(f.views.get('known-creation-source/host'),sourceSaved);assert.deepEqual(f.created,[native.scope]);
});

test('unavailable-host precheck preserves disconnect guidance before opening',async t=>{
  let requests=0;const f=fixture({placement:{async acquire(){requests++;throw new Error('No placement while host is unavailable');}}});t.after(()=>f.app.dispose());
  await f.app.start();f.connectionLost(new ServiceConnectionLost('Host disconnected during native intent lookup. Reconnect to continue.'));
  const before=f.app.getSnapshot().error,result=await f.app.openReserved(scope);
  assert.equal(result.kind,'refused');assert.equal(f.app.getSnapshot().error,before);assert.equal(requests,0);assert.equal(f.app.getSnapshot().busy,false);
});

test('double source and catalog read failure retains both causes with native guidance',async t=>{
  let moving=false,f;const failures=[];
  const placement={async acquire(_request,owner){
    if(!moving)return{kind:'inline',view:{kind:'acquired',storage:await f.storage.reopen('double-read-source',()=>{})}};
    await owner.release();failures.push('Original source read aborted','Fallback catalog read aborted');return{kind:'refused',reason:'Inspect uncertain native reservation before retrying'};
  }};
  f=fixture({placement});f.storage.catalogViewId='original-view';t.after(()=>f.app.dispose());f.behavior.read=async()=>{if(failures.length)throw new Error(failures.shift());};
  await f.app.start();await f.app.openReserved(scope);moving=true;const result=await f.app.openReserved(scope);
  assert.equal(result.kind,'refused');for(const part of ['Inspect uncertain native reservation','Original source read aborted','Fallback catalog read aborted']){assert.ok(result.reason.includes(part));assert.ok(f.app.getSnapshot().error.includes(part));}
});

for(const action of ['release','quiesce'])test(`late native refusal after ${action} does not restart a disconnected source feed`,async t=>{
  let moving=false,f;const entered=deferred(),gate=deferred();
  const placement={async acquire(_request,owner){
    if(!moving)return owner.storage.viewId==='feed-source'?{kind:'inline',view:{kind:'owned',viewId:owner.storage.viewId}}:{kind:'inline',view:{kind:'acquired',storage:await f.storage.reopen('feed-source',()=>{})}};
    await owner[action]();entered.resolve();return gate.promise;
  }};
  f=fixture({placement});f.storage.catalogViewId='original-view';t.after(()=>f.app.dispose());await f.app.start();await f.app.openReserved(scope);
  const draft='Keep exact draft across disconnected source restore';await f.app.getSnapshot().active.store.setDraft(draft);const feeds=f.feeds.length;moving=true;
  const opening=f.app.openReserved(scope);await entered.promise;f.connectionLost(new ServiceConnectionLost('Disconnected after source handoff. Explicitly reconnect.'));const before=f.app.getSnapshot().error;
  gate.resolve({kind:'refused',reason:'Native request refused after source pause'});assert.equal((await opening).kind,'refused');
  assert.equal(f.feeds.length,feeds,'no new host feed opens before explicit reconnect');assert.equal(f.app.getSnapshot().active,null);assert.equal(f.app.getSnapshot().error,before);
  moving=false;await f.app.reconnect();assert.equal(f.feeds.length,feeds+1);assert.equal(f.app.getSnapshot().active.store.getSnapshot().draft,draft);
});

for(const stage of ['startup','reconnect'])test(`${stage} saved-route late placement failure preserves authoritative disconnect guidance`,async t=>{
  let holding=stage==='startup';const entered=deferred(),gate=deferred();
  const f=fixture({placement:{async acquire(_request,owner){if(holding){entered.resolve();return gate.promise;}return{kind:'inline',view:{kind:'owned',viewId:owner.storage.viewId}};}}});
  t.after(()=>f.app.dispose());f.views.set('original-view/host',{...empty(),route:scope});
  f.drafts.set('original-view/host/conversation',{version:3,scope,draft:'Saved route exact draft',draftRevision:1,image:null,outbox:[],frontendSends:[]});
  let restoring;if(stage==='startup')restoring=f.app.start();else{await f.app.start();holding=true;restoring=f.app.reconnect();}
  await entered.promise;const feeds=f.feeds.length;f.connectionLost(new ServiceConnectionLost('Connection lost during saved-route placement. Reconnect required.'));const before=f.app.getSnapshot().error;
  gate.reject(new Error('Late native saved-route placement failed'));await restoring;
  assert.equal(f.app.getSnapshot().host.kind,'unavailable');assert.equal(f.app.getSnapshot().error,before);assert.equal(f.feeds.length,feeds);
  assert.equal(f.app.getSnapshot().lastPlacement.kind,'refused');assert.match(f.app.getSnapshot().lastPlacement.reason,/Late native saved-route placement failed/);
  holding=false;await f.app.reconnect();assert.equal(f.app.getSnapshot().error,'');assert.equal(f.app.getSnapshot().active.store.getSnapshot().draft,'Saved route exact draft');
});

for(const stage of ['initial','reconnect'])test(`${stage} handshake still exposes its fresh failure cause`,async t=>{
  const f=fixture();t.after(()=>f.app.dispose());if(stage==='reconnect'){await f.app.start();f.connectionLost(new ServiceConnectionLost('Old connection diagnostic'));}
  f.behavior.metadata=async()=>{throw new Error('Fresh handshake metadata failure');};if(stage==='initial')await f.app.start();else await f.app.reconnect();
  assert.equal(f.app.getSnapshot().error,'Fresh handshake metadata failure');assert.equal(f.app.getSnapshot().host.kind,'unavailable');
});

async function failedRestoration(t,native,fault,{catalog=true,disconnect=false}={}){
  let f,moving=false,selectFailure=false,requests=0,known;const reads=[];
  const placement={async acquire(request,owner){
    requests++;
    if(!moving)return owner.storage.viewId==='unhealthy-source'?{kind:'inline',view:{kind:'owned',viewId:owner.storage.viewId}}:{kind:'inline',view:{kind:'acquired',storage:await f.storage.reopen('unhealthy-source',()=>{})}};
    if(owner.storage.viewId==='unhealthy-source'){
      await owner.release();
      if(fault==='select')selectFailure=true;else reads.push(...(native==='pending'?['Catalog load aborted']:['Source load aborted','Catalog load aborted']));
      if(disconnect)f.connectionLost(new ServiceConnectionLost('Connection lost after release. Reconnect required.'));
    }
    if(native==='thrown')throw new Error('Native launch threw; inspect its reservation');
    known??=native==='pending'?{kind:'pending',scope:request.scope,reason:'Recorded child remains pending'}:{kind:'refused',reason:'Native reservation needs inspection'};
    return known;
  }};
  f=fixture({placement});if(catalog)f.storage.catalogViewId='original-view';t.after(()=>f.app.dispose());
  f.behavior.read=async()=>{if(reads.length)throw new Error(reads.shift());};
  f.behavior.reopen=async id=>{if(moving&&fault==='select'&&id==='unhealthy-source'&&(native!=='pending'||!catalog))throw new Error('Former source is unavailable');};
  f.behavior.select=()=>{if(selectFailure){selectFailure=false;throw new Error('Catalog selection aborted');}};
  await f.app.start();await f.app.openReserved(scope);await f.app.getSnapshot().active.store.setDraft('C8 source bytes');moving=true;
  const result=await f.app.openReserved(scope);
  return{f,result,known:()=>known,requests:()=>requests,ready:()=>{moving=false;selectFailure=false;reads.length=0;}};
}

for(const native of ['pending','refused','thrown'])for(const fault of ['read','select'])test(`${native} placement with ${fault} restoration failure has the same disabled local-owner state`,async t=>{
  const x=await failedRestoration(t,native,fault),{f,result}=x;
  assert.equal(result.kind,native==='pending'?'pending':'refused');if(native==='pending')assert.equal(result,x.known());
  assert.equal(applicationEnabled(f.app.getSnapshot()),false);assert.match(f.app.getSnapshot().storageFailure,/Catalog (load|selection) aborted/);
  if(native!=='pending'){assert.match(result.reason,/Native/);assert.match(result.reason,/Catalog (load|selection) aborted/);}
  const requests=x.requests();await f.app.openReserved({...scope,conversationId:'must-not-place-while-unloaded'});assert.equal(x.requests(),requests,'failed local storage cannot issue another native placement');
  x.ready();await f.app.reconnect();assert.equal(f.app.getSnapshot().storageFailure,'');assert.equal(applicationEnabled(f.app.getSnapshot()),true);assert.equal(f.app.getSnapshot().active.store.getSnapshot().draft,'C8 source bytes');
});

test('explicit reconnect recovers a missing owner without a retained catalog',async t=>{
  const x=await failedRestoration(t,'thrown','select',{catalog:false}),{f}=x;
  assert.equal(applicationEnabled(f.app.getSnapshot()),false);assert.match(f.app.getSnapshot().storageFailure,/Former source is unavailable/);
  x.ready();await f.app.reconnect();assert.equal(f.app.getSnapshot().storageFailure,'');assert.equal(applicationEnabled(f.app.getSnapshot()),true);assert.equal((await f.app.openReserved(scope)).kind,'inline');assert.equal(f.app.getSnapshot().active.store.getSnapshot().draft,'C8 source bytes');
});

test('later teardown cancels a storage-recovery restart while its original disposal drains',async t=>{
  const x=await failedRestoration(t,'pending','read'),{f}=x;const entered=deferred(),close=deferred();t.after(close.resolve);
  f.behavior.close=async owner=>{if(owner.viewId==='original-view'){entered.resolve();await close.promise;}};
  const owners=f.leases.length,metadata=f.metadataCalls(),feeds=f.feeds.length;x.ready();const reconnecting=f.app.reconnect();await entered.promise;
  const teardown=f.app.dispose();
  try { assert.equal(f.app.dispose(),teardown,'repeated teardown shares disposal while cancelling the queued restart'); }
  finally { close.resolve(); }
  await Promise.all([reconnecting,teardown]);
  assert.equal(f.leases.length,owners,'no replacement owner starts after teardown');assert.equal(f.metadataCalls(),metadata);assert.equal(f.feeds.length,feeds);assert.ok(f.leases.every(owner=>owner.closed));
  assert.equal(f.drafts.get('unhealthy-source/host/conversation').draft,'C8 source bytes');
});

for(const fault of ['draft','route'])test(`saved-route ${fault} recovery failure preserves the already reported inline placement`,async t=>{
  const newest={...scope,conversationId:'reported-inline-successor'};let f;
  const placement={async acquire(_request,owner){
    if(fault==='route')owner.storage.saveView=async()=>{throw new Error('Recovered route write aborted');};
    return{kind:'inline',view:{kind:'owned',viewId:owner.storage.viewId}};
  }};
  f=fixture({placement});t.after(()=>f.app.dispose());f.views.set('original-view/host',{...empty(),route:scope});
  f.drafts.set('original-view/host/conversation',{version:3,scope,draft:'Original predecessor bytes',draftRevision:1,image:null,outbox:[],frontendSends:[]});
  f.behavior.continuation=async input=>input.scope.conversationId===scope.conversationId?{predecessor:null,carried:null,closure:'cancelled',successor:{kind:'confirmed',scope:newest}}:{predecessor:null,carried:null,closure:null,successor:null};
  f.storage.locate=async selected=>{if(fault==='draft'&&selected.conversationId===scope.conversationId&&f.app.getSnapshot().active?.scope.conversationId===newest.conversationId)throw new Error('Predecessor draft lookup aborted');return null;};
  await f.app.start();assert.deepEqual(f.app.getSnapshot().active.scope,newest);assert.equal(f.app.getSnapshot().lastPlacement.kind,'inline');assert.deepEqual(f.app.getSnapshot().lastPlacement.scope,newest);
  assert.match(f.app.getSnapshot().error,fault==='draft'?/Predecessor draft lookup aborted/:/Recovered route write aborted/);assert.equal(f.drafts.get('original-view/host/conversation').draft,'Original predecessor bytes');
});

test('a known pending outcome with local read failure keeps the authoritative disconnect diagnostic',async t=>{
  const x=await failedRestoration(t,'pending','read',{disconnect:true}),{f,result}=x;
  assert.equal(result,x.known());assert.equal(f.app.getSnapshot().lastPlacement,result);assert.match(f.app.getSnapshot().storageFailure,/Catalog load aborted/);
  assert.equal(f.app.getSnapshot().error,'Connection lost after release. Reconnect required.');assert.equal(applicationEnabled(f.app.getSnapshot()),false);
});

test('detached creation cleanup waits for reconnect without placing the confirmed creation again',async t=>{
  let f,native,disconnect=true;let requests=0;const placement={async acquire(request,owner){
    if(request.creation)return{kind:'inline',view:{kind:'owned',viewId:owner.storage.viewId}};
    requests++;
    if(disconnect)f.connectionLost(new ServiceConnectionLost('Disconnected before local creation cleanup. Reconnect.'));
    native={kind:'detached',scope:request.scope,label:'already-open-child'};return native;
  }};
  f=fixture({placement});t.after(()=>f.app.dispose());await f.app.start();const result=await f.app.create();
  assert.equal(result,native);assert.equal(f.app.getSnapshot().lastPlacement,native);assert.equal(f.app.getSnapshot().error,'Disconnected before local creation cleanup. Reconnect.');assert.deepEqual(f.views.get('original-view/host').pendingCreation.scope,native.scope);
  const created=f.created.length;disconnect=false;await f.app.reconnect();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.views.get('original-view/host').pendingCreation,null);assert.equal(f.app.getSnapshot().saved.pendingCreation,null);
  assert.equal(f.created.length,created,'confirmed host creation is not replayed');assert.equal(requests,1,'confirmed native placement is not replayed');
  assert.equal((await f.app.create()).kind,'detached');assert.equal(f.created.length,created+1);
});

test('explicit refresh clears stale connection guidance while loading',async t=>{
  const f=fixture();t.after(()=>f.app.dispose());await f.app.start();f.connectionLost(new ServiceConnectionLost('Old disconnect guidance'));
  const entered=deferred(),metadata=deferred();t.after(metadata.resolve);f.behavior.metadata=async()=>{entered.resolve();await metadata.promise;};const reconnecting=f.app.reconnect();await entered.promise;
  assert.equal(f.app.getSnapshot().host.kind,'loading');assert.equal(f.app.getSnapshot().error,'');metadata.resolve();await reconnecting;assert.equal(f.app.getSnapshot().host.kind,'ready');
});

test('definitive incompatible metadata replaces stale disconnect guidance',async t=>{
  const f=fixture();t.after(()=>f.app.dispose());await f.app.start();f.connectionLost(new ServiceConnectionLost('Stale unavailable-host message'));f.behavior.wireVersion='incompatible-wire';await f.app.reconnect();
  assert.equal(f.app.getSnapshot().host.kind,'incompatible');assert.equal(f.app.getSnapshot().error,'');
});

test('a new disconnect during refresh remains authoritative over late incompatible metadata',async t=>{
  const f=fixture();t.after(()=>f.app.dispose());await f.app.start();f.connectionLost(new ServiceConnectionLost('Old disconnect'));
  const entered=deferred(),metadata=deferred();t.after(metadata.resolve);f.behavior.metadata=async()=>{entered.resolve();await metadata.promise;};f.behavior.wireVersion='incompatible-wire';const reconnecting=f.app.reconnect();await entered.promise;
  f.connectionLost(new ServiceConnectionLost('New disconnect during explicit refresh'));metadata.resolve();await reconnecting;
  assert.equal(f.app.getSnapshot().host.kind,'unavailable');assert.equal(f.app.getSnapshot().error,'New disconnect during explicit refresh');
});


test('loaded catalog storage read failure can be retried explicitly after storage recovers', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  await f.app.start();
  const firstOwner = f.leases[0];
  f.connectionLost(new ServiceConnectionLost('Reconnect to inspect local storage.'));
  let reads = 0;
  f.behavior.read = async () => { if (++reads === 1) throw new Error('Transient saved-view read failure'); };
  await f.app.reconnect();
  assert.match(f.app.getSnapshot().storageFailure, /Transient saved-view read failure/);
  await f.app.reconnect();
  assert.ok(reads >= 2, 'a fresh explicit retry reaches saved-view storage');
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  assert.equal(firstOwner.closed, true);
  assert.equal(f.app.getSnapshot().storageFailure, '');
});

test('restoration navigation failure disables the owning catalog and explicit reconnect restores its saved draft', async t => {
  let f, moving = false;
  const placement = { async acquire(request, owner) {
    if (moving) { await owner.quiesce(); f.behavior.navigation = async () => { throw new Error('Catalog navigation transaction failed'); }; return { kind: 'refused', reason: 'Child placement refused' }; }
    return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
  } };
  f = fixture({ placement }); f.storage.catalogViewId = 'original-view'; t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start(); await f.app.getSnapshot().active.store.setDraft('Navigation recovery exact bytes');
  moving = true;
  const result = await f.app.openReserved({ ...scope, conversationId: 'other' });
  assert.equal(result.kind, 'refused');
  assert.equal(applicationEnabled(f.app.getSnapshot()), false);
  assert.match(f.app.getSnapshot().storageFailure, /Catalog navigation transaction failed/);
  assert.equal(f.app.getSnapshot().active, null);
  moving = false; f.behavior.navigation = async () => {};
  await f.app.reconnect();
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  assert.equal(f.app.getSnapshot().active.store.getSnapshot().draft, 'Navigation recovery exact bytes');
});

test('an opening rejected by local storage preserves the previously admitted pending placement identity', async t => {
  const x = await failedRestoration(t, 'pending', 'read'), { f, result } = x;
  assert.equal(f.app.getSnapshot().lastPlacement, result);
  const rejected = await f.app.openReserved({ ...scope, conversationId: 'cannot-open' });
  assert.equal(rejected.kind, 'refused');
  assert.equal(f.app.getSnapshot().lastPlacement, result, 'no new placement request displaced its pending owner');
  const terminal = { kind: 'detached', scope: result.scope, label: 'original-child' };
  assert.equal(f.app.settlePlacement(result, terminal), true);
  assert.equal(f.app.getSnapshot().lastPlacement, terminal);
});

test('a principal transition interrupted by disconnect clears the old active editor before publishing ready', async t => {
  const f = fixture(), gate = deferred(), entered = deferred(), lookup = deferred(), lookupEntered = deferred();
  t.after(async () => { gate.resolve(); lookup.resolve(); await f.app.dispose(); });
  f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  f.views.set('original-view/host', { ...empty(), route: scope });
  const generation = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'principal-transition', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'Retained callback' }, decodeInput: x => x, async execute() { throw new Error('No effects'); } }); return { dispose() {} }; } });
  t.after(() => generation.generation.retire());
  const token = {}; f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [generation.generation] });
  await f.app.start(); const original = f.app.getSnapshot().active;
  await assert.rejects(original.store.send('Retain original principal capture'), /Reply lost/);
  let held = true;
  f.behavior.write = async () => { if (held) { entered.resolve(); await gate.promise; } };
  f.behavior.principalId = 'replacement';
  const transitioning = f.app.reconnect(); await entered.promise;
  f.connectionLost(new ServiceConnectionLost('Disconnected during principal authority transition'));
  held = false; gate.resolve(); await transitioning;
  assert.equal(f.app.getSnapshot().host.kind, 'unavailable');
  f.behavior.agentLookup = async () => { lookupEntered.resolve(); await lookup.promise; return f.descriptor(); };
  const ready = []; const unsubscribe = f.app.subscribe(() => { const state = f.app.getSnapshot(); if (state.host.kind === 'ready') ready.push(state.active); });
  try {
    const reconnecting = f.app.reconnect(); await lookupEntered.promise;
    assert.ok(ready.length > 0);
    assert.equal(ready[0], null, 'the old principal active editor is cleared before ready publication');
    lookup.resolve(); await reconnecting;
  } finally { unsubscribe(); lookup.resolve(); }
  assert.equal(f.drafts.get('original-view/host/conversation').frontendSends[0].ownerId, 'principal');
});


for (const fault of ['read', 'same-navigation', 'other-navigation']) test(`active editor storage recovery restores exact saved bytes after ${fault} fault`, async t => {
  const f = fixture(); f.storage.catalogViewId = 'original-view'; t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope }); await f.app.start();
  await f.app.getSnapshot().active.store.setDraft('Active storage recovery exact bytes');
  const original = f.leases[0];
  if (fault === 'read') { let once = true; f.behavior.read = async () => { if (once) { once = false; throw new Error('One-shot active read abort'); } }; await f.app.reconnect(); }
  else { let once = true; f.behavior.navigation = async () => { if (once) { once = false; throw new Error('One-shot active navigation abort'); } }; await f.app.openReserved(fault === 'same-navigation' ? scope : { ...scope, conversationId: 'other-active-target' }); }
  assert.equal(applicationEnabled(f.app.getSnapshot()), false); assert.ok(f.app.getSnapshot().active);
  await f.app.reconnect();
  assert.equal(applicationEnabled(f.app.getSnapshot()), true); assert.equal(original.closed, true);
  assert.equal(f.app.getSnapshot().active.store.getSnapshot().draft, 'Active storage recovery exact bytes');
  assert.deepEqual(f.app.getSnapshot().active.scope, scope); assert.deepEqual(f.submitted, []);
});

for (const kind of ['pending', 'detached']) test(`one reconnect reactivates retained source while confirmed ${kind} creation cleanup completes`, async t => {
  let f, separate = false;
  const placement = { async acquire(request, owner) {
    if (request.creation || !separate) return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
    f.connectionLost(new ServiceConnectionLost('Creation placement disconnected the source'));
    return kind === 'pending' ? { kind, scope: request.scope, reason: 'Awaiting known child' } : { kind, scope: request.scope, label: 'known-created-child' };
  } };
  f = fixture({ placement }); t.after(() => f.app.dispose()); f.views.set('original-view/host', { ...empty(), route: scope }); await f.app.start();
  const original = f.app.getSnapshot().active; await original.store.setDraft('Retained source exact bytes'); separate = true;
  const result = await f.app.create(); if (kind === 'pending') f.app.settlePlacement(result, { kind: 'detached', scope: result.scope, label: 'settled-child' });
  const feeds = f.feeds.length; separate = false; await f.app.reconnect();
  assert.equal(f.app.getSnapshot().saved.pendingCreation, null); assert.equal(f.feeds.length, feeds + 1, 'one explicit reconnect opens the retained source feed');
  assert.equal(f.app.getSnapshot().active.store, original.store); assert.equal(f.app.getSnapshot().active.store.getSnapshot().draft, 'Retained source exact bytes');
  assert.equal(f.created.length, 1);
});

for (const kind of ['pending', 'detached']) test(`confirmed ${kind} creation marker cleanup survives a failed commit and storage reacquisition`, async t => {
  let f, finalPlacements = 0, fail = true;
  const placement = { async acquire(request, owner) {
    if (request.creation) return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } };
    finalPlacements++;
    const save = owner.storage.saveView.bind(owner.storage);
    owner.storage.saveView = async (host, next) => { if (fail && next.pendingCreation === null) throw new Error('Creation cleanup commit aborted'); return save(host, next); };
    return kind === 'pending' ? { kind, scope: request.scope, reason: 'Waiting for child' } : { kind, scope: request.scope, label: 'known-created-child' };
  } };
  f = fixture({ placement }); t.after(() => f.app.dispose()); await f.app.start(); const result = await f.app.create();
  if (kind === 'pending') { f.app.settlePlacement(result, { kind: 'detached', scope: result.scope, label: 'settled-child' }); await new Promise(resolve => setImmediate(resolve)); }
  assert.match(f.app.getSnapshot().storageFailure, /Creation cleanup commit aborted/); assert.deepEqual(f.views.get('original-view/host').pendingCreation.scope, result.scope);
  fail = false; await f.app.reconnect();
  assert.equal(f.app.getSnapshot().storageFailure, ''); assert.equal(f.views.get('original-view/host').pendingCreation, null);
  assert.equal(f.created.length, 1, 'completed host creation was not replayed'); assert.equal(finalPlacements, 1, 'known detached placement was not replayed');
  assert.equal((await f.app.create()).kind, kind); assert.equal(f.created.length, 2);
});

for (const target of ['other-view', 'new-marker']) test(`late confirmed creation cannot clear ${target} pending record`, async t => {
  const placement = { async acquire(request, owner) { return request.creation ? { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } } : { kind: 'pending', scope: request.scope, reason: 'Late creation child' }; } };
  const f = fixture({ placement }); t.after(() => f.app.dispose()); await f.app.start(); const pending = await f.app.create();
  const other = { scope: { ...scope, conversationId: 'unrelated-pending-marker' }, agentId: 'other' };
  if (target === 'other-view') { f.views.set('other-view/host', { ...empty(), pendingCreation: other }); await f.app.reopenView('other-view'); }
  else { f.views.set('original-view/host', { ...empty(), pendingCreation: other }); await f.app.reconnect(); }
  assert.equal(f.app.settlePlacement(pending, { kind: 'detached', scope: pending.scope, label: 'late-child' }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, other);
  if (target === 'other-view') { await f.app.reopenView('original-view'); assert.equal(f.views.get('original-view/host').pendingCreation, null, 'original view cleanup resumes only when its matching marker is loaded'); }
});

test('storage-blocked placement refusal fits the placement parser and preserves prior identity', async t => {
  const { parseConversationOpenResult } = await import('@openpane/contracts');
  const x = await failedRestoration(t, 'pending', 'read'), { f, result } = x;
  for (const diagnostic of ['x'.repeat(999) + '😀'.repeat(300), '\uD800']) {
    f.leases.find(owner => !owner.closed).failure(new Error(diagnostic));
    assert.equal(f.app.getSnapshot().storageFailure, diagnostic, 'the diagnostic reaches the failed owner before refusal');
    const refused = await f.app.openReserved(scope);
    assert.doesNotThrow(() => parseConversationOpenResult(refused)); assert.equal(f.app.getSnapshot().lastPlacement, result);
  }
});


test('late pending creation settlement survives a storage restart without replaying creation', async t => {
  let placements = 0;
  const placement = { async acquire(request, owner) { if (!request.creation) { placements++; return { kind: 'pending', scope: request.scope, reason: 'Pending across local recovery' }; } return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } }; } };
  const f = fixture({ placement }); t.after(() => f.app.dispose()); await f.app.start(); const pending = await f.app.create();
  f.leases[0].failure(new Error('Reacquire original editor')); await f.app.reconnect();
  assert.equal(f.app.getSnapshot().storageFailure, ''); assert.deepEqual(f.app.getSnapshot().saved.pendingCreation.scope, pending.scope);
  assert.equal(f.app.settlePlacement(pending, { kind: 'detached', scope: pending.scope, label: 'late-after-restart' }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.getSnapshot().saved.pendingCreation, null); assert.equal(f.created.length, 1); assert.equal(placements, 1);
});

test('active storage recovery retains image bytes and captured journal identity through the real lease pool', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); f.views.set('original-view/host', { ...empty(), route: scope });
  f.drafts.set('original-view/host/conversation', journalRecord(scope));
  f.behavior.binding = async request => ({ kind: 'pending', id: request.id }); f.behavior.uuids = true;
  f.behavior.uploadImage = async input => ({ imageId: '00000000-0000-4000-8000-aaaaaaaaaaaa', name: input.name, mediaType: 'image/png', byteLength: input.bytes.byteLength, width: 1, height: 1 });
  await f.app.start(); const active = f.app.getSnapshot().active;
  await active.store.setDraft('Pinned capture and image exact draft');
  await active.store.selectImage({ name: 'recovery.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]) });
  const saved = structuredClone(f.drafts.get('original-view/host/conversation'));
  let once = true; f.behavior.read = async () => { if (once) { once = false; throw new Error('Read aborted with retained image and capture'); } };
  await f.app.reconnect(); await f.app.reconnect();
  const restored = f.app.getSnapshot().active.store.getSnapshot(), durable = f.drafts.get('original-view/host/conversation');
  assert.equal(applicationEnabled(f.app.getSnapshot()), true); assert.equal(restored.draft, saved.draft); assert.equal(restored.image.status, 'ready');
  assert.deepEqual(durable.image, saved.image); assert.deepEqual(durable.frontendSends[0].command, saved.frontendSends[0].command); assert.equal(durable.frontendSends[0].ownerId, saved.frontendSends[0].ownerId);
  const imageBytes = await f.leases.find(owner => !owner.closed).drafts(() => {}).loadImage(scope, durable.image.selectionId);
  assert.deepEqual([...imageBytes], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
});


test('confirmed creation arriving while storage recovery drains survives the sessionless interval', async t => {
  let placements = 0;
  const placement = { async acquire(request, owner) { if (!request.creation) { placements++; return { kind: 'pending', scope: request.scope, reason: 'Pending during physical recovery' }; } return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } }; } };
  const f = fixture({ placement }), gate = deferred(), entered = deferred();
  t.after(async () => { gate.resolve(); await f.app.dispose(); }); await f.app.start(); const pending = await f.app.create();
  f.leases[0].failure(new Error('Recover original storage after closure'));
  f.behavior.close = async () => { entered.resolve(); await gate.promise; };
  const reconnecting = f.app.reconnect(); await entered.promise;
  try { assert.equal(f.app.settlePlacement(pending, { kind: 'detached', scope: pending.scope, label: 'known-during-drain' }), true); }
  finally { gate.resolve(); await reconnecting; }
  assert.equal(f.app.getSnapshot().storageFailure, ''); assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
  assert.equal(f.created.length, 1); assert.equal(placements, 1);
});


test('native readiness settling during a held send clears confirmed creation before commands become idle', async t => {
  const { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js');
  const { BrowserViewStorage } = await import('../../apps/desktop/dist/application/browser-storage.js');
  const locate = BrowserViewStorage.locateEditor;
  BrowserViewStorage.locateEditor = async () => ({ binding: null, legacyViewIds: [] });
  t.after(() => { BrowserViewStorage.locateEditor = locate; });
  const lookup = deferred(), lookupEntered = deferred(), send = deferred(), sendEntered = deferred();
  let ready = false, holdRecovery = false, reservation;
  const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
    if (command.kind === 'reservations') return [reservation];
    if (command.kind === 'lookup') {
      if (holdRecovery) { holdRecovery = false; lookupEntered.resolve(); await lookup.promise; }
      reservation = { scope: command.scope, viewId: 'native-target', label: 'known-child', transitionId: 'transition', creationAgentId: 'default', phase: ready ? 'target-ready' : 'requested', bindingRevision: ready ? 1 : null, writerGeneration: ready ? 1 : null };
      return { kind: ready ? 'ready' : 'opening', reservation };
    }
    if (command.kind === 'launch') return { kind: 'pending', scope: command.scope, reason: 'Native readiness is in flight' };
    throw new Error(command.kind);
  } };
  const coordinator = new WindowCoordinator(port);
  const placement = { async acquire(request, owner) { return request.creation || request.scope.conversationId === scope.conversationId ? { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } } : coordinator.acquire(request, owner); } };
  const f = fixture({ placement });
  t.after(async () => { lookup.resolve(); send.resolve(); await f.app.dispose(); });
  f.views.set('original-view/host', { ...empty(), route: scope }); await f.app.start(); await deliver(f);
  const active = f.app.getSnapshot().active, pending = await f.app.create();
  const runtime = Object.assign(Object.create(WindowRuntime.prototype), { context: { role: 'main' }, controller: f.app, coordinator, carryRecoveryAfter: null, policyScope: null,
    snapshot: { placementNotice: null }, listeners: new Set(), port });
  ready = true; holdRecovery = true;
  const recovering = runtime.readRecovery(); await lookupEntered.promise;
  f.behavior.submit = async command => { sendEntered.resolve(); await send.promise; return resultFor(command, { kind: 'completed' }); };
  const sending = f.app.conversationActions(active).commands.send('Held fixture send'); await sendEntered.promise;
  lookup.resolve(); await recovering;
  assert.equal(f.app.getSnapshot().busy, true); assert.deepEqual(f.app.getSnapshot().saved.pendingCreation.scope, pending.scope);
  send.resolve(); await sending;
  assert.equal(f.app.getSnapshot().busy, false); assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
  ready = false;
  assert.equal((await f.app.create()).kind, 'pending', 'the next New Chat needs no failed click or creation replay');
  assert.equal(f.created.length, 2);
});

test('coordinator refusal diagnostics stay nonempty, bounded and valid Unicode for the native boundary', async () => {
  const { parseConversationOpenResult } = await import('@openpane/contracts');
  for (const diagnostic of ['x'.repeat(999) + '😀', 'bad\uD800diagnostic', '']) {
    const coordinator = new WindowCoordinator({ context: { role: 'main' }, async request() { throw new Error(diagnostic); } });
    const result = await coordinator.acquire({ scope, creation: false, agentId: 'agent', agentLabel: 'Agent', carryFrom: null, initialDraft: null },
      { storage: { viewId: 'source' }, holds: () => false, async quiesce() {}, async release() {} });
    assert.equal(result.kind, 'refused'); assert.doesNotThrow(() => parseConversationOpenResult(result));
    assert.doesNotMatch(result.reason, /[\uD800-\uDFFF]/u);
  }
});


test('storage reconnect republishes the original pending creation identity for native recovery', async t => {
  const { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js');
  const { BrowserViewStorage } = await import('../../apps/desktop/dist/application/browser-storage.js');
  const locate = BrowserViewStorage.locateEditor;
  BrowserViewStorage.locateEditor = async () => ({ binding: null, legacyViewIds: [] });
  t.after(() => { BrowserViewStorage.locateEditor = locate; });
  let placements = 0, lookups = 0, ready = false, reservation;
  const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
    if (command.kind === 'reservations') return [reservation];
    if (command.kind === 'lookup') { lookups++; reservation = { scope: command.scope, viewId: 'original-target', label: 'known-child', transitionId: 'original-attempt', creationAgentId: 'default', phase: ready ? 'target-ready' : 'requested', bindingRevision: ready ? 1 : null, writerGeneration: ready ? 1 : null }; return { kind: ready ? 'ready' : 'opening', reservation }; }
    if (command.kind === 'launch') return { kind: 'pending', scope: command.scope, reason: 'Awaiting durable target readiness' };
    throw new Error(command.kind);
  } };
  const coordinator = new WindowCoordinator(port);
  const placement = { async acquire(request, owner) { if (!request.creation) { placements++; return coordinator.acquire(request, owner); } return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } }; } };
  const f = fixture({ placement }); t.after(() => f.app.dispose()); await f.app.start(); const pending = await f.app.create();
  assert.equal(pending.kind, 'pending');
  f.leases[0].failure(new Error('Recover the original source editor')); await f.app.reconnect();
  ready = true; const before = lookups;
  const runtime = Object.assign(Object.create(WindowRuntime.prototype), { context: { role: 'main' }, controller: f.app, coordinator, carryRecoveryAfter: null, policyScope: null,
    snapshot: { placementNotice: null }, listeners: new Set(), port });
  await runtime.readRecovery(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(lookups, before + 1, 'native recovery discovers the retained pending placement after storage restart');
  assert.equal(f.app.getSnapshot().saved.pendingCreation, null); assert.equal(f.app.getSnapshot().lastPlacement.kind, 'detached');
  assert.equal(f.created.length, 1); assert.equal(placements, 1, 'recovery never repeats native placement');
});


test('native recovery discovers an earlier creation after another pending placement becomes current', async t => {
  const { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js');
  const { BrowserViewStorage } = await import('../../apps/desktop/dist/application/browser-storage.js');
  const locate = BrowserViewStorage.locateEditor;
  BrowserViewStorage.locateEditor = async () => ({ binding: null, legacyViewIds: [] });
  t.after(() => { BrowserViewStorage.locateEditor = locate; });
  const reservations = new Map(), calls = []; let completedScope = null, placements = 0;
  const port = { context: { role: 'main', label: 'main', liveRelay: true }, async request(command) {
    if (command.kind === 'reservations') return [...reservations.values()];
    if (command.kind === 'lookup') {
      calls.push(command.scope.conversationId); const completed = completedScope?.conversationId === command.scope.conversationId;
      const reservation = { scope: command.scope, viewId: `target-${command.scope.conversationId}`, label: `child-${command.scope.conversationId}`, transitionId: `attempt-${command.scope.conversationId}`, creationAgentId: 'default', phase: completed ? 'target-ready' : 'requested', bindingRevision: completed ? 1 : null, writerGeneration: completed ? 1 : null };
      reservations.set(command.scope.conversationId, reservation); return { kind: completed ? 'closed' : 'opening', reservation };
    }
    if (command.kind === 'launch') return { kind: 'pending', scope: command.scope, reason: 'Waiting for original target' };
    throw new Error(command.kind);
  } };
  const coordinator = new WindowCoordinator(port);
  const placement = { async acquire(request, owner) { if (!request.creation) { placements++; return coordinator.acquire(request, owner); } return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } }; } };
  const f = fixture({ placement }); t.after(() => f.app.dispose()); await f.app.start(); const creation = await f.app.create();
  assert.deepEqual(f.app.pendingPlacements(), [creation], 'the current creation identity is deduplicated');
  const later = await f.app.openReserved({ hostId: 'host', conversationId: 'other-pending-chat' });
  assert.equal(f.app.getSnapshot().lastPlacement, later); assert.deepEqual(f.app.pendingPlacements(), [creation, later]);
  await f.app.reconnect(); assert.equal(f.app.getSnapshot().lastPlacement, later, 'a healthy refresh preserves the later opening identity');
  completedScope = creation.scope; const before = calls.length;
  const runtime = Object.assign(Object.create(WindowRuntime.prototype), { context: { role: 'main' }, controller: f.app, coordinator, carryRecoveryAfter: null, policyScope: null,
    snapshot: { placementNotice: null }, listeners: new Set(), port });
  await runtime.readRecovery(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.getSnapshot().saved.pendingCreation, null, 'earlier confirmed creation clears without being the current placement');
  assert.deepEqual(calls.slice(before), [creation.scope.conversationId, later.scope.conversationId]);
  assert.equal(f.app.getSnapshot().lastPlacement, later, 'earlier completion does not replace the later opening');
  assert.deepEqual(f.app.pendingPlacements(), [later]); assert.equal(f.created.length, 1); assert.equal(placements, 2);
});


for (const recovery of ['rejected', 'ambiguous']) test(`native creation recovery preserves its ${recovery} outcome and unsent draft`, async t => {
  const { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js');
  const targetScope = { hostId: 'host', conversationId: 'native-pending-creation' }, sourceScope = { hostId: 'host', conversationId: 'native-create-requester' };
  const placement = { async acquire(_request, owner) { return { kind: 'inline', view: { kind: 'owned', viewId: owner.storage.viewId } }; } };
  const f = fixture({ placement }); t.after(() => f.app.dispose());
  f.drafts.set('original-view/host/native-pending-creation', { version: 3, scope: targetScope, draft: 'Preserve original unsent creation text', draftRevision: 1, image: null, outbox: [], frontendSends: [] });
  f.behavior.agentLookup = async selected => selected.conversationId === sourceScope.conversationId ? f.descriptor() : null;
  f.behavior.create = async () => { if (f.created.length === 1) throw new ServiceError('unavailable', 'First creation reply is ambiguous'); if (f.created.length === 2) throw new ServiceError(recovery === 'rejected' ? 'create-rejected' : 'unavailable', recovery === 'rejected' ? 'Creation definitively refused' : 'Creation still needs confirmation'); };
  await f.app.start(); assert.equal((await f.app.createReserved(targetScope, 'default')).kind, 'pending');
  const target = { scope: targetScope, viewId: 'original-view', label: 'creation-child', transitionId: 'creation-attempt', creationAgentId: 'default', phase: 'assigned', bindingRevision: null, writerGeneration: null };
  let saved = { sourceScope, requestId: '1:recover-saved-creation', action: { kind: 'create', agentId: 'default', carry: false }, target, result: null };
  const runtime = Object.assign(Object.create(WindowRuntime.prototype), { context: { role: 'main' }, controller: f.app, snapshot: { placementNotice: null }, listeners: new Set(), async syncDraftCarries() {},
    port: { async request(command) {
      if (command.kind === 'read-intent') return saved;
      if (command.kind === 'lookup') return { kind: 'opening', reservation: target };
      if (command.kind === 'complete-intent') { saved = { ...saved, result: command.result }; return { ok: true }; }
      throw new Error(command.kind);
    } } });
  await runtime.processIntent(saved);
  if (recovery === 'rejected') {
    await runtime.processIntent(saved);
    assert.equal(f.created.length, 2, 'a definitive refusal is terminal for the admitted native request');
    assert.equal(saved.result?.kind, 'refused'); assert.match(saved.result.reason, /Creation definitively refused/);
    assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
  } else {
    assert.equal(f.created.length, 2); assert.equal(saved.result, null); assert.deepEqual(f.app.getSnapshot().saved.pendingCreation.scope, targetScope);
    assert.match(runtime.snapshot.placementNotice, /confirmation/);
  }
  assert.equal(f.drafts.get('original-view/host/native-pending-creation').draft, 'Preserve original unsent creation text'); assert.deepEqual(f.submitted, []);
});
