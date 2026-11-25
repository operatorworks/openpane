import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UiStore } from '../../apps/host/build/tsc/ui-store.js';
import { createExperienceBundle } from '../../apps/host/build/tsc/experience-bundle.js';
import { MainUiConnection, WindowRuntime } from '../../apps/desktop/dist/application/window-runtime.js';
import { UI_RECOVERY_KEY, reserveRecovery, NATIVE_BINDING_REFUSED } from '../../apps/desktop/dist/application/ui-recovery.js';
import { UiConnection } from '../../apps/desktop/dist/application/ui-connection.js';
import { parseUiRequest } from '../../apps/host/build/tsc/ui-protocol.js';
const processFetch = globalThis.fetch;
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  assert.equal(globalThis.fetch, processFetch, 'the preceding fixture restored the process fetch implementation');
  const directory = await mkdtemp(join(tmpdir(), 'native-ui-recovery-')), store = new UiStore(join(directory, 'ui.sqlite'), 'host');
  const previousFetch = globalThis.fetch, previousStorage = globalThis.localStorage, previousDocument = globalThis.document, saved = new Map();
  globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  let beforeConfirm = async () => {}; let recoveryReply = null;
  let recoverInline = async () => { throw new Error('Unexpected inline recovery'); }; const initiators = new Map();
  let bind = async () => {}, presence = 0, restoreReply = async reply => reply, cancellation = () => false;
  let transport = (_request, run) => run(), confirm = async () => {}, admit = () => ({ admission: 'accepted' }), sequence = 0, pending = false;
  const confirmations = [], requests = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    if (options.signal?.aborted) throw new Error("Closed");
    return transport(request, async () => Response.json({ ok: true, value: await store.execute(request) }), options.signal);
  };
  const port = { context: { liveRelay: true, brokerInstance: 'broker' }, async request(command) {
    if (command.kind === 'bind-ui') { await bind(command); return { role: 'main', brokerInstance: 'broker', label: 'main', documentIncarnation: 'fixture-document', viewId: 'fixture-view', hostId: command.hostId, profileId: command.profileId }; }
    if (command.kind === 'presence') return { presenceSequence: ++presence };
    if (command.kind === 'drain-ui') return { children: [], reports: [], localBuiltin: false };
    if (command.kind === 'publish-ui') return {};
    if (command.kind === 'recover-inline') return recoverInline(command);
    if (command.kind === 'restore-builtin') { pending = true; initiators.set(sequence + 1, command.requestId); recoveryReply = { sequence: ++sequence, hostId: store.context().hostId, profileId: store.context().profileId }; return restoreReply(recoveryReply); }
    if (command.kind === 'read-recovery') { const context = pending ? recoveryReply : null; return { pending, sequence, hostId: context?.hostId ?? null, profileId: context?.profileId ?? null, initiator: pending ? initiators.get(sequence) ?? null : null }; }
    if (command.kind === 'read-recovery-cancellation') return { cancelled: await cancellation(command.sequence) };
    if (command.kind === 'scope-recovery') return admit(command);
    if (command.kind === 'confirm-recovery') {
      await beforeConfirm(command.sequence);
      confirmations.push({ sequence: command.sequence, selected: store.context().selection.selected.kind });
      if (sequence === command.sequence) pending = false;
      await confirm(command.sequence); return {};
    }
    throw new Error(command.kind);
  } };
  const ui = new MainUiConnection(port);
  let runtime;
  const runtimeWake = () => {
    if (!runtime) {
      runtime = new WindowRuntime({ role: 'main', version: 1, label: 'main', brokerInstance: 'broker', documentIncarnation: 'fixture-document', viewId: 'fixture-main', reservation: null, liveRelay: true });
      runtime.ui.close(); runtime.ui = ui; runtime.port = port;
    }
    return runtime.recoveryWake();
  };
  const cleanups = [];
  t.after(async () => {
    const errors = [];
    ui.close();
    for (const close of cleanups.reverse()) { try { await close(); } catch (error) { errors.push(error); } }
    globalThis.fetch = previousFetch; globalThis.localStorage = previousStorage; globalThis.document = previousDocument;
    try { store.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    if (errors.length) throw new AggregateError(errors, 'Native UI fixture cleanup failed');
  });
  return { port, runtimeWake, beforeConfirm: fn => { beforeConfirm = fn; }, wake: (sequence, host) => ui.restoreNative(sequence, host, initiators.get(sequence) ?? null), recoverInline: fn => { recoverInline = fn; }, after: cleanup => cleanups.push(cleanup), ui, store, confirmations, requests, pending: () => pending, cached: () => JSON.parse(saved.get(UI_RECOVERY_KEY) ?? 'null'),
    latestSequence: () => sequence, restoreReply: fn => { restoreReply = fn; }, cancellations: fn => { cancellation = fn; }, bind: fn => { bind = fn; }, scope: fn => { admit = fn; }, transport: fn => { transport = fn; }, confirm: fn => { confirm = fn; }, async apply(target = store) {
      const bundle = createExperienceBundle({ schemaVersion: 2, id: 'new-selection', label: 'New selection', theme: { density: 'comfortable', mode: 'system', light: {}, dark: {} }, presentation: { home: { kind: 'stack', panes: ['conversations', 'conversation'] }, transcript: 'bubbles', navigation: 'rail', chats: 'inline', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, stylesheet: null, assets: [] }, null, []);
      await target.execute({ op: 'apply', requestId: `1:${randomUUID()}`, expectedRevision: target.context().revision, bundle });
    } };
}

test('overlapping browser restores reuse one durable recovery reservation', async t => {
  const f = await fixture(t), ui = new UiConnection(), entered = gate(), held = gate();
  f.after(() => { held.resolve(); ui.close(); });
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
  const f = await fixture(t), ui = new UiConnection(); f.after(() => ui.close());
  await ui.restore();
  f.transport((request, run) => { if (request.op === 'context') throw new Error('Context temporarily unavailable'); return run(); });
  await ui.restore();
  assert.equal(f.store.context().revision, 2);
  assert.equal(f.cached(), null);
});

test('a newer native restore gets its own reservation after an earlier commit loses its reply', async t => {
  const f = await fixture(t), committed = gate(), loseReply = gate(); let held = false;
  f.after(() => loseReply.resolve());
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

test('a coalesced earlier native confirmation cannot erase the next persisted reservation', { timeout: 5000 }, async t => {
  const f = await fixture(t), firstConfirm = gate(), releaseFirst = gate(), nextStarted = gate(), releaseNext = gate();
  let confirms = 0, firstId;
  f.after(() => { releaseFirst.resolve(); releaseNext.resolve(); });
  f.confirm(async sequence => { if (sequence === 1) { confirms++; firstConfirm.resolve(); await releaseFirst.promise; } });
  f.transport(async (request, run) => {
    if (request.op === 'restore') { firstId ??= request.requestId; if (request.requestId !== firstId) { nextStarted.resolve(); await releaseNext.promise; } }
    return run();
  });
  const first = f.ui.restore(); await firstConfirm.promise; const duplicate = f.ui.finishRecovery();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(confirms, 1);
  releaseFirst.resolve(); await first; const next = f.ui.restore(); await nextStarted.promise;
  const pendingRequest = f.cached(); assert.ok(pendingRequest); await duplicate; assert.equal(confirms, 1);
  assert.deepEqual(f.cached(), pendingRequest); releaseNext.resolve(); await next; assert.equal(confirms, 1); assert.equal(f.pending(), false); assert.equal(f.cached(), null);
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
  f.after(() => { ui.close(); globalThis.document = previousDocument; globalThis.fetch = previousFetch; });
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
  const port = { context, async request(command) { commands.push(command); if (command.kind === 'bind-ui') { boundHost = command.hostId; return { role: 'main', hostId: boundHost, profileId: command.profileId, brokerInstance: 'broker', label: 'main', documentIncarnation: context.documentIncarnation, viewId: context.viewId }; } if (command.kind === 'presence') return { presenceSequence: 1 }; if (command.kind === 'drain-ui') return { children: [], reports: [], localBuiltin: false }; if (command.kind === 'scope-recovery') return { admission: 'accepted' }; if (command.kind === 'publish-ui' || command.kind === 'confirm-recovery') return {}; if (command.kind === 'recover-inline') { assert.deepEqual(command.expectedContext, { hostId: boundHost, profileId: f.store.context().profileId }); return { scope, viewId: 'original-view', nativeLabel: 'closed-A-child', fromTransitionId: 'closed-A', transitionId: 'inline:A', targetLabel: 'main', creationAgentId: null }; } if (command.kind === 'restore-builtin') return { sequence: ++sequence, hostId: f.store.context().hostId, profileId: f.store.context().profileId }; if (command.kind === 'phase') { if (boundHost !== command.scope.hostId) throw new Error('wrong-host'); return {}; } if (command.kind === 'pending-intents' || command.kind === 'reservations') return []; throw new Error(command.kind); } };
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
      const reply = { initiator: null, pending: ++wakeReads === 1, sequence: 1, hostId: boundHost, profileId: current.context().profileId };
      if (reply.pending) { wakeEntered.resolve(); await releaseWake.promise; }
      return reply;
    }
    if (command.kind === 'presence') return { presenceSequence: commands.length };
    if (command.kind === 'drain-ui') return { children: [], reports: [], localBuiltin: false };
    if (command.kind === 'scope-recovery') return { admission: 'accepted' }; if (command.kind === 'publish-ui' || command.kind === 'confirm-recovery') return {};
    if (command.kind === 'restore-builtin') return { sequence: ++sequence, hostId: f.store.context().hostId, profileId: f.store.context().profileId };
    if (command.kind === 'read-recovery-cancellation') return { cancelled: false };
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

  f.after(async () => { releaseContext.resolve(); releaseWake.resolve(); releasePost.resolve(); releaseResponse.resolve(); releaseReader(); oldPoll.resolve(); stopPoll.resolve(); ui.close(); await restoring?.catch(() => {}); globalThis.fetch = previousFetch; globalThis.document = previousDocument; other.close(); await rm(directory, { recursive: true, force: true }); });
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
  f.after(async () => { release.resolve(); ui.close(); await restoring; globalThis.fetch = previousFetch; other.close(); await rm(directory, { recursive: true, force: true }); });
  restoring = ui.restore(); await entered.promise; target = other; release.resolve(); await restoring;
  assert.equal(other.context().selection.selected.kind, 'experience'); assert.equal(other.context().revision, before.revision); assert.equal(other.context().recoveryGeneration, before.recoveryGeneration);
  assert.equal(f.store.context().selection.selected.kind, 'experience');
  assert.deepEqual(sent.expectedContext, { hostId: 'host', profileId: f.store.context().profileId });
  assert.equal(f.cached().kind, 'reserved', 'a foreign-profile refusal cannot settle the original request'); assert.equal(Object.hasOwn(f.cached().request, 'expectedContext'), false);
});

test('an existing saved recovery retries with context without rewriting its immutable request', async t => {
  const f = await fixture(t), context = f.store.context(), request = { op: 'restore', requestId: `recovery:${context.recoveryGeneration}:${randomUUID()}`, expectedRevision: context.revision, expectedRecoveryGeneration: context.recoveryGeneration };
  const committed = await f.store.execute(request);
  localStorage.setItem(UI_RECOVERY_KEY, JSON.stringify({ version: 1, kind: 'reserved', hostId: context.hostId, profileId: context.profileId, request, originator: { kind: 'browser' } }));
  const ui = new UiConnection(); f.after(() => ui.close()); await ui.restore();
  const retried = f.requests.find(row => row.op === 'restore');
  assert.deepEqual(Object.fromEntries(Object.entries(retried).filter(([key]) => key !== 'expectedContext')), request);
  assert.deepEqual(retried.expectedContext, { hostId: context.hostId, profileId: context.profileId });
  assert.equal(f.store.context().revision, committed.receipt.selectionRevision); assert.equal(f.cached(), null);
});

test('an explicit native restore before the first UI binding uses the first fresh host context', async t => {
  const f = await fixture(t); await f.apply(); const confirmations = [];
  const ui = new MainUiConnection({ context: { liveRelay: false, brokerInstance: 'initial-broker' }, async request(command) {
    if (command.kind === 'restore-builtin') return { sequence: 1, hostId: null, profileId: null };
    if (command.kind === 'scope-recovery') { assert.equal(f.requests.filter(value => value.op === 'restore').length, 0, 'native scope is pinned before the host write'); return { admission: 'accepted' }; }
    if (command.kind === 'confirm-recovery') { confirmations.push(command.sequence); return {}; }
    if (command.kind === 'read-recovery-cancellation') return { cancelled: false };
    throw new Error(command.kind);
  } });
  f.after(() => ui.close()); await ui.restore();
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
  f.after(async () => { releaseContext.resolve(); oldPoll.resolve(); stopPoll.resolve(); ui.close(); await restoring; globalThis.fetch = previousFetch; globalThis.document = previousDocument; other.close(); await rm(directory, { recursive: true, force: true }); });
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
  const ui = new UiConnection(); f.after(async () => { release.resolve(); stopPoll.resolve(); ui.close(); await Promise.all([first, second]); globalThis.document = previousDocument; });
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
    if (command.kind === 'read-recovery') { const reply = { initiator: null, pending, sequence, hostId: 'host', profileId: boundProfile }; if (holdRead) { holdRead = false; oldReply.resolve(); await releaseOld.promise; } return reply; }
    if (command.kind === 'scope-recovery') return { admission: 'accepted' };
    if (command.kind === 'confirm-recovery') { if (command.sequence === sequence) pending = false; return {}; }
    if (command.kind === 'phase') return {};
    if (command.kind === 'pending-intents' || command.kind === 'reservations') return [];
    if (command.kind === 'read-recovery-cancellation') return { cancelled: false };
    throw new Error(command.kind);
  } };
  const ui = new MainUiConnection(port), coordinator = new WindowCoordinator(port), runtime = Object.assign(new WindowRuntime(context), { controller: controller.app, port, ui, coordinator, drive: async () => {} });
  const actualRestore = ui.restoreNative.bind(ui);
  ui.restoreNative = (...args) => { const [number] = args; if (number === 1) { if (scenario === 'new-profile-active' || scenario === 'shared-promise-gap') assert.equal(ui.restoration?.sequence, 2, 'the old reply reaches the actual active newer promise'); oldConsumer.resolve(); } return actualRestore(...args); };
  if (scenario === 'shared-promise-gap') {
    const actualPost = ui.post.bind(ui); let latest = ui.recoveryAttempt;
    ui.post = request => { if (request.op !== 'context' || current !== other) return actualPost(request); let accept; const held = new Promise(resolve => { accept = resolve; }); actualPost(request).then(value => { releaseReader = () => accept(value); readerContext.resolve(); }); return held; };
    Object.defineProperty(ui, 'recoveryAttempt', { configurable: true, get: () => latest, set(value) { latest = value; if (publishThenBind) { publishThenBind = false; releaseReader(); } } });
  }
  f.after(async () => { runtime.closed = true; for (const cleanup of runtime.cleanups.splice(0)) cleanup(); releaseOld.resolve(); releaseNext.resolve(); releaseReader(); aPoll.resolve(); bPoll.resolve(); stop.resolve(); ui.close(); await Promise.all([resuming, waking]); await controller.app.dispose(); globalThis.fetch = previousFetch; globalThis.document = previousDocument; other.close(); await rm(directory, { recursive: true, force: true }); });
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
  f.after(async () => { foreignUi.close(); homeUi?.close(); globalThis.fetch = previousFetch; globalThis.document = previousDocument; other.close(); await rm(directory, { recursive: true, force: true }); });
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
  const ui = new UiConnection(); f.after(async () => { disconnect.resolve(); releaseOld.resolve(); releasePacket.resolve(); ui.close(); await oldRestore; globalThis.fetch = previousFetch; globalThis.document = previousDocument; other.close(); await rm(directory, { recursive: true, force: true }); });
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
      const reply = { initiator: null, pending, sequence, hostId: broker?.hostId ?? null, profileId: broker?.profileId ?? null };
      if (pending) { trace.push({ kind: 'native-read', profileId: reply.profileId }); if (++pendingReads === 2) { rereadEntered.resolve(); await releaseReread.promise; } }
      return reply;
    }
    if (command.kind === 'scope-recovery') return { admission: 'accepted' };
    if (command.kind === 'confirm-recovery') { if (rejectConfirm && ++confirms === 1) throw new Error('Recorded real confirmation dispatch refusal'); if (command.sequence === sequence) pending = false; return {}; }
    if (command.kind === 'presence') return { presenceSequence: trace.length + pendingReads + polls + 1 };
    if (command.kind === 'drain-ui') return { children: [], reports: [], localBuiltin: false };
    if (command.kind === 'read-close') return { pending: false, attemptId: null };
    if (command.kind === 'publish-ui') return {};
    if (command.kind === 'read-recovery-cancellation') return { cancelled: false };
    throw new Error(command.kind);
  } };
  const ui = new MainUiConnection(port), coordinator = new WindowCoordinator(port), runtime = Object.assign(new WindowRuntime(context), { controller: controller.app, port, ui, coordinator, drive: async () => {} });
  const actualRestore = ui.restoreNative.bind(ui); ui.restoreNative = (...args) => { const [number] = args; attempts.push({ sequence: number, delivery: ui.getSnapshot().deliveryContext }); attempted.resolve(); return actualRestore(...args); };
  f.after(async () => { runtime.closed = true; for (const cleanup of runtime.cleanups.splice(0)) cleanup(); releaseBind.resolve(); releaseReread.resolve(); releaseState.resolve(); disconnect.resolve(); ui.close(); await draining; await controller.app.dispose(); globalThis.fetch = previousFetch; globalThis.document = previousDocument; previousStore.close(); await rm(directory, { recursive: true, force: true }); });
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
  const ui = new UiConnection(); f.after(async () => { ui.close(); globalThis.fetch = previousFetch; globalThis.document = previousDocument; other.close(); await rm(directory, { recursive: true, force: true }); });
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

for (const [status, storage] of [['reserved', 'new'], ['reserved', 'legacy'], ['reserved', 'archive-failure'], ['reserved', 'archive-a-failure'], ['conflicted', 'new']]) test(`an unconfirmed saved recovery survives an explicit restore for another profile (${status}, ${storage})`, { timeout: 6000 }, async t => {
  const originalStorage = globalThis.localStorage, f = await fixture(t), directory = await mkdtemp(join(tmpdir(), 'pending-profile-ui-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(); await f.apply(other);
  f.transport(async (request, run) => {
    if (request.op === 'restore' && status === 'reserved') throw new Error('Original A was unavailable before commit');
    if (request.op === 'restore') await f.apply();
    try { return await run(); } catch (error) { return Response.json({ ok: false, code: error.code, error: error.message }, { status: 409 }); }
  });
  const originalUi = new UiConnection(); await originalUi.restore(); originalUi.close(); const saved = f.cached(); let raw = localStorage.getItem(UI_RECOVERY_KEY); assert.equal(saved.kind, status); assert.equal(f.store.context().selection.selected.kind, 'experience');
  if (storage !== 'new') {
    const legacy = JSON.parse(raw); delete legacy.originator; raw = JSON.stringify(legacy); const values = new Map([[UI_RECOVERY_KEY, raw]]);
    globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem(key, value) { if (storage === 'archive-failure' && key !== UI_RECOVERY_KEY || storage === 'archive-a-failure' && key === `${UI_RECOVERY_KEY}:${JSON.stringify(['host', f.store.context().profileId])}`) throw new Error('Recorded scoped archive unavailable'); values.set(key, value); }, removeItem: key => values.delete(key) };
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
  f.after(async () => { releaseA.resolve(); b.close(); a?.close(); globalThis.fetch = previousFetch; globalThis.document = previousDocument; globalThis.localStorage = originalStorage; other.close(); await rm(directory, { recursive: true, force: true }); });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Pending profile recovery did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  b.start(); await until(() => b.getSnapshot().state !== null); await b.restore(); assert.equal(other.context().selection.selected.kind, 'builtin'); assert.equal(f.store.context().selection.selected.kind, 'experience');
  if (storage === 'archive-failure' || storage === 'archive-a-failure') assert.equal(localStorage.getItem(UI_RECOVERY_KEY), raw, 'archive failure must preserve the legacy active record');
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
    if (command.kind === 'scope-recovery') return { admission: 'accepted' };
    if (command.kind === 'confirm-recovery') { pending = false; return {}; }
    if (command.kind === 'read-recovery-cancellation') return { cancelled: false };
    throw new Error(command.kind);
  } });
  f.after(() => ui.close()); await ui.restore();
  assert.equal(pending, false, 'the new native action must complete after finishing the original saved operation'); assert.equal(f.cached(), null); assert.equal(f.store.context().revision, 3);
  const ids = new Set(f.requests.filter(request => request.op === 'restore').map(request => request.requestId)); assert.equal(ids.size, 2); assert.ok(ids.has(original.request.requestId));
});

const untilRecovery = async check => { const deadline = Date.now() + 2000; while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1)); assert.ok(check(), 'recovery checkpoint'); };
async function concurrentRecovery(t) {
  const originalDocument = globalThis.document, response = gate(), hook = gate(); let ui, restoring;
  t.after(async () => { response.resolve(); hook.resolve(); ui?.close(); await restoring; globalThis.document = originalDocument; });
  const f = await fixture(t); globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  let hooks = 0, contextReads = 0, restores = 0, offline = false; const entered = gate();
  class ObservedRecovery extends UiConnection { async recovered() { hooks++; await hook.promise; } }
  ui = new ObservedRecovery();
  f.transport(async (request, run, signal) => {
    if (request.op === 'context') { contextReads++; if (offline) throw new Error('Context temporarily unavailable'); }
    if (request.op === 'state') return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    const result = await run();
    if (request.op === 'restore' && ++restores === 1) { entered.resolve(); await response.promise; }
    return result;
  });
  await f.apply(); restoring = ui.restore(); await entered.promise;
  await f.apply(); const newer = f.store.context(); ui.start();
  await untilRecovery(() => contextReads >= 2); await new Promise(resolve => setImmediate(resolve)); response.resolve();
  await untilRecovery(() => hooks > 0); await new Promise(resolve => setImmediate(resolve));
  return { f, ui, newer, hooks: () => hooks, finish: async () => { hook.resolve(); await restoring; }, offline: () => { offline = true; } };
}
test('polling and direct restore share one reserved completion hook', { timeout: 5000 }, async t => {
  const f = await concurrentRecovery(t); assert.equal(f.hooks(), 1); await f.finish();
});
test('an older restore receipt preserves a newer polled selection for offline retry', { timeout: 5000 }, async t => {
  const f = await concurrentRecovery(t); await f.finish(); f.offline(); await f.ui.restore();
  const requests = f.f.requests.filter(request => request.op === 'restore'), original = requests[0].requestId;
  const retry = requests.find(request => request.requestId !== original);
  assert.ok(retry, 'a new offline recovery was reserved'); assert.equal(retry.expectedRevision, f.newer.revision);
  assert.equal(retry.expectedRecoveryGeneration, f.newer.recoveryGeneration);
});

test('native UI fixture final cleanup restores the process fetch implementation', () => { assert.equal(globalThis.fetch, processFetch); });

test('native confirmation carries the saved receipt generation and exact profile', async t => {
  const f = await fixture(t); await f.apply(); let confirmation, scoped;
  const ui = new MainUiConnection({ context: { liveRelay: false, brokerInstance: 'receipt-profile' }, async request(command) {
    if (command.kind === 'restore-builtin') return { sequence: 1, hostId: 'host', profileId: f.store.context().profileId };
    if (command.kind === 'scope-recovery') { scoped = command; assert.equal(f.requests.filter(value => value.op === 'restore').length, 0, 'native scope is pinned before the host write'); return { admission: 'accepted' }; }
    if (command.kind === 'confirm-recovery') { confirmation = command; return {}; }
    if (command.kind === 'read-recovery-cancellation') return { cancelled: false };
    throw new Error(command.kind);
  } }); f.after(() => ui.close());
  await ui.restore();
  const request = f.requests.findLast(value => value.op === 'restore');
  const { receipt } = await f.store.execute({ op: 'status', requestId: request.requestId });
  assert.deepEqual(scoped.expectedContext, { hostId: 'host', profileId: f.store.context().profileId });
  assert.equal(confirmation.deliveryGeneration, receipt.deliveryGeneration);
  assert.deepEqual(confirmation.expectedContext, { hostId: 'host', profileId: f.store.context().profileId });
});

test('a canceled startup wake cannot post Restore or retain a reservation for the new profile', async t => {
  const f = await fixture(t); await f.apply(); let scopes = 0;
  const ui = new MainUiConnection({ context: { liveRelay: false, brokerInstance: 'canceled-startup' }, async request(command) {
    if (command.kind === 'scope-recovery') { scopes++; return { admission: 'cancelled' }; }
    if (command.kind === 'read-recovery-cancellation') return { cancelled: false };
    throw new Error(command.kind);
  } }); f.after(() => ui.close());
  assert.equal(await ui.restoreNative(1, null), false);
  assert.equal(scopes, 1); assert.equal(f.requests.filter(value => value.op === 'restore').length, 0);
  assert.equal(f.store.context().selection.selected.kind, 'experience'); assert.equal(f.cached(), null);
  assert.equal(ui.getSnapshot().localBuiltin, false);
});

test('a delayed unbound initiating reply joins the same sequence already resolved by its wake', async t => {
  const f = await fixture(t); await f.apply(); const entered = gate(), release = gate(); let initiator;
  f.after(() => release.resolve());
  const authority = { hostId: 'host', profileId: f.store.context().profileId };
  const ui = new MainUiConnection({ context: { liveRelay: false, brokerInstance: 'adopted-startup' }, async request(command) {
    if (command.kind === 'restore-builtin') { initiator = command.requestId; entered.resolve(); await release.promise; return { sequence: 1, hostId: null, profileId: null }; }
    if (command.kind === 'scope-recovery') return { admission: 'accepted' };
    if (command.kind === 'confirm-recovery') return {};
    if (command.kind === 'read-recovery-cancellation') return { cancelled: false };
    throw new Error(command.kind);
  } }); f.after(() => ui.close());
  const initiating = ui.restore(); await entered.promise;
  assert.equal(await ui.restoreNative(1, authority, initiator), true);
  release.resolve(); await initiating;
  assert.equal(f.requests.filter(value => value.op === 'restore').length, 1);
  assert.equal(f.store.context().selection.selected.kind, 'builtin'); assert.equal(f.cached(), null);
});


test('same-profile double Restore supersedes the unposted action without rejecting or dropping fallback', async t => {
  const f = await fixture(t); await f.apply(); f.scope(command => ({ admission: command.submitted || command.sequence === f.latestSequence() ? 'accepted' : 'superseded' }));
  const seen = []; f.ui.subscribe(() => seen.push(f.ui.getSnapshot().localBuiltin));
  const results = await Promise.allSettled([f.ui.restore(), f.ui.restore()]);
  assert.deepEqual(results.map(value => value.status), ['fulfilled', 'fulfilled']);
  assert.equal(f.requests.filter(value => value.op === 'restore').length, 1);
  const firstBuiltin = seen.indexOf(true); assert.ok(firstBuiltin >= 0); assert.equal(seen.slice(firstBuiltin).includes(false), false);
  assert.equal(f.store.context().selection.selected.kind, 'builtin'); assert.equal(f.pending(), false); assert.equal(f.cached(), null);
});

test('superseding a submitted Restore replays its lost receipt before reserving from an offline context', async t => {
  const f = await fixture(t); await f.apply(); const committed = gate(), release = gate(); let lose = true, offline = false;
  f.after(() => release.resolve()); f.scope(command => ({ admission: command.submitted || command.sequence === f.latestSequence() ? 'accepted' : 'superseded' }));
  f.transport(async (request, run) => {
    if (request.op === 'context' && offline) throw new Error('Context offline while Restore remains reachable');
    const response = await run();
    if (request.op === 'restore' && lose) { lose = false; offline = true; committed.resolve(); await release.promise; throw new Error('Host committed but reply was lost'); }
    return response;
  });
  const first = f.ui.restore(); await committed.promise; const second = f.ui.restore(); release.resolve(); await Promise.all([first, second]);
  assert.equal(f.cached(), null); assert.equal(f.pending(), false); assert.equal(f.store.context().revision, 3);
  assert.equal(new Set(f.requests.filter(value => value.op === 'restore').map(value => value.requestId)).size, 2);
});


test('an unposted native reservation becomes durable only after native admission', async t => {
  const f = await fixture(t); await f.apply(); let admitted = false, posted = false;
  f.scope(command => { assert.equal(command.submitted, false); assert.equal(f.cached(), null); admitted = true; return { admission: 'accepted' }; });
  f.transport((request, run) => {
    if (request.op === 'restore') { assert.equal(admitted, true); assert.equal(f.cached().submitted, true); assert.equal(f.cached().request.requestId, request.requestId); posted = true; }
    return run();
  });
  await f.ui.restore(); assert.equal(posted, true); assert.equal(f.cached(), null);
});


test('a new explicit native Restore proceeds after an older uncommitted request definitively conflicts', async t => {
  const f = await fixture(t); await f.apply(); let first = true;
  f.transport(async (request, run) => {
    if (request.op === 'restore' && first) { first = false; throw new Error('Request never reached host'); }
    try { return await run(); } catch (error) { return Response.json({ ok: false, code: error.code, error: error.message }, { status: 409 }); }
  });
  await f.ui.restore(); const old = f.cached().request.requestId; await f.apply();
  await f.ui.restore();
  assert.equal(f.store.context().selection.selected.kind, 'builtin'); assert.equal(f.cached(), null); assert.equal(f.pending(), false);
  assert.ok(f.requests.some(request => request.op === 'restore' && request.requestId !== old));
});

for (const [admission, submitted] of [['accepted', false], ['wrong-host', false], ['accepted', true]]) test(`a delayed native admission cannot persist an unposted Restore after another profile binds (${admission}, submitted ${submitted})`, { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'native-admission-profile-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  let saved; if (submitted) { saved = { ...reserveRecovery(f.store.context(), { kind: 'native', brokerInstance: 'held-admission', sequence: 1 }), submitted: true }; await f.store.execute(saved.request); await f.apply(); localStorage.setItem(UI_RECOVERY_KEY, JSON.stringify(saved)); }
  const entered = gate(), release = gate(), disconnect = gate(); let current = f.store, presence = 0; const polls = new Map();
  globalThis.document = { visibilityState: 'visible' };
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body), target = current;
    const count = request.op === 'state' ? (polls.get(target) ?? 0) + 1 : 0; if (count) polls.set(target, count);
    if (request.op === 'state' && count > 1) {
      if (target === other) { await disconnect.promise; throw new Error('Switch back to A'); }
      return new Promise((_, reject) => { if (options.signal.aborted) reject(new Error('Closed')); else options.signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    }
    try { return Response.json({ ok: true, value: await target.execute(parseUiRequest(request)) }); }
    catch (error) { return Response.json({ ok: false, code: error.code ?? 'unavailable', error: error.message }, { status: 409 }); }
  };
  const identity = { role: 'main', brokerInstance: 'held-admission', label: 'main', documentIncarnation: 'held-document', viewId: 'held-view' };
  const ui = new MainUiConnection({ context: { ...identity, liveRelay: false }, async request(command) {
    if (command.kind === 'restore-builtin') return { sequence: 1, hostId: 'host', profileId: f.store.context().profileId };
    if (command.kind === 'scope-recovery') { entered.resolve(); await release.promise; if (admission === 'wrong-host') throw 'wrong-host'; return { admission: 'accepted' }; }
    if (command.kind === 'bind-ui') return { ...identity, hostId: command.hostId, profileId: command.profileId };
    if (command.kind === 'presence') return { presenceSequence: ++presence };
    if (command.kind === 'drain-ui') return { children: [], reports: [], localBuiltin: false };
    if (command.kind === 'publish-ui' || command.kind === 'confirm-recovery') return {};
    if (command.kind === 'read-recovery-cancellation') return { cancelled: false };
    throw new Error(command.kind);
  } }); let restoring;
  f.after(async () => { release.resolve(); disconnect.resolve(); ui.close(); await restoring?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Admission binding did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  restoring = submitted ? ui.restoreNative(1, { hostId: 'host', profileId: f.store.context().profileId }) : ui.restore(); await entered.promise; current = other; ui.start();
  await until(() => JSON.parse(ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && ui.getSnapshot().state !== null);
  release.resolve(); await restoring.catch(() => {});
  if (submitted) { assert.equal(f.cached().kind, 'reserved'); assert.equal(f.cached().request.requestId, saved.request.requestId); }
  else { assert.equal(f.cached(), null); assert.equal(localStorage.getItem(`${UI_RECOVERY_KEY}:${JSON.stringify(['host', f.store.context().profileId])}`), null); }
  current = f.store; disconnect.resolve(); await until(() => JSON.parse(ui.getSnapshot().deliveryContext ?? 'null')?.profileId === f.store.context().profileId && ui.getSnapshot().state !== null);
  assert.equal(ui.getSnapshot().localBuiltin, false); assert.equal(f.store.context().selection.selected.kind, 'experience'); assert.equal(f.cached(), null);
});


for (const bytes of ['{', '{"version":2}']) test(`explicit Restore heals unreadable active recovery bytes (${bytes})`, async t => {
  const f = await fixture(t); await f.apply(); localStorage.setItem(UI_RECOVERY_KEY, bytes);
  const ui = new UiConnection(); f.after(() => ui.close()); await ui.restore();
  assert.equal(f.store.context().selection.selected.kind, 'builtin'); assert.equal(f.cached(), null);
  const reopened = new UiConnection(); f.after(() => reopened.close()); assert.equal(reopened.getSnapshot().localBuiltin, false); assert.equal(reopened.getSnapshot().diagnostic, null);
});

test('a wrong-profile host refusal cannot retire an older submitted receipt', async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'native-wrong-profile-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); f.after(async () => { other.close(); await rm(directory, { recursive: true, force: true }); });
  let first = true, wrong = false, old;
  f.transport(async (request, run) => {
    try {
      if (request.op === 'restore' && wrong && request.requestId === old) { wrong = false; return Response.json({ ok: true, value: await other.execute(parseUiRequest(request)) }); }
      const response = await run();
      if (request.op === 'restore' && first) { first = false; throw new Error('Original A commit reply lost'); }
      return response;
    } catch (error) { if (!error.code) throw error; return Response.json({ ok: false, code: error.code, error: error.message }, { status: 409 }); }
  });
  await f.ui.restore(); old = f.cached().request.requestId; wrong = true;
  await f.ui.restore().catch(() => {});
  assert.equal(f.cached().kind, 'reserved'); assert.equal(f.cached().request.requestId, old);
  assert.equal(f.requests.some(request => request.op === 'restore' && request.requestId !== old), false);
  await f.ui.restore(); assert.equal(f.cached(), null); assert.equal(f.pending(), false);
});

test('a pre-existing reader loads a conflicted scoped recovery without reposting it', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); globalThis.document = { visibilityState: 'visible' };
  const first = new UiConnection(), second = new UiConnection(); f.after(() => { first.close(); second.close(); });
  let restorePosts = 0;
  f.transport(async (request, run) => {
    if (request.op === 'restore') { restorePosts++; await f.apply(); }
    try { return await run(); } catch (error) { return Response.json({ ok: false, code: error.code, error: error.message }, { status: 409 }); }
  });
  await first.restore(); assert.equal(f.cached().kind, 'conflicted'); const before = restorePosts;
  second.start(); const deadline = Date.now() + 2500;
  while (!second.getSnapshot().state) { if (Date.now() > deadline) throw new Error('Second reader did not load its conflict'); await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.equal(restorePosts, before); assert.match(second.getSnapshot().diagnostic, /Current UI revision/);
});


test('a stale reader cannot resurrect a recovery another reader already retired', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); let first = true, target;
  const directory = await mkdtemp(join(tmpdir(), 'stale-recovery-profile-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  f.after(async () => { other.close(); await rm(directory, { recursive: true, force: true }); });
  f.transport(async (request, run) => {
    if (target) return Response.json({ ok: true, value: await target.execute(parseUiRequest(request)) });
    const response = await run(); if (request.op === 'restore' && first) { first = false; throw new Error('A committed reply was lost'); } return response;
  });
  await f.ui.restore(); const stale = new UiConnection(); f.after(() => stale.close());
  await f.ui.restore(); await f.ui.restore(); await f.apply();
  const key = `${UI_RECOVERY_KEY}:${JSON.stringify(['host', f.store.context().profileId])}`;
  assert.equal(localStorage.getItem(key), null); target = other; await stale.restore(); assert.equal(localStorage.getItem(key), null);
  target = null; globalThis.document = { visibilityState: 'visible' }; const reopened = new UiConnection(); f.after(() => reopened.close());
  const before = f.requests.filter(request => request.op === 'restore').length; reopened.start(); const deadline = Date.now() + 2500;
  while (!reopened.getSnapshot().state) { if (Date.now() > deadline) throw new Error('A theme did not load'); await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.equal(reopened.getSnapshot().localBuiltin, false); assert.equal(f.requests.filter(request => request.op === 'restore').length, before);
});

test('a stale passive reader observes that another reader retired its submitted recovery', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); let lose = true;
  f.transport(async (request, run) => {
    try {
      const response = await run(); if (request.op === 'restore' && lose) { lose = false; throw new Error('Committed A reply lost'); } return response;
    } catch (error) { if (!error.code) throw error; return Response.json({ ok: false, code: error.code, error: error.message }, { status: 409 }); }
  });
  await f.ui.restore(); const stale = new UiConnection(); f.after(() => stale.close());
  await f.ui.restore(); await f.ui.restore(); await f.apply(); globalThis.document = { visibilityState: 'visible' };
  const before = f.requests.filter(request => request.op === 'restore').length; stale.start(); const deadline = Date.now() + 2500;
  while (!stale.getSnapshot().state) { if (Date.now() > deadline) throw new Error('Stale reader did not load'); await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.equal(stale.getSnapshot().localBuiltin, false); assert.equal(f.requests.filter(request => request.op === 'restore').length, before);
});

for (const readable of [true, false]) test(`a delayed terminal refusal cannot resurrect a recovery retired by another reader (shared reads ${readable})`, { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const entered = gate(), release = gate(); let inject = true, held = false;
  f.after(() => release.resolve());
  f.transport(async (request, run) => {
    if (request.op === 'restore' && inject) { inject = false; await f.apply(); }
    let response; try { response = await run(); } catch (error) { response = Response.json({ ok: false, code: error.code, error: error.message }, { status: 409 }); }
    if (request.op === 'restore' && !held) { held = true; entered.resolve(); await release.promise; }
    return response;
  });
  const first = new UiConnection(); f.after(() => first.close()); const pending = first.restore(); await entered.promise;
  const second = new UiConnection(); f.after(() => second.close()); await second.restore(); await second.restore(); await f.apply();
  const storage = globalThis.localStorage; f.after(() => { globalThis.localStorage = storage; });
  if (!readable) globalThis.localStorage = { ...storage, getItem(key) { if (key.startsWith(UI_RECOVERY_KEY + ':')) throw new Error('Scoped ownership read unavailable'); return storage.getItem(key); } };
  assert.equal(f.cached(), null); release.resolve(); await pending; assert.equal(f.cached(), null);
  if (readable) { assert.equal(first.getSnapshot().localBuiltin, false); assert.doesNotMatch(first.getSnapshot().diagnostic ?? '', /Builtin appearance is local/); }
  const key = `${UI_RECOVERY_KEY}:${JSON.stringify(['host', f.store.context().profileId])}`; assert.equal(storage.getItem(key), null);
});

test('a scoped terminal conflict wins when its active-slot update failed', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const storage = globalThis.localStorage; globalThis.document = { visibilityState: 'visible' };
  globalThis.localStorage = { ...storage, setItem(key, raw) { if (key === UI_RECOVERY_KEY && JSON.parse(raw).kind === 'conflicted') throw new Error('Active conflict write unavailable'); storage.setItem(key, raw); } };
  f.after(() => { globalThis.localStorage = storage; }); let posts = 0;
  f.transport(async (request, run) => {
    if (request.op === 'restore') { posts++; await f.apply(); }
    try { return await run(); } catch (error) { return Response.json({ ok: false, code: error.code, error: error.message }, { status: 409 }); }
  });
  const first = new UiConnection(); f.after(() => first.close()); await first.restore(); assert.equal(f.cached().kind, 'reserved');
  const before = posts, reopened = new UiConnection(); f.after(() => reopened.close()); reopened.start(); const deadline = Date.now() + 2500;
  while (!reopened.getSnapshot().state) { if (Date.now() > deadline) throw new Error('Partial conflict did not load'); await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.equal(posts, before); assert.match(reopened.getSnapshot().diagnostic, /Current UI revision/);
});

test('a passive needs-context marker retires when another reader completes recovery', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); let offline = true;
  f.transport((request, run) => { if (offline && request.op === 'context') throw new Error('Context offline'); return run(); });
  const first = new UiConnection(); f.after(() => first.close()); await first.restore(); assert.equal(f.cached().kind, 'needs-context');
  const stale = new UiConnection(); f.after(() => stale.close()); offline = false; await first.restore(); await f.apply(); assert.equal(f.cached(), null);
  globalThis.document = { visibilityState: 'visible' }; stale.start(); const deadline = Date.now() + 2500;
  while (!stale.getSnapshot().state) { if (Date.now() > deadline) throw new Error('Needs-context reader did not load'); await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.equal(stale.getSnapshot().localBuiltin, false); assert.equal(stale.getSnapshot().diagnostic, null);
});

test('malformed scoped bytes do not strand an exact valid active request', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); let offline = true;
  f.transport(async (request, run) => { if (request.op === 'restore' && offline) throw new Error('Before commit'); try { return await run(); } catch (error) { return Response.json({ ok: false, code: error.code, error: error.message }, { status: 409 }); } });
  const seed = new UiConnection(); f.after(() => seed.close()); await seed.restore(); await f.apply(); offline = false;
  const key = `${UI_RECOVERY_KEY}:${JSON.stringify(['host', f.store.context().profileId])}`; localStorage.setItem(key, '{'); globalThis.document = { visibilityState: 'visible' };
  const reopened = new UiConnection(); f.after(() => reopened.close()); reopened.start(); const deadline = Date.now() + 2500;
  while (!reopened.getSnapshot().state) { if (Date.now() > deadline) throw new Error('Exact active request remained stranded'); await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.equal(f.cached().kind, 'conflicted'); await reopened.restore(); assert.equal(f.cached(), null);
});

for (const removable of [true, false]) test(`successful retry retires superseded active bytes before scoped cleanup (removable ${removable})`, { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); let offline = true;
  f.transport(async (request, run) => { if (request.op === 'restore' && offline) throw new Error('Before commit'); try { return await run(); } catch (error) { return Response.json({ ok: false, code: error.code, error: error.message }, { status: 409 }); } });
  const ui = new UiConnection(); f.after(() => ui.close()); await ui.restore(); const old = f.cached().request.requestId; await f.apply(); offline = false;
  const storage = globalThis.localStorage, key = `${UI_RECOVERY_KEY}:${JSON.stringify(['host', f.store.context().profileId])}`;
  globalThis.localStorage = { ...storage, setItem(name, raw) { if (name === UI_RECOVERY_KEY) throw new Error('Active writes unavailable'); storage.setItem(name, raw); }, removeItem(name) { if (!removable && name === UI_RECOVERY_KEY) throw new Error('Active removal unavailable'); storage.removeItem(name); } }; f.after(() => { globalThis.localStorage = storage; });
  await ui.restore(); assert.equal(ui.getSnapshot().localBuiltin, true); await ui.restore(); const newest = f.requests.findLast(request => request.op === 'restore').requestId; assert.notEqual(newest, old);
  if (removable) assert.equal(storage.getItem(UI_RECOVERY_KEY), null);
  else assert.equal(JSON.parse(storage.getItem(key)).request.requestId, newest, 'preserve scoped success until the superseded active copy can retire');
  globalThis.localStorage = storage; await f.apply(); globalThis.document = { visibilityState: 'visible' };
  const before = f.requests.length, reopened = new UiConnection(); f.after(() => reopened.close()); reopened.start(); const deadline = Date.now() + 2500;
  while (!reopened.getSnapshot().state) { if (Date.now() > deadline) throw new Error('Successful retry did not heal split storage'); await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.equal(reopened.getSnapshot().localBuiltin, false); assert.equal(f.cached(), null); assert.equal(f.requests.slice(before).some(request => request.op === 'restore' && request.requestId === old), false);
});

test('a delayed passive refusal cannot clear the newer explicit action fallback', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); let phase = 'seed', held = false, holdContext = false; const dispatched = [];
  const passive = gate(), releasePassive = gate(), context = gate(), releaseContext = gate(); f.after(() => { releasePassive.resolve(); releaseContext.resolve(); });
  f.transport(async (request, run) => {
    if (request.op === 'restore' && phase === 'new-action') dispatched.push({ requestId: request.requestId, fallback: first.getSnapshot().localBuiltin });
    if (request.op === 'restore' && phase === 'seed') throw new Error('Before commit');
    if (request.op === 'context' && holdContext) { holdContext = false; context.resolve(); await releaseContext.promise; }
    let response; try { response = await run(); } catch (error) { response = Response.json({ ok: false, code: error.code, error: error.message }, { status: 409 }); }
    if (request.op === 'restore' && phase === 'passive' && !held) { held = true; passive.resolve(); await releasePassive.promise; }
    return response;
  });
  const seed = new UiConnection(); f.after(() => seed.close()); await seed.restore(); await f.apply(); phase = 'passive'; globalThis.document = { visibilityState: 'visible' };
  const first = new UiConnection(); f.after(() => first.close()); first.start(); await passive.promise;
  const second = new UiConnection(); f.after(() => second.close()); await second.restore(); await second.restore(); await f.apply();
  phase = 'new-action'; holdContext = true; const action = first.restore(); f.after(async () => { releaseContext.resolve(); await action; }); await context.promise;
  releasePassive.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.getSnapshot().localBuiltin, true); releaseContext.resolve(); await action;
  assert.ok(dispatched.length > 0, 'the newer explicit action dispatched its request'); assert.ok(dispatched.every(value => value.fallback), 'fallback stays active at dispatch'); assert.equal(f.store.context().selection.selected.kind, 'builtin');
});

for (const replacement of ['pending', 'complete', 'successful-predecessor']) test('a native action retains its own reservation after adopting a browser replacement (' + replacement + ')', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); let phase = 'seed', held = false, holdReplacement = false, replacementId;
  const oldEntered = gate(), releaseOld = gate(), nextEntered = gate(), releaseNext = gate(); let native, browser;
  f.after(async () => { releaseOld.resolve(); releaseNext.resolve(); await native?.catch(() => {}); await browser?.catch(() => {}); });
  let original;
  f.transport(async (request, run) => {
    if (request.op === 'restore' && phase === 'seed') { if (replacement === 'successful-predecessor') await run(); throw new Error('Original browser reply unavailable'); }
    let response; try { response = await run(); } catch (error) { response = Response.json({ ok: false, code: error.code, error: error.message }, { status: 409 }); }
    if (request.op === 'restore' && request.requestId === original && !held) { held = true; oldEntered.resolve(); await releaseOld.promise; }
    if (request.op === 'restore' && request.requestId !== original && holdReplacement && !replacementId) { replacementId = request.requestId; nextEntered.resolve(); await releaseNext.promise; }
    return response;
  });
  const seed = new UiConnection(); f.after(() => seed.close()); await seed.restore(); original = f.cached().request.requestId; if (replacement !== 'successful-predecessor') await f.apply(); phase = 'reconcile';
  native = f.ui.restore(); await oldEntered.promise;
  const second = new UiConnection(); f.after(() => second.close()); await second.restore();
  if (replacement === 'pending') { holdReplacement = true; browser = second.restore(); await nextEntered.promise; }
  else { await second.restore(); await f.apply(); }
  const current = f.store.context(); releaseOld.resolve(); await native;
  assert.equal(f.pending(), false); assert.equal(f.cached(), null); assert.equal(f.store.context().selection.selected.kind, 'builtin');
  assert.ok(f.confirmations.some(value => value.sequence === 1));
  const own = f.requests.findLast(request => request.op === 'restore'); assert.notEqual(own.requestId, original); if (replacementId) assert.notEqual(own.requestId, replacementId);
  assert.equal(own.expectedRevision, current.revision); assert.equal(own.expectedRecoveryGeneration, current.recoveryGeneration);
  releaseNext.resolve(); await browser;
});

test('a transport loss observes that another reader retired the same committed request', async t => {
  const f = await fixture(t); await f.apply(); const entered = gate(), release = gate(); let first = true, offline = false; f.after(() => release.resolve());
  f.transport(async (request, run) => {
    if (request.op === 'context' && offline) throw new Error('Disconnected context');
    const response = await run();
    if (request.op === 'restore' && first) { first = false; entered.resolve(); await release.promise; throw new Error('Committed response body lost'); }
    return response;
  });
  const original = new UiConnection(); f.after(() => original.close()); const action = original.restore(); await entered.promise;
  const second = new UiConnection(); f.after(() => second.close()); await second.restore(); await f.apply(); assert.equal(f.cached(), null); offline = true;
  release.resolve(); await action; assert.equal(original.getSnapshot().localBuiltin, false); assert.doesNotMatch(original.getSnapshot().diagnostic ?? '', /Builtin appearance is local/); assert.equal(f.cached(), null);
});

for (const available of [true, false]) test(`a native action keeps fallback after its transport reply is retired (fresh context ${available})`, { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const entered = gate(), release = gate(); let first = true, retrying = false; const fallbacks = [];
  f.after(() => release.resolve());
  f.transport(async (request, run) => {
    if (retrying && request.op === 'context') { fallbacks.push(f.ui.getSnapshot().localBuiltin); if (!available) throw new Error('Fresh context unavailable'); }
    const response = await run();
    if (request.op === 'restore' && first) { first = false; entered.resolve(); await release.promise; throw new Error('Committed native response lost'); }
    return response;
  });
  const action = f.ui.restore(); await entered.promise;
  const other = new UiConnection(); f.after(() => other.close()); await other.restore(); await f.apply(); retrying = true; release.resolve(); await action.catch(() => {});
  assert.ok(fallbacks.length > 0); assert.ok(fallbacks.every(Boolean), 'native fallback survives mandatory fresh context');
  if (available) { assert.equal(f.pending(), false); assert.equal(f.store.context().selection.selected.kind, 'builtin'); }
  else { assert.equal(f.ui.getSnapshot().localBuiltin, true); assert.match(f.ui.getSnapshot().diagnostic, /retry/i); assert.equal(f.pending(), true); }
});

test('retiring shared recovery invalidates cached context before a new reservation', async t => {
  const f = await fixture(t); await f.apply(); let seed = true, offline = false;
  f.transport((request, run) => {
    if (request.op === 'restore' && seed) throw new Error('Before commit');
    if (request.op === 'context' && offline) throw new Error('Context offline');
    return run();
  });
  const first = new UiConnection(); f.after(() => first.close()); await first.restore(); seed = false;
  const other = new UiConnection(); f.after(() => other.close()); await other.restore(); await f.apply(); offline = true;
  const before = f.requests.filter(request => request.op === 'restore').length; await first.restore();
  assert.equal(f.requests.filter(request => request.op === 'restore').length, before, 'no successor from a retired reservation cached context');
  offline = false; await first.restore(); assert.equal(f.store.context().selection.selected.kind, 'builtin');
});

test('a valid native receipt still confirms after another reader retires its outbox', async t => {
  const f = await fixture(t); await f.apply(); const entered = gate(), release = gate(); let first = true; f.after(() => release.resolve());
  f.transport(async (request, run) => {
    const response = await run(); if (request.op === 'restore' && first) { first = false; entered.resolve(); await release.promise; } return response;
  });
  const action = f.ui.restore(); await entered.promise;
  const other = new UiConnection(); f.after(() => other.close()); await other.restore(); await f.apply();
  const before = f.requests.filter(request => request.op === 'restore').length; release.resolve(); await action;
  assert.equal(f.pending(), false); assert.equal(f.requests.filter(request => request.op === 'restore').length, before, 'validated own receipt does not create a successor');
  assert.equal(f.store.context().selection.selected.kind, 'experience'); assert.equal(f.cached(), null);
});

test('native successor refreshes counters after predecessor confirmation awaits a sibling commit', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); let lose = true, hold = true; const entered = gate(), release = gate(); f.after(() => release.resolve());
  f.transport(async (request, run) => { const response = await run(); if (request.op === 'restore' && lose) { lose = false; throw new Error('First reply lost'); } return response; });
  await f.ui.restore();
  f.confirm(async sequence => { if (sequence === 1 && hold) { hold = false; entered.resolve(); await release.promise; } });
  const newer = f.ui.restore(); await entered.promise;
  const other = new UiConnection(); f.after(() => other.close()); await other.restore(); await other.restore(); const current = f.store.context(); release.resolve(); await newer;
  assert.equal(f.pending(), false); const own = f.requests.findLast(request => request.op === 'restore');
  assert.equal(own.expectedRecoveryGeneration, current.recoveryGeneration); assert.equal(own.expectedRevision, current.revision);
});

test('confirmation retry retains a validated native receipt after shared outbox retirement', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const entered = gate(), release = gate(); let first = true, fail = true; f.after(() => release.resolve());
  f.transport(async (request, run) => { const response = await run(); if (request.op === 'restore' && first) { first = false; entered.resolve(); await release.promise; } return response; });
  f.confirm(async () => { if (fail) { fail = false; throw new Error('Confirmation IPC lost'); } });
  const action = f.ui.restore(); await entered.promise; const other = new UiConnection(); f.after(() => other.close()); await other.restore(); await f.apply();
  const before = f.requests.filter(request => request.op === 'restore').length; release.resolve(); await action.catch(() => {});
  await f.wake(1, { hostId: 'host', profileId: f.store.context().profileId });
  assert.equal(f.requests.filter(request => request.op === 'restore').length, before, 'retry only confirms the committed native request');
  assert.equal(f.store.context().selection.selected.kind, 'experience'); assert.equal(f.confirmations.length, 2);
});

for (const native of [false, true]) test(`successful receipts retire local work when scoped reads fail (native ${native})`, { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const storage = globalThis.localStorage;
  globalThis.localStorage = { ...storage, getItem(key) { if (key.startsWith(UI_RECOVERY_KEY + ':')) throw new Error('Scoped reads unavailable'); return storage.getItem(key); } }; f.after(() => { globalThis.localStorage = storage; });
  let posts = 0; f.transport((request, run) => { if (request.op === 'restore' && ++posts > 4) throw new Error('Repeated predecessor replay exceeded probe budget'); return run(); });
  const ui = native ? f.ui : new UiConnection(); if (!native) f.after(() => ui.close());
  await ui.restore(); const original = f.requests.findLast(request => request.op === 'restore').requestId; await f.apply(); await ui.restore();
  assert.equal(f.store.context().selection.selected.kind, 'builtin'); assert.notEqual(f.requests.findLast(request => request.op === 'restore').requestId, original);
  if (native) assert.equal(f.pending(), false);
});

test('live state cannot retire a native fallback after its mandatory context read fails', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); globalThis.document = { visibilityState: 'visible' };
  const identity = { role: 'main', brokerInstance: 'live-fallback', label: 'main', documentIncarnation: 'fallback-document', viewId: 'fallback-view' }; let sequence = 0, presence = 0;
  const ui = new MainUiConnection({ context: { ...identity, liveRelay: false }, async request(command) {
    if (command.kind === 'restore-builtin') return { sequence: ++sequence, hostId: 'host', profileId: f.store.context().profileId };
    if (command.kind === 'scope-recovery') return { admission: 'accepted' };
    if (command.kind === 'confirm-recovery' || command.kind === 'publish-ui') return {};
    if (command.kind === 'bind-ui') return { ...identity, hostId: command.hostId, profileId: command.profileId };
    if (command.kind === 'presence') return { presenceSequence: ++presence };
    if (command.kind === 'drain-ui') return { children: [], reports: [], localBuiltin: false };
    if (command.kind === 'read-recovery-cancellation') return { cancelled: false };
    throw new Error(command.kind);
  } }); f.after(() => ui.close()); await ui.restore(); await f.apply();
  const entered = gate(), release = gate(), stateEntered = gate(), releaseState = gate(); let holdRestore = true, offline = false, firstState = true;
  f.after(() => { release.resolve(); releaseState.resolve(); });
  f.transport(async (request, run, signal) => {
    if (request.op === 'context' && offline) throw new Error('Mandatory context offline');
    if (request.op === 'state') {
      if (firstState) { firstState = false; stateEntered.resolve(); await releaseState.promise; }
      else return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    }
    const response = await run(); if (request.op === 'restore' && holdRestore) { holdRestore = false; entered.resolve(); await release.promise; throw new Error('Native response lost'); } return response;
  });
  ui.start(); await stateEntered.promise; const action = ui.restore(); await entered.promise;
  const other = new UiConnection(); f.after(() => other.close()); await other.restore(); await f.apply(); offline = true; release.resolve(); await action.catch(() => {}); releaseState.resolve();
  const deadline = Date.now() + 2500; while (ui.getSnapshot().state?.selection.selected.kind !== 'experience') { if (Date.now() > deadline) throw new Error('Themed state did not arrive'); await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.equal(ui.getSnapshot().localBuiltin, true); assert.match(ui.getSnapshot().diagnostic, /retry/i);
});

test('readable completed bytes with failed cleanup cannot refetch context forever', async t => {
  const f = await fixture(t); await f.apply(); const storage = globalThis.localStorage; let contexts = 0;
  globalThis.localStorage = { ...storage, removeItem(key) { if (key.startsWith(UI_RECOVERY_KEY + ':')) throw new Error('Scoped removal failed'); storage.removeItem(key); } }; f.after(() => { globalThis.localStorage = storage; });
  f.transport((request, run) => { if (request.op === 'context' && ++contexts > 5) throw new Error('Repeated context fetch exceeded probe budget'); return run(); });
  const ui = new UiConnection(); f.after(() => ui.close()); await ui.restore(); await f.apply(); await ui.restore();
  assert.equal(f.store.context().selection.selected.kind, 'builtin'); assert.ok(contexts <= 3);
});

for (const scenario of ['same-sequence', 'new-sequence', 'new-sequence-after-reader-refresh']) test(`a pending receipt confirmation preserves action identity across a held context (${scenario})`, { timeout: 5000 }, async t => {
  const newer = scenario !== 'same-sequence', refreshReader = scenario === 'new-sequence-after-reader-refresh';
  const f = await fixture(t); await f.apply(); globalThis.document = { visibilityState: 'visible' };
  let fail = true, held = false, holdContext = false, states = 0, scopeCalls = 0;
  const confirming = gate(), releaseConfirm = gate(), releaseContext = gate(), stateRead = gate(), contextCaptured = gate(); f.after(() => { releaseConfirm.resolve(); releaseContext.resolve(); });
  f.scope(command => { scopeCalls++; return { admission: command.submitted || f.pending() ? 'accepted' : 'cancelled' }; });
  f.confirm(async () => { if (fail) { fail = false; throw new Error('Confirmation failed'); } if (!held) { held = true; confirming.resolve(); await releaseConfirm.promise; } });
  f.transport(async (request, run, signal) => {
    if (request.op === 'state' && ++states > (refreshReader ? 2 : 1)) return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    const response = await run(); if (request.op === 'context' && holdContext) { holdContext = false; contextCaptured.resolve(); await releaseContext.promise; }
    if (request.op === 'state') { if (refreshReader && states === 1) throw new Error('Reconnect and refresh context before releasing the old action lookup'); stateRead.resolve(); } return response;
  });
  await f.ui.restore(); f.ui.start(); await confirming.promise; holdContext = true; const before = scopeCalls;
  const action = newer ? f.ui.restore() : f.wake(1, { hostId: 'host', profileId: f.store.context().profileId });
  if (newer) { await contextCaptured.promise; const other = new UiConnection(); f.after(() => other.close()); await other.restore(); await other.restore(); await f.apply(); }
  const current = f.store.context(); releaseConfirm.resolve(); await stateRead.promise; releaseContext.resolve(); const outcome = await Promise.allSettled([action]);
  assert.equal(outcome[0].status, 'fulfilled'); if (!newer) { assert.equal(outcome[0].value, true); assert.equal(scopeCalls, before, 'same-sequence confirmation never reserves'); }
  else { assert.equal(f.pending(), false); const own = f.requests.findLast(request => request.op === 'restore'); assert.equal(own.expectedRevision, current.revision); assert.equal(own.expectedRecoveryGeneration, current.recoveryGeneration); }
});

test('an unpersisted predecessor yields to a newer scoped receipt after native confirmation', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const storage = globalThis.localStorage; let refuseWrite = true, lose = true, held = false, siblingId;
  const confirming = gate(), releaseConfirm = gate(), siblingEntered = gate(), releaseSibling = gate(); let action, sibling;
  f.after(async () => { releaseConfirm.resolve(); releaseSibling.resolve(); await action?.catch(() => {}); await sibling?.catch(() => {}); globalThis.localStorage = storage; });
  globalThis.localStorage = { ...storage, setItem(key, raw) { if (refuseWrite && key.startsWith(UI_RECOVERY_KEY + ':')) throw new Error('Predecessor scoped write failed'); storage.setItem(key, raw); } };
  f.transport(async (request, run) => { const response = await run(); if (request.op === 'restore' && lose) { lose = false; throw new Error('Committed reply lost'); } if (request.op === 'restore' && siblingId === 'next') { siblingId = request.requestId; siblingEntered.resolve(); await releaseSibling.promise; } return response; });
  await f.ui.restore(); refuseWrite = false; f.confirm(async sequence => { if (sequence === 1 && !held) { held = true; confirming.resolve(); await releaseConfirm.promise; } });
  action = f.ui.restore(); await confirming.promise; const other = new UiConnection(); f.after(() => other.close()); siblingId = 'next'; sibling = other.restore(); await siblingEntered.promise;
  const current = f.store.context(); releaseConfirm.resolve(); await action; assert.equal(f.pending(), false);
  const own = f.requests.findLast(request => request.op === 'restore'); assert.notEqual(own.requestId, siblingId); assert.equal(own.expectedRevision, current.revision); assert.equal(own.expectedRecoveryGeneration, current.recoveryGeneration);
  releaseSibling.resolve(); await sibling;
});

test('a refused profile bind retains the original native fallback owner', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); globalThis.document = { visibilityState: 'visible' }; await f.ui.restore(); await f.apply();
  const directory = await mkdtemp(join(tmpdir(), 'refused-fallback-bind-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other); f.after(async () => { other.close(); await rm(directory, { recursive: true, force: true }); });
  const restoreEntered = gate(), releaseRestore = gate(), stateEntered = gate(), releaseState = gate(), rebound = gate(); f.after(() => { releaseRestore.resolve(); releaseState.resolve(); });
  let current = f.store, offline = false, holdRestore = true, states = 0, refused = false;
  f.bind(async command => { if (command.profileId === other.context().profileId) { refused = true; current = f.store; throw NATIVE_BINDING_REFUSED; } });
  f.transport(async (request, run, signal) => {
    if (request.op === 'context' && offline) throw new Error('Mandatory context unavailable');
    if (request.op === 'state') {
      states++;
      if (states === 1) { stateEntered.resolve(); await releaseState.promise; }
      else if (states === 2) { current = other; throw new Error('Reconnect to B'); }
      else if (states > 3) return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    }
    const response = current === f.store ? await run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
    if (request.op === 'restore' && holdRestore) { holdRestore = false; restoreEntered.resolve(); await releaseRestore.promise; throw new Error('Native reply lost'); }
    if (request.op === 'state' && states === 3) rebound.resolve(); return response;
  });
  f.ui.start(); await stateEntered.promise; const action = f.ui.restore(); await restoreEntered.promise; const sibling = new UiConnection(); f.after(() => sibling.close()); await sibling.restore(); await f.apply(); offline = true; releaseRestore.resolve(); await action.catch(() => {}); offline = false; releaseState.resolve(); await rebound.promise;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(refused, true); assert.equal(f.ui.getSnapshot().localBuiltin, true); assert.equal(f.pending(), true);
});

test('a refused foreign binding interval cannot reject an admitted original-profile Restore', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); globalThis.document = { visibilityState: 'visible' };
  const directory = await mkdtemp(join(tmpdir(), 'overlap-refused-bind-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other); f.after(async () => { other.close(); await rm(directory, { recursive: true, force: true }); });
  const polling = gate(), releasePoll = gate(), admitting = gate(), releaseAdmission = gate(), binding = gate(), releaseBinding = gate(); let current = f.store, states = 0, action;
  f.after(async () => { releasePoll.resolve(); releaseAdmission.resolve(); releaseBinding.resolve(); await action?.catch(() => {}); });
  f.scope(async () => { admitting.resolve(); await releaseAdmission.promise; return { admission: 'accepted' }; });
  f.bind(async command => { if (command.profileId === other.context().profileId) { binding.resolve(); await releaseBinding.promise; current = f.store; throw NATIVE_BINDING_REFUSED; } });
  f.transport(async (request, run, signal) => {
    if (request.op === 'state') {
      states++;
      if (states === 2) { polling.resolve(); await releasePoll.promise; current = other; throw new Error('Observe B'); }
      if (states > 2) return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    }
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  f.ui.start(); await polling.promise; action = f.ui.restore(); await admitting.promise; releasePoll.resolve(); await binding.promise;
  releaseAdmission.resolve(); await new Promise(resolve => setImmediate(resolve)); releaseBinding.resolve(); const result = await Promise.allSettled([action]);
  assert.equal(result[0].status, 'fulfilled'); assert.equal(f.store.context().selection.selected.kind, 'builtin'); assert.equal(f.pending(), false);
});


test('confirmation-only retries keep recorded semantics through repeated IPC failures', async t => {
  const f = await fixture(t); await f.apply(); let confirmations = 0;
  f.confirm(async () => { if (++confirmations <= 2) throw new Error('Confirmation reply unavailable'); });
  await f.ui.restore(); const posts = f.requests.filter(request => request.op === 'restore').length;
  const host = { hostId: 'host', profileId: f.store.context().profileId };
  assert.equal(await f.wake(1, host), true, 'the exact host receipt remains recorded after another confirmation failure');
  assert.match(f.ui.getSnapshot().diagnostic, /retry/i); assert.equal(await f.wake(1, host), true);
  assert.equal(confirmations, 3); assert.equal(f.requests.filter(request => request.op === 'restore').length, posts);
});

test('a late retired receipt invalidates only its own profile cached context', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'late-profile-epoch-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const committed = gate(), release = gate(), stateReady = gate(); let current = f.store, first = true, offline = false, states = 0, action;
  f.after(async () => { release.resolve(); await action?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.transport(async (request, run, signal) => {
    if (request.op === 'context' && offline) throw new Error('Context endpoint unavailable');
    if (request.op === 'state' && ++states > 1) return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    const response = current === f.store ? await run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
    if (request.op === 'restore' && first) { first = false; committed.resolve(); await release.promise; }
    if (request.op === 'state') stateReady.resolve(); return response;
  });
  const ui = new UiConnection(); f.after(() => ui.close()); action = ui.restore(); await committed.promise;
  const sibling = new UiConnection(); f.after(() => sibling.close()); await sibling.restore(); current = other; globalThis.document = { visibilityState: 'visible' }; ui.start(); await stateReady.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(ui.getSnapshot().deliveryContext).profileId, other.context().profileId); release.resolve(); await action;
  offline = true; await ui.restore(); assert.equal(other.context().selection.selected.kind, 'builtin', 'A retirement cannot stale valid B counters');
});

test('a stale accepted admission cannot post through backoff after the committed profile changed', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'admitted-profile-backoff-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const admitted = gate(), releaseAdmission = gate(), rebinding = gate(), releaseRebind = gate(); let current = f.store, boundB = false, bStates = 0, action;
  f.after(async () => { releaseAdmission.resolve(); releaseRebind.resolve(); await action?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.scope(async () => { admitted.resolve(); await releaseAdmission.promise; return { admission: 'accepted' }; });
  f.bind(async command => { if (command.profileId === other.context().profileId) boundB = true; else if (boundB) { rebinding.resolve(); await releaseRebind.promise; throw NATIVE_BINDING_REFUSED; } });
  f.transport((request, run) => {
    if (request.op === 'state' && current === other && ++bStates > 1) { current = f.store; throw new Error('B disconnected while broker stays bound B'); }
    return current === f.store ? run() : other.execute(parseUiRequest(request)).then(value => Response.json({ ok: true, value }));
  });
  action = f.ui.restore(); await admitted.promise; current = other; globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await rebinding.promise;
  assert.equal(JSON.parse(f.ui.getSnapshot().deliveryContext).profileId, other.context().profileId); releaseAdmission.resolve(); await new Promise(resolve => setImmediate(resolve)); releaseRebind.resolve(); await action.catch(() => {});
  assert.equal(f.requests.some(request => request.op === 'restore'), false, 'no A POST after B committed'); assert.equal(f.cached(), null); assert.equal(f.store.context().selection.selected.kind, 'experience');
});

test('a successful A to B to A bind cancels the old unsubmitted native reservation', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'admission-aba-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const admitted = gate(), releaseAdmission = gate(), disconnect = gate(); let current = f.store, nativeAlive = true, first = true, bStates = 0, action;
  f.after(async () => { releaseAdmission.resolve(); disconnect.resolve(); await action?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.scope(async () => { if (first) { first = false; admitted.resolve(); await releaseAdmission.promise; return { admission: 'accepted' }; } return { admission: nativeAlive ? 'accepted' : 'cancelled' }; });
  f.bind(async command => { if (command.profileId === other.context().profileId) nativeAlive = false; });
  f.transport(async (request, run, signal) => {
    if (request.op === 'state' && current === other && ++bStates > 1) { await disconnect.promise; current = f.store; throw new Error('Return to A'); }
    if (request.op === 'state' && current === f.store) return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('A/B binding did not commit'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  action = f.ui.restore(); await admitted.promise; current = other; globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && bStates > 1);
  disconnect.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === f.store.context().profileId); releaseAdmission.resolve(); await action.catch(() => {});
  assert.equal(f.requests.some(request => request.op === 'restore'), false); assert.equal(f.cached(), null); assert.equal(localStorage.getItem(`${UI_RECOVERY_KEY}:${JSON.stringify(['host', f.store.context().profileId])}`), null); assert.equal(f.store.context().selection.selected.kind, 'experience');
});

test('a held older state cannot regress the counters advanced by a Restore receipt', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); globalThis.document = { visibilityState: 'visible' };
  const captured = gate(), release = gate(), next = gate(); let states = 0, offline = false; f.after(() => release.resolve());
  f.transport(async (request, run, signal) => {
    if (request.op === 'context' && offline) throw new Error('Context endpoint unavailable');
    if (request.op === 'state' && ++states > 1) { next.resolve(); return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); }); }
    const response = await run(); if (request.op === 'state') { captured.resolve(); await release.promise; } return response;
  });
  const ui = new UiConnection(); f.after(() => ui.close()); ui.start(); await captured.promise; await ui.restore(); const receipt = f.store.context(); release.resolve(); await next.promise; offline = true; await ui.restore();
  const newest = f.requests.findLast(request => request.op === 'restore'); assert.equal(newest.expectedRevision, receipt.revision); assert.equal(newest.expectedRecoveryGeneration, receipt.recoveryGeneration); assert.equal(f.cached(), null);
});

test('a context captured before an owned receipt cannot authorize a later native successor', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); globalThis.document = { visibilityState: 'visible' };
  const posting = gate(), releasePost = gate(), captured = gate(), releaseContext = gate(), stateRead = gate(); let initial = true, holdPost = true, holdContext = false, states = 0, action;
  f.after(async () => { releasePost.resolve(); releaseContext.resolve(); await action?.catch(() => {}); });
  f.transport(async (request, run, signal) => {
    if (request.op === 'restore' && initial) { initial = false; throw new Error('Original POST never reached host'); }
    if (request.op === 'restore' && holdPost) { holdPost = false; posting.resolve(); await releasePost.promise; }
    if (request.op === 'state' && ++states > 1) return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    const response = await run(); if (request.op === 'context' && holdContext) { holdContext = false; captured.resolve(); await releaseContext.promise; } if (request.op === 'state') stateRead.resolve(); return response;
  });
  await f.ui.restore(); f.ui.start(); await posting.promise; holdContext = true; action = f.ui.restore(); await captured.promise; releasePost.resolve(); await stateRead.promise; const receipt = f.store.context(); releaseContext.resolve(); await action;
  assert.equal(f.pending(), false); const newest = f.requests.findLast(request => request.op === 'restore'); assert.equal(newest.expectedRevision, receipt.revision); assert.equal(newest.expectedRecoveryGeneration, receipt.recoveryGeneration);
});

test('a delayed same-profile reconnect preserves counters from a newer receipt', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); globalThis.document = { visibilityState: 'visible' };
  const reconnect = gate(), releaseReconnect = gate(), stateRead = gate(); let states = 0, holdContext = false, offline = false;
  f.after(() => releaseReconnect.resolve());
  f.transport(async (request, run, signal) => {
    if (request.op === 'context' && offline) throw new Error('Context endpoint unavailable');
    if (request.op === 'state') {
      if (++states === 2) { holdContext = true; throw new Error('Reconnect A'); }
      if (states > 3) return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    }
    const response = await run(); if (request.op === 'context' && holdContext) { holdContext = false; reconnect.resolve(); await releaseReconnect.promise; }
    if (request.op === 'state' && states === 3) stateRead.resolve(); return response;
  });
  f.ui.start(); await reconnect.promise; await f.ui.restore(); const receipt = f.store.context(); releaseReconnect.resolve(); await stateRead.promise; await new Promise(resolve => setImmediate(resolve)); offline = true; await f.ui.restore();
  const newest = f.requests.findLast(request => request.op === 'restore'); assert.equal(newest.expectedRevision, receipt.revision); assert.equal(newest.expectedRecoveryGeneration, receipt.recoveryGeneration); assert.equal(f.pending(), false); assert.equal(f.cached(), null);
});

test('a lost foreign binding reply is reconciled before polling the original profile', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'lost-bind-reply-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other); f.after(async () => { other.close(); await rm(directory, { recursive: true, force: true }); });
  globalThis.document = { visibilityState: 'visible' }; let current = f.store, brokerProfile = null, states = 0, originalBinds = 0; const returned = gate();
  f.bind(async command => { brokerProfile = command.profileId; if (command.profileId === other.context().profileId) { current = f.store; throw new Error('B bound but reply lost'); } originalBinds++; });
  f.scope(command => { if (command.expectedContext.profileId !== brokerProfile) throw 'wrong-host'; return { admission: 'accepted' }; });
  f.transport(async (request, run, signal) => {
    if (request.op === 'state') {
      if (++states === 2) { current = other; throw new Error('Observe B'); }
      if (states > 3) return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    }
    const response = current === f.store ? await run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
    if (request.op === 'state' && states === 3) returned.resolve(); return response;
  });
  f.ui.start(); await returned.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(brokerProfile, f.store.context().profileId, 'A polling cannot resume with native broker still on B'); assert.equal(originalBinds, 2);
  await f.ui.restore(); assert.equal(f.store.context().selection.selected.kind, 'builtin'); assert.equal(f.pending(), false);
});

test('lost foreign binding acknowledgement cannot reuse a cancelled unsubmitted admission', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'lost-admission-aba-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const admitted = gate(), release = gate(); let current = f.store, nativeAlive = true, first = true, action;
  f.after(async () => { release.resolve(); await action?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.scope(async () => { if (first) { first = false; admitted.resolve(); await release.promise; return { admission: 'accepted' }; } return { admission: nativeAlive ? 'accepted' : 'cancelled' }; });
  f.bind(async command => { if (command.profileId === other.context().profileId) { nativeAlive = false; current = f.store; throw new Error('B committed and cancelled A, reply lost'); } });
  f.transport(async (request, run, signal) => {
    if (request.op === 'state') return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  action = f.ui.restore(); await admitted.promise; current = other; globalThis.document = { visibilityState: 'visible' }; f.ui.start();
  const deadline = Date.now() + 2500; while (JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId !== f.store.context().profileId) { if (Date.now() > deadline) throw new Error('A did not rebind'); await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.equal(nativeAlive, false); release.resolve(); await action.catch(() => {});
  assert.equal(f.requests.some(request => request.op === 'restore'), false); assert.equal(f.cached(), null); assert.equal(f.store.context().selection.selected.kind, 'experience');
});

test('equivalent native rebind preserves an in-flight paint confirmation', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); globalThis.document = { visibilityState: 'visible' };
  const polling = gate(), reconnect = gate(), painting = gate(), releasePaint = gate(), stateEntered = gate(), releaseState = gate(); let states = 0;
  f.after(() => { reconnect.resolve(); releasePaint.resolve(); releaseState.resolve(); });
  f.transport(async (request, run) => {
    if (request.op === 'state') {
      if (++states === 2) { polling.resolve(); await reconnect.promise; throw new Error('Reconfirm native binding'); }
      if (states === 3) { stateEntered.resolve(); await releaseState.promise; }
    }
    const response = await run(); if (request.op === 'paint') { painting.resolve(); await releasePaint.promise; } return response;
  });
  f.ui.start(); await polling.promise; const state = f.ui.getSnapshot().state; assert.ok(state); const paint = f.ui.rendered(state); await painting.promise; reconnect.resolve(); await stateEntered.promise;
  releasePaint.resolve(); await paint; assert.equal(f.ui.getSnapshot().confirmedGeneration, state.selection.deliveryGeneration, 'same binding keeps the current paint owner before another poll can repair it'); releaseState.resolve();
});

test('a cancelled admission stays terminal when a newer native Restore is pending', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'terminal-cancelled-admission-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const admitting = gate(), releaseAdmission = gate(), disconnect = gate(), posting = gate(), releasePost = gate(); let current = f.store, firstScope = true, bStates = 0, firstAction, newerAction;
  f.after(async () => { releaseAdmission.resolve(); disconnect.resolve(); releasePost.resolve(); await firstAction?.catch(() => {}); await newerAction?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.scope(async command => { if (firstScope) { firstScope = false; admitting.resolve(); await releaseAdmission.promise; throw 'wrong-host'; } return { admission: command.sequence === 1 ? 'superseded' : 'accepted' }; });
  f.transport(async (request, run, signal) => {
    if (request.op === 'restore') { posting.resolve(); await releasePost.promise; }
    if (request.op === 'state' && current === other && ++bStates > 1) { await disconnect.promise; current = f.store; throw new Error('Return to A'); }
    if (request.op === 'state' && current === f.store) return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Cancellation binding did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  firstAction = f.ui.restore(); const firstOutcome = Promise.allSettled([firstAction]); await admitting.promise; current = other; globalThis.document = { visibilityState: 'visible' }; f.ui.start();
  await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && bStates > 1); disconnect.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === f.store.context().profileId);
  newerAction = f.ui.restore(); releaseAdmission.resolve(); await posting.promise; const result = await firstOutcome;
  assert.equal(result[0].status, 'rejected', 'cancelled action cannot release an inline resume before the newer host write commits'); assert.equal(f.store.context().selection.selected.kind, 'experience');
  releasePost.resolve(); await newerAction; assert.equal(f.pending(), false);
});

for (const foreign of [true, false]) for (const timing of ['active', 'completed']) test(`an older initiating reply checks cancellation before inheriting a newer result (${foreign ? 'foreign binding' : 'same profile'}, ${timing})`, { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'older-native-inheritance-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), returnA = gate(), allocated = gate(), releaseOld = gate(), posting = gate(), releasePost = gate();
  let current = f.store, aStates = 0, bStates = 0, bound = null, cancelledThrough = 0, old, newer;
  f.after(async () => { disconnect.resolve(); returnA.resolve(); releaseOld.resolve(); releasePost.resolve(); await old?.catch(() => {}); await newer?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.restoreReply(async reply => { if (reply.sequence === 1) { allocated.resolve(); await releaseOld.promise; } return reply; });
  f.bind(async command => { if (bound !== null && bound !== command.profileId) cancelledThrough = f.latestSequence(); bound = command.profileId; });
  f.cancellations(sequence => sequence <= cancelledThrough);
  f.scope(command => ({ admission: !command.submitted && command.sequence <= cancelledThrough ? 'cancelled' : command.sequence < f.latestSequence() ? 'superseded' : 'accepted' }));
  f.transport(async (request, run, signal) => {
    if (request.op === 'restore') { posting.resolve(); await releasePost.promise; }
    if (request.op === 'state') {
      if (current === f.store && ++aStates > 1) {
        if (foreign && aStates === 2) { polling.resolve(); await disconnect.promise; current = other; throw new Error('Bind B'); }
        polling.resolve(); return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
      }
      if (current === other && ++bStates > 1) { await returnA.promise; current = f.store; throw new Error('Return A'); }
    }
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Older caller binding did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await polling.promise; old = f.ui.restore(); const oldResult = Promise.allSettled([old]); await allocated.promise;
  if (foreign) { disconnect.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && bStates > 1); returnA.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === f.store.context().profileId); }
  newer = f.ui.restore(); await posting.promise;
  if (timing === 'active') releaseOld.resolve();
  releasePost.resolve(); await newer;
  if (timing === 'completed') releaseOld.resolve();
  const result = await oldResult; assert.equal(result[0].status, foreign ? 'rejected' : 'fulfilled');
  assert.equal(f.requests.filter(request => request.op === 'restore').length, 1); assert.equal(f.store.context().selection.selected.kind, 'builtin');
});

test('admission handoff never submits after a binding cancelled it', { timeout: 30000 }, async t => {
  for (let hops = 0; hops <= 6; hops++) await t.test(`native reply scheduling ${hops}`, { timeout: 5000 }, async child => {
    const f = await fixture(child); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'admission-final-handoff-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host');
    const captured = gate(), releaseContext = gate(), bound = gate(), releaseBind = gate(); let offerB = false, states = 0, cancelled = false, first = true;
    const dispatches = []; let action;
    f.after(async () => { releaseContext.resolve(); releaseBind.resolve(); await action?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
    f.bind(async command => { if (command.profileId === other.context().profileId) { cancelled = true; bound.resolve(); await releaseBind.promise; throw new Error('Foreign bind committed but reply lost'); } });
    f.scope(async () => {
      if (first) { first = false; releaseContext.resolve(); for (let n = 0; n < hops; n++) await Promise.resolve(); return { admission: 'accepted' }; }
      return { admission: cancelled ? 'cancelled' : 'accepted' };
    });
    f.confirm(async () => { if (cancelled) throw 'wrong-host'; });
    f.transport(async (request, run, signal) => {
      if (request.op === 'state') {
        if (++states === 2) { offerB = true; throw new Error('Reconnect to B'); }
        if (states > 2) return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
      }
      if (request.op === 'context' && offerB) { offerB = false; const response = Response.json({ ok: true, value: await other.execute(parseUiRequest(request)) }); captured.resolve(); await releaseContext.promise; return response; }
      if (request.op === 'restore') dispatches.push({ cancelled, submitted: f.cached()?.submitted });
      return run();
    });
    globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await captured.promise; action = f.ui.restore(); const outcome = Promise.allSettled([action]); await bound.promise;
    await new Promise(resolve => setImmediate(resolve)); releaseBind.resolve(); await outcome;
    assert.equal(dispatches.some(value => value.cancelled), false, 'no POST can use admission invalidated before its dispatch');
  });
});

test('an exact completed receipt join stays recorded after a foreign binding roundtrip', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'exact-completed-join-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), returnA = gate(), allocated = gate(), releaseOld = gate(); let current = f.store, aStates = 0, bStates = 0, bound = null, cancelledThrough = 0, old;
  f.after(async () => { disconnect.resolve(); returnA.resolve(); releaseOld.resolve(); await old?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.restoreReply(async reply => { allocated.resolve(); await releaseOld.promise; return reply; });
  f.bind(async command => { if (bound !== null && bound !== command.profileId) cancelledThrough = f.latestSequence(); bound = command.profileId; }); f.cancellations(sequence => sequence <= cancelledThrough);
  f.transport(async (request, run, signal) => {
    if (request.op === 'state') {
      if (current === f.store && ++aStates > 1) { if (aStates === 2) { polling.resolve(); await disconnect.promise; current = other; throw new Error('Bind B'); } return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); }); }
      if (current === other && ++bStates > 1) { await returnA.promise; current = f.store; throw new Error('Return A'); }
    }
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Exact receipt binding did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await polling.promise; old = f.ui.restore(); const result = Promise.allSettled([old]); await allocated.promise;
  assert.equal(await f.wake(1, { hostId: 'host', profileId: f.store.context().profileId }), true);
  disconnect.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && bStates > 1); returnA.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === f.store.context().profileId);
  releaseOld.resolve(); assert.equal((await result)[0].status, 'fulfilled'); assert.equal(f.requests.filter(request => request.op === 'restore').length, 1);
});

test('a superseded exact completed join still checks foreign binding cancellation', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'exact-completed-join-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), returnA = gate(), allocated = gate(), releaseOld = gate(), allocatedNew = gate(), releaseNew = gate(); let newer, current = f.store, aStates = 0, bStates = 0, bound = null, cancelledThrough = 0, old;
  f.after(async () => { disconnect.resolve(); returnA.resolve(); releaseOld.resolve(); releaseNew.resolve(); await newer?.catch(() => {}); await old?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.restoreReply(async reply => { if (reply.sequence === 1) { allocated.resolve(); await releaseOld.promise; } else { allocatedNew.resolve(); await releaseNew.promise; } return reply; });
  f.scope(command => ({ admission: command.sequence <= cancelledThrough ? 'cancelled' : command.sequence < f.latestSequence() ? 'superseded' : 'accepted' }));
  f.bind(async command => { if (bound !== null && bound !== command.profileId) cancelledThrough = f.latestSequence(); bound = command.profileId; }); f.cancellations(sequence => sequence <= cancelledThrough);
  f.transport(async (request, run, signal) => {
    if (request.op === 'state') {
      if (current === f.store && ++aStates > 1) { if (aStates === 2) { polling.resolve(); await disconnect.promise; current = other; throw new Error('Bind B'); } return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); }); }
      if (current === other && ++bStates > 1) { await returnA.promise; current = f.store; throw new Error('Return A'); }
    }
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Exact receipt binding did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await polling.promise; old = f.ui.restore(); const result = Promise.allSettled([old]); await allocated.promise;
  newer = f.ui.restore(); void newer.catch(() => {}); await allocatedNew.promise;
  assert.equal(await f.wake(1, { hostId: 'host', profileId: f.store.context().profileId }), true);
  disconnect.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && bStates > 1); returnA.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === f.store.context().profileId);
  releaseOld.resolve(); assert.equal((await result)[0].status, 'rejected'); assert.equal(f.requests.filter(request => request.op === 'restore').length, 0);
});

test('an initially unbound completed join retains its resolved receipt authority', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'exact-completed-join-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), returnA = gate(), allocated = gate(), releaseOld = gate(); let current = f.store, aStates = 0, bStates = 0, bound = null, cancelledThrough = 0, old;
  f.after(async () => { disconnect.resolve(); returnA.resolve(); releaseOld.resolve(); await old?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.restoreReply(async reply => { allocated.resolve(); await releaseOld.promise; return { ...reply, hostId: null, profileId: null }; });
  f.bind(async command => { if (bound !== null && bound !== command.profileId) cancelledThrough = f.latestSequence(); bound = command.profileId; }); f.cancellations(sequence => sequence <= cancelledThrough);
  f.transport(async (request, run, signal) => {
    if (request.op === 'state') {
      if (current === f.store && ++aStates > 1) { if (aStates === 2) { polling.resolve(); await disconnect.promise; current = other; throw new Error('Bind B'); } return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); }); }
      if (current === other && ++bStates > 1) { await returnA.promise; current = f.store; throw new Error('Return A'); }
    }
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Exact receipt binding did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.document = { visibilityState: 'visible' }; old = f.ui.restore(); const result = Promise.allSettled([old]); await allocated.promise;
  assert.equal(await f.wake(1, null), true);
  f.ui.start(); await polling.promise;
  disconnect.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && bStates > 1);
  releaseOld.resolve(); assert.equal((await result)[0].status, 'rejected'); assert.equal(other.context().selection.selected.kind, 'experience'); assert.equal(f.requests.filter(request => request.op === 'restore').length, 1);
});

test('an unbound exact confirmation join cannot report success after a foreign binding', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'exact-completed-join-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), returnA = gate(), allocated = gate(), releaseOld = gate(), confirming = gate(), releaseConfirm = gate(), joined = gate(); let waking, current = f.store, aStates = 0, bStates = 0, bound = null, cancelledThrough = 0, old;
  f.after(async () => { disconnect.resolve(); returnA.resolve(); releaseOld.resolve(); releaseConfirm.resolve(); await waking?.catch(() => {}); await old?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.restoreReply(async reply => { allocated.resolve(); await releaseOld.promise; return { ...reply, hostId: null, profileId: null }; });
  f.confirm(async () => { confirming.resolve(); await releaseConfirm.promise; });
  f.bind(async command => { if (bound !== null && bound !== command.profileId) cancelledThrough = f.latestSequence(); bound = command.profileId; }); f.cancellations(sequence => sequence <= cancelledThrough);
  f.transport(async (request, run, signal) => {
    if (request.op === 'state') {
      if (current === f.store && ++aStates > 1) { if (aStates === 2) { polling.resolve(); await disconnect.promise; current = other; throw new Error('Bind B'); } return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); }); }
      if (current === other && ++bStates > 1) { await returnA.promise; current = f.store; throw new Error('Return A'); }
    }
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Exact receipt binding did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.document = { visibilityState: 'visible' }; old = f.ui.restore(); const result = Promise.allSettled([old]); await allocated.promise;
  f.ui.start(); await polling.promise;
  waking = f.wake(1, null); await confirming.promise;
  const actualRestore = f.ui.restoreNative.bind(f.ui);
  f.ui.restoreNative = (...args) => { const promise = actualRestore(...args); joined.resolve(); return promise; };
  releaseOld.resolve(); await joined.promise;
  disconnect.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && bStates > 1);
  releaseConfirm.resolve(); await waking; assert.equal((await result)[0].status, 'rejected'); assert.equal(other.context().selection.selected.kind, 'experience'); assert.equal(f.requests.filter(request => request.op === 'restore').length, 1);
});

test('reader-confirmed replay promotes an exact pending result before a binding roundtrip', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const recoveryGeneration = f.store.context().recoveryGeneration; const directory = await mkdtemp(join(tmpdir(), 'exact-completed-join-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), returnA = gate(), allocated = gate(), releaseOld = gate(), replay = gate(), replayed = gate(); let lose = true, current = f.store, aStates = 0, bStates = 0, bound = null, cancelledThrough = 0, old;
  f.after(async () => { disconnect.resolve(); replay.resolve(); returnA.resolve(); releaseOld.resolve(); await old?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.restoreReply(async reply => { allocated.resolve(); await releaseOld.promise; return reply; });
  f.bind(async command => { if (bound !== null && bound !== command.profileId) cancelledThrough = f.latestSequence(); bound = command.profileId; }); f.cancellations(sequence => sequence <= cancelledThrough);
  f.transport(async (request, run, signal) => {
    if (request.op === 'restore' && lose) { lose = false; await run(); throw new Error('Lost committed Restore response'); }
    if (request.op === 'state') {
      if (current === f.store && ++aStates > 1) { if (aStates === 2) { polling.resolve(); await replay.promise; throw new Error('Reconnect A for receipt replay'); } if (aStates === 3) { replayed.resolve(); await disconnect.promise; current = other; throw new Error('Bind B'); } return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); }); }
      if (current === other && ++bStates > 1) { await returnA.promise; current = f.store; throw new Error('Return A'); }
    }
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Exact receipt binding did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await polling.promise; old = f.ui.restore(); const result = Promise.allSettled([old]); await allocated.promise;
  assert.equal(await f.wake(1, { hostId: 'host', profileId: f.store.context().profileId }), true);
  replay.resolve(); await replayed.promise; assert.equal(f.confirmations.length, 1);
  disconnect.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && bStates > 1); returnA.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === f.store.context().profileId);
  releaseOld.resolve(); assert.equal((await result)[0].status, 'fulfilled'); const posts = f.requests.filter(request => request.op === 'restore'); assert.equal(posts.length, 2); assert.equal(new Set(posts.map(request => request.requestId)).size, 1); assert.equal(f.store.context().recoveryGeneration, recoveryGeneration + 1);
});

test('an exact cached receipt join waits for a committed foreign binding acknowledgement', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'exact-completed-join-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), returnA = gate(), allocated = gate(), releaseOld = gate(), binding = gate(), releaseBind = gate(), delivered = gate(); let settled = false, current = f.store, aStates = 0, bStates = 0, bound = null, cancelledThrough = 0, old;
  f.after(async () => { disconnect.resolve(); returnA.resolve(); releaseOld.resolve(); releaseBind.resolve(); await old?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.restoreReply(async reply => { allocated.resolve(); await releaseOld.promise; delivered.resolve(); return { ...reply, hostId: null, profileId: null }; });
  f.bind(async command => { if (bound !== null && bound !== command.profileId) cancelledThrough = f.latestSequence(); bound = command.profileId; if (command.profileId === other.context().profileId) { binding.resolve(); await releaseBind.promise; } }); f.cancellations(sequence => sequence <= cancelledThrough);
  f.transport(async (request, run, signal) => {
    if (request.op === 'state') {
      if (current === f.store && ++aStates > 1) { if (aStates === 2) { polling.resolve(); await disconnect.promise; current = other; throw new Error('Bind B'); } return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); }); }
      if (current === other && ++bStates > 1) { await returnA.promise; current = f.store; throw new Error('Return A'); }
    }
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Exact receipt binding did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.document = { visibilityState: 'visible' }; old = f.ui.restore(); const result = Promise.allSettled([old]).then(value => { settled = true; return value; }); await allocated.promise;
  assert.equal(await f.wake(1, null), true);
  f.ui.start(); await polling.promise;
  disconnect.resolve(); await binding.promise; releaseOld.resolve(); await delivered.promise; await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false, 'binding acknowledgement is still pending');
  releaseBind.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && bStates > 1);
  assert.equal((await result)[0].status, 'rejected'); assert.equal(other.context().selection.selected.kind, 'experience'); assert.equal(f.requests.filter(request => request.op === 'restore').length, 1);
});


test('an in-flight pending join observes its exact replayed receipt before cancellation', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const recoveryGeneration = f.store.context().recoveryGeneration; const directory = await mkdtemp(join(tmpdir(), 'exact-completed-join-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), returnA = gate(), allocated = gate(), releaseOld = gate(), replay = gate(), replayed = gate(), readingCancellation = gate(), releaseCancellation = gate(); let lose = true, current = f.store, aStates = 0, bStates = 0, bound = null, cancelledThrough = 0, old;
  f.after(async () => { disconnect.resolve(); replay.resolve(); returnA.resolve(); releaseOld.resolve(); releaseCancellation.resolve(); await old?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.restoreReply(async reply => { allocated.resolve(); await releaseOld.promise; return reply; });
  f.bind(async command => { if (bound !== null && bound !== command.profileId) cancelledThrough = f.latestSequence(); bound = command.profileId; }); f.cancellations(sequence => sequence <= cancelledThrough);
  f.transport(async (request, run, signal) => {
    if (request.op === 'restore' && lose) { lose = false; await run(); throw new Error('Lost committed Restore response'); }
    if (request.op === 'state') {
      if (current === f.store && ++aStates > 1) { if (aStates === 2) { polling.resolve(); await replay.promise; throw new Error('Reconnect A for receipt replay'); } if (aStates === 3) { replayed.resolve(); await disconnect.promise; current = other; throw new Error('Bind B'); } return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); }); }
      if (current === other && ++bStates > 1) { await returnA.promise; current = f.store; throw new Error('Return A'); }
    }
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Exact receipt binding did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await polling.promise; old = f.ui.restore(); const result = Promise.allSettled([old]); await allocated.promise;
  assert.equal(await f.wake(1, { hostId: 'host', profileId: f.store.context().profileId }), true);
  f.cancellations(async sequence => { readingCancellation.resolve(); await releaseCancellation.promise; return sequence <= cancelledThrough; });
  releaseOld.resolve(); await readingCancellation.promise; replay.resolve(); await replayed.promise; assert.equal(f.confirmations.length, 1);
  disconnect.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && bStates > 1); returnA.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === f.store.context().profileId);
  releaseCancellation.resolve(); assert.equal((await result)[0].status, 'fulfilled'); const posts = f.requests.filter(request => request.op === 'restore'); assert.equal(posts.length, 2); assert.equal(new Set(posts.map(request => request.requestId)).size, 1); assert.equal(f.store.context().recoveryGeneration, recoveryGeneration + 1);
});

test('an exact receipt cannot succeed while a committed foreign bind reply is lost', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'exact-completed-join-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), returnA = gate(), allocated = gate(), releaseOld = gate(), binding = gate(), releaseBind = gate(), delivered = gate(), releaseContext = gate(); let lost = false, settled = false, current = f.store, aStates = 0, bStates = 0, bound = null, cancelledThrough = 0, old;
  f.after(async () => { disconnect.resolve(); returnA.resolve(); releaseOld.resolve(); releaseBind.resolve(); releaseContext.resolve(); await old?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.restoreReply(async reply => { allocated.resolve(); await releaseOld.promise; delivered.resolve(); return { ...reply, hostId: null, profileId: null }; });
  f.bind(async command => { if (bound !== null && bound !== command.profileId) cancelledThrough = f.latestSequence(); bound = command.profileId; if (command.profileId === other.context().profileId) { binding.resolve(); await releaseBind.promise; lost = true; throw new Error('Committed native B binding reply lost'); } }); f.cancellations(sequence => sequence <= cancelledThrough);
  f.transport(async (request, run, signal) => {
    if (request.op === 'context' && lost) await releaseContext.promise;
    if (request.op === 'state') {
      if (current === f.store && ++aStates > 1) { if (aStates === 2) { polling.resolve(); await disconnect.promise; current = other; throw new Error('Bind B'); } return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); }); }
      if (current === other && ++bStates > 1) { await returnA.promise; current = f.store; throw new Error('Return A'); }
    }
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  globalThis.document = { visibilityState: 'visible' }; old = f.ui.restore(); const result = Promise.allSettled([old]).then(value => { settled = true; return value; }); await allocated.promise;
  assert.equal(await f.wake(1, null), true);
  f.ui.start(); await polling.promise;
  disconnect.resolve(); await binding.promise; releaseOld.resolve(); await delivered.promise; await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false, 'binding acknowledgement is still pending');
  releaseBind.resolve();
  assert.equal((await result)[0].status, 'rejected'); assert.equal(other.context().selection.selected.kind, 'experience'); assert.equal(f.requests.filter(request => request.op === 'restore').length, 1);
});



test('a newer completed Restore cannot evict an exact receipt needed by a live join', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const recoveryGeneration = f.store.context().recoveryGeneration; const directory = await mkdtemp(join(tmpdir(), 'exact-completed-join-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), returnA = gate(), allocated = gate(), releaseOld = gate(), replay = gate(), replayed = gate(), readingCancellation = gate(), releaseCancellation = gate(); let lose = true, current = f.store, aStates = 0, bStates = 0, bound = null, cancelledThrough = 0, old;
  f.after(async () => { disconnect.resolve(); replay.resolve(); returnA.resolve(); releaseOld.resolve(); releaseCancellation.resolve(); await old?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.restoreReply(async reply => { allocated.resolve(); await releaseOld.promise; return reply; });
  f.bind(async command => { if (bound !== null && bound !== command.profileId) cancelledThrough = f.latestSequence(); bound = command.profileId; }); f.cancellations(sequence => sequence <= cancelledThrough);
  f.transport(async (request, run, signal) => {
    if (request.op === 'restore' && lose) { lose = false; await run(); throw new Error('Lost committed Restore response'); }
    if (request.op === 'state') {
      if (current === f.store && ++aStates > 1) { if (aStates === 2) { polling.resolve(); await replay.promise; throw new Error('Reconnect A for receipt replay'); } if (aStates === 3) { replayed.resolve(); await disconnect.promise; current = other; throw new Error('Bind B'); } return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); }); }
      if (current === other && ++bStates > 1) { await returnA.promise; current = f.store; throw new Error('Return A'); }
    }
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Exact receipt binding did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await polling.promise; old = f.ui.restore(); const result = Promise.allSettled([old]); await allocated.promise;
  assert.equal(await f.wake(1, { hostId: 'host', profileId: f.store.context().profileId }), true);
  f.cancellations(async sequence => { if (sequence === 1) { readingCancellation.resolve(); await releaseCancellation.promise; } return sequence <= cancelledThrough; });
  releaseOld.resolve(); await readingCancellation.promise; replay.resolve(); await replayed.promise; assert.equal(f.confirmations.length, 1);
  disconnect.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && bStates > 1); returnA.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === f.store.context().profileId);
  await f.ui.restore();
  releaseCancellation.resolve(); assert.equal((await result)[0].status, 'fulfilled'); const posts = f.requests.filter(request => request.op === 'restore'); assert.equal(posts.length, 3); assert.equal(posts[0].requestId, posts[1].requestId); assert.notEqual(posts[1].requestId, posts[2].requestId); assert.equal(f.store.context().recoveryGeneration, recoveryGeneration + 2);
});

test('an initiating Restore retains its receipt before its allocation reply arrives', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'exact-completed-join-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), returnA = gate(), allocated = gate(), releaseOld = gate(); let current = f.store, aStates = 0, bStates = 0, bound = null, cancelledThrough = 0, old;
  f.after(async () => { disconnect.resolve(); returnA.resolve(); releaseOld.resolve(); await old?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.restoreReply(async reply => { if (reply.sequence === 1) { allocated.resolve(); await releaseOld.promise; } return reply; });
  f.bind(async command => { if (bound !== null && bound !== command.profileId) cancelledThrough = f.latestSequence(); bound = command.profileId; }); f.cancellations(sequence => sequence <= cancelledThrough);
  f.transport(async (request, run, signal) => {
    if (request.op === 'state') {
      if (current === f.store && ++aStates > 1) { if (aStates === 2) { polling.resolve(); await disconnect.promise; current = other; throw new Error('Bind B'); } return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); }); }
      if (current === other && ++bStates > 1) { await returnA.promise; current = f.store; throw new Error('Return A'); }
    }
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Exact receipt binding did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await polling.promise; old = f.ui.restore(); const result = Promise.allSettled([old]); await allocated.promise;
  await f.runtimeWake(); assert.equal(f.pending(), false);
  disconnect.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && bStates > 1); returnA.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === f.store.context().profileId);
  await f.ui.restore();
  releaseOld.resolve(); assert.equal((await result)[0].status, 'fulfilled'); const posts = f.requests.filter(request => request.op === 'restore'); assert.equal(posts.length, 2); assert.notEqual(posts[0].requestId, posts[1].requestId);
});


test('an exact receipt survives a failed held cancellation read', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const recoveryGeneration = f.store.context().recoveryGeneration; const directory = await mkdtemp(join(tmpdir(), 'exact-completed-join-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), returnA = gate(), allocated = gate(), releaseOld = gate(), replay = gate(), replayed = gate(), readingCancellation = gate(), releaseCancellation = gate(); let lose = true, current = f.store, aStates = 0, bStates = 0, bound = null, cancelledThrough = 0, old;
  f.after(async () => { disconnect.resolve(); replay.resolve(); returnA.resolve(); releaseOld.resolve(); releaseCancellation.resolve(); await old?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.restoreReply(async reply => { allocated.resolve(); await releaseOld.promise; return reply; });
  f.bind(async command => { if (bound !== null && bound !== command.profileId) cancelledThrough = f.latestSequence(); bound = command.profileId; }); f.cancellations(sequence => sequence <= cancelledThrough);
  f.transport(async (request, run, signal) => {
    if (request.op === 'restore' && lose) { lose = false; await run(); throw new Error('Lost committed Restore response'); }
    if (request.op === 'state') {
      if (current === f.store && ++aStates > 1) { if (aStates === 2) { polling.resolve(); await replay.promise; throw new Error('Reconnect A for receipt replay'); } if (aStates === 3) { replayed.resolve(); await disconnect.promise; current = other; throw new Error('Bind B'); } return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); }); }
      if (current === other && ++bStates > 1) { await returnA.promise; current = f.store; throw new Error('Return A'); }
    }
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Exact receipt binding did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await polling.promise; old = f.ui.restore(); const result = Promise.allSettled([old]); await allocated.promise;
  assert.equal(await f.wake(1, { hostId: 'host', profileId: f.store.context().profileId }), true);
  f.cancellations(async sequence => { if (sequence === 1) { readingCancellation.resolve(); await releaseCancellation.promise; throw new Error('Native cancellation reply lost'); } return sequence <= cancelledThrough; });
  releaseOld.resolve(); await readingCancellation.promise; replay.resolve(); await replayed.promise; assert.equal(f.confirmations.length, 1);
  disconnect.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && bStates > 1); returnA.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === f.store.context().profileId);
  await f.ui.restore();
  releaseCancellation.resolve(); assert.equal((await result)[0].status, 'fulfilled'); const posts = f.requests.filter(request => request.op === 'restore'); assert.equal(posts.length, 3); assert.equal(posts[0].requestId, posts[1].requestId); assert.notEqual(posts[1].requestId, posts[2].requestId); assert.equal(f.store.context().recoveryGeneration, recoveryGeneration + 2);
});

test('inline recovery cannot mutate a saved A reservation after a lost B binding reply', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'inline-profile-guard-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const { fixture: controllerFixture } = await import('./controller-fixture.mjs'), { WindowRuntime } = await import('../../apps/desktop/dist/application/window-runtime.js'), { WindowCoordinator } = await import('../../apps/desktop/dist/application/window-coordinator.js');
  const polling = gate(), disconnect = gate(), lost = gate(), releaseContext = gate(); let current = f.store, nativeProfile = f.store.context().profileId, aStates = 0, failed = false, transitionId = 'closed-A', phase = 'failed';
  const controller = controllerFixture(); await controller.app.start(); const scope = { hostId: 'host', conversationId: 'saved-A' }, context = { role: 'main', version: 1, label: 'main', brokerInstance: 'broker', documentIncarnation: 'document', viewId: 'main', reservation: null, liveRelay: true };
  const runtime = Object.assign(new WindowRuntime(context), { controller: controller.app, port: f.port, ui: f.ui, coordinator: new WindowCoordinator(f.port), drive: async () => {} });
  f.after(async () => { disconnect.resolve(); releaseContext.resolve(); other.close(); await controller.app.dispose(); await rm(directory, { recursive: true, force: true }); });
  f.bind(async command => { nativeProfile = command.profileId; if (nativeProfile === other.context().profileId) { failed = true; lost.resolve(); throw new Error('Native B binding reply lost'); } });
  f.recoverInline(command => {
    if (!command.expectedContext || command.expectedContext.hostId !== 'host' || command.expectedContext.profileId !== nativeProfile) throw 'wrong-host';
    transitionId = 'inline:A'; phase = 'inline-ready'; return { scope, viewId: 'saved-view', nativeLabel: 'closed-A', fromTransitionId: 'closed-A', transitionId, targetLabel: 'main', creationAgentId: null };
  });
  f.transport(async (request, run, signal) => {
    if (request.op === 'context' && failed) await releaseContext.promise;
    if (request.op === 'state' && current === f.store && ++aStates > 1) { polling.resolve(); await disconnect.promise; current = other; throw new Error('Observe B'); }
    if (request.op === 'state' && current === other) return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await polling.promise; disconnect.resolve(); await lost.promise; await new Promise(resolve => setImmediate(resolve));
  await runtime.resumeWindow({ scope, viewId: 'saved-view', label: 'closed-A', transitionId: 'closed-A', creationAgentId: null, phase: 'failed', bindingRevision: 1, writerGeneration: 1 }, true);
  assert.equal(transitionId, 'closed-A'); assert.equal(phase, 'failed'); assert.equal(f.requests.filter(request => request.op === 'restore').length, 0);
});

test('a correlated allocation reply retries its pending native confirmation', async t => {
  const f = await fixture(t); await f.apply(); const allocated = gate(), release = gate(); let attempts = 0, old;
  f.after(async () => { release.resolve(); await old?.catch(() => {}); });
  f.restoreReply(async reply => { allocated.resolve(); await release.promise; return reply; });
  f.beforeConfirm(async () => { if (++attempts === 1) throw new Error('Native confirmation failed before commit'); });
  old = f.ui.restore(); await allocated.promise; await f.runtimeWake(); assert.equal(f.pending(), true);
  release.resolve(); await old; assert.equal(attempts, 2); assert.equal(f.pending(), false); assert.equal(f.requests.filter(request => request.op === 'restore').length, 1);
});

test('a correlated receipt survives rejected confirmation after a foreign roundtrip', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'exact-completed-join-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), returnA = gate(), allocated = gate(), releaseOld = gate(), confirming = gate(), releaseConfirm = gate(), joined = gate(); let waking, current = f.store, aStates = 0, bStates = 0, bound = null, cancelledThrough = 0, old;
  f.after(async () => { disconnect.resolve(); returnA.resolve(); releaseOld.resolve(); releaseConfirm.resolve(); await waking?.catch(() => {}); await old?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.restoreReply(async reply => { allocated.resolve(); await releaseOld.promise; return { ...reply, hostId: null, profileId: null }; });
  f.confirm(async () => { confirming.resolve(); await releaseConfirm.promise; throw new Error('Committed native confirmation reply lost'); });
  f.bind(async command => { if (bound !== null && bound !== command.profileId) cancelledThrough = f.latestSequence(); bound = command.profileId; }); f.cancellations(sequence => sequence <= cancelledThrough);
  f.transport(async (request, run, signal) => {
    if (request.op === 'state') {
      if (current === f.store && ++aStates > 1) { if (aStates === 2) { polling.resolve(); await disconnect.promise; current = other; throw new Error('Bind B'); } return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); }); }
      if (current === other && ++bStates > 1) { await returnA.promise; current = f.store; throw new Error('Return A'); }
    }
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Exact receipt binding did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.document = { visibilityState: 'visible' }; old = f.ui.restore(); const result = Promise.allSettled([old]); await allocated.promise;
  f.ui.start(); await polling.promise;
  waking = f.wake(1, null); await confirming.promise;
  const actualRestore = f.ui.restoreNative.bind(f.ui);
  f.ui.restoreNative = (...args) => { const promise = actualRestore(...args); joined.resolve(); return promise; };
  releaseOld.resolve(); await joined.promise;
  disconnect.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && bStates > 1); returnA.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === f.store.context().profileId);
  releaseConfirm.resolve(); await waking; assert.equal((await result)[0].status, 'fulfilled'); assert.equal(other.context().selection.selected.kind, 'experience'); assert.equal(f.requests.filter(request => request.op === 'restore').length, 1);
});

for (const returned of [true, false]) test(`a live exact join retains its receipt after outbox retirement and confirmation failure (return A ${returned})`, { timeout: 6000 }, async t => {
  const f = await fixture(t); await f.apply(); const generation = f.store.context().recoveryGeneration;
  const directory = await mkdtemp(join(tmpdir(), 'live-retired-receipt-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), returnA = gate(), confirming = gate(), releaseConfirm = gate(); let current = f.store, aStates = 0, bStates = 0, old, sibling;
  f.after(async () => { sibling?.close(); disconnect.resolve(); returnA.resolve(); releaseConfirm.resolve(); await old?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.confirm(async () => { confirming.resolve(); await releaseConfirm.promise; throw new Error('Committed confirmation reply lost'); });
  f.transport(async (request, run, signal) => {
    const hang = () => new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    if (request.op === 'state') {
      if (request.context.brokerInstance !== 'broker') return hang();
      if (current === f.store && ++aStates > 1) { if (aStates === 2) { polling.resolve(); await disconnect.promise; current = other; throw new Error('Bind B'); } return hang(); }
      if (current === other && ++bStates > 1) { await returnA.promise; current = f.store; throw new Error('Return A'); }
    }
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const until = async check => { const deadline = Date.now() + 3000; while (!check()) { if (Date.now() > deadline) throw new Error('Live receipt test did not reach its gate'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await polling.promise; old = f.ui.restore(); const result = Promise.allSettled([old]); await confirming.promise;
  sibling = new UiConnection(); sibling.start(); await until(() => f.cached() === null && f.requests.filter(request => request.op === 'restore').length >= 2);
  disconnect.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && bStates > 1);
  if (returned) { returnA.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === f.store.context().profileId); }
  releaseConfirm.resolve(); assert.equal((await result)[0].status, returned ? 'fulfilled' : 'rejected');
  const posts = f.requests.filter(request => request.op === 'restore'); assert.equal(new Set(posts.map(request => request.requestId)).size, 1); assert.equal(f.store.context().recoveryGeneration, generation + 1); assert.equal(other.context().selection.selected.kind, 'experience');
});

test('an initiating Restore uses its own receipt when its allocation reply is lost', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'exact-completed-join-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), returnA = gate(), allocated = gate(), releaseOld = gate(); let current = f.store, aStates = 0, bStates = 0, bound = null, cancelledThrough = 0, old;
  f.after(async () => { disconnect.resolve(); returnA.resolve(); releaseOld.resolve(); await old?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.restoreReply(async reply => { if (reply.sequence === 1) { allocated.resolve(); await releaseOld.promise; throw new Error('Native allocation reply lost'); } return reply; });
  f.bind(async command => { if (bound !== null && bound !== command.profileId) cancelledThrough = f.latestSequence(); bound = command.profileId; }); f.cancellations(sequence => sequence <= cancelledThrough);
  f.transport(async (request, run, signal) => {
    if (request.op === 'state') {
      if (current === f.store && ++aStates > 1) { if (aStates === 2) { polling.resolve(); await disconnect.promise; current = other; throw new Error('Bind B'); } return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); }); }
      if (current === other && ++bStates > 1) { await returnA.promise; current = f.store; throw new Error('Return A'); }
    }
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const until = async check => { const deadline = Date.now() + 2500; while (!check()) { if (Date.now() > deadline) throw new Error('Exact receipt binding did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } };
  globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await polling.promise; old = f.ui.restore(); const result = Promise.allSettled([old]); await allocated.promise;
  await f.runtimeWake(); assert.equal(f.pending(), false);
  disconnect.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === other.context().profileId && bStates > 1); returnA.resolve(); await until(() => JSON.parse(f.ui.getSnapshot().deliveryContext ?? 'null')?.profileId === f.store.context().profileId);
  await f.ui.restore();
  releaseOld.resolve(); assert.equal((await result)[0].status, 'fulfilled'); const posts = f.requests.filter(request => request.op === 'restore'); assert.equal(posts.length, 2); assert.notEqual(posts[0].requestId, posts[1].requestId);
});

test('public Restore waits for a bind that starts after its inner receipt check', { timeout: 6000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'public-restore-binding-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), allocated = gate(), releaseOld = gate(), parsed = gate(), binding = gate(), releaseBind = gate(); let current = f.store, aStates = 0, releaseParsed = () => {}, old, settled = false, armed = false;
  f.after(async () => { disconnect.resolve(); releaseOld.resolve(); releaseParsed(); releaseBind.resolve(); await old?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.restoreReply(async () => { allocated.resolve(); await releaseOld.promise; throw new Error('Native allocation reply lost'); });
  f.bind(async command => { if (command.profileId === other.context().profileId) { binding.resolve(); await releaseBind.promise; } });
  f.transport(async (request, run, signal) => {
    if (request.op === 'state' && current === f.store && ++aStates > 1) { polling.resolve(); await disconnect.promise; current = other; throw new Error('Observe B'); }
    if (request.op === 'state' && current === other) return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    return current === f.store ? run() : Response.json({ ok: true, value: await current.execute(parseUiRequest(request)) });
  });
  const actualPost = f.ui.post.bind(f.ui); f.ui.post = request => { const task = actualPost(request); if (request.op !== 'context' || current !== other) return task; return new Promise((resolve, reject) => { task.then(value => { releaseParsed = () => resolve(value); parsed.resolve(); }, reject); }); };
  const actualCurrent = f.ui.recoveryIsCurrent.bind(f.ui); f.ui.recoveryIsCurrent = host => { const valid = actualCurrent(host); if (armed) { armed = false; releaseParsed(); } return valid; };
  globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await polling.promise; old = f.ui.restore(); const result = Promise.allSettled([old]).then(value => { settled = true; return value; }); await allocated.promise; await f.runtimeWake();
  disconnect.resolve(); await parsed.promise; armed = true; releaseOld.resolve(); await binding.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'public Restore must wait for the in-flight native acknowledgement'); releaseBind.resolve(); assert.equal((await result)[0].status, 'rejected'); assert.equal(other.context().selection.selected.kind, 'experience'); assert.equal(f.requests.filter(request => request.op === 'restore').length, 1);
});

test('public Restore processes its native profile after the binding acknowledgement arrives', { timeout: 6000 }, async t => {
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'public-bound-restore-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const polling = gate(), disconnect = gate(), binding = gate(), releaseBind = gate(), allocated = gate(); let current = f.store, broker = null, states = 0, action, settled = false;
  f.after(async () => { disconnect.resolve(); releaseBind.resolve(); await action?.catch(() => {}); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.bind(async command => { broker = { hostId: command.hostId, profileId: command.profileId }; if (command.profileId === other.context().profileId) { binding.resolve(); await releaseBind.promise; } });
  f.restoreReply(async reply => { allocated.resolve(); return { ...reply, ...broker }; });
  f.transport(async (request, run, signal) => {
    if (request.op === 'state' && current === f.store && ++states > 1) { polling.resolve(); await disconnect.promise; current = other; throw new Error('Observe B'); }
    if (request.op === 'state' && current === other) return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    return current === f.store ? run() : Response.json({ ok: true, value: await other.execute(parseUiRequest(request)) });
  });
  globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await polling.promise; disconnect.resolve(); await binding.promise;
  assert.equal(broker.profileId, other.context().profileId); assert.equal(JSON.parse(f.ui.getSnapshot().deliveryContext).profileId, f.store.context().profileId);
  action = f.ui.restore(); const result = Promise.allSettled([action]).then(value => { settled = true; return value; }); await allocated.promise; await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  releaseBind.resolve(); assert.equal((await result)[0].status, 'fulfilled'); assert.equal(other.context().selection.selected.kind, 'builtin'); assert.equal(f.store.context().selection.selected.kind, 'experience'); assert.equal(f.requests.filter(request => request.op === 'restore').length, 1);
});

test('an unbound public Restore retains the authority inherited from its newer join', { timeout: 6000 }, async t => {
  const { AsyncLocalStorage } = await import('node:async_hooks'), joins = new AsyncLocalStorage();
  const f = await fixture(t); await f.apply(); const directory = await mkdtemp(join(tmpdir(), 'unbound-joined-restore-')), other = new UiStore(join(directory, 'ui.sqlite'), 'host'); await f.apply(other);
  const contextRead = gate(), releaseContext = gate(), allocated = gate(), releaseOld = gate(), posting = gate(), releasePost = gate(), polling = gate(), disconnect = gate(), parsed = gate(), joined = gate(), binding = gate(), releaseBind = gate(); let contexts = 0, current = f.store, states = 0, armed = false, releaseParsed = () => {}, old, newer, settled = false;
  f.after(async () => { releaseContext.resolve(); releaseOld.resolve(); releasePost.resolve(); disconnect.resolve(); releaseParsed(); releaseBind.resolve(); await Promise.allSettled([old, newer]); other.close(); await rm(directory, { recursive: true, force: true }); });
  f.restoreReply(async reply => { if (reply.sequence === 1) { allocated.resolve(); await releaseOld.promise; } return { ...reply, hostId: null, profileId: null }; });
  f.bind(async command => { if (command.profileId === other.context().profileId) { binding.resolve(); await releaseBind.promise; } });
  f.cancellations(sequence => { if (sequence === 1) armed = true; return false; });
  f.transport(async (request, run, signal) => {
    if (request.op === 'context' && ++contexts === 1) { const response = await run(); contextRead.resolve(); await releaseContext.promise; return response; }
    if (request.op === 'restore') { posting.resolve(); await releasePost.promise; return run(); }
    if (request.op === 'state' && current === f.store && ++states > 1) { polling.resolve(); await disconnect.promise; current = other; throw new Error('Observe B'); }
    if (request.op === 'state' && current === other) return new Promise((_, reject) => { if (signal.aborted) reject(new Error('Closed')); else signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
    return current === f.store ? run() : Response.json({ ok: true, value: await other.execute(parseUiRequest(request)) });
  });
  const actualPost = f.ui.post.bind(f.ui); f.ui.post = request => { const task = actualPost(request); if (request.op !== 'context' || current !== other) return task; return new Promise((resolve, reject) => { task.then(value => { releaseParsed = () => resolve(value); parsed.resolve(); }, reject); }); };
  const actualJoin = f.ui.joinedRecoveryResult.bind(f.ui); f.ui.joinedRecoveryResult = (...args) => { const result = joins.run(args[0], () => actualJoin(...args)); if (args[0] === 1) joined.resolve(); return result; };
  const actualCurrent = f.ui.recoveryIsCurrent.bind(f.ui); f.ui.recoveryIsCurrent = host => { const valid = actualCurrent(host); if (armed && joins.getStore() === 1) { armed = false; releaseParsed(); } return valid; };
  old = f.ui.restore(); const result = Promise.allSettled([old]).then(value => { settled = true; return value; }); await allocated.promise; newer = f.ui.restore(); const newerResult = Promise.allSettled([newer]); await contextRead.promise;
  globalThis.document = { visibilityState: 'visible' }; f.ui.start(); await polling.promise; releaseContext.resolve(); await posting.promise; disconnect.resolve(); await parsed.promise; releaseOld.resolve(); await joined.promise; releasePost.resolve(); await binding.promise; await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  releaseBind.resolve(); assert.equal((await result)[0].status, 'rejected'); await newerResult; assert.equal(other.context().selection.selected.kind, 'experience'); assert.equal(f.requests.filter(request => request.op === 'restore').length, 1);
});
