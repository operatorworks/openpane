import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UiStore } from '../../apps/host/build/tsc/ui-store.js';
import { parseUiRequest } from '../../apps/host/build/tsc/ui-protocol.js';
import { UiConnection } from '../../apps/desktop/dist/application/ui-connection.js';
import { ChildUiConnection } from '../../apps/desktop/dist/application/native-ui-relay.js';

const state = { version: 1, change: 1, selection: { revision: 0, deliveryGeneration: 0, selected: { kind: 'builtin' }, previousHealthy: { kind: 'builtin' } }, bundle: null, envelope: null, transitions: [], fault: null, display: null };
const scope = { hostId: 'host', conversationId: 'chat' };
const context = { role: 'chat', hostId: 'host', profileId: 'profile', brokerInstance: 'broker', label: 'chat', documentIncarnation: 'child', viewId: 'view', scope };
for (const seat of ['main', 'child']) test(`${seat} invalidates a rejected appearance and fences its delayed paint confirmation`, { timeout: 5000 }, async t => {
  const previous = globalThis.document; globalThis.document = new EventTarget();
  let release, entered, reports = 0;
  const held = new Promise(resolve => { release = resolve; }), reporting = new Promise(resolve => { entered = resolve; });
  const report = async () => { if (reports++ === 0) { entered(); await held; } return {}; };
  const ui = seat === 'main' ? new UiConnection() : new ChildUiConnection({ context, request: report });
  if (seat === 'main') { ui.window = { ...context, role: 'main', label: 'main' }; ui.post = report; }
  ui.snapshot = { ...ui.getSnapshot(), state, localBuiltin: false, deliveryContext: 'document' };
  t.after(() => { release(); ui.close(); globalThis.document = previous; });
  const first = ui.rendered(state); await reporting;
  await ui.failed(state, 'Essential text became unreadable');
  assert.deepEqual(ui.getSnapshot().validatedVisual, { kind: 'none' });
  assert.equal(ui.getSnapshot().confirmedGeneration, null);
  release(); await first;
  assert.equal(ui.getSnapshot().confirmedGeneration, null);
  await ui.rendered(state);
  assert.equal(ui.getSnapshot().validatedVisual.kind, 'delivery');
  assert.equal(ui.getSnapshot().confirmedGeneration, 0);
  assert.equal(reports, seat === 'child' ? 3 : 2);
});

test('main confirms a lost paint reply when polling returns a fresh object for the same delivery', { timeout: 5000 }, async t => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, storage: globalThis.localStorage };
  const directory = await mkdtemp(join(tmpdir(), 'lost-ui-paint-')), store = new UiStore(join(directory, 'ui.sqlite'), 'host'), saved = new Map();
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  let reports = 0, reads = 0, nextRead, secondRead, release;
  const pollingAgain = new Promise(resolve => { nextRead = resolve; }), pollingSecond = new Promise(resolve => { secondRead = resolve; }), held = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.op === 'state') {
      if (++reads === 2) { secondRead(); await held; }
      if (reads > 2) {
        nextRead(); return new Promise((_, reject) => { if (options.signal.aborted) reject(new Error('Closed')); else options.signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }); });
      }
    }
    let value;
    try { value = await store.execute(parseUiRequest(request.op === 'state' ? { ...request, waitMs: 0 } : request)); }
    catch (error) { return Response.json({ ok: false, code: error.code ?? 'unavailable', error: error.message }, { status: 409 }); }
    if (request.op === 'paint' && reports++ === 0) throw new Error('First paint reply lost');
    return Response.json({ ok: true, value });
  };
  const ui = new UiConnection();
  t.after(async () => { release(); ui.close(); globalThis.document = previous.document; globalThis.fetch = previous.fetch; globalThis.localStorage = previous.storage; store.close(); await rm(directory, { recursive: true, force: true }); });
  ui.start(); await pollingSecond;
  const painted = ui.getSnapshot().state; assert.ok(painted);
  await assert.rejects(ui.rendered(painted), /First paint reply lost/);
  assert.equal(ui.getSnapshot().confirmedGeneration, null);
  release(); await pollingAgain;
  assert.notEqual(ui.getSnapshot().state, painted); assert.equal(reports, 2); assert.equal(ui.getSnapshot().confirmedGeneration, 0);
});


for (const delayedFailure of [false, true]) test(`main sends no rendered ACK after rejection while paint is pending (failure delayed ${delayedFailure})`, { timeout: 5000 }, async t => {
  const previous = globalThis.document; globalThis.document = new EventTarget();
  const ui = new UiConnection(), acknowledgements = [];
  let releasePaint, paintEntered, releaseFailure, failureEntered;
  const paintHold = new Promise(resolve => { releasePaint = resolve; }), painted = new Promise(resolve => { paintEntered = resolve; });
  const failureHold = new Promise(resolve => { releaseFailure = resolve; }), failed = new Promise(resolve => { failureEntered = resolve; });
  const current = { ...state, envelope: { requestId: '1:11111111-1111-4111-8111-111111111111', deliveryGeneration: 0, selectionRevision: 0, digest: null } };
  ui.window = { ...context, role: 'main', label: 'main' };
  ui.snapshot = { ...ui.getSnapshot(), state: current, localBuiltin: false, deliveryContext: 'document' };
  ui.post = async request => {
    if (request.op === 'paint') { paintEntered(); await paintHold; }
    else {
      assert.equal(request.op, 'ack'); acknowledgements.push(request.result.kind);
      if (request.result.kind === 'failed') { failureEntered(); if (delayedFailure) await failureHold; }
    }
    return {};
  };
  t.after(() => { releasePaint(); releaseFailure(); ui.close(); globalThis.document = previous; });
  const reporting = ui.rendered(current); await painted;
  const rejecting = ui.failed(current, 'Essential text became unreadable'); await failed;
  releasePaint(); await reporting;
  assert.deepEqual(acknowledgements, ['failed']);
  releaseFailure(); await rejecting;
  assert.equal(ui.getSnapshot().confirmedGeneration, null);
});

test('local builtin recovery fences an earlier custom paint before its acknowledgement', { timeout: 5000 }, async t => {
  const previous = globalThis.document; globalThis.document = new EventTarget();
  const ui = new UiConnection();
  let releasePaint, releaseRecovery, entered;
  const paint = new Promise(resolve => { releasePaint = resolve; });
  const recovery = new Promise(resolve => { releaseRecovery = resolve; });
  const reporting = new Promise(resolve => { entered = resolve; });
  const acknowledgements = [];
  const current = { ...state, selection: { ...state.selection, selected: { kind: 'experience', digest: 'a'.repeat(64) } }, bundle: { digest: 'a'.repeat(64) }, envelope: { requestId: 'held-custom-paint' } };
  ui.window = { ...context, role: 'main', label: 'main' }; ui.recovery = null;
  ui.snapshot = { ...ui.getSnapshot(), state: current, localBuiltin: false, deliveryContext: 'document' };
  ui.post = async request => {
    if (request.op === 'paint') { entered(); await paint; return {}; }
    if (request.op === 'context') { await recovery; throw new Error('Recovery request held offline'); }
    if (request.op === 'ack') { acknowledgements.push(request.result.kind); return {}; }
    throw new Error('Unexpected request ' + request.op);
  };
  t.after(() => { releasePaint(); releaseRecovery(); ui.close(); globalThis.document = previous; });
  const pending = ui.rendered(current); await reporting;
  const restoring = ui.restore();
  await ui.rendered(current, true);
  releasePaint(); await pending;
  assert.deepEqual(acknowledgements, []);
  assert.equal(ui.getSnapshot().confirmedGeneration, null);
  assert.equal(ui.getSnapshot().validatedVisual.kind, 'local-builtin');
  releaseRecovery(); await restoring;
});

test('retrying offline restore retains the already validated local builtin appearance', async t => {
  const previous = globalThis.document; globalThis.document = new EventTarget();
  const ui = new UiConnection(); ui.recovery = null;
  ui.window = { ...context, role: 'main', label: 'main' };
  ui.snapshot = { ...ui.getSnapshot(), state, localBuiltin: true, validatedVisual: { kind: 'local-builtin' }, deliveryContext: 'document' };
  ui.post = async () => { throw new Error('Host unavailable'); };
  t.after(() => { ui.close(); globalThis.document = previous; });
  await ui.restore();
  assert.equal(ui.getSnapshot().localBuiltin, true);
  assert.deepEqual(ui.getSnapshot().validatedVisual, { kind: 'local-builtin' });
  assert.equal(ui.getSnapshot().confirmedGeneration, null);
});

const untilChild = async predicate => { for (let n = 0; n < 200 && !predicate(); n++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate(), 'child boundary checkpoint'); };
function childReportingFixture(t, { snapshot = state, builtin = false, report = async () => ({}), restore = async () => ({}), presence = async () => ({}) } = {}) {
  const previous = globalThis.document; globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  let currentContext = context, currentState = snapshot, localBuiltin = builtin, recoveryFloor = null;
  const reports = [];
  const ui = new ChildUiConnection({ context: { ...context, reservation: { scope } }, async request(command) {
    if (command.kind === 'presence') return presence();
    if (command.kind === 'read-ui') return { context: currentContext, state: currentState, localBuiltin, recoveryFloor };
    if (command.kind === 'report-ui') { reports.push({ context: currentContext, report: command.report }); return report(command.report); }
    if (command.kind === 'restore-builtin') { const result = await restore(); localBuiltin = true; return result; }
    throw new Error(command.kind);
  } });
  t.after(() => { ui.close(); globalThis.document = previous; });
  return { ui, reports, cache(nextState, builtin, floor = null) { currentState = nextState; localBuiltin = builtin; recoveryFloor = floor; }, async read(nextContext = currentContext) { currentContext = nextContext; ui.refresh(); await untilChild(() => JSON.parse(ui.getSnapshot().deliveryContext ?? 'null')?.profileId === nextContext.profileId && ui.getSnapshot().state !== null); await new Promise(resolve => setImmediate(resolve)); } };
}
test('child local builtin paint retains its mode across cache refresh', { timeout: 5000 }, async t => {
  const f = childReportingFixture(t, { builtin: true }); await f.read(); await f.ui.rendered(f.ui.getSnapshot().state, true);
  assert.equal(f.ui.getSnapshot().validatedVisual.kind, 'local-builtin');
  await f.read(); assert.equal(f.ui.getSnapshot().validatedVisual.kind, 'local-builtin');
});
test('child restore fences an in-flight themed confirmation', { timeout: 5000 }, async t => {
  let release, entered; const held = new Promise(resolve => { release = resolve; }), reporting = new Promise(resolve => { entered = resolve; }); t.after(() => release());
  const manifest = { schemaVersion: 2, id: 'report-test', label: 'Report test', theme: { density: 'comfortable', mode: 'system', light: {}, dark: {} }, presentation: { home: { kind: 'stack', panes: ['conversations'] }, transcript: 'bubbles', navigation: 'rail', chats: 'inline', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, stylesheet: null, assets: [] };
  const themed = { ...state, selection: { ...state.selection, revision: 1, deliveryGeneration: 1, selected: { kind: 'experience', digest: 'a'.repeat(64) } }, bundle: { manifest, digest: 'a'.repeat(64) } };
  const f = childReportingFixture(t, { snapshot: themed, report: async () => { entered(); await held; return {}; } });
  await f.read(); const painting = f.ui.rendered(f.ui.getSnapshot().state); await reporting;
  await f.ui.restore(); await f.ui.rendered(f.ui.getSnapshot().state, true);
  release(); await painting;
  assert.equal(f.ui.getSnapshot().validatedVisual.kind, 'local-builtin'); assert.equal(f.ui.getSnapshot().confirmedGeneration, null);
});
test('child restore failure preserves builtin and offers retry without rejecting', { timeout: 5000 }, async t => {
  const f = childReportingFixture(t, { restore: async () => { throw new Error('Native broker unavailable'); } }); await f.read();
  await f.ui.restore(); assert.equal(f.ui.getSnapshot().localBuiltin, true); assert.match(f.ui.getSnapshot().diagnostic, /retry|could not be saved/i);
});

const themedChildState = () => ({ ...state, selection: { ...state.selection, revision: 1, deliveryGeneration: 1, selected: { kind: 'experience', digest: 'a'.repeat(64) } }, bundle: { digest: 'a'.repeat(64), manifest: { schemaVersion: 2, id: 'restore-test', label: 'Restore test', theme: { density: 'comfortable', mode: 'system', light: {}, dark: {} }, presentation: { home: { kind: 'stack', panes: ['conversations'] }, transcript: 'bubbles', navigation: 'rail', chats: 'inline', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, stylesheet: null, assets: [] } } });
test('child cache refresh cannot undo a failed local Restore or invalidate its retry paint', async t => {
  const f = childReportingFixture(t, { snapshot: themedChildState(), restore: async () => { throw new Error('Broker unavailable'); } }); await f.read();
  await f.ui.restore(); await f.ui.rendered(f.ui.getSnapshot().state, true); await f.read();
  assert.equal(f.ui.getSnapshot().localBuiltin, true); assert.match(f.ui.getSnapshot().diagnostic, /retry Restore/);
  assert.equal(f.ui.getSnapshot().validatedVisual.kind, 'local-builtin');
  await f.ui.restore(); assert.equal(f.ui.getSnapshot().validatedVisual.kind, 'local-builtin'); assert.equal(f.ui.getSnapshot().confirmedGeneration, null);
});

test('child publishes a new delivery without an old validation even when presence fails', async t => {
  const previous = globalThis.document; globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  let current = state, failPresence = false, reads = 0;
  const ui = new ChildUiConnection({ context: { ...context, reservation: { scope } }, async request(command) {
    if (command.kind === 'read-ui') { reads++; return { state: current, localBuiltin: false, recoveryFloor: null, context }; }
    if (command.kind === 'presence') { if (failPresence) throw new Error('Presence unavailable'); return {}; }
    if (command.kind === 'report-ui') return {};
    throw new Error(command.kind);
  } }); t.after(() => { ui.close(); globalThis.document = previous; });
  ui.refresh(); await untilChild(() => ui.getSnapshot().state); await ui.rendered(ui.getSnapshot().state);
  const snapshots = []; ui.subscribe(() => snapshots.push(ui.getSnapshot()));
  current = { ...state, change: 2, selection: { ...state.selection, revision: 2, deliveryGeneration: 2 } }; failPresence = true; ui.selectScope(scope); ui.refresh();
  await untilChild(() => reads === 2 && /Presence/.test(ui.getSnapshot().diagnostic ?? ''));
  const advanced = snapshots.filter(value => value.state?.selection.deliveryGeneration === 2); assert.ok(advanced.length > 0);
  for (const snapshot of advanced) {
    assert.equal(snapshot.validatedVisual.kind, 'none'); assert.equal(snapshot.confirmedGeneration, null);
  }
});

test('successful child Restore hands fallback to the broker and accepts a newer custom cache', async t => {
  const f = childReportingFixture(t, { snapshot: themedChildState() }); await f.read(); await f.ui.restore(); await f.read();
  assert.equal(f.ui.getSnapshot().localBuiltin, true);
  const newer = themedChildState(); newer.selection = { ...newer.selection, revision: 3, deliveryGeneration: 3 };
  f.cache(newer, false); await f.read(); assert.equal(f.ui.getSnapshot().localBuiltin, false);
  await f.ui.rendered(f.ui.getSnapshot().state); assert.equal(f.ui.getSnapshot().confirmedGeneration, 3);
});

test('a failed child Restore keeps its retry instruction after a presence error', async t => {
  const f = childReportingFixture(t, { snapshot: themedChildState(), restore: async () => { throw new Error('Restore unavailable'); }, presence: async () => { throw new Error('Presence unavailable'); } });
  await f.read(); await f.ui.restore(); f.ui.selectScope(scope); await f.read();
  assert.equal(f.ui.getSnapshot().localBuiltin, true); assert.match(f.ui.getSnapshot().diagnostic, /retry Restore/);
});

test('child Restore before its first cache read still reports a failed save', async t => {
  let f;
  f = childReportingFixture(t, { snapshot: themedChildState(), restore: async () => { await f.read(); throw new Error('Recorded save failure'); } });
  await f.ui.restore(); assert.equal(f.ui.getSnapshot().localBuiltin, true); assert.match(f.ui.getSnapshot().diagnostic, /retry Restore/);
});

test('cached builtin cannot retire a child Restore whose request later fails', async t => {
  let reject, entered;
  const held = new Promise((_, no) => { reject = no; }), requested = new Promise(yes => { entered = yes; });
  const f = childReportingFixture(t, { restore: async () => { entered(); return held; } });
  await f.read(); const restoring = f.ui.restore(); await requested; await f.read();
  reject(new Error('Recorded save failure')); await restoring;
  f.cache(themedChildState(), false); await f.read();
  assert.equal(f.ui.getSnapshot().localBuiltin, true); assert.match(f.ui.getSnapshot().diagnostic, /retry Restore/);
});


test('an earlier broker Restore cannot retire a later failed child request', async t => {
  const f = childReportingFixture(t, { snapshot: themedChildState(), builtin: true, restore: async () => { throw new Error('Later IPC failed'); } });
  await f.read(); await f.ui.restore(); await f.read();
  const builtin = { ...state, selection: { ...state.selection, revision: 2, deliveryGeneration: 2 } };
  f.cache(builtin, false, 2); await f.read();
  assert.equal(f.ui.getSnapshot().localBuiltin, true); assert.match(f.ui.getSnapshot().diagnostic, /retry Restore/);
  const themed = themedChildState(); themed.selection = { ...themed.selection, revision: 3, deliveryGeneration: 3 };
  f.cache(themed, false, 2); await f.read();
  assert.equal(f.ui.getSnapshot().localBuiltin, true); assert.match(f.ui.getSnapshot().diagnostic, /retry Restore/);
});

test('a newer externally saved builtin retires a failed child Restore', async t => {
  const f = childReportingFixture(t, { snapshot: themedChildState(), restore: async () => { throw new Error('IPC failed'); } });
  await f.read(); await f.ui.restore();
  f.cache({ ...state, selection: { ...state.selection, revision: 2, deliveryGeneration: 2 } }, false); await f.read();
  assert.equal(f.ui.getSnapshot().localBuiltin, false); assert.doesNotMatch(f.ui.getSnapshot().diagnostic ?? '', /retry Restore/);
  const themed = themedChildState(); themed.selection = { ...themed.selection, revision: 3, deliveryGeneration: 3 };
  f.cache(themed, false); await f.read(); assert.equal(f.ui.getSnapshot().localBuiltin, false);
});
