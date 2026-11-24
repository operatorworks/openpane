import assert from 'node:assert/strict';
import test from 'node:test';
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
  const previous = globalThis.document; globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const ui = new UiConnection();
  let reports = 0, reads = 0, nextRead;
  const pollingAgain = new Promise(resolve => { nextRead = resolve; });
  ui.window = { ...context, role: 'main', label: 'main' };
  ui.context = { hostId: 'host', profileId: 'profile' };
  ui.recovery = null;
  ui.snapshot = { ...ui.getSnapshot(), state, localBuiltin: false, deliveryContext: 'document' };
  ui.post = async request => {
    if (request.op === 'paint') {
      if (reports++ === 0) throw new Error('First paint reply lost');
      return {};
    }
    assert.equal(request.op, 'state');
    if (reads++ === 0) return structuredClone(state);
    nextRead();
    return new Promise((_, reject) => ui.abort.signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }));
  };
  t.after(() => { ui.close(); globalThis.document = previous; });
  await assert.rejects(ui.rendered(state), /First paint reply lost/);
  assert.equal(ui.getSnapshot().confirmedGeneration, null);
  const reading = ui.readLoop();
  await pollingAgain;
  assert.notEqual(ui.getSnapshot().state, state);
  assert.equal(reports, 2);
  assert.equal(ui.getSnapshot().confirmedGeneration, 0);
  ui.close(); await reading;
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
