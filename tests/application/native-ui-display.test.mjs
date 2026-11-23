import assert from 'node:assert/strict';
import test from 'node:test';
import { WindowCoordinator } from '../../apps/desktop/dist/application/window-coordinator.js';
import { ChildUiConnection, NativeMainUiRelay } from '../../apps/desktop/dist/application/native-ui-relay.js';
const scope = { hostId: 'host', conversationId: 'chat' };
const context = { role: 'chat', hostId: 'host', profileId: 'profile', brokerInstance: 'broker', label: 'chat', documentIncarnation: 'child', viewId: 'view', scope };
const native = { ...context, version: 1, liveRelay: true, reservation: { scope } };
const state = display => ({ version: 1, change: 1, selection: { revision: 0, deliveryGeneration: 0, selected: { kind: 'builtin' }, previousHealthy: { kind: 'builtin' } }, bundle: null, envelope: null, transitions: [], fault: null, display });
const page = (subscription, sequence) => ({ kind: 'page', page: { kind: 'snapshot', scope, subscriptionId: subscription.subscriptionId, from: subscription.cursor,
  snapshotId: 'snapshot', highWater: sequence, publications: [], next: { kind: 'live', epoch: 1, sequence } } });
async function wait(predicate) { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Native cache did not settle'); }

test('a native child advances only its scoped cache cursor, reports presence and ignores an old cached page', async t => {
  const originalDocument = globalThis.document, originalFetch = globalThis.fetch;
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  globalThis.fetch = () => { throw new Error('Children must not poll the host UI service'); };
  let child;
  t.after(() => { child?.close(); globalThis.document = originalDocument; globalThis.fetch = originalFetch; });
  const requests = []; let cached = null, subscription = null, wake;
  const port = { context: native, async listen(_name, handler) { wake = handler; return () => {}; }, async request(command) {
    requests.push(command);
    if (command.kind === 'read-ui') return { state: cached, localBuiltin: false, context };
    if (command.kind === 'presence') subscription = command.display;
    return { ok: true };
  } };
  child = new ChildUiConnection(port);
  child.selectScope(scope); child.start(); await wait(() => subscription !== null && requests.some(request => request.kind === 'read-ui'));
  cached = state(page(subscription, 8)); wake(); await wait(() => subscription.cursor?.sequence === 8);
  assert.equal(child.getSnapshot().cards.kind, 'ready');
  const presenceCount = requests.filter(request => request.kind === 'presence').length;
  wake(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests.filter(request => request.kind === 'presence').length, presenceCount, 'old native cache does not advance or create a wake loop');
  assert.throws(() => child.selectScope({ ...scope, conversationId: 'foreign' }), /assigned cards/);
  const oldId = subscription.subscriptionId; child.refreshCards(); await wait(() => subscription.subscriptionId !== oldId);
  assert.equal(subscription.cursor, null); assert.equal(child.getSnapshot().cards.kind, 'loading');
});

test('the native main relay forwards exact child subscriptions and refuses a cross-scope card cache', async () => {
  const main = { ...context, role: 'main', label: 'main', documentIncarnation: 'main' }; delete main.scope;
  const subscription = { scope, subscriptionId: 'sub', cursor: null }, commands = [];
  const port = { async request(command) { commands.push(command); if (command.kind === 'drain-ui') return { children: [{ context, display: subscription, visible: true, presenceSequence: 1, placement: null }], reports: [], localBuiltin: false }; return { ok: true }; } };
  const relay = new NativeMainUiRelay(port);
  const response = page(subscription, 8);
  assert.equal(await relay.publish(state(null), main, async request => {
    assert.deepEqual(request.children[0].display, subscription);
    return { children: [{ incarnation: 'child', envelope: null, display: response }] };
  }), false);
  assert.deepEqual(commands.find(command => command.kind === 'publish-ui').children[0].display, response);
  await assert.rejects(relay.publish(state(null), main, async () => ({ children: [{ incarnation: 'child', envelope: null, display: { ...response, page: { ...response.page, scope: { ...scope, conversationId: 'other' } } } }] })), /Foreign native card/);
});


test('child placement notices retain the exact durable request ID and pending result for later settlement', async () => {
  let request, noticed;
  const coordinator = new WindowCoordinator({ context: native, async request(command) { if (command.kind === 'intent-context') return { epoch: 1, pendingCarryRequests: [] }; request = command; return { sourceScope: scope, requestId: command.requestId, action: command.action, result: null, target: null }; } });
  coordinator.observeIntent((result, requestId) => { noticed = { result, requestId }; });
  const result = await coordinator.delegateCreate('agent', false);
  assert.equal(result.kind, 'pending'); assert.equal(noticed.result, result);
  assert.equal(noticed.requestId, request.requestId); assert.equal(request.kind, 'placement-intent');
  assert.deepEqual(request.action, { kind: 'create', agentId: 'agent', carry: false });
});


test('a failed window save cancels the native quit before offering explicit recovery',async()=>{
  const {WindowRuntime}=await import('../../apps/desktop/dist/application/window-runtime.js');const commands=[];
  const runtime=Object.create(WindowRuntime.prototype);Object.assign(runtime,{closed:false,controller:{async dispose(){throw new Error('Storage write failed');}},port:{async request(command){commands.push(command.kind);}},snapshot:{placementNotice:null},listeners:new Set()});
  await runtime.closeWindow();assert.deepEqual(commands,['close-cancelled']);assert.match(runtime.snapshot.placementNotice,/Copy any unsaved text/);assert.match(runtime.snapshot.placementNotice,/Recovery menu/);
});

test('a native child retries an unconfirmed card cursor when the cached page is unchanged', async t => {
  const originalDocument = globalThis.document;
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  let child; t.after(() => { child?.close(); globalThis.document = originalDocument; });
  let wake, cached = null, subscription = null, rejected = false; const attempts = [];
  const port = { context: native, async listen(_name, handler) { wake = handler; return () => {}; }, async request(command) {
    if (command.kind === 'read-ui') return { state: cached, localBuiltin: false, context };
    if (command.kind === 'presence') {
      attempts.push(command.display);
      if (command.display?.cursor?.kind === 'snapshot' && !rejected) { rejected = true; throw new Error('Presence reply lost'); }
      subscription = command.display;
    }
    return { ok: true };
  } };
  child = new ChildUiConnection(port); child.selectScope(scope); child.start(); await wait(() => subscription !== null && wake && attempts.length >= 2);
  const first = page(subscription, 8); first.page.next = { kind: 'snapshot', snapshotId: 'snapshot', highWater: 8, after: 1 };
  first.page.publications = [{ scope, publicationId: 'pub-1', sequence: 1, publishedAtMs: 1, digest: 'a'.repeat(64), event: { type: 'CUSTOM', name: 'openpane.datadog.metrics.v1', value: { schemaVersion: 1, title: 'CPU', query: 'metric', fromMs: 0, toMs: 1000, fetchedAtMs: 1000, series: [] } } }];
  cached = state(first); wake(); await wait(() => rejected);
  assert.equal(subscription.cursor, null); wake(); await wait(() => subscription.cursor?.kind === 'snapshot');
  assert.equal(attempts.filter(item => item?.cursor?.kind === 'snapshot').length, 2);
});

test('a malformed child report is retired without blocking a healthy sibling receipt', async () => {
  const main = { ...context, role: 'main', label: 'main', documentIncarnation: 'main' }; delete main.scope;
  const commands = [], posted = [], valid = { kind: 'rendered', deliveryGeneration: 0, selectionRevision: 0, digest: null, envelope: null, reason: null };
  let reports = [{ id: 'bad', context, report: { ...valid, kind: 'failed', reason: '' } }, { id: 'good', context, report: valid }];
  const port = { async request(command) {
    commands.push(command);
    if (command.kind === 'drain-ui') return { children: [{ context, display: null, visible: true, presenceSequence: 1, placement: null }], reports, localBuiltin: false };
    if (command.kind === 'confirm-ui') reports = reports.filter(report => !command.ids.includes(report.id));
    return { ok: true };
  } };
  const relay = new NativeMainUiRelay(port), post = async request => { posted.push(request); return request.op === 'relay' ? { children: [{ incarnation: 'child', envelope: null, display: null }] } : {}; };
  await relay.publish(state(null), main, post); await relay.publish(state(null), main, post);
  assert.deepEqual(reports, []); assert.equal(posted.filter(request => request.op === 'paint').length, 1);
  assert.deepEqual(commands.filter(command => command.kind === 'confirm-ui').flatMap(command => command.ids), ['bad', 'good']);
});

test('a visible child omitted by a relay byte budget requests another page even when earlier children are caught up', async () => {
  const main = { ...context, role: 'main', label: 'main', documentIncarnation: 'main' }; delete main.scope;
  const children = Array.from({ length: 9 }, (_, index) => {
    const scoped = { ...scope, conversationId: `chat-${index}` }, child = { ...context, scope: scoped, label: `chat-${index}`, viewId: `view-${index}`, documentIncarnation: `child-${index}` };
    return { context: child, visible: true, presenceSequence: index + 1, placement: null, display: { scope: scoped, subscriptionId: `sub-${index}`, cursor: { kind: 'live', epoch: 1, sequence: 0 } } };
  });
  const relay = new NativeMainUiRelay({ async request(command) { return command.kind === 'drain-ui' ? { children, reports: [], localBuiltin: false } : { ok: true }; } });
  let pass = 0;
  const post = async () => ({ children: children.map((child, index) => ({ incarnation: child.context.documentIncarnation, envelope: null,
    display: pass === 0 && index === 8 ? null : { kind: 'page', page: { kind: 'changes', scope: child.display.scope, subscriptionId: child.display.subscriptionId, from: child.display.cursor, highWater: 0, changes: [], next: child.display.cursor } } })) });
  assert.equal(await relay.publish(state(null), main, post), true); pass++;
  assert.equal(await relay.publish(state(null), main, post), false);
});

test('a second explicit native restore arriving during the first save is processed after it settles', async () => {
  const { WindowRuntime, MainUiConnection } = await import('../../apps/desktop/dist/application/window-runtime.js');
  let sequence = 1, pending = true, release; const first = new Promise(resolve => { release = resolve; }), calls = [];
  const ui = Object.create(MainUiConnection.prototype);
  ui.restoreNative = async current => { calls.push(current); if (current === 1) await first; if (current === sequence) pending = false; };
  const runtime = Object.create(WindowRuntime.prototype);
  Object.assign(runtime, { context: { role: 'main' }, ui, port: { async request() { return { pending, sequence }; } }, nativeRecoverySeen: null, nativeRecoveryTask: null, snapshot: {}, listeners: new Set() });
  const firstWake = runtime.recoveryWake(); await wait(() => calls.length === 1);
  sequence = 2; const secondWake = runtime.recoveryWake(); release(); await Promise.all([firstWake, secondWake]);
  assert.deepEqual(calls, [1, 2]); assert.equal(pending, false);
});
