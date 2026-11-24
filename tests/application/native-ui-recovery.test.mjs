import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UiStore } from '../../apps/host/build/tsc/ui-store.js';
import { createExperienceBundle } from '../../apps/host/build/tsc/experience-bundle.js';
import { MainUiConnection } from '../../apps/desktop/dist/application/window-runtime.js';
import { UI_RECOVERY_KEY } from '../../apps/desktop/dist/application/ui-recovery.js';
import { UiConnection } from '../../apps/desktop/dist/application/ui-connection.js';
import { parseUiRequest } from '../../apps/host/build/tsc/ui-protocol.js';
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'native-ui-recovery-')), store = new UiStore(join(directory, 'ui.sqlite'), 'host');
  const previousFetch = globalThis.fetch, previousStorage = globalThis.localStorage, saved = new Map();
  globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  let transport = (_request, run) => run(), confirm = async () => {}, sequence = 0, pending = false;
  const confirmations = [], requests = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    return transport(request, async () => Response.json({ ok: true, value: await store.execute(request) }));
  };
  const ui = new MainUiConnection({ context: { liveRelay: true, brokerInstance: 'broker' }, async request(command) {
    if (command.kind === 'restore-builtin') { pending = true; return { sequence: ++sequence, hostId: store.context().hostId, profileId: store.context().profileId }; }
    if (command.kind === 'confirm-recovery') {
      confirmations.push({ sequence: command.sequence, selected: store.context().selection.selected.kind });
      if (sequence === command.sequence) pending = false;
      await confirm(command.sequence); return {};
    }
    throw new Error(command.kind);
  } });
  t.after(async () => { ui.close(); globalThis.fetch = previousFetch; globalThis.localStorage = previousStorage; store.close(); await rm(directory, { recursive: true, force: true }); });
  return { ui, store, confirmations, requests, pending: () => pending, cached: () => JSON.parse(saved.get(UI_RECOVERY_KEY) ?? 'null'),
    transport: fn => { transport = fn; }, confirm: fn => { confirm = fn; }, async apply(target = store) {
      const bundle = createExperienceBundle({ schemaVersion: 2, id: 'new-selection', label: 'New selection', theme: { density: 'comfortable', mode: 'system', light: {}, dark: {} }, presentation: { home: { kind: 'stack', panes: ['conversations', 'conversation'] }, transcript: 'bubbles', navigation: 'rail', chats: 'inline', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, stylesheet: null, assets: [] }, null, []);
      await target.execute({ op: 'apply', requestId: `1:${randomUUID()}`, expectedRevision: target.context().revision, bundle });
    } };
}

test('overlapping browser restores reuse one durable recovery reservation', async t => {
  const f = await fixture(t), ui = new UiConnection(), entered = gate(), held = gate();
  t.after(() => { held.resolve(); ui.close(); });
  f.transport(async (request, run) => {
    const response = await run();
    if (request.op === 'context') { entered.resolve(); await held.promise; }
    return response;
  });
  const one = ui.restore(), two = ui.restore(); await entered.promise; held.resolve(); await Promise.all([one, two]);
  assert.equal(f.requests.filter(request => request.op === 'restore').length, 1);
  assert.equal(f.cached(), null);
});

test('a successful restore advances the cached recovery context used during an outage', async t => {
  const f = await fixture(t), ui = new UiConnection(); t.after(() => ui.close());
  await ui.restore();
  f.transport((request, run) => { if (request.op === 'context') throw new Error('Context temporarily unavailable'); return run(); });
  await ui.restore();
  assert.equal(f.store.context().revision, 2);
  assert.equal(f.cached(), null);
});

test('a newer native restore gets its own reservation after an earlier commit loses its reply', async t => {
  const f = await fixture(t), committed = gate(), loseReply = gate(); let held = false;
  t.after(() => loseReply.resolve());
  f.transport(async (request, run) => {
    const response = await run();
    if (request.op === 'restore' && !held) { held = true; committed.resolve(); await loseReply.promise; throw new Error('Committed restore reply lost'); }
    return response;
  });
  const first = f.ui.restore(); await committed.promise; await f.apply(); const second = f.ui.restore(); loseReply.resolve(); await Promise.all([first, second]);
  assert.equal(f.store.context().selection.selected.kind, 'builtin'); assert.equal(f.store.context().revision, 3); assert.equal(f.pending(), false);
  assert.equal(new Set(f.requests.filter(request => request.op === 'restore').map(request => request.requestId)).size, 2);
  assert.ok(f.confirmations.some(row => row.sequence === 2 && row.selected === 'builtin'));
});

test('a delayed earlier native confirmation cannot erase the next persisted reservation', async t => {
  const f = await fixture(t), firstConfirm = gate(), duplicateConfirm = gate(), releaseFirst = gate(), releaseDuplicate = gate(), nextStarted = gate(), releaseNext = gate();
  let confirms = 0, firstId;
  t.after(() => { releaseFirst.resolve(); releaseDuplicate.resolve(); releaseNext.resolve(); });
  f.confirm(async sequence => { if (sequence !== 1) return; confirms++; if (confirms === 1) { firstConfirm.resolve(); await releaseFirst.promise; } else { duplicateConfirm.resolve(); await releaseDuplicate.promise; } });
  f.transport(async (request, run) => {
    if (request.op === 'restore') { firstId ??= request.requestId; if (request.requestId !== firstId) { nextStarted.resolve(); await releaseNext.promise; } }
    return run();
  });
  const first = f.ui.restore(); await firstConfirm.promise; const duplicate = f.ui.finishRecovery(); await duplicateConfirm.promise;
  releaseFirst.resolve(); await first; const next = f.ui.restore(); await nextStarted.promise;
  const pendingRequest = f.cached(); assert.ok(pendingRequest); releaseDuplicate.resolve(); await duplicate;
  assert.deepEqual(f.cached(), pendingRequest); releaseNext.resolve(); await next; assert.equal(f.pending(), false); assert.equal(f.cached(), null);
});


test('an inline-only desktop receives appearance state without declaring native children', async t => {
  const f = await fixture(t), previousDocument = globalThis.document, previousFetch = globalThis.fetch;
  globalThis.document = { visibilityState: 'visible' };
  let inventories = 0, stateRequests = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.op === 'state' && ++stateRequests > 1) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }));
    try { return Response.json({ ok: true, value: await f.store.execute(parseUiRequest(request)) }); }
    catch (error) { return Response.json({ ok: false, code: 'invalid-input', error: error.message }, { status: 400 }); }
  };
  const ui = new UiConnection({ async liveChildren() { inventories++; return []; }, async publish() { return false; }, close() {} },
    async context => ({ role: 'main', profileId: context.profileId, hostId: context.hostId, viewId: 'inline-main', brokerInstance: 'native-broker', label: 'main', documentIncarnation: 'inline-document' }), false);
  t.after(() => { ui.close(); globalThis.document = previousDocument; globalThis.fetch = previousFetch; });
  ui.start();
  for (let n = 0; n < 100 && !ui.getSnapshot().state && !ui.getSnapshot().diagnostic; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(ui.getSnapshot().state, ui.getSnapshot().diagnostic ?? 'Appearance state did not arrive');
  assert.equal(ui.getSnapshot().state.selection.selected.kind, 'builtin');
  assert.equal(inventories, 0);
});
for (const [aligned, backoff] of [[false, false], [true, false], [true, true]]) test(`inline resume keeps builtin recovery with its conversation host (UI aligned ${aligned}, backoff ${backoff})`, async t => {
  const f = await fixture(t); await f.apply(); const { fixture: controllerFixture } = await import('./controller-fixture.mjs'); const { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js'); const { WindowCoordinator } = await import('../../apps/desktop/dist/application/window-coordinator.js');
  const previousDocument = globalThis.document; globalThis.document = { visibilityState: 'visible' }; let releasePoll; const heldPoll = new Promise(resolve => { releasePoll = resolve; }); let stateReads = 0;
  f.transport((request, run) => request.op === 'state' && ++stateReads > 1 ? heldPoll.then(() => { if (backoff) throw new Error('Recorded same-host UI backoff'); return Response.json({ ok: true, value: null }); }) : run());
  const hostId = aligned ? 'host' : 'host-A', scope = { hostId, conversationId: 'inline-source' }, controller = controllerFixture(); controller.host(hostId); controller.views.set(`original-view/${hostId}`, { version: 2, route: scope, pendingCreation: null }); await controller.app.start(); const context = { role: 'main', version: 1, label: 'main', brokerInstance: 'broker', documentIncarnation: 'main-document', viewId: 'catalog', reservation: null, liveRelay: false }; let boundHost, sequence = 0; const commands = [];
  const port = { context, async request(command) { commands.push(command); if (command.kind === 'bind-ui') { boundHost = command.hostId; return { role: 'main', hostId: boundHost, profileId: command.profileId, brokerInstance: 'broker', label: 'main', documentIncarnation: context.documentIncarnation, viewId: context.viewId }; } if (command.kind === 'presence') return { presenceSequence: 1 }; if (command.kind === 'drain-ui') return { children: [], reports: [], localBuiltin: false }; if (command.kind === 'publish-ui' || command.kind === 'confirm-recovery') return {}; if (command.kind === 'recover-inline') return { scope, viewId: 'original-view', nativeLabel: 'closed-A-child', fromTransitionId: 'closed-A', transitionId: 'inline:A', targetLabel: 'main', creationAgentId: null }; if (command.kind === 'restore-builtin') return { sequence: ++sequence, hostId: f.store.context().hostId, profileId: f.store.context().profileId }; if (command.kind === 'phase') { if (boundHost !== command.scope.hostId) throw new Error('wrong-host'); return {}; } if (command.kind === 'pending-intents' || command.kind === 'reservations') return []; throw new Error(command.kind); } };
  const ui = new MainUiConnection(port), coordinator = new WindowCoordinator(port), runtime = Object.assign(new WindowRuntime(context), { controller: controller.app, coordinator, port, ui, drive: async () => {}, recoveryWake: async () => {} });
  try { ui.start(); const until = Date.now() + 3000; while (!ui.getSnapshot().state) { if (Date.now() > until) throw new Error('Actual native UI reader did not bind'); await new Promise(resolve => setTimeout(resolve, 1)); } await ui.rendered(ui.getSnapshot().state); assert.equal(JSON.parse(ui.getSnapshot().deliveryContext).hostId, 'host'); assert.equal(boundHost, 'host'); assert.equal(controller.app.getSnapshot().host.metadata.hostId, hostId); assert.equal(f.store.context().selection.selected.kind, 'experience');
    if (backoff) { releasePoll(); const until = Date.now() + 2500; while (!ui.getSnapshot().diagnostic?.includes('Recorded same-host UI backoff')) { if (Date.now() > until) throw new Error('Real UI reader did not enter backoff'); await new Promise(resolve => setTimeout(resolve, 2)); } }
    await runtime.resumeWindow({ scope, viewId: 'original-view', label: 'closed-A-child', transitionId: 'closed-A', creationAgentId: null, phase: 'failed', bindingRevision: 1, writerGeneration: 1 }, true);
    assert.equal(f.store.context().selection.selected.kind, aligned ? 'builtin' : 'experience'); assert.equal(commands.some(command => command.kind === 'restore-builtin'), aligned);
    assert.equal(commands.some(command => command.kind === 'recover-inline'), aligned, 'known foreign UI cannot mutate the native recovery reservation');
  } finally { ui.close(); releasePoll(); await controller.app.dispose(); globalThis.document = previousDocument; }
});

for (const stage of ['wake', 'context', 'post', 'response', 'context-microtask']) test(`native recovery stays with its bound host across a real UI reader rebind (${stage})`, { timeout: 6000 }, async t => {
  const duringMicrotask = stage === 'context-microtask', duringContext = stage === 'context' || duringMicrotask, duringPost = stage === 'post', duringResponse = stage === 'response';
  const f = await fixture(t), directory = await mkdtemp(join(tmpdir(), 'native-ui-other-host-')), other = new UiStore(join(directory, 'ui.sqlite'), 'other-host');
  await f.apply(); await f.apply(other);
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch; globalThis.document = { visibilityState: 'visible' };
  const oldPoll = gate(), contextEntered = gate(), releaseContext = gate(), stopPoll = gate(), wakeEntered = gate(), releaseWake = gate(), postEntered = gate(), releasePost = gate(), responseEntered = gate(), releaseResponse = gate(), readerContext = gate(); let current = f.store, stateReads = 0, holdContext = false, holdPost = false, holdResponse = false, boundHost = null, sequence = 0;
  const commands = [], restores = [], lateWrites = []; let wakeReads = 0, firstRestore, releaseReader = () => {}, verifyThenBind = false;
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Native recovery gate did not finish'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body), target = current;
    if (request.op === 'restore' && holdPost) { holdPost = false; postEntered.resolve(); await releasePost.promise; }
    const destination = request.op === 'restore' ? current : target;
    if (request.op === 'restore') { firstRestore ??= request; restores.push(destination === other ? 'other-host' : 'host'); }
    if (request.op === 'state' && ++stateReads > 1) {
      if (target === f.store) { await oldPoll.promise; throw new Error('Recorded old host UI disconnect'); }
      await stopPoll.promise; throw new Error('Closed other UI poll');
    }
    let value;
    try { value = await destination.execute(parseUiRequest(request)); }
    catch (error) { return Response.json({ ok: false, code: error.code ?? 'unavailable', error: error.message }, { status: 409 }); }
    if (request.op === 'restore' && holdResponse) { holdResponse = false; responseEntered.resolve(); await releaseResponse.promise; }
    if (request.op === 'context' && holdContext && target === f.store) { holdContext = false; contextEntered.resolve(); await releaseContext.promise; }
    return Response.json({ ok: true, value });
  };
  const context = { role: 'main', liveRelay: false, brokerInstance: 'broker' }, port = { context, async request(command) {
    commands.push(command);
    if (command.kind === 'bind-ui') { boundHost = command.hostId; return { role: 'main', hostId: command.hostId, profileId: command.profileId, brokerInstance: 'broker', label: 'main', documentIncarnation: 'document', viewId: 'catalog' }; }
    if (command.kind === 'read-recovery') {
      const reply = { pending: ++wakeReads === 1, sequence: 1, hostId: boundHost, profileId: current.context().profileId };
      if (reply.pending) { wakeEntered.resolve(); await releaseWake.promise; }
      return reply;
    }
    if (command.kind === 'presence') return { presenceSequence: commands.length };
    if (command.kind === 'drain-ui') return { children: [], reports: [], localBuiltin: false };
    if (command.kind === 'publish-ui' || command.kind === 'confirm-recovery') return {};
    if (command.kind === 'restore-builtin') return { sequence: ++sequence, hostId: f.store.context().hostId, profileId: f.store.context().profileId };
    throw new Error(command.kind);
  } };
  const ui = new MainUiConnection(port); let restoring;
  if (duringMicrotask) {
    const actualPost = ui.post.bind(ui); let latest = ui.lastContext;
    ui.post = request => {
      if (request.op !== 'context' || current !== other) return actualPost(request);
      let accept; const held = new Promise(resolve => { accept = resolve; });
      actualPost(request).then(value => { releaseReader = () => accept(value); readerContext.resolve(); });
      return held;
    };
    Object.defineProperty(ui, 'lastContext', { configurable: true, get: () => latest, set(value) { latest = value; if (verifyThenBind && value?.hostId === 'host') { verifyThenBind = false; releaseReader(); } } });
    const set = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (key, value) => { if (key === UI_RECOVERY_KEY && boundHost === 'other-host') lateWrites.push(JSON.parse(value)); set(key, value); };
  }

  t.after(async () => { releaseContext.resolve(); releaseWake.resolve(); releasePost.resolve(); releaseResponse.resolve(); releaseReader(); oldPoll.resolve(); stopPoll.resolve(); ui.close(); await restoring?.catch(() => {}); globalThis.fetch = previousFetch; globalThis.document = previousDocument; other.close(); await rm(directory, { recursive: true, force: true }); });
  ui.start(); await until(() => ui.getSnapshot().state !== null && stateReads > 1);
  if (duringContext) { holdContext = true; restoring = ui.restore(ui.recoveryHost('host')).then(() => null, error => error.message); await contextEntered.promise; assert.equal(ui.getSnapshot().localBuiltin, true, 'the current host keeps immediate local builtin recovery while context is held'); }
  else if (duringResponse) { holdResponse = true; restoring = ui.restore(ui.recoveryHost('host')).then(() => null, error => error.message); await responseEntered.promise; }
  else if (duringPost) { holdPost = true; restoring = ui.restore(ui.recoveryHost('host')).then(() => null, error => error.message); await postEntered.promise; }
  else {
    const { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js');
    const runtime = Object.assign(new WindowRuntime({ role: 'main', version: 1, label: 'main', brokerInstance: 'broker', documentIncarnation: 'document', viewId: 'catalog', reservation: null, liveRelay: false }), { port, ui });
    restoring = runtime.recoveryWake(); await wakeEntered.promise;
  }
  current = other; stateReads = 0; oldPoll.resolve();
  if (duringMicrotask) { await readerContext.promise; verifyThenBind = true; releaseContext.resolve(); }
  await until(() => boundHost === 'other-host' && ui.getSnapshot().deliveryContext && JSON.parse(ui.getSnapshot().deliveryContext).hostId === 'other-host' && ui.getSnapshot().state !== null);
  if (duringPost || duringResponse) { await ui.rendered(ui.getSnapshot().state); assert.equal(ui.getSnapshot().validatedVisual.kind, 'delivery', 'B appearance paints before the old POST is released'); }
  if (duringResponse) releaseResponse.resolve();
  else if (duringContext) releaseContext.resolve();
  else if (duringPost) releasePost.resolve();
  else releaseWake.resolve();
  const scopedOutcome = await restoring;
  if (duringResponse || duringMicrotask) assert.match(scopedOutcome ?? '', /changed hosts/, 'the scoped caller cannot report success after the actual B bind');
  if (duringMicrotask) assert.deepEqual(lateWrites, [], 'no old-host recovery reservation may be written after B binds');
  if (duringResponse) {
    assert.equal(f.store.context().selection.selected.kind, 'builtin', 'the successful A operation remains committed');
    const receipt = await f.store.execute({ op: 'status', requestId: firstRestore.requestId });
    assert.equal(receipt.receipt.requestId, firstRestore.requestId); assert.equal(receipt.receipt.digest, null);
  }
  if (stage === 'wake') assert.equal(wakeReads, 1, 'stale queued reply stops without another native recovery read');
  assert.equal(other.context().selection.selected.kind, 'experience');
  if (duringResponse) assert.equal(restores[0], 'host');
  else if (duringPost) { assert.ok(restores.length > 0); assert.ok(restores.every(host => host === 'other-host')); }
  else assert.deepEqual(restores, [], 'old host recovery must never be posted to the new host');
  assert.equal(ui.getSnapshot().state.selection.selected.kind, 'experience');
  assert.equal(ui.getSnapshot().localBuiltin, false, 'old host local fallback must not remain selected after rebind');
  const posts = restores.length; await ui.restoreNative(1, { hostId: 'host', profileId: f.store.context().profileId });
  assert.equal(restores.length, posts, 'replaying the old native wake cannot post another restore to B'); assert.equal(ui.getSnapshot().localBuiltin, false);
});

test('a held restore POST cannot select builtin in another real store with matching counters', { timeout: 4000 }, async t => {
  const f = await fixture(t), directory = await mkdtemp(join(tmpdir(), 'native-ui-post-host-')), other = new UiStore(join(directory, 'ui.sqlite'), 'other-host');
  await f.apply(); await f.apply(other); const before = other.context(), entered = gate(), release = gate(), previousFetch = globalThis.fetch;
  let target = f.store, sent;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.op === 'restore') { sent = request; entered.resolve(); await release.promise; }
    try { return Response.json({ ok: true, value: await target.execute(parseUiRequest(request)) }); }
    catch (error) { return Response.json({ ok: false, code: error.code ?? 'unavailable', error: error.message }, { status: 409 }); }
  };
  const ui = new UiConnection(); let restoring;
  t.after(async () => { release.resolve(); ui.close(); await restoring; globalThis.fetch = previousFetch; other.close(); await rm(directory, { recursive: true, force: true }); });
  restoring = ui.restore(); await entered.promise; target = other; release.resolve(); await restoring;
  assert.equal(other.context().selection.selected.kind, 'experience'); assert.equal(other.context().revision, before.revision); assert.equal(other.context().recoveryGeneration, before.recoveryGeneration);
  assert.equal(f.store.context().selection.selected.kind, 'experience');
  assert.deepEqual(sent.expectedContext, { hostId: 'host', profileId: f.store.context().profileId });
  assert.equal(f.cached().kind, 'conflicted'); assert.equal(Object.hasOwn(f.cached().request, 'expectedContext'), false);
});

test('an existing saved recovery retries with context without rewriting its immutable request', async t => {
  const f = await fixture(t), context = f.store.context(), request = { op: 'restore', requestId: `recovery:${context.recoveryGeneration}:${randomUUID()}`, expectedRevision: context.revision, expectedRecoveryGeneration: context.recoveryGeneration };
  const committed = await f.store.execute(request);
  localStorage.setItem(UI_RECOVERY_KEY, JSON.stringify({ version: 1, kind: 'reserved', hostId: context.hostId, profileId: context.profileId, request, originator: { kind: 'browser' } }));
  const ui = new UiConnection(); t.after(() => ui.close()); await ui.restore();
  const retried = f.requests.find(row => row.op === 'restore');
  assert.deepEqual(Object.fromEntries(Object.entries(retried).filter(([key]) => key !== 'expectedContext')), request);
  assert.deepEqual(retried.expectedContext, { hostId: context.hostId, profileId: context.profileId });
  assert.equal(f.store.context().revision, committed.receipt.selectionRevision); assert.equal(f.cached(), null);
});

test('an explicit native restore before the first UI binding uses the first fresh host context', async t => {
  const f = await fixture(t); await f.apply(); const confirmations = [];
  const ui = new MainUiConnection({ context: { liveRelay: false, brokerInstance: 'initial-broker' }, async request(command) {
    if (command.kind === 'restore-builtin') return { sequence: 1, hostId: null, profileId: null };
    if (command.kind === 'confirm-recovery') { confirmations.push(command.sequence); return {}; }
    throw new Error(command.kind);
  } });
  t.after(() => ui.close()); await ui.restore();
  assert.equal(f.store.context().selection.selected.kind, 'builtin'); assert.deepEqual(confirmations, [1]); assert.equal(f.cached(), null);
});

for (const scenario of ['bound-same', 'bound-host-change', 'bound-profile-change', 'initial-same', 'initial-rebind', 'bound-context-rejection', 'initial-completed-rebind']) test(`ordinary browser Restore retains its appearance authority (${scenario})`, { timeout: 6000 }, async t => {
  const initial = scenario.startsWith('initial'), lateBind = scenario === 'bound-context-rejection', completedInitial = scenario === 'initial-completed-rebind', rebind = scenario.endsWith('change') || scenario === 'initial-rebind' || lateBind || completedInitial;
  const f = await fixture(t), directory = await mkdtemp(join(tmpdir(), 'browser-ui-recovery-')), other = new UiStore(join(directory, 'ui.sqlite'), scenario === 'bound-profile-change' ? 'host' : 'other-host');
  await f.apply(); await f.apply(other);
  const previousFetch = globalThis.fetch, previousDocument = globalThis.document; globalThis.document = { visibilityState: 'visible' };
  const contextEntered = gate(), releaseContext = gate(), oldPoll = gate(), stopPoll = gate(); let current = f.store, holdContext = false, stateReads = 0, restoring;
  const restores = [], ui = new UiConnection();
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Browser recovery gate did not finish'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body), target = current;
    if (request.op === 'state' && ++stateReads > 1) { if (target === f.store) { await oldPoll.promise; throw new Error('Recorded browser host disconnect'); } await stopPoll.promise; throw new Error('Closed browser poll'); }
    if (request.op === 'context' && holdContext && !initial) { holdContext = false; contextEntered.resolve(); await releaseContext.promise; }
    const destination = request.op === 'context' && !initial ? current : target;
    let value;
    try { if (request.op === 'restore') restores.push({ hostId: destination.context().hostId, profileId: destination.context().profileId }); value = await destination.execute(parseUiRequest(request)); }
    catch (error) { return Response.json({ ok: false, code: error.code ?? 'unavailable', error: error.message }, { status: 409 }); }
    if (request.op === 'context' && holdContext && initial) { holdContext = false; contextEntered.resolve(); await releaseContext.promise; }
    return Response.json({ ok: true, value });
  };
  t.after(async () => { releaseContext.resolve(); oldPoll.resolve(); stopPoll.resolve(); ui.close(); await restoring; globalThis.fetch = previousFetch; globalThis.document = previousDocument; other.close(); await rm(directory, { recursive: true, force: true }); });
  if (!initial) { ui.start(); await until(() => ui.getSnapshot().state !== null && stateReads > 1); assert.equal(JSON.parse(ui.getSnapshot().deliveryContext).hostId, 'host'); }
  holdContext = true; restoring = ui.restore(); await contextEntered.promise;
  if (rebind) {
    if (completedInitial) { releaseContext.resolve(); await restoring; assert.equal(f.store.context().selection.selected.kind, 'builtin'); }
    current = other; stateReads = 0;
    if (lateBind) { releaseContext.resolve(); await restoring; assert.equal(f.cached(), null, 'context rejection happens before reserving recovery'); assert.equal(JSON.parse(ui.getSnapshot().deliveryContext).profileId, f.store.context().profileId); assert.equal(ui.getSnapshot().localBuiltin, true, 'current A fallback stays active during its own backoff'); }
    if (initial) ui.start(); else oldPoll.resolve();
    await until(() => ui.getSnapshot().state !== null && ui.getSnapshot().deliveryContext && JSON.parse(ui.getSnapshot().deliveryContext).profileId === other.context().profileId);
    assert.match(JSON.parse(ui.getSnapshot().deliveryContext).brokerInstance, /^browser:/, 'this is the ordinary browser reader, without native recovery authority');
  }
  releaseContext.resolve(); await restoring;
  if (rebind) {
    assert.equal(other.context().selection.selected.kind, 'experience'); assert.equal(ui.getSnapshot().localBuiltin, false, 'the new host/profile must keep its appearance');
    assert.deepEqual(restores, completedInitial ? [{ hostId: 'host', profileId: f.store.context().profileId }] : [], 'the old Restore action cannot reserve and post a replacement-host restore'); assert.equal(f.store.context().selection.selected.kind, completedInitial ? 'builtin' : 'experience');
  } else {
    assert.equal(f.store.context().selection.selected.kind, 'builtin'); assert.equal(f.cached(), null); assert.deepEqual(restores, [{ hostId: 'host', profileId: f.store.context().profileId }]);
    if (initial) { ui.start(); await until(() => ui.getSnapshot().state !== null); assert.equal(JSON.parse(ui.getSnapshot().deliveryContext).profileId, f.store.context().profileId); }
  }
});

test('an initial browser Restore and a repeated Restore after first binding share one durable request', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const previousDocument = globalThis.document; globalThis.document = { visibilityState: 'visible' };
  const entered = gate(), release = gate(), stopPoll = gate(); let polls = 0, first, second; const ids = [];
  f.transport(async (request, run) => {
    if (request.op === 'restore') { ids.push(request.requestId); entered.resolve(); await release.promise; }
    if (request.op === 'state' && ++polls > 1) { await stopPoll.promise; throw new Error('Closed browser poll'); }
    return run();
  });
  const ui = new UiConnection(); t.after(async () => { release.resolve(); stopPoll.resolve(); ui.close(); await Promise.all([first, second]); globalThis.document = previousDocument; });
  first = ui.restore(); await entered.promise; ui.start();
  const deadline = Date.now() + 2500;
  while (!ui.getSnapshot().deliveryContext) { if (Date.now() > deadline) throw new Error('First browser binding did not arrive'); await new Promise(resolve => setTimeout(resolve, 2)); }
  second = ui.restore(); release.resolve(); await Promise.all([first, second]);
  assert.equal(new Set(ids).size, 1); assert.equal(f.store.context().revision, 2); assert.equal(f.cached(), null);
});

for (const scenario of ['new-profile-complete', 'profile-ABA', 'same-profile', 'new-profile-active', 'shared-promise-gap', 'lost-wake', 'same-profile-wake', 'grant-profile-change', 'grant-same-profile']) test(`a delayed native restore reply retains sequence authority (${scenario})`, { timeout: 7000 }, async t => {
  const f = await fixture(t), directory = await mkdtemp(join(tmpdir(), 'native-ui-sequence-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(); await f.apply(other);
  const { fixture: controllerFixture } = await import('./controller-fixture.mjs'), { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js'), { WindowCoordinator } = await import('../../apps/desktop/dist/application/window-coordinator.js');
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch; globalThis.document = { visibilityState: 'visible' };
  const aPoll = gate(), bPoll = gate(), stop = gate(), oldReply = gate(), releaseOld = gate(), nextReply = gate(), releaseNext = gate(), readerContext = gate(), oldConsumer = gate();
  const commands = [], restorations = [], listeners = new Map(); let holdRead = false; let current = f.store, sequence = 0, pending = false, boundProfile = null, stage = 'a', reads = 0, holdNext = false, releaseReader = () => {}, publishThenBind = false, resuming, waking;
  const until = async check => { const deadline = Date.now() + 3000; while (!check()) { if (Date.now() > deadline) throw new Error('Native sequence gate did not finish'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body), target = current, selected = stage;
    if (request.op === 'state' && ++reads > 1) { await (selected === 'a' ? aPoll : selected === 'b' ? bPoll : stop).promise; throw new Error('Recorded native profile disconnect'); }
    let value;
    try { value = await target.execute(parseUiRequest(request)); }
    catch (error) { return Response.json({ ok: false, code: error.code ?? 'unavailable', error: error.message }, { status: 409 }); }
    if (request.op === 'restore') { restorations.push({ profileId: target.context().profileId, requestId: request.requestId }); if (holdNext) { holdNext = false; nextReply.resolve(); await releaseNext.promise; } }
    return Response.json({ ok: true, value });
  };
  const controller = controllerFixture(), scope = { hostId: 'host', conversationId: 'sequence-inline-chat' }; controller.views.set('original-view/host', { version: 2, route: scope, pendingCreation: null }); await controller.app.start(); await controller.app.getSnapshot().active.store.setDraft('Exact original sequence draft');
  const context = { role: 'main', version: 1, label: 'main', brokerInstance: 'sequence-broker', documentIncarnation: 'main-document', viewId: 'catalog', reservation: null, liveRelay: false };
  const port = { context, async listen(event, callback) { listeners.set(event, callback); return () => listeners.delete(event); }, async request(command) {
    commands.push(command);
    if (command.kind === 'read-close') return { pending: false, attemptId: null };
    if (command.kind === 'bind-ui') { boundProfile = command.profileId; pending = false; return { role: 'main', hostId: command.hostId, profileId: command.profileId, brokerInstance: context.brokerInstance, label: 'main', documentIncarnation: context.documentIncarnation, viewId: context.viewId }; }
    if (command.kind === 'presence') return { presenceSequence: commands.length };
    if (command.kind === 'drain-ui') return { children: [], reports: [], localBuiltin: false };
    if (command.kind === 'publish-ui') return {};
    if (command.kind === 'recover-inline') { const grant = { scope, viewId: 'original-view', nativeLabel: 'closed-child', fromTransitionId: 'closed', transitionId: 'inline-sequence', targetLabel: 'main', creationAgentId: null }; if (scenario.startsWith('grant-')) { oldReply.resolve(); await releaseOld.promise; } return grant; }
    if (command.kind === 'restore-builtin') { pending = true; const reply = { sequence: ++sequence, hostId: 'host', profileId: boundProfile }; oldReply.resolve(); await releaseOld.promise; return reply; }
    if (command.kind === 'read-recovery') { const reply = { pending, sequence, hostId: 'host', profileId: boundProfile }; if (holdRead) { holdRead = false; oldReply.resolve(); await releaseOld.promise; } return reply; }
    if (command.kind === 'confirm-recovery') { if (command.sequence === sequence) pending = false; return {}; }
    if (command.kind === 'phase') return {};
    if (command.kind === 'pending-intents' || command.kind === 'reservations') return [];
    throw new Error(command.kind);
  } };
  const ui = new MainUiConnection(port), coordinator = new WindowCoordinator(port), runtime = Object.assign(new WindowRuntime(context), { controller: controller.app, port, ui, coordinator, drive: async () => {} });
  const actualRestore = ui.restoreNative.bind(ui);
  ui.restoreNative = (number, host) => { if (number === 1) { if (scenario === 'new-profile-active' || scenario === 'shared-promise-gap') assert.equal(ui.restoration?.sequence, 2, 'the old reply reaches the actual active newer promise'); oldConsumer.resolve(); } return actualRestore(number, host); };
  if (scenario === 'shared-promise-gap') {
    const actualPost = ui.post.bind(ui); let latest = ui.recoveryAttempt;
    ui.post = request => { if (request.op !== 'context' || current !== other) return actualPost(request); let accept; const held = new Promise(resolve => { accept = resolve; }); actualPost(request).then(value => { releaseReader = () => accept(value); readerContext.resolve(); }); return held; };
    Object.defineProperty(ui, 'recoveryAttempt', { configurable: true, get: () => latest, set(value) { latest = value; if (publishThenBind) { publishThenBind = false; releaseReader(); } } });
  }
  t.after(async () => { runtime.closed = true; for (const cleanup of runtime.cleanups.splice(0)) cleanup(); releaseOld.resolve(); releaseNext.resolve(); releaseReader(); aPoll.resolve(); bPoll.resolve(); stop.resolve(); ui.close(); await Promise.all([resuming, waking]); await controller.app.dispose(); globalThis.fetch = previousFetch; globalThis.document = previousDocument; other.close(); await rm(directory, { recursive: true, force: true }); });
  if (scenario.endsWith('wake')) runtime.start(); else ui.start();
  await until(() => ui.getSnapshot().state !== null && reads > 1); await ui.rendered(ui.getSnapshot().state);
  if (scenario.endsWith('wake')) {
    await until(() => listeners.has('openpane-ui-wakeup') && runtime.nativeRecoveryTask === null);
    sequence = 1; pending = true; holdRead = true; listeners.get('openpane-ui-wakeup')(); await oldReply.promise;
    if (scenario === 'lost-wake') { current = other; stage = 'b'; reads = 0; aPoll.resolve(); await until(() => boundProfile === other.context().profileId && ui.getSnapshot().state !== null && JSON.parse(ui.getSnapshot().deliveryContext).profileId === other.context().profileId); }
    sequence = 2; pending = true; listeners.get('openpane-ui-wakeup')(); waking = runtime.nativeRecoveryTask;
    releaseOld.resolve(); await waking;
    assert.equal(pending, false, 'the coalesced real listener wake must drain the newer pending native request');
    assert.equal(current.context().selection.selected.kind, 'builtin'); assert.equal(sequence, 2);
    return;
  }
  resuming = runtime.resumeWindow({ scope, viewId: 'original-view', label: 'closed-child', transitionId: 'closed', creationAgentId: null, phase: 'failed', bindingRevision: 1, writerGeneration: 1 }, true); await oldReply.promise;
  if (scenario.startsWith('grant-')) {
    if (scenario === 'grant-profile-change') { current = other; stage = 'b'; reads = 0; aPoll.resolve(); await until(() => ui.getSnapshot().state !== null && JSON.parse(ui.getSnapshot().deliveryContext).profileId === other.context().profileId); }
    releaseOld.resolve(); await resuming;
    assert.equal(sequence, scenario === 'grant-same-profile' ? 1 : 0, 'the captured preflight profile cannot be recaptured after the native grant await');
    assert.equal(commands.filter(command => command.kind === 'phase' && command.phase === 'inline-ready').length, scenario === 'grant-same-profile' ? 1 : 0);
    assert.equal(other.context().selection.selected.kind, 'experience'); assert.equal(controller.app.getSnapshot().active.store.getSnapshot().draft, 'Exact original sequence draft'); return;
  }
  if (scenario !== 'same-profile' && scenario !== 'shared-promise-gap') {
    current = other; stage = 'b'; reads = 0; aPoll.resolve(); await until(() => boundProfile === other.context().profileId && ui.getSnapshot().state !== null && JSON.parse(ui.getSnapshot().deliveryContext).profileId === other.context().profileId);
  }
  sequence++; pending = true; holdNext = scenario === 'new-profile-active' || scenario === 'shared-promise-gap'; waking = runtime.recoveryWake();
  if (holdNext) await nextReply.promise; else await waking;
  if (scenario === 'profile-ABA') {
    current = f.store; stage = 'returned-a'; reads = 0; bPoll.resolve(); await until(() => boundProfile === f.store.context().profileId && ui.getSnapshot().state !== null && JSON.parse(ui.getSnapshot().deliveryContext).profileId === f.store.context().profileId);
  }
  if (scenario === 'shared-promise-gap') {
    releaseOld.resolve(); await oldConsumer.promise;
    current = other; stage = 'b'; reads = 0; aPoll.resolve(); await readerContext.promise;
    void waking.then(() => releaseReader(), () => releaseReader());
    publishThenBind = true; releaseNext.resolve();
  } else { releaseOld.resolve(); if (scenario === 'new-profile-active') await oldConsumer.promise; releaseNext.resolve(); }
  await Promise.all([resuming, waking]);
  if (scenario === 'shared-promise-gap') await until(() => boundProfile === other.context().profileId && ui.getSnapshot().state !== null && JSON.parse(ui.getSnapshot().deliveryContext).profileId === other.context().profileId);
  const progressed = commands.filter(command => command.kind === 'phase' && command.phase === 'inline-ready');
  assert.equal(progressed.length, scenario === 'same-profile' ? 1 : 0, 'old profile recovery must not continue inline resume through a newer profile completion');
  if (scenario === 'shared-promise-gap') { assert.equal(other.context().selection.selected.kind, 'experience'); assert.equal(ui.getSnapshot().localBuiltin, false, 'the new profile must keep its painted appearance'); }
  assert.equal(controller.app.getSnapshot().active.store.getSnapshot().draft, 'Exact original sequence draft');
  assert.equal(sequence, 2); assert.equal(new Set(restorations.map(row => row.requestId)).size, 1, 'only the new explicit native recovery commits');
});

for (const [otherHost, explicit] of [['other-host', false], ['host', false], ['other-host', true], ['host', true]]) test(`a saved foreign recovery stays with its original host/profile (${otherHost}, explicit B ${explicit})`, { timeout: 5000 }, async t => {
  const f = await fixture(t), directory = await mkdtemp(join(tmpdir(), 'foreign-ui-recovery-')), other = new UiStore(join(directory, 'ui.sqlite'), otherHost); await f.apply(); await f.apply(other);
  f.transport(async (request, run) => { const response = await run(); if (request.op === 'restore') throw new Error('Recorded committed A recovery reply lost'); return response; });
  const originalUi = new UiConnection(); await originalUi.restore(); originalUi.close(); const saved = f.cached(); assert.equal(saved.kind, 'reserved'); assert.equal(f.store.context().selection.selected.kind, 'builtin');
  const previousFetch = globalThis.fetch, previousDocument = globalThis.document; globalThis.document = { visibilityState: 'visible' }; let current = other; const polls = new Map(), posted = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body), target = current;
    if (request.op === 'restore') posted.push({ profileId: target.context().profileId, requestId: request.requestId });
    if (request.op === 'state') { const count = (polls.get(target) ?? 0) + 1; polls.set(target, count); if (count > 1) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('Closed reader')), { once: true })); }
    try { return Response.json({ ok: true, value: await target.execute(parseUiRequest(request)) }); }
    catch (error) { return Response.json({ ok: false, code: error.code ?? 'unavailable', error: error.message }, { status: 409 }); }
  };
  const foreignUi = new UiConnection(); let homeUi;
  t.after(async () => { foreignUi.close(); homeUi?.close(); globalThis.fetch = previousFetch; globalThis.document = previousDocument; other.close(); await rm(directory, { recursive: true, force: true }); });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Foreign recovery reader did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  foreignUi.start(); await until(() => foreignUi.getSnapshot().state !== null);
  assert.equal(foreignUi.getSnapshot().localBuiltin, false); assert.equal(foreignUi.getSnapshot().diagnostic, null, 'B cannot show the original A recovery retry notice');
  assert.deepEqual(f.cached(), saved, 'a foreign reader must preserve the original immutable recovery reservation'); assert.deepEqual(posted, []);
  await foreignUi.rendered(foreignUi.getSnapshot().state); assert.equal(foreignUi.getSnapshot().validatedVisual.kind, 'delivery'); assert.equal(other.context().selection.selected.kind, 'experience');
  if (explicit) {
    await foreignUi.restore(); assert.equal(other.context().selection.selected.kind, 'builtin', 'one explicit B action must create B recovery instead of retrying A'); assert.equal(f.cached(), null);
    assert.equal(posted.length, 1); assert.equal(posted[0].profileId, other.context().profileId); assert.notEqual(posted[0].requestId, saved.request.requestId); assert.equal(f.store.context().revision, 2);
    const original = await f.store.execute({ op: 'status', requestId: saved.request.requestId }); assert.equal(original.receipt.requestId, saved.request.requestId);
    return;
  }
  foreignUi.close(); current = f.store; homeUi = new UiConnection(); homeUi.start(); await until(() => homeUi.getSnapshot().state !== null && f.cached() === null);
  assert.equal(f.store.context().revision, 2, 'returning A replays its committed receipt instead of issuing a new operation'); assert.deepEqual(posted, [{ profileId: f.store.context().profileId, requestId: saved.request.requestId }]);
});

test('a delayed completed recovery cannot clear another profile current local fallback', { timeout: 6000 }, async t => {
  const f = await fixture(t), directory = await mkdtemp(join(tmpdir(), 'late-ui-floor-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(); await f.apply(other); await f.apply(other);
  const previousFetch = globalThis.fetch, previousDocument = globalThis.document; globalThis.document = { visibilityState: 'visible' };
  const disconnect = gate(), committed = gate(), releaseOld = gate(), packetReady = gate(), releasePacket = gate(); let current = f.store, foreignContext = false, oldRestore; const polls = new Map();
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body), target = request.op === 'context' && foreignContext ? f.store : current;
    if (request.op === 'context') foreignContext = false;
    const count = request.op === 'state' ? (polls.get(target) ?? 0) + 1 : 0; if (count) polls.set(target, count);
    if (request.op === 'state' && target === f.store && count > 1) { await disconnect.promise; throw new Error('Recorded profile A disconnect'); }
    if (request.op === 'state' && target === other && count > 2) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('Closed B reader')), { once: true }));
    if (request.op === 'state' && target === other && count === 2) await f.apply(other);
    let value;
    try { value = await target.execute(parseUiRequest(request)); }
    catch (error) { return Response.json({ ok: false, code: error.code ?? 'unavailable', error: error.message }, { status: 409 }); }
    if (request.op === 'restore' && target === f.store) { committed.resolve(); await releaseOld.promise; }
    if (request.op === 'state' && target === other && count === 2) { packetReady.resolve(); await releasePacket.promise; }
    return Response.json({ ok: true, value });
  };
  const ui = new UiConnection(); t.after(async () => { disconnect.resolve(); releaseOld.resolve(); releasePacket.resolve(); ui.close(); await oldRestore; globalThis.fetch = previousFetch; globalThis.document = previousDocument; other.close(); await rm(directory, { recursive: true, force: true }); });
  const until = async check => { const deadline = Date.now() + 3000; while (!check()) { if (Date.now() > deadline) throw new Error('Late recovery ownership gate did not finish'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  ui.start(); await until(() => ui.getSnapshot().state !== null && polls.get(f.store) > 1);
  oldRestore = ui.restore(); await committed.promise;
  current = other; disconnect.resolve(); await until(() => ui.getSnapshot().state !== null && JSON.parse(ui.getSnapshot().deliveryContext).profileId === other.context().profileId); await packetReady.promise;
  releaseOld.resolve(); await oldRestore; assert.equal(f.store.context().selection.selected.kind, 'builtin'); assert.equal(f.cached(), null);
  foreignContext = true; await ui.restore(); assert.equal(f.cached(), null); assert.equal(ui.getSnapshot().localBuiltin, true, 'B keeps its current fallback after a context refusal');
  releasePacket.resolve(); await until(() => ui.getSnapshot().state?.selection.revision === 3);
  assert.equal(JSON.parse(ui.getSnapshot().deliveryContext).profileId, other.context().profileId); assert.equal(other.context().selection.selected.kind, 'experience');
  assert.equal(ui.getSnapshot().localBuiltin, true, 'an old A receipt cannot clear B fallback using A delivery generation');
});

for (const [publishBinding, rejectConfirm] of [[true, false], [false, false], [true, true]]) test(`a declined native wake observes the binding that actually declined it (publish binding ${publishBinding}, reject confirm ${rejectConfirm})`, { timeout: 6000 }, async t => {
  const f = await fixture(t), directory = await mkdtemp(join(tmpdir(), 'native-bind-lag-')), previousStore = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(); await f.apply(previousStore);
  const { fixture: controllerFixture } = await import('./controller-fixture.mjs'), { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js'), { WindowCoordinator } = await import('../../apps/desktop/dist/application/window-coordinator.js');
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch; globalThis.document = { visibilityState: 'visible' };
  const disconnect = gate(), bindEntered = gate(), releaseBind = gate(), attempted = gate(), rereadEntered = gate(), releaseReread = gate(), releaseState = gate(), listeners = new Map(), trace = [], posts = [], attempts = [];
  let current = previousStore, broker = null, pending = false, sequence = 0, pendingReads = 0, polls = 0, confirms = 0, draining;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body), target = current;
    if (request.op === 'state' && ++polls > 1) {
      if (target === previousStore) { await disconnect.promise; throw new Error('Recorded previous UI disconnect'); }
      if (rejectConfirm && polls === 2) await releaseState.promise;
      else return new Promise((_, reject) => { if (options.signal.aborted) reject(new Error('Closed reader')); else options.signal.addEventListener('abort', () => reject(new Error('Closed reader')), { once: true }); });
    }
    if (request.op === 'restore') posts.push({ profileId: target.context().profileId, requestId: request.requestId });
    try { return Response.json({ ok: true, value: await target.execute(parseUiRequest(request)) }); }
    catch (error) { return Response.json({ ok: false, code: error.code ?? 'unavailable', error: error.message }, { status: 409 }); }
  };
  const controller = controllerFixture(); await controller.app.start();
  const context = { role: 'main', version: 1, label: 'main', brokerInstance: 'bind-lag-broker', documentIncarnation: 'bind-lag-document', viewId: 'catalog', reservation: null, liveRelay: false };
  const port = { context, async listen(event, callback) { listeners.set(event, callback); return () => listeners.delete(event); }, async request(command) {
    if (command.kind === 'bind-ui') {
      if (broker && (broker.hostId !== command.hostId || broker.profileId !== command.profileId)) pending = false;
      broker = { hostId: command.hostId, profileId: command.profileId }; trace.push({ kind: 'native-bind', profileId: broker.profileId });
      const reply = { role: 'main', ...broker, brokerInstance: context.brokerInstance, label: 'main', documentIncarnation: context.documentIncarnation, viewId: context.viewId };
      if (broker.profileId === f.store.context().profileId) { bindEntered.resolve(); await releaseBind.promise; }
      return reply;
    }
    if (command.kind === 'restore-builtin') { sequence++; pending = true; trace.push({ kind: 'native-request', profileId: broker.profileId }); return { sequence, ...broker }; }
    if (command.kind === 'read-recovery') {
      const reply = { pending, sequence, hostId: broker?.hostId ?? null, profileId: broker?.profileId ?? null };
      if (pending) { trace.push({ kind: 'native-read', profileId: reply.profileId }); if (++pendingReads === 2) { rereadEntered.resolve(); await releaseReread.promise; } }
      return reply;
    }
    if (command.kind === 'confirm-recovery') { if (rejectConfirm && ++confirms === 1) throw new Error('Recorded real confirmation dispatch refusal'); if (command.sequence === sequence) pending = false; return {}; }
    if (command.kind === 'presence') return { presenceSequence: trace.length + pendingReads + polls + 1 };
    if (command.kind === 'drain-ui') return { children: [], reports: [], localBuiltin: false };
    if (command.kind === 'read-close') return { pending: false, attemptId: null };
    if (command.kind === 'publish-ui') return {};
    throw new Error(command.kind);
  } };
  const ui = new MainUiConnection(port), coordinator = new WindowCoordinator(port), runtime = Object.assign(new WindowRuntime(context), { controller: controller.app, port, ui, coordinator, drive: async () => {} });
  const actualRestore = ui.restoreNative.bind(ui); ui.restoreNative = (number, host) => { attempts.push({ sequence: number, delivery: ui.getSnapshot().deliveryContext }); attempted.resolve(); return actualRestore(number, host); };
  t.after(async () => { runtime.closed = true; for (const cleanup of runtime.cleanups.splice(0)) cleanup(); releaseBind.resolve(); releaseReread.resolve(); releaseState.resolve(); disconnect.resolve(); ui.close(); await draining; await controller.app.dispose(); globalThis.fetch = previousFetch; globalThis.document = previousDocument; previousStore.close(); await rm(directory, { recursive: true, force: true }); });
  const until = async check => { const deadline = Date.now() + 3000; while (!check()) { if (Date.now() > deadline) throw new Error('Native binding reply gate did not finish'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  runtime.start(); await until(() => ui.getSnapshot().state !== null && polls > 1 && listeners.has('openpane-ui-wakeup') && runtime.nativeRecoveryTask === null);
  current = f.store; polls = 0; disconnect.resolve(); await bindEntered.promise; await until(() => runtime.nativeRecoveryTask === null);
  assert.equal(broker.profileId, f.store.context().profileId); assert.equal(JSON.parse(ui.getSnapshot().deliveryContext).profileId, previousStore.context().profileId);
  await port.request({ kind: 'restore-builtin' }); listeners.get('openpane-ui-wakeup')(); await attempted.promise;
  listeners.get('openpane-ui-wakeup')(); await rereadEntered.promise; draining = runtime.nativeRecoveryTask;
  if (publishBinding) { releaseBind.resolve(); await until(() => ui.getSnapshot().state !== null && polls > 1 && JSON.parse(ui.getSnapshot().deliveryContext).profileId === f.store.context().profileId); }
  releaseReread.resolve(); await draining;
  if (rejectConfirm) { assert.equal(pending, true); assert.equal(f.cached().kind, 'reserved'); releaseState.resolve(); await until(() => !pending && f.cached() === null); assert.equal(f.store.context().revision, 2, 'reader confirmation retry replays the original committed operation'); }
  assert.equal(trace.filter(row => row.kind === 'native-bind').length, 2, 'there is no native rebind after the fresh request that could cancel it');
  const requestAt = trace.findIndex(row => row.kind === 'native-request'), targetBindAt = trace.findIndex(row => row.kind === 'native-bind' && row.profileId === f.store.context().profileId); assert.ok(targetBindAt >= 0 && targetBindAt < requestAt);
  assert.equal(sequence, 1); assert.equal(pending, !publishBinding, 'the same valid native request must drain once its matching JS binding is published');
  assert.equal(f.store.context().selection.selected.kind, publishBinding ? 'builtin' : 'experience'); assert.equal(previousStore.context().selection.selected.kind, 'experience');
  assert.equal(attempts.length, publishBinding ? 2 : 1); assert.equal(new Set(posts.map(row => row.requestId)).size, publishBinding ? 1 : 0);
});

for (const mode of ['foreign', 'same', 'context-offline', 'fully-offline', 'offline-first-foreign-binding']) test(`an unbound Restore discovers its authority before reusing a saved request (${mode})`, { timeout: 5000 }, async t => {
  const f = await fixture(t), directory = await mkdtemp(join(tmpdir(), 'unbound-saved-ui-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(); await f.apply(other);
  f.transport(async (request, run) => { const response = await run(); if (request.op === 'restore') throw new Error('Recorded committed original reply lost'); return response; });
  const originalUi = new UiConnection(); await originalUi.restore(); originalUi.close(); const saved = f.cached(), raw = localStorage.getItem(UI_RECOVERY_KEY); assert.equal(saved.kind, 'reserved');
  const previousFetch = globalThis.fetch, previousDocument = globalThis.document; globalThis.document = { visibilityState: 'visible' };
  let current = mode === 'foreign' ? other : f.store, unavailable = mode.includes('offline'), polls = 0; const posts = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body), target = current;
    if (request.op === 'context' && unavailable) throw new Error('Recorded context unavailable');
    if (request.op === 'restore') { posts.push(request); if (mode === 'fully-offline' && unavailable) throw new Error('Recorded restore unavailable'); }
    if (request.op === 'state' && ++polls > 1) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('Closed UI reader')), { once: true }));
    try { return Response.json({ ok: true, value: await target.execute(parseUiRequest(request)) }); }
    catch (error) { return Response.json({ ok: false, code: error.code ?? 'unavailable', error: error.message }, { status: 409 }); }
  };
  const ui = new UiConnection(); t.after(async () => { ui.close(); globalThis.fetch = previousFetch; globalThis.document = previousDocument; other.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(ui.getSnapshot().deliveryContext, null); await ui.restore();
  if (mode === 'fully-offline') { assert.equal(localStorage.getItem(UI_RECOVERY_KEY), raw, 'offline replay preserves the exact original reservation'); unavailable = false; await ui.restore(); }
  if (mode === 'foreign') { assert.equal(other.context().selection.selected.kind, 'builtin', 'the first unbound B action must restore B'); assert.notEqual(posts.at(-1).requestId, saved.request.requestId); }
  else { assert.equal(f.store.context().revision, 2); assert.ok(posts.length > 0); for (const post of posts) assert.deepEqual(Object.fromEntries(Object.entries(post).filter(([key]) => key !== 'expectedContext')), saved.request); }
  assert.equal(f.cached(), null);
  if (mode === 'offline-first-foreign-binding') {
    unavailable = false; current = other; ui.start(); const until = Date.now() + 2500; while (!ui.getSnapshot().state) { if (Date.now() > until) throw new Error('First foreign binding did not arrive'); await new Promise(resolve => setTimeout(resolve, 2)); }
    assert.equal(ui.getSnapshot().localBuiltin, false, 'an offline original receipt cannot lend fallback to the first foreign binding');
  }
});

for (const [status, storage] of [['reserved', 'new'], ['reserved', 'legacy'], ['reserved', 'archive-failure'], ['conflicted', 'new']]) test(`an unconfirmed saved recovery survives an explicit restore for another profile (${status}, ${storage})`, { timeout: 6000 }, async t => {
  const originalStorage = globalThis.localStorage, f = await fixture(t), directory = await mkdtemp(join(tmpdir(), 'pending-profile-ui-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(); await f.apply(other);
  f.transport(async (request, run) => {
    if (request.op === 'restore' && status === 'reserved') throw new Error('Original A was unavailable before commit');
    if (request.op === 'restore') await f.apply();
    try { return await run(); } catch (error) { return Response.json({ ok: false, code: error.code, error: error.message }, { status: 409 }); }
  });
  const originalUi = new UiConnection(); await originalUi.restore(); originalUi.close(); const saved = f.cached(); let raw = localStorage.getItem(UI_RECOVERY_KEY); assert.equal(saved.kind, status); assert.equal(f.store.context().selection.selected.kind, 'experience');
  if (storage !== 'new') {
    const legacy = JSON.parse(raw); delete legacy.originator; raw = JSON.stringify(legacy); const values = new Map([[UI_RECOVERY_KEY, raw]]);
    globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem(key, value) { if (storage === 'archive-failure' && key !== UI_RECOVERY_KEY) throw new Error('Recorded scoped archive unavailable'); values.set(key, value); }, removeItem: key => values.delete(key) };
  }
  const cached = () => JSON.parse(localStorage.getItem(UI_RECOVERY_KEY) ?? 'null');
  const previousFetch = globalThis.fetch, previousDocument = globalThis.document; globalThis.document = { visibilityState: 'visible' };
  let current = other; const polls = new Map(), posts = [], atA = gate(), releaseA = gate();
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body), target = current;
    if (request.op === 'restore') { posts.push({ profileId: target.context().profileId, request }); if (target === f.store) { atA.resolve(); await releaseA.promise; } }
    if (request.op === 'state') { const count = (polls.get(target) ?? 0) + 1; polls.set(target, count); if (count > 1) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('Closed pending profile reader')), { once: true })); }
    try { return Response.json({ ok: true, value: await target.execute(parseUiRequest(request)) }); }
    catch (error) { return Response.json({ ok: false, code: error.code ?? 'unavailable', error: error.message }, { status: 409 }); }
  };
  const b = new UiConnection(); let a;
  t.after(async () => { releaseA.resolve(); b.close(); a?.close(); globalThis.fetch = previousFetch; globalThis.document = previousDocument; globalThis.localStorage = originalStorage; other.close(); await rm(directory, { recursive: true, force: true }); });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Pending profile recovery did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  b.start(); await until(() => b.getSnapshot().state !== null); await b.restore(); assert.equal(other.context().selection.selected.kind, 'builtin'); assert.equal(f.store.context().selection.selected.kind, 'experience');
  if (storage === 'archive-failure') assert.equal(localStorage.getItem(UI_RECOVERY_KEY), raw, 'archive failure must preserve the legacy active record');
  b.close(); current = f.store; a = new UiConnection(); a.start();
  await until(() => posts.some(row => row.profileId === f.store.context().profileId) || a.getSnapshot().state !== null);
  assert.equal(localStorage.getItem(UI_RECOVERY_KEY), raw, 'the selected legacy reservation retains its original bytes');
  if (status === 'conflicted') { assert.equal(a.getSnapshot().localBuiltin, true); assert.match(a.getSnapshot().diagnostic, /Current UI revision/); assert.equal(posts.some(row => row.profileId === f.store.context().profileId), false); const retry = a.restore(); await atA.promise; releaseA.resolve(); await retry; }
  else { assert.ok(posts.some(row => row.profileId === f.store.context().profileId), 'returning A must resume its original pending intent'); releaseA.resolve(); }
  await until(() => a.getSnapshot().state !== null && cached() === null);
  const resumed = posts.find(row => row.profileId === f.store.context().profileId).request;
  if (status === 'reserved') assert.deepEqual(Object.fromEntries(Object.entries(resumed).filter(([key]) => key !== 'expectedContext')), saved.request); else assert.notEqual(resumed.requestId, saved.request.requestId);
  assert.equal(f.store.context().selection.selected.kind, 'builtin');
});

test('a fresh native action uses the context advanced by an older saved recovery it first completes', async t => {
  const f = await fixture(t); await f.apply();
  f.transport((request, run) => { if (request.op === 'restore') throw new Error('Original saved browser recovery did not commit'); return run(); });
  const originalUi = new UiConnection(); await originalUi.restore(); originalUi.close(); const original = f.cached(); assert.equal(original.kind, 'reserved');
  f.transport(async (_request, run) => { try { return await run(); } catch (error) { return Response.json({ ok: false, code: error.code, error: error.message }, { status: 409 }); } });
  let pending = false; const ui = new MainUiConnection({ context: { liveRelay: false, brokerInstance: 'new-native-action' }, async request(command) {
    if (command.kind === 'restore-builtin') { pending = true; return { sequence: 1, hostId: 'host', profileId: f.store.context().profileId }; }
    if (command.kind === 'confirm-recovery') { pending = false; return {}; }
    throw new Error(command.kind);
  } });
  t.after(() => ui.close()); await ui.restore();
  assert.equal(pending, false, 'the new native action must complete after finishing the original saved operation'); assert.equal(f.cached(), null); assert.equal(f.store.context().revision, 3);
  const ids = new Set(f.requests.filter(request => request.op === 'restore').map(request => request.requestId)); assert.equal(ids.size, 2); assert.ok(ids.has(original.request.requestId));
});
