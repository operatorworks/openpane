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
  const coordinator = new WindowCoordinator({ context: native, async request(command) { if (command.kind === 'intent-context') return { epoch: 1 }; request = command; return { result: null, target: null }; } });
  coordinator.observeIntent((result, requestId) => { noticed = { result, requestId }; });
  const result = await coordinator.delegateCreate('agent', false);
  assert.equal(result.kind, 'pending'); assert.equal(noticed.result, result);
  assert.equal(noticed.requestId, request.requestId); assert.equal(request.kind, 'placement-intent');
  assert.deepEqual(request.action, { kind: 'create', agentId: 'agent', carry: false });
});
