import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, symlink, link, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { UiStore } from '../../apps/host/build/tsc/ui-store.js';
import { createExperienceBundle } from '../../apps/host/build/tsc/experience-bundle.js';
const bundle = id => createExperienceBundle({ schemaVersion: 2, id, label: id, theme: { density: 'comfortable', mode: 'system', light: {}, dark: {} },
  presentation: { home: { kind: 'stack', panes: ['conversations', 'conversation'] }, transcript: 'bubbles', navigation: 'rail', chats: 'inline', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, stylesheet: null, assets: [] }, null, []);
async function fixture(t, { checkScope } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ui-store-'));
  const path = join(directory, 'ui.sqlite'); let store = new UiStore(path, 'host', undefined, checkScope);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const id = () => `${store.context().requestEpoch}:${randomUUID()}`;
  const window = (name = 'main') => { const context = store.context(); return { hostId: 'host', profileId: context.profileId, role: 'main', brokerInstance: 'browser', label: name, documentIncarnation: randomUUID(), viewId: name }; };
  return { path, get store() { return store; }, id, window, restart() { store.close(); store = new UiStore(path, 'host', undefined, checkScope); },
    state(context, visible = true, presenceSequence = 1) { return store.execute({ op: 'state', context, visible, presenceSequence, after: null, waitMs: 0 }); } };
}
const envelope = receipt => Object.fromEntries(['requestId', 'deliveryGeneration', 'selectionRevision', 'digest'].map(key => [key, receipt[key]]));
const paint = (store, window, receipt) => store.execute({ op: 'paint', session: window.documentIncarnation, deliveryGeneration: receipt.deliveryGeneration, selectionRevision: receipt.selectionRevision, digest: receipt.digest });
test('reapplying verified bytes repairs a damaged bundle with the same digest', async t => {
  const f = await fixture(t), valid = bundle('repairable');
  await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: valid });
  f.store.db.prepare('UPDATE ui_bundles SET value=? WHERE digest=?').run('{broken', valid.digest);
  f.restart();
  assert.equal(f.store.context().selection.selected.kind, 'builtin');
  await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: f.store.context().revision, bundle: valid });
  assert.deepEqual(f.store.bundle(valid.digest), valid);
  f.restart(); assert.equal(f.store.context().selection.selected.digest, valid.digest);
});
test('a resumed native main renews its live children before expiring the receipt cohort', async t => {
  const f = await fixture(t), main = f.window(), child = { ...main, role: 'chat', label: 'child', documentIncarnation: 'child', viewId: 'child', scope: { hostId: 'host', conversationId: 'chat' } };
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const state = sequence => ({ op: 'state', context: main, visible: true, presenceSequence: sequence, after: null, waitMs: 0, nativePlacement: true, liveChildren: ['child'] });
  const relay = sequence => ({ op: 'relay', main, children: [{ context: child, visible: true, presenceSequence: sequence }], departed: [] });
  await f.store.execute(state(1)); await f.store.execute(relay(1));
  const receipt = (await f.store.execute({ op: 'refresh', requestId: f.id(), expectedRevision: 0 })).receipt;
  now += 16000;
  await f.store.execute(state(2));
  const resumed = await f.store.execute(relay(2));
  assert.deepEqual(resumed.children[0].envelope, envelope(receipt));
  for (const window of [main, child]) {
    await paint(f.store, window, receipt);
    await f.store.execute({ op: 'ack', session: window.documentIncarnation, envelope: envelope(receipt), result: { kind: 'rendered' } });
  }
  assert.equal((await f.store.execute({ op: 'status', requestId: receipt.requestId })).outcome, 'all-rendered');
});
test('an existing child paint also settles a later placement resolution in the same receipt', async t => {
  const f = await fixture(t), main = f.window(), scope = { hostId: 'host', conversationId: 'existing' };
  const child = { ...main, role: 'chat', label: 'child', documentIncarnation: 'child', viewId: 'child', scope };
  await f.store.execute({ op: 'state', context: main, visible: true, presenceSequence: 1, after: null, waitMs: 0, nativePlacement: true });
  await f.store.execute({ op: 'relay', main, children: [{ context: child, visible: true, presenceSequence: 1 }], departed: [] });
  const base = bundle('existing-child'), separate = createExperienceBundle({ ...base.manifest, presentation: { ...base.manifest.presentation, chats: 'separate' } }, null, []);
  const receipt = (await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: separate })).receipt;
  for (const window of [main, child]) {
    await paint(f.store, window, receipt);
    await f.store.execute({ op: 'ack', session: window.documentIncarnation, envelope: envelope(receipt), result: { kind: 'rendered' } });
  }
  const transition = receipt.participants.find(participant => participant.slot.kind === 'transition').slot;
  const target = { scope, viewId: 'child', label: 'child', nativeTransitionId: 'native', bindingRevision: 2 };
  await f.store.execute({ op: 'placement-reserve', session: main.documentIncarnation, envelope: envelope(receipt), transitionId: transition.transitionId, target });
  await f.store.execute({ op: 'relay', main, children: [{ context: child, visible: true, presenceSequence: 2, placement: { nativeTransitionId: 'native', bindingRevision: 2 } }], departed: [] });
  assert.equal((await f.store.execute({ op: 'status', requestId: receipt.requestId })).outcome, 'all-rendered');
});
test('selection and idempotency commit together; stale or conflicting writes preserve the current selection', async t => {
  const f = await fixture(t);
  assert.equal(f.store.context().selection.selected.kind, 'builtin');
  const request = { op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: bundle('first') };
  const selected = await f.store.execute(request);
  assert.equal(selected.outcome, 'selected-with-no-clients');
  assert.deepEqual(await f.store.execute(request), selected);
  await assert.rejects(f.store.execute({ ...request, bundle: bundle('other') }), /different input/);
  await assert.rejects(f.store.execute({ ...request, requestId: f.id() }), /Current UI revision is 1/);
  f.restart();
  assert.deepEqual(await f.store.execute(request), selected);
  assert.equal(f.store.context().selection.selected.digest, request.bundle.digest);
});
test('paint and placement are independent; refresh captures fixed incarnations and never counts zero clients as rendered', async t => {
  const f = await fixture(t), one = f.window(), hidden = f.window('hidden');
  await f.state(one); await f.state(hidden, false);
  const { receipt } = await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: bundle('paint') });
  assert.equal(receipt.participants.length, 2);
  const ack = { op: 'ack', session: one.documentIncarnation, envelope: envelope(receipt), result: { kind: 'rendered' } };
  await paint(f.store, one, receipt);
  assert.equal((await f.store.execute(ack)).outcome, 'pending');
  assert.deepEqual(await f.store.execute(ack), await f.store.execute(ack));
  await assert.rejects(f.store.execute({ ...ack, session: hidden.documentIncarnation }), /visible/);
  const unrelated = f.window('late'); await f.state(unrelated);
  await assert.rejects(f.store.execute({ ...ack, session: unrelated.documentIncarnation }), /participant/);
  await f.state(hidden, true, 2); await paint(f.store, hidden, receipt);
  assert.equal((await f.store.execute({ ...ack, session: hidden.documentIncarnation })).outcome, 'all-rendered');
  const next = await f.store.execute({ op: 'refresh', requestId: f.id(), expectedRevision: 1 });
  assert.equal(next.receipt.selectionRevision, 1); assert.equal(next.receipt.deliveryGeneration, receipt.deliveryGeneration + 1);
  const replacement = { ...one, documentIncarnation: randomUUID() }; await f.state(replacement, true, 3);
  await assert.rejects(f.store.execute(ack), /Unknown|superseded/);
  const status = await f.store.execute({ op: 'status', requestId: next.receipt.requestId });
  assert.equal(status.receipt.participants[0].visual.kind, 'departed');
});
test('capacity refusal is atomic; reserved builtin recovery and compaction remain available at full normal capacity', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 16; index++) await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: index, bundle: bundle(`bundle-${index}`) });
  await assert.rejects(f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 16, bundle: bundle('overflow') }), /capacity/);
  assert.equal(f.store.context().revision, 16);
  for (let index = 16; index < 4096; index++) await f.store.execute({ op: 'refresh', requestId: f.id(), expectedRevision: 16 });
  await assert.rejects(f.store.execute({ op: 'refresh', requestId: f.id(), expectedRevision: 16 }), /capacity/);
  const recovery = { op: 'restore', requestId: `recovery:1:${randomUUID()}`, expectedRevision: 16, expectedRecoveryGeneration: 1 };
  const restored = await f.store.execute(recovery); assert.equal(restored.receipt.digest, null);
  assert.deepEqual(await f.store.execute(recovery), restored);
  const nextRecovery = { op: 'restore', requestId: `recovery:2:${randomUUID()}`, expectedRevision: 17, expectedRecoveryGeneration: 2 };
  await f.store.execute(nextRecovery); await assert.rejects(f.store.execute(recovery), /expired/);
  await f.store.execute({ op: 'compact', expectedEpoch: 1 });
  await assert.rejects(f.store.execute({ op: 'refresh', requestId: `1:${randomUUID()}`, expectedRevision: 18 }), /expired/);
  const { removed } = await f.store.execute({ op: 'prune', requestId: f.id(), keep: 2 }); assert.equal(removed.length, 14);
  await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 18, bundle: bundle('after-prune') });
});
test('cohort over 32 windows refuses before selection instead of truncating rendering claims', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 33; index++) await f.state(f.window(String(index)));
  await assert.rejects(f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: bundle('too-many') }), /33 compatible windows/);
  assert.equal(f.store.context().revision, 0);
});

test('metadata capacity reserves late failure bytes and never prevents builtin recovery', async t => {
  const f = await fixture(t);
  const windows = Array.from({ length: 32 }, (_, index) => ({ ...f.window(String(index)), viewId: 'view-' + 'x'.repeat(190) }));
  for (const window of windows) await f.state(window);
  let latest = await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: bundle('metadata') });
  let refused = false;
  for (let index = 0; index < 4096; index++) {
    try { latest = await f.store.execute({ op: 'refresh', requestId: f.id(), expectedRevision: 1 }); }
    catch (error) { assert.match(error.message, /capacity/); refused = true; break; }
  }
  assert.equal(refused, true);
  for (const window of windows) await f.store.execute({ op: 'ack', session: window.documentIncarnation, envelope: envelope(latest.receipt), result: { kind: 'failed', reason: '\u0000'.repeat(500) } });
  const db = new DatabaseSync(f.path, { readOnly: true });
  try { assert.ok(db.prepare('SELECT sum(length(CAST(result AS BLOB))) AS bytes FROM ui_receipts').get().bytes <= 32 * 1024 * 1024); }
  finally { db.close(); }
  assert.equal((await f.store.execute({ op: 'restore', requestId: `recovery:1:${randomUUID()}`, expectedRecoveryGeneration: 1, expectedRevision: 1 })).receipt.digest, null);
});

test('one main relay registers children, preserves fixed paint cohorts and filters receipt envelopes', async t => {
  const f = await fixture(t), main = f.window(); await f.state(main);
  const child = name => ({ ...main, role: 'chat', label: name, documentIncarnation: randomUUID(), viewId: name, scope: { hostId: 'host', conversationId: name } });
  const one = child('one'), hidden = child('hidden');
  const relay = (children, departed = []) => f.store.execute({ op: 'relay', main, children, departed });
  const present = (context, sequence, visible = true) => ({ context, presenceSequence: sequence, visible });
  await relay([present(one, 1), present(hidden, 1, false)]);
  const selected = await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: bundle('relay') });
  assert.equal(selected.receipt.participants.length, 3);
  const late = child('late'), delivered = await relay([present(one, 2), present(hidden, 2, false), present(late, 1)]);
  assert.deepEqual(delivered.children.map(child => child.envelope?.requestId ?? null), [selected.receipt.requestId, selected.receipt.requestId, null]);
  await assert.rejects(f.store.execute({ op: 'ack', session: hidden.documentIncarnation, envelope: envelope(selected.receipt), result: { kind: 'rendered' } }), /visible/);
  await relay([present(one, 3), present(late, 2)], [hidden.documentIncarnation]);
  const status = await f.store.execute({ op: 'status', requestId: selected.receipt.requestId });
  assert.equal(status.receipt.participants.find(participant => participant.slot.context.label === 'hidden').visual.kind, 'departed');
  await assert.rejects(relay([present(one, 3)]), /Stale/);
  await assert.rejects(f.store.execute({ op: 'relay', main: { ...main, documentIncarnation: randomUUID() }, children: [], departed: [] }), /Unregistered/);
});

test('a native transition stays pending after main paints and resolves once to the reserved child incarnation', async t => {
  const f = await fixture(t), main = f.window();
  await f.store.execute({ op: 'state', context: main, visible: true, presenceSequence: 1, after: null, waitMs: 0, nativePlacement: true });
  const base = bundle('separate'), separate = createExperienceBundle({ ...base.manifest, presentation: { ...base.manifest.presentation, chats: 'separate' } }, null, []);
  const { receipt } = await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: separate });
  assert.equal(receipt.participants.length, 2);
  const transition = receipt.participants.find(item => item.slot.kind === 'transition').slot;
  const env = envelope(receipt), paint = context => f.store.execute({ op: 'paint', session: context.documentIncarnation, ...Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'requestId')) });
  await paint(main);
  assert.equal((await f.store.execute({ op: 'ack', session: main.documentIncarnation, envelope: env, result: { kind: 'rendered' } })).outcome, 'pending');
  const target = { scope: { hostId: 'host', conversationId: 'assigned' }, viewId: 'dedicated', label: 'assigned-child', nativeTransitionId: 'native-transition', bindingRevision: 3 };
  const reserve = { op: 'placement-reserve', session: main.documentIncarnation, envelope: env, transitionId: transition.transitionId, target };
  await f.store.execute({ op: 'state', context: main, visible: false, presenceSequence: 2, after: null, waitMs: 0, nativePlacement: true });
  await f.store.execute(reserve); await f.store.execute(reserve);
  await f.store.execute({ op: 'state', context: main, visible: true, presenceSequence: 3, after: null, waitMs: 0, nativePlacement: true });
  await assert.rejects(f.store.execute({ ...reserve, target: { ...target, viewId: 'replacement' } }), /already fixed/);
  const child = { ...main, role: 'chat', scope: target.scope, viewId: target.viewId, label: target.label, documentIncarnation: randomUUID() };
  const ready = (context, sequence, revision = 3, visible = false) => f.store.execute({ op: 'relay', main, children: [{ context, visible, presenceSequence: sequence,
    placement: { nativeTransitionId: target.nativeTransitionId, bindingRevision: revision } }], departed: [] });
  const ignored = await ready(child, 1, 4); assert.equal(ignored.children[0].envelope, null);
  const delivered = await ready(child, 2);
  assert.equal(delivered.children[0].envelope.requestId, receipt.requestId);
  let status = await f.store.execute({ op: 'status', requestId: receipt.requestId });
  const resolved = status.receipt.participants.find(item => item.slot.kind === 'transition');
  assert.equal(resolved.placement.kind, 'ready'); assert.equal(resolved.slot.resolved.documentIncarnation, child.documentIncarnation); assert.equal(status.outcome, 'pending');
  await assert.rejects(paint(child), /visible/);
  await ready(child, 3, 3, true); await paint(child);
  assert.equal((await f.store.execute({ op: 'ack', session: child.documentIncarnation, envelope: env, result: { kind: 'rendered' } })).outcome, 'all-rendered');
  const reloaded = { ...child, documentIncarnation: randomUUID() };
  const late = await ready(reloaded, 4, 3, true); assert.equal(late.children[0].envelope, null);
  await assert.rejects(f.store.execute({ op: 'ack', session: reloaded.documentIncarnation, envelope: env, result: { kind: 'rendered' } }), /participant/);
});

test('an empty native catalog must paint before confirming unchanged placement; restart terminates unfinished transitions', async t => {
  const f = await fixture(t), main = f.window();
  const present = () => f.store.execute({ op: 'state', context: main, visible: true, presenceSequence: 1, after: null, waitMs: 0, nativePlacement: true });
  await present(); const base = bundle('catalog'), separate = createExperienceBundle({ ...base.manifest, presentation: { ...base.manifest.presentation, chats: 'separate' } }, null, []);
  const { receipt } = await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: separate }), env = envelope(receipt);
  const slot = receipt.participants.find(item => item.slot.kind === 'transition').slot;
  const idle = { op: 'placement-idle', session: main.documentIncarnation, envelope: env, transitionId: slot.transitionId };
  await assert.rejects(f.store.execute(idle), /source to paint/);
  await f.store.execute({ op: 'paint', session: main.documentIncarnation, deliveryGeneration: env.deliveryGeneration, selectionRevision: env.selectionRevision, digest: env.digest });
  assert.equal((await f.store.execute({ op: 'ack', session: main.documentIncarnation, envelope: env, result: { kind: 'rendered' } })).outcome, 'pending');
  assert.equal((await f.store.execute(idle)).outcome, 'all-rendered');
  const next = await f.store.execute({ op: 'refresh', requestId: f.id(), expectedRevision: 1 });
  assert.deepEqual(f.store.context().selection.previousHealthy, { kind: 'experience', digest: separate.digest });
  f.restart(); const stopped = await f.store.execute({ op: 'status', requestId: next.receipt.requestId });
  assert.equal(stopped.receipt.participants.find(item => item.slot.kind === 'transition').placement.kind, 'failed'); assert.notEqual(stopped.outcome, 'all-rendered'); assert.notEqual(stopped.outcome, 'pending');
});

test('reserved builtin recovery still commits with all 64 admitted documents present', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 64; i++) await f.state(f.window(`window-${i}`));
  const context = f.store.context(), requestId = `recovery:${context.recoveryGeneration}:${randomUUID()}`;
  const result = await f.store.execute({ op: 'restore', requestId, expectedRevision: context.revision, expectedRecoveryGeneration: context.recoveryGeneration });
  assert.equal(f.store.context().selection.selected.kind, 'builtin');
  assert.equal(result.receipt.participants.length, 64);
  assert.equal((await f.store.execute({ op: 'status', requestId })).receipt.participants.length, 64);
  f.restart(); assert.equal((await f.store.execute({ op: 'status', requestId })).receipt.participants.length, 64);
});

test('builtin recovery does not depend on the selected artwork still being readable', async t => {
  const f = await fixture(t), selected = bundle('removed-artwork');
  await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: selected });
  const database = new DatabaseSync(f.path); database.prepare('DELETE FROM ui_bundles WHERE digest=?').run(selected.digest); database.close();
  const context = f.store.context();
  await f.store.execute({ op: 'restore', requestId: `recovery:${context.recoveryGeneration}:${randomUUID()}`, expectedRevision: context.revision, expectedRecoveryGeneration: context.recoveryGeneration });
  assert.equal(f.store.context().selection.selected.kind, 'builtin');
});

test('superseded appearance deliveries terminalize their unfinished native placement', async t => {
  const f = await fixture(t), main = f.window();
  await f.store.execute({ op: 'state', context: main, visible: true, presenceSequence: 1, after: null, waitMs: 0, nativePlacement: true });
  const base = bundle('superseded-placement'), separate = createExperienceBundle({ ...base.manifest, presentation: { ...base.manifest.presentation, chats: 'separate' } }, null, []);
  const first = await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: separate });
  await f.store.execute({ op: 'refresh', requestId: f.id(), expectedRevision: 1 });
  const previous = await f.store.execute({ op: 'status', requestId: first.receipt.requestId });
  assert.equal(previous.outcome, 'superseded');
  assert.equal(previous.receipt.participants.find(p => p.slot.kind === 'transition').placement.kind, 'failed');
});

test('unchanged state and relay polls reuse the validated immutable manifest', async t => {
  const f = await fixture(t), main = f.window(); await f.state(main);
  await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: bundle('cached-manifest') });
  const prepare = f.store.db.prepare.bind(f.store.db); let reads = 0;
  f.store.db.prepare = function(sql, ...args) { if (sql.startsWith('SELECT value FROM ui_bundles')) reads++; return prepare(sql, ...args); };
  await f.state(main, true, 2); await f.state(main, true, 3);
  const child = { ...f.window('child'), role: 'chat', scope: { hostId: 'host', conversationId: 'child' } };
  await f.store.execute({ op: 'relay', main, children: [{ context: child, visible: true, presenceSequence: 1 }], departed: [] });
  assert.equal(reads, 0, 'polling already validated immutable data must not re-read and decode its artwork');
});

test('an older native document report cannot replace a reloaded window, even if its first report was delayed', async t => {
  const f = await fixture(t), old = f.window(), current = { ...old, documentIncarnation: randomUUID() };
  await f.state(current, true, 4);
  await assert.rejects(f.state(old, true, 3), /Stale/);
  const receipt = await f.store.execute({ op: 'refresh', requestId: f.id(), expectedRevision: 0 });
  assert.deepEqual(receipt.receipt.participants.map(item => item.slot.context.documentIncarnation), [current.documentIncarnation]);
  await f.state(current, true, 5);
  await assert.rejects(f.state(old, true, 2), /Stale/);
});

test('late nonparticipant paint does not bless an appearance that the fixed cohort failed', async t => {
  const f = await fixture(t), main = f.window(); await f.state(main);
  const selected = await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: bundle('unconfirmed') });
  const late = f.window('late'); await f.state(late);
  await f.store.execute({ op: 'paint', session: late.documentIncarnation, ...envelope(selected.receipt) });
  await f.store.execute({ op: 'ack', session: main.documentIncarnation, envelope: envelope(selected.receipt), result: { kind: 'failed', reason: 'Could not paint' } });
  await f.store.execute({ op: 'refresh', requestId: f.id(), expectedRevision: 1 });
  assert.deepEqual(f.store.context().selection.previousHealthy, { kind: 'builtin' });
});

test('a valid returning heartbeat preserves its own pending receipt after a delayed poll', async t => {
  const f = await fixture(t), main = f.window(); await f.state(main);
  const selected = await f.store.execute({ op: 'refresh', requestId: f.id(), expectedRevision: 0 });
  const now = Date.now; Date.now = () => now() + 16000;
  try {
    await f.state(main, true, 2); await paint(f.store, main, selected.receipt);
    assert.equal((await f.store.execute({ op: 'ack', session: main.documentIncarnation, envelope: envelope(selected.receipt), result: { kind: 'rendered' } })).outcome, 'all-rendered');
  } finally { Date.now = now; }
});


test('a failed new appearance keeps the previous painted bundle pinned while another window is pending', async t => {
  const f=await fixture(t), one=f.window('one'),two=f.window('two');await f.state(one);await f.state(two);
  const a=bundle('painted-a'),first=await f.store.execute({op:'apply',requestId:f.id(),expectedRevision:0,bundle:a});
  const env=envelope(first.receipt);await f.store.execute({op:'paint',session:one.documentIncarnation,deliveryGeneration:env.deliveryGeneration,selectionRevision:env.selectionRevision,digest:env.digest});
  await f.store.execute({op:'ack',session:one.documentIncarnation,envelope:env,result:{kind:'rendered'}});
  const second=await f.store.execute({op:'apply',requestId:f.id(),expectedRevision:1,bundle:bundle('failed-b')});
  await f.store.execute({op:'ack',session:one.documentIncarnation,envelope:envelope(second.receipt),result:{kind:'failed',reason:'Could not paint'}});
  const pruned=await f.store.execute({op:'prune',requestId:f.id(),keep:0});assert.ok(!pruned.removed.includes(a.digest));assert.equal(f.store.bundle(a.digest).digest,a.digest);
});

test('an expired replacement lease still fences older document presence', async t => {
  const f=await fixture(t),old=f.window(),current={...old,documentIncarnation:randomUUID()};await f.state(current,true,4);
  const now=Date.now;Date.now=()=>now()+16000;
  try {await assert.rejects(f.state(old,true,3),/Stale/);const result=await f.store.execute({op:'refresh',requestId:f.id(),expectedRevision:0});assert.deepEqual(result.receipt.participants,[]);}finally{Date.now=now;}
});

for(const kind of ['symlink','hardlink','directory'])test(`UI database refuses a ${kind} before touching the conversation database`,async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ui-db-isolation-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'ui.sqlite'),hostPath=join(directory,'host.sqlite'),original=new DatabaseSync(hostPath);
  original.exec("PRAGMA journal_mode=WAL;CREATE TABLE sentinel(value TEXT);INSERT INTO sentinel VALUES ('preserve')");original.close();
  if(kind==='symlink')await symlink(hostPath,path);else if(kind==='hardlink')await link(hostPath,path);else await mkdir(path);
  assert.throws(()=>new UiStore(path,'host'),/independent regular file|separate/);
  const check=new DatabaseSync(hostPath);try{assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode,'wal');assert.equal(check.prepare('SELECT value FROM sentinel').get().value,'preserve');assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'ui_%'").all(),[]);}finally{check.close();}
});

test('a valid apply clears the old startup recovery diagnostic',async t=>{
  const f=await fixture(t),bad=bundle('missing-startup');await f.store.execute({op:'apply',requestId:f.id(),expectedRevision:0,bundle:bad});
  const corrupt=new DatabaseSync(f.path);corrupt.prepare('DELETE FROM ui_bundles WHERE digest=?').run(bad.digest);corrupt.close();f.restart();
  assert.match(f.store.context().fault,/missing or invalid/);await f.store.execute({op:'apply',requestId:f.id(),expectedRevision:f.store.context().revision,bundle:bundle('repaired')});assert.equal(f.store.context().fault,null);
});


test('a mismatched child placement hint leaves sibling delivery and presence intact',async t=>{
  const f=await fixture(t),main=f.window(),one={...f.window('one'),role:'chat',scope:{hostId:'host',conversationId:'one'}};
  await f.store.execute({op:'state',context:main,visible:true,presenceSequence:1,after:null,waitMs:0,nativePlacement:true});await f.state(one);
  const base=bundle('isolated-hints'),separate=createExperienceBundle({...base.manifest,presentation:{...base.manifest.presentation,chats:'separate'}},null,[]);
  const selected=await f.store.execute({op:'apply',requestId:f.id(),expectedRevision:0,bundle:separate}),env=envelope(selected.receipt),slot=selected.receipt.participants.find(row=>row.slot.kind==='transition').slot;
  const target={scope:{hostId:'host',conversationId:'two'},viewId:'two',label:'two',nativeTransitionId:'transition',bindingRevision:3};
  const reserve={op:'placement-reserve',session:main.documentIncarnation,envelope:env,transitionId:slot.transitionId,target};
  await assert.rejects(f.store.execute(reserve), /paint/);
  await paint(f.store,main,selected.receipt); await f.store.execute(reserve);
  const two={...main,role:'chat',scope:target.scope,viewId:'two',label:'two',documentIncarnation:randomUUID()};
  const relay=sequence=>f.store.execute({op:'relay',main,children:[{context:one,visible:true,presenceSequence:sequence+1},{context:two,visible:true,presenceSequence:sequence,placement:{nativeTransitionId:'transition',bindingRevision:4}}],departed:[]});
  await relay(1);const now=Date.now;Date.now=()=>now()+16000;
  try{const reply=await relay(2);assert.equal(reply.children.find(row=>row.incarnation===one.documentIncarnation).envelope.requestId,env.requestId);await paint(f.store,one,selected.receipt);const status=await f.store.execute({op:'ack',session:one.documentIncarnation,envelope:env,result:{kind:'rendered'}});assert.equal(status.receipt.participants.find(row=>row.slot.kind==='transition').placement.kind,'pending');}finally{Date.now=now;}
});

test('compaction requires explicit abandonment of pending waits and replays its exact latest CAS result after restart', async t => {
  const f = await fixture(t), main = f.window(); await f.state(main);
  const applied = await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: bundle('compact-pending') });
  await assert.rejects(f.store.execute({ op: 'compact', expectedEpoch: 1 }), /abandon-waits/);
  assert.equal(f.store.context().requestEpoch, 1);
  assert.equal((await f.store.execute({ op: 'status', requestId: applied.receipt.requestId })).outcome, 'pending');
  const request = { op: 'compact', expectedEpoch: 1, abandonWaits: true }, result = await f.store.execute(request);
  assert.equal(result.epoch, 2); assert.equal(result.previousEpoch, 1); assert.equal(result.abandonedWaits, true);
  f.restart(); assert.deepEqual(await f.store.execute(request), result);
  await assert.rejects(f.store.execute({ ...request, abandonWaits: false }), /changed abandon-waits/);
  await assert.rejects(f.store.execute({ op: 'status', requestId: applied.receipt.requestId }), /expired/);
  const next = await f.store.execute({ op: 'compact', expectedEpoch: 2 }); assert.equal(next.epoch, 3);
  await assert.rejects(f.store.execute(request), /already advanced/);
});

test('compaction preserves reserved recovery replay and explicit abandonment never marks its participants rendered', async t => {
  const f = await fixture(t), main = f.window(); await f.state(main);
  const request = { op: 'restore', requestId: `recovery:1:${randomUUID()}`, expectedRevision: 0, expectedRecoveryGeneration: 1 };
  const pending = await f.store.execute(request); assert.equal(pending.outcome, 'pending');
  await f.store.execute({ op: 'compact', expectedEpoch: 1 });
  assert.deepEqual(await f.store.execute(request), pending);
  await f.store.execute({ op: 'compact', expectedEpoch: 2, abandonWaits: true });
  const retained = await f.store.execute(request);
  assert.equal(retained.outcome, 'partial'); assert.equal(retained.receipt.participants[0].visual.kind, 'departed');
  f.restart(); assert.deepEqual(await f.store.execute(request), retained);
});

test('a rendered acknowledgement cannot confirm a delivery before that document reports its matching paint', async t => {
  const f = await fixture(t), main = f.window(); await f.state(main);
  const applied = await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: bundle('paint-required') });
  const ack = { op: 'ack', session: main.documentIncarnation, envelope: envelope(applied.receipt), result: { kind: 'rendered' } };
  await assert.rejects(f.store.execute(ack), /paint/i); assert.equal((await f.store.execute({ op: 'status', requestId: applied.receipt.requestId })).outcome, 'pending');
  await f.store.execute({ op: 'paint', session: main.documentIncarnation, deliveryGeneration: applied.receipt.deliveryGeneration, selectionRevision: applied.receipt.selectionRevision, digest: applied.receipt.digest });
  assert.equal((await f.store.execute(ack)).outcome, 'all-rendered');
});

test('a child refused at presence capacity does not block already admitted relay participants', async t => {
  const f = await fixture(t), main = f.window(); await f.state(main);
  const child = name => ({ ...main, role: 'chat', label: name, documentIncarnation: randomUUID(), viewId: name, scope: { hostId: 'host', conversationId: name } });
  const existing = child('existing'), extra = child('extra');
  const present = (context, presenceSequence) => ({ context, presenceSequence, visible: true });
  await f.store.execute({ op: 'relay', main, children: [present(existing, 1)], departed: [] });
  const { receipt } = await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: bundle('admission-capacity') });
  for (let index = 0; index < 62; index++) await f.state(f.window(`other-${index}`));
  const delivered = await f.store.execute({ op: 'relay', main, children: [present(existing, 2), present(extra, 1)], departed: [] });
  assert.deepEqual(delivered.children.map(row => row.envelope?.requestId ?? null), [receipt.requestId, null]);
  await paint(f.store, main, receipt); await paint(f.store, existing, receipt);
  for (const context of [main, existing]) await f.store.execute({ op: 'ack', session: context.documentIncarnation, envelope: envelope(receipt), result: { kind: 'rendered' } });
  assert.equal((await f.store.execute({ op: 'status', requestId: receipt.requestId })).outcome, 'all-rendered');
  await assert.rejects(f.store.execute({ op: 'relay', main, children: [present(existing, 2)], departed: [] }), /Stale/);
});

for (const table of ['ui_receipts', 'ui_state']) test(`automatic SQLite rollback of ${table} also restores the live selection`, async t => {
  const f = await fixture(t), database = new DatabaseSync(f.path), selected = bundle(`automatic-rollback-${table.replaceAll('_', '-')}`);
  t.after(() => database.close());
  database.exec(`CREATE TRIGGER reject_apply BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ROLLBACK,'injected automatic rollback'); END`);
  const request = { op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: selected };
  await assert.rejects(f.store.execute(request));
  assert.equal(f.store.context().revision, 0); assert.equal(f.store.context().selection.selected.kind, 'builtin');
  database.exec('DROP TRIGGER reject_apply');
  await assert.rejects(f.store.execute({ op: 'status', requestId: request.requestId }), /not found/i);
  assert.throws(() => f.store.bundle(selected.digest), /unavailable/i);
  f.restart(); assert.equal(f.store.context().revision, 0);
  const retried = await f.store.execute(request); assert.equal(retried.receipt.selectionRevision, 1);
});

test('a failed idle catalog appearance does not leave an unreserved placement pending', async t => {
  const f = await fixture(t), main = f.window();
  await f.store.execute({ op: 'state', context: main, visible: true, presenceSequence: 1, after: null, waitMs: 0, nativePlacement: true });
  const base = bundle('failed-idle'), separate = createExperienceBundle({ ...base.manifest, presentation: { ...base.manifest.presentation, chats: 'separate' } }, null, []);
  const { receipt } = await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: separate });
  const result = await f.store.execute({ op: 'ack', session: main.documentIncarnation, envelope: envelope(receipt), result: { kind: 'failed', reason: 'Stylesheet did not load' } });
  assert.notEqual(result.outcome, 'pending'); assert.ok(result.receipt.participants.every(participant => participant.visual.kind === 'failed'));
  await f.store.execute({ op: 'compact', expectedEpoch: 1 });
});

test('an expired main presence cannot complete an idle placement as rendered', async t => {
  const f = await fixture(t), main = f.window();
  await f.store.execute({ op: 'state', context: main, visible: true, presenceSequence: 1, after: null, waitMs: 0, nativePlacement: true });
  const base = bundle('expired-idle'), separate = createExperienceBundle({ ...base.manifest, presentation: { ...base.manifest.presentation, chats: 'separate' } }, null, []);
  const { receipt } = await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: separate });
  await paint(f.store, main, receipt); await f.store.execute({ op: 'ack', session: main.documentIncarnation, envelope: envelope(receipt), result: { kind: 'rendered' } });
  const transitionId = receipt.participants.find(participant => participant.slot.kind === 'transition').slot.transitionId, now = Date.now;
  Date.now = () => now() + 16000;
  try { await assert.rejects(f.store.execute({ op: 'placement-idle', session: main.documentIncarnation, envelope: envelope(receipt), transitionId }), /placement/i); }
  finally { Date.now = now; }
});

test('unsupported selected and healthy bundles recover once and allow a fresh v2 write without resetting UI data', async t => {
  const { canonicalJson } = await import('@openpane/contracts');
  const { sha256 } = await import('../../apps/host/build/tsc/experience-bundle.js');
  for (const mode of ['selected', 'healthy', 'builtin']) {
    const f = await fixture(t), valid = bundle(`valid-${mode}`);
    await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: valid });
    f.store.close();
    const db = new DatabaseSync(f.path);
    const old = structuredClone(valid); old.manifest.schemaVersion = 1;
    delete old.manifest.theme.density; delete old.manifest.presentation.home; delete old.manifest.presentation.transcript;
    old.digest = sha256(canonicalJson({ manifest: old.manifest, stylesheet: old.stylesheet, assets: old.assets }));
    db.prepare('INSERT INTO ui_bundles VALUES (?,?,?,?)').run(old.digest, JSON.stringify(old), Buffer.byteLength(JSON.stringify(old)), 1);
    const state = JSON.parse(db.prepare('SELECT value FROM ui_state WHERE id=1').get().value);
    state.healthy = { kind: 'experience', digest: old.digest }; state.selection.previousHealthy = state.healthy;
    if (mode === 'selected') state.selection.selected = state.healthy;
    if (mode === 'builtin') state.selection.selected = { kind: 'builtin' };
    db.prepare('UPDATE ui_state SET value=? WHERE id=1').run(JSON.stringify(state));
    db.exec('CREATE TABLE retained_ui_data (value TEXT); INSERT INTO retained_ui_data VALUES (\'kept\')'); db.close();
    f.restart();
    const context = f.store.context();
    assert.equal(context.revision, mode === 'selected' ? 2 : 1);
    assert.equal(context.selection.selected.kind, mode === 'healthy' ? 'experience' : 'builtin');
    if (mode === 'healthy') assert.equal(context.selection.selected.digest, valid.digest);
    assert.equal(context.selection.previousHealthy.kind, 'builtin'); assert.match(context.fault, /unsupported|unavailable/);
    assert.throws(() => f.store.bundle(old.digest), error => error.code === 'unavailable');
    assert.equal(f.store.context().revision, context.revision); f.restart(); assert.equal(f.store.context().revision, context.revision);
    assert.equal(f.store.context().fault, context.fault, 'recovery remains visible until an explicit valid selection');
    await f.store.execute({ op: 'refresh', requestId: f.id(), expectedRevision: context.revision });
    assert.equal(f.store.context().fault, context.fault);
    f.restart(); assert.equal(f.store.context().fault, context.fault, 'refresh does not acknowledge an unsupported saved bundle');
    const next = bundle(`next-${mode}`), requestId = f.id();
    await f.store.execute({ op: 'apply', requestId, expectedRevision: context.revision, bundle: next });
    assert.equal((await f.store.execute({ op: 'status', requestId })).receipt.digest, next.digest);
    f.restart(); assert.equal(f.store.context().selection.selected.digest, next.digest);
    assert.equal(f.store.context().fault, null);
    const inspect = new DatabaseSync(f.path); assert.equal(inspect.prepare('SELECT value FROM retained_ui_data').get().value, 'kept');
    assert.equal(inspect.prepare('SELECT count(*) AS count FROM ui_bundles WHERE digest=?').get(old.digest).count, 1); inspect.close();
  }
});

test('a superseded reservation is an authoritative no-op so an already transferred editor can finish its old handoff', async t => {
  const f = await fixture(t), main = f.window();
  await f.store.execute({ op: 'state', context: main, visible: true, presenceSequence: 1, after: null, waitMs: 0, nativePlacement: true });
  const base = bundle('superseded-handoff'), separate = createExperienceBundle({ ...base.manifest, presentation: { ...base.manifest.presentation, chats: 'separate' } }, null, []);
  const a = await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: separate });
  await paint(f.store, main, a.receipt);
  const slot = a.receipt.participants.find(row => row.slot.kind === 'transition').slot;
  const b = await f.store.execute({ op: 'refresh', requestId: f.id(), expectedRevision: 1 });
  const target = { scope: { hostId: 'host', conversationId: 'one' }, viewId: 'one', label: 'one', nativeTransitionId: 'native-A', bindingRevision: 3 };
  const reply = await f.store.execute({ op: 'placement-reserve', session: main.documentIncarnation, envelope: envelope(a.receipt), transitionId: slot.transitionId, target });
  assert.equal(reply.outcome, 'superseded');
  const current = await f.store.execute({ op: 'status', requestId: b.receipt.requestId });
  assert.equal(current.receipt.participants.find(row => row.slot.kind === 'transition').slot.target, null);
  assert.equal(current.outcome, 'pending');
});

test('restore context guards host and profile before replay without changing legacy operation identity', async t => {
  const f = await fixture(t), context = f.store.context(), request = { op: 'restore', requestId: `recovery:${context.recoveryGeneration}:${randomUUID()}`, expectedRevision: context.revision, expectedRecoveryGeneration: context.recoveryGeneration };
  const { parseUiRequest } = await import('../../apps/host/build/tsc/ui-protocol.js');
  const expectedContext = { hostId: 'host', profileId: context.profileId };
  const original = await f.store.execute(request);
  assert.deepEqual(await f.store.execute(parseUiRequest({ ...request, expectedContext })), original, 'adding transport correlation must replay the original durable operation');
  for (const foreign of [{ ...expectedContext, hostId: 'other-host' }, { ...expectedContext, profileId: 'other-profile' }]) {
    await assert.rejects(f.store.execute(parseUiRequest({ ...request, expectedContext: foreign })), error => error.code === 'wrong-host');
  }
  assert.equal(f.store.context().revision, original.receipt.selectionRevision);
  for (const invalid of [null, {}, { hostId: 'host' }, { profileId: context.profileId }, { ...expectedContext, extra: true }]) assert.throws(() => parseUiRequest({ ...request, expectedContext: invalid }));
  const next = f.store.context(), guarded = { op: 'restore', requestId: `recovery:${next.recoveryGeneration}:${randomUUID()}`, expectedRevision: next.revision, expectedRecoveryGeneration: next.recoveryGeneration };
  const receipt = await f.store.execute({ ...guarded, expectedContext });
  assert.deepEqual(await f.store.execute(guarded), receipt, 'the current-host CLI may replay a scoped operation without changing its input identity');
});

test('uppercase recovery receipts remain readable with the restore cohort limit', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 33; index++) await f.state(f.window(String(index)));
  const requestId = `RECOVERY:1:${randomUUID()}`;
  const result = await f.store.execute({ op: 'restore', requestId, expectedRevision: 0, expectedRecoveryGeneration: 1 });
  assert.equal(result.receipt.participants.length, 33);
  f.restart();
  assert.equal((await f.store.execute({ op: 'status', requestId })).receipt.participants.length, 33);
});
for (const failedFirst of [true, false]) test(`existing child failure settles regardless of relay order: failedFirst=${failedFirst}`, async t => {
  const f = await fixture(t), main = f.window(), scope = { hostId: 'host', conversationId: 'existing' };
  const child = { ...main, role: 'chat', label: 'child', documentIncarnation: 'child', viewId: 'child', scope };
  await f.store.execute({ op: 'state', context: main, visible: true, presenceSequence: 1, after: null, waitMs: 0, nativePlacement: true });
  await f.store.execute({ op: 'relay', main, children: [{ context: child, visible: true, presenceSequence: 1 }], departed: [] });
  const base = bundle('existing-child'), separate = createExperienceBundle({ ...base.manifest, presentation: { ...base.manifest.presentation, chats: 'separate' } }, null, []);
  const receipt = (await f.store.execute({ op: 'apply', requestId: f.id(), expectedRevision: 0, bundle: separate })).receipt;
  await paint(f.store, main, receipt);
  await f.store.execute({ op: 'ack', session: main.documentIncarnation, envelope: envelope(receipt), result: { kind: 'rendered' } });
  const transition = receipt.participants.find(participant => participant.slot.kind === 'transition').slot;
  const target = { scope, viewId: 'child', label: 'child', nativeTransitionId: 'native', bindingRevision: 2 };
  await f.store.execute({ op: 'placement-reserve', session: main.documentIncarnation, envelope: envelope(receipt), transitionId: transition.transitionId, target });
  const fail = () => f.store.execute({ op: 'ack', session: child.documentIncarnation, envelope: envelope(receipt), result: { kind: 'failed', reason: 'fixture render failure' } });
  const relay = () => f.store.execute({ op: 'relay', main, children: [{ context: child, visible: true, presenceSequence: 2, placement: { nativeTransitionId: 'native', bindingRevision: 2 } }], departed: [] });
  if (failedFirst) { await fail(); await relay(); } else { await relay(); await fail(); }
  const status = await f.store.execute({ op: 'status', requestId: receipt.requestId });
  assert.equal(status.outcome, 'partial');
  assert.equal(status.receipt.participants.find(participant => participant.slot.kind === 'transition').visual.kind, 'failed');
});

test('display reads do not persist appearance state', async t => {
  const f = await fixture(t, { checkScope: () => true });
  f.store.db.exec('CREATE TABLE appearance_writes(value INTEGER); CREATE TRIGGER count_appearance_writes AFTER INSERT ON ui_state BEGIN INSERT INTO appearance_writes VALUES(1); END');
  const subscription = { scope: { hostId: 'host', conversationId: 'read-only-cards' }, subscriptionId: randomUUID(), cursor: null };
  for (let n = 0; n < 2; n++) assert.equal(f.store.readDisplay(subscription).kind, 'snapshot');
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM appearance_writes').get().count, 0);
});
