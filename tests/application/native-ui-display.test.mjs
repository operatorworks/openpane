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

test('a native close requested before listener installation replays after installation', async () => {
  const { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js');
  let install; const held = new Promise(resolve => { install = resolve; }), commands = [], runtime = Object.create(WindowRuntime.prototype);
  Object.assign(runtime, { context: { role: 'main' }, started: false, closed: false, cleanups: [], snapshot: { closing: false }, listeners: new Set(),
    configurePlacementTracking() {}, uiChanged() {}, async drive() {}, recoveryWake: async () => {},
    ui: { subscribe: () => () => {}, start() {}, getSnapshot: () => ({ state: {}, diagnostic: null }) },
    controller: { subscribe: () => () => {}, async start() {}, getSnapshot: () => ({ lastPlacement: null }), async prepareClose() { commands.push('saved'); }, async dispose() { commands.push('disposed'); } },
    port: { async listen(event) { if (event === 'openpane-close-requested') await held; return () => {}; }, async request(command) { if (command.kind === 'read-close') return { pending: true }; commands.push(command.kind); return {}; } } });
  runtime.start(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(commands, []);
  install(); await wait(() => commands.includes('close-ready'));
  assert.deepEqual(commands, ['saved', 'disposed', 'close-ready']);
});

test('main retries failed-placement reporting before settling an assigned native refusal', async () => {
  const { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js'), { UiConnection } = await import('../../apps/desktop/dist/application/ui-connection.js');
  const pending = { kind: 'pending', scope, reason: 'Opening' }, digest = 'a'.repeat(64), transition = { envelope: { requestId: '1:request', deliveryGeneration: 2, selectionRevision: 1, digest }, slot: { transitionId: 'transition', target: { scope } } };
  const ui = Object.create(UiConnection.prototype); let attempts = 0, settled = null;
  ui.getSnapshot = () => ({ state: { selection: { deliveryGeneration: 2, revision: 1 }, bundle: { digest }, transitions: [transition] }, localBuiltin: false, deliveryContext: 'document', confirmedGeneration: 2,
    validatedVisual: { kind: 'delivery', context: 'document', generation: 2, revision: 1, digest } });
  ui.failPlacement = async () => { attempts++; if (attempts === 1) throw new Error('Lost failure acknowledgement'); };
  const runtime = Object.create(WindowRuntime.prototype);
  Object.assign(runtime, { context: { role: 'main' }, ui, policyDelivery: JSON.stringify(['document', 2, 1, digest]), policyScope: scope, snapshot: {}, listeners: new Set(),
    controller: { getSnapshot: () => ({ host: { kind: 'ready', metadata: { hostId: 'host' } }, lastPlacement: pending }), settlePlacement(expected, result) { assert.equal(expected, pending); settled = result; return true; } },
    port: { async request(command) { return command.kind === 'reservations' ? [] : { kind: 'opening', reservation: { scope, viewId: 'view', label: 'child', transitionId: 'native', creationAgentId: 'agent', phase: 'failed', bindingRevision: null, writerGeneration: null } }; } } });
  await assert.rejects(runtime.refreshRecovery(), /Lost failure acknowledgement/); assert.equal(settled, null);
  await runtime.refreshRecovery(); assert.equal(attempts, 2); assert.equal(settled.kind, 'refused');
});

test('a hidden child retires reports from superseded appearances', async () => {
  const main = { ...context, role: 'main', label: 'main', documentIncarnation: 'main' }; delete main.scope;
  const commands = [];
  const relay = new NativeMainUiRelay({ async request(command) {
    commands.push(command);
    if (command.kind === 'drain-ui') return { children: [{ context, display: null, visible: false, presenceSequence: 1, placement: null }],
      reports: [{ id: 'stale', context, report: { kind: 'rendered', deliveryGeneration: 0, selectionRevision: 0, digest: null, envelope: null, reason: null } }], localBuiltin: false };
    return { ok: true };
  } });
  const selected = state(null); selected.selection.deliveryGeneration = 1;
  await relay.publish(selected, main, async () => ({ children: [{ incarnation: 'child', envelope: null, display: null }] }));
  assert.deepEqual(commands.filter(command => command.kind === 'confirm-ui').flatMap(command => command.ids), ['stale']);
});

test('overlapping child presence changes retry the latest subscription after a failed update', async t => {
  const previous = globalThis.document; globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  let release, failed = false; const held = new Promise(resolve => { release = resolve; }), attempts = [];
  const child = new ChildUiConnection({ context: native, async request(command) {
    if (command.kind === 'read-ui') return { state: state(null), localBuiltin: false, context: null };
    if (command.kind === 'presence') {
      attempts.push(command.display);
      if (attempts.length === 1) await held;
      else if (!failed) { failed = true; throw new Error('Latest update failed'); }
    }
    return { ok: true };
  } });
  t.after(() => { release(); child.close(); globalThis.document = previous; });
  child.selectScope(scope); child.refreshCards();
  assert.equal(attempts.length, 1, 'presence updates are serialized');
  release(); await wait(() => failed);
  child.refresh(); await wait(() => attempts.length === 3);
  assert.notEqual(attempts[0].subscriptionId, attempts[1].subscriptionId);
  assert.deepEqual(attempts[2], attempts[1]);
});

for (const healthy of [false, true]) test(`assigned readiness requires healthy creation storage and tolerates carry recovery failure: ${healthy}`, async t => {
  const { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js');
  const previous = globalThis.document; globalThis.document = { visibilityState: 'visible' }; t.after(() => { globalThis.document = previous; });
  const commands = [], runtime = Object.create(WindowRuntime.prototype);
  let current = { busy: false, host: { kind: 'ready' }, storageFailure: null, saved: { pendingCreation: { scope } }, active: null, error: null };
  Object.assign(runtime, { closed: false, processing: false, childReady: false, childRefusalReported: false, recoveryDirty: false,
    context: { ...native, reservation: { scope, creationAgentId: 'agent' } }, childOwner: { editorBinding: () => ({ revision: 1 }) },
    controller: { getSnapshot: () => current, async recoverCreation() { current = { ...current, active: { scope }, saved: { pendingCreation: null }, storageFailure: healthy ? null : 'Saving creation failed' }; } },
    async syncDraftCarries() { throw new Error('Unreadable carry'); }, port: { async request(command) { commands.push(command.kind); } },
    ui: {}, snapshot: {}, listeners: new Set() });
  await runtime.drive();
  assert.deepEqual(commands, healthy ? ['ready'] : []);
});

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


test('cleanup failure after successful save reopens the saved editor after cancelling native close', async t => {
  const { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js');
  const commands = [], originalWindow = globalThis.window; let reloaded = 0;
  globalThis.window = { location: { reload() { reloaded++; } } }; t.after(() => { globalThis.window = originalWindow; });
  const runtime = Object.create(WindowRuntime.prototype);
  Object.assign(runtime, { closed: false, controller: { async prepareClose() {}, async dispose() { throw new Error('Cleanup failed after save'); } },
    port: { async request(command) { commands.push(command.kind); } }, snapshot: { closing: false, placementNotice: null }, listeners: new Set() });
  await runtime.closeWindow(); assert.deepEqual(commands, ['close-cancelled']); assert.equal(reloaded, 1); assert.match(runtime.snapshot.placementNotice, /saved editor is reopening/);
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
  ui.restoreNative = async current => { calls.push(current); if (current === 1) await first; if (current === sequence) pending = false; return true; };
  const runtime = Object.create(WindowRuntime.prototype);
  Object.assign(runtime, { context: { role: 'main' }, ui, port: { async request() { return { pending, sequence }; } }, nativeRecoverySeen: null, nativeRecoveryTask: null, snapshot: {}, listeners: new Set() });
  const firstWake = runtime.recoveryWake(); await wait(() => calls.length === 1);
  sequence = 2; const secondWake = runtime.recoveryWake(); release(); await Promise.all([firstWake, secondWake]);
  assert.deepEqual(calls, [1, 2]); assert.equal(pending, false);
});

test('a wake that first sees a newer native sequence queues behind a manual restore already saving', async t => {
  const { WindowRuntime, MainUiConnection } = await import('../../apps/desktop/dist/application/window-runtime.js');
  const { UiConnection } = await import('../../apps/desktop/dist/application/ui-connection.js');
  const original = UiConnection.prototype.requestRecovery; let sequence = 0, pending = false, release; const gate = new Promise(resolve => { release = resolve; }), calls = [];
  UiConnection.prototype.requestRecovery = async function(originator) { calls.push(originator.sequence); if (calls.length === 1) await gate; await this.recovered(originator); return true; };
  t.after(() => { release(); UiConnection.prototype.requestRecovery = original; });
  const port = { context: { liveRelay: true, role: 'main', brokerInstance: 'broker' }, async request(command) {
    if (command.kind === 'restore-builtin') { pending = true; return { sequence: ++sequence }; }
    if (command.kind === 'read-recovery') return { pending, sequence };
    if (command.kind === 'confirm-recovery') { if (sequence === command.sequence) pending = false; return {}; }
    throw new Error(command.kind);
  } };
  const ui = new MainUiConnection(port), manual = ui.restore(); await wait(() => calls.length === 1);
  sequence++; pending = true;
  const runtime = Object.create(WindowRuntime.prototype); Object.assign(runtime, { context: port.context, port, ui, nativeRecoverySeen: null, nativeRecoveryTask: null, snapshot: {}, listeners: new Set() });
  const waking = runtime.recoveryWake(); await new Promise(resolve => setImmediate(resolve)); release(); await Promise.all([manual, waking]);
  assert.deepEqual(calls, [1, 2]); assert.equal(pending, false);
});

for (const opening of [false, true]) test(`main settles a catalog placement only after the current child is ready (opening ${opening})`, async t => {
  const { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js');
  const { fixture } = await import('./controller-fixture.mjs');
  const pending = { kind: 'pending', scope, reason: 'Waiting for the assigned editor' };
  const f = fixture({ placement: { async acquire() { return pending; } } }); t.after(() => f.app.dispose());
  await f.app.start(); await f.app.open(scope);
  const reservation = { scope, viewId: 'view', label: 'chat', transitionId: 'transition', creationAgentId: null, phase: 'target-ready', bindingRevision: 1, writerGeneration: 1 };
  const runtime = Object.create(WindowRuntime.prototype);
  Object.assign(runtime, { context: { role: 'main' }, controller: f.app, port: { async request(command) { return command.kind === 'reservations' ? [] : { kind: opening ? 'opening' : 'ready', reservation }; } },
    snapshot: { recovery: { kind: 'none' }, placementNotice: pending.reason }, listeners: new Set(), policyScope: scope });
  await runtime.refreshRecovery();
  assert.deepEqual(f.app.getSnapshot().lastPlacement, opening ? pending : { kind: 'detached', scope, label: 'chat' });
  assert.equal(runtime.snapshot.placementNotice, opening ? pending.reason : null);
  assert.equal(runtime.policyScope, opening ? scope : null);
});

test('a late ready lookup cannot clear a newer main placement or its notice', async t => {
  const { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js');
  const { fixture } = await import('./controller-fixture.mjs');
  const f = fixture({ placement: { async acquire(request) { return { kind: 'pending', scope: request.scope, reason: `Waiting for ${request.scope.conversationId}` }; } } }); t.after(() => f.app.dispose());
  await f.app.start(); await f.app.open(scope);
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), reading = new Promise(resolve => { entered = resolve; });
  const runtime = Object.create(WindowRuntime.prototype);
  Object.assign(runtime, { context: { role: 'main' }, controller: f.app, port: { async request(command) {
    if (command.kind === 'reservations') return [];
    entered(); await gate; return { kind: 'ready', reservation: { scope, viewId: 'view', label: 'chat', transitionId: 'transition', creationAgentId: null, phase: 'target-ready', bindingRevision: 1, writerGeneration: 1 } };
  } }, snapshot: { recovery: { kind: 'none' }, placementNotice: 'Waiting for chat' }, listeners: new Set() });
  const refreshing = runtime.refreshRecovery(); await reading;
  const newer = { ...scope, conversationId: 'newer' }; await f.app.open(newer); runtime.snapshot.placementNotice = 'Waiting for newer';
  const expected = f.app.getSnapshot().lastPlacement; release(); await refreshing;
  assert.equal(f.app.getSnapshot().lastPlacement, expected); assert.equal(runtime.snapshot.placementNotice, 'Waiting for newer');
});

test('main reconciles a native restore already pending before its wake listener is installed', async () => {
  const { WindowRuntime, MainUiConnection } = await import('../../apps/desktop/dist/application/window-runtime.js');
  let install, reads = 0, pending = true; const installed = new Promise(resolve => { install = resolve; }), restored = [];
  const ui = Object.create(MainUiConnection.prototype);
  Object.assign(ui, { subscribe() { return () => {}; }, start() {}, getSnapshot: () => ({ state: {}, diagnostic: null }), async restoreNative(sequence) { restored.push(sequence); pending = false; return true; } });
  const runtime = Object.create(WindowRuntime.prototype);
  Object.assign(runtime, { context: { role: 'main' }, started: false, closed: false, cleanups: [], recoveryDirty: false, nativeRecoverySeen: null, nativeRecoveryTask: null,
    configurePlacementTracking() {}, uiChanged() {}, async drive() {}, ui, controller: { subscribe() { return () => {}; }, async start() {}, getSnapshot: () => ({ lastPlacement: null }) },
    port: { async listen(event) { if (event === 'openpane-ui-wakeup') await installed; return () => {}; }, async request(command) { if (command.kind === 'read-close') return { pending: false }; assert.equal(command.kind, 'read-recovery'); reads++; return { pending, sequence: 3 }; } } });
  runtime.start(); await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 0);
  install(); await wait(() => restored.length === 1);
  assert.deepEqual(restored, [3]); assert.equal(pending, false); assert.equal(reads, 2);
});

for (const fails of [false, true]) test(`native close drains the latest draft before disposal (write fails ${fails})`, async t => {
  const { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js');
  const { fixture } = await import('./controller-fixture.mjs');
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { version: 2, route: scope, pendingCreation: null }); await f.app.start();
  const active = f.app.getSnapshot().active; await active.store.setDraft('Earlier saved text');
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), saving = new Promise(resolve => { entered = resolve; });
  f.behavior.write = async () => { entered(); await gate; if (fails) throw new Error('Latest draft could not be saved'); };
  const writing = active.store.setDraft('Latest unsent edit').catch(error => error.message); await saving;
  const commands = [], runtime = Object.create(WindowRuntime.prototype);
  Object.assign(runtime, { closed: false, controller: f.app, port: { async request(command) { commands.push(command.kind); } }, snapshot: { closing: false, placementNotice: null }, listeners: new Set() });
  const closing = runtime.closeWindow(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(commands, []);
  release(); await Promise.all([writing, closing]);
  assert.deepEqual(commands, [fails ? 'close-cancelled' : 'close-ready']);
  assert.equal(f.app.getSnapshot().active?.store ?? null, fails ? active.store : null);
  assert.equal(f.drafts.get('original-view/host/chat').draft, fails ? 'Earlier saved text' : 'Latest unsent edit');
  if (fails) assert.match(runtime.snapshot.placementNotice, /Copy any unsaved text/);
});

test('main does not publish mismatched child envelopes and omits its already-consumed card page', async () => {
  const main = { ...context, role: 'main', label: 'main', documentIncarnation: 'main' }; delete main.scope;
  const commands = [], subscription = { scope, subscriptionId: 'sub', cursor: null };
  const relay = new NativeMainUiRelay({ async request(command) {
    commands.push(command);
    if (command.kind === 'drain-ui') return { children: [{ context, display: subscription, visible: true, presenceSequence: 1, placement: null }], reports: [], localBuiltin: false };
    return { ok: true };
  } });
  const envelope = { requestId: '1:changed', deliveryGeneration: 1, selectionRevision: 1, digest: 'a'.repeat(64) };
  assert.equal(await relay.publish(state(page(subscription, 1)), main, async () => ({ children: [{ incarnation: 'child', envelope, display: page(subscription, 1) }] })), true);
  assert.equal(commands.some(command => command.kind === 'publish-ui'), false);
  await relay.publish(state(page(subscription, 1)), main, async () => ({ children: [{ incarnation: 'child', envelope: null, display: page(subscription, 1) }] }));
  const published = commands.find(command => command.kind === 'publish-ui');
  assert.equal(published.snapshot.display, null); assert.deepEqual(published.children[0].display, page(subscription, 1));
});

test('a definitive assigned creation refusal settles main and exposes same-scope retry in its child', async () => {
  const { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js');
  const commands = [], reservation = { scope, viewId: 'view', label: 'chat', transitionId: 'transition', creationAgentId: 'agent', phase: 'failed', bindingRevision: 1, writerGeneration: 1 };
  const runtime = Object.create(WindowRuntime.prototype);
  let current = { busy: false, host: { kind: 'ready' }, storageFailure: '', active: null, saved: { pendingCreation: { scope, agentId: 'agent' } }, error: '' };
  const retries = [];
  Object.assign(runtime, { context: { role: 'chat', reservation }, closed: false, processing: false, childReady: false, childRefusalReported: false, recoveryDirty: false,
    controller: { getSnapshot: () => current, async recoverCreation() { current = { ...current, saved: { pendingCreation: null }, error: 'Provider refused creation' }; }, async createReserved(scope, agent) { retries.push({ scope, agent }); } },
    port: { async request(command) { commands.push(command); } }, snapshot: { canRetryCreation: false }, listeners: new Set(), async syncDraftCarries() {} });
  await runtime.drive(); assert.equal(commands[0].kind, 'creation-refused'); assert.equal(commands.some(command => command.kind === 'ready'), false);
  assert.equal(runtime.snapshot.canRetryCreation, true); runtime.drive = async () => {};
  await runtime.retryAssignedCreation(); assert.deepEqual(retries, [{ scope, agent: 'agent' }]);
  const pending = { kind: 'pending', scope, reason: 'Waiting for assigned editor' }; let settled;
  const main = Object.create(WindowRuntime.prototype);
  Object.assign(main, { context: { role: 'main' }, ui: { getSnapshot: () => ({ state: null }) }, controller: { getSnapshot: () => ({ host: { kind: 'ready', metadata: { hostId: 'host' } }, lastPlacement: pending }), settlePlacement(expected, result) { assert.equal(expected, pending); settled = result; return true; } },
    port: { async request(command) { return command.kind === 'reservations' ? [] : { kind: 'opening', reservation }; } }, snapshot: { recovery: { kind: 'none' } }, listeners: new Set() });
  await main.refreshRecovery(); assert.equal(settled.kind, 'refused'); assert.match(settled.reason, /unsent draft is preserved/);
});


test('the last first-message check reads current native policy synchronously', () => {
  const coordinator = new WindowCoordinator({ context: { role: 'main', liveRelay: true } });
  assert.equal(coordinator.canAutomaticallySend(), true);
  coordinator.setPresentation({ navigation: 'rail', chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } });
  assert.equal(coordinator.canAutomaticallySend(), false);
  coordinator.setPresentation(null); assert.equal(coordinator.canAutomaticallySend(), true);
});
