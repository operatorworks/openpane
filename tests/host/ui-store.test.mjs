import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { UiStore } from '../../apps/host/build/tsc/ui-store.js';
import { createExperienceBundle } from '../../apps/host/build/tsc/experience-bundle.js';
const bundle = id => createExperienceBundle({ schemaVersion: 1, id, label: id, theme: { mode: 'system', light: {}, dark: {} },
  presentation: { navigation: 'rail', chats: 'inline', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, stylesheet: null, assets: [] }, null, []);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ui-store-'));
  const path = join(directory, 'ui.sqlite'); let store = new UiStore(path, 'host');
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const id = () => `${store.context().requestEpoch}:${randomUUID()}`;
  const window = (name = 'main') => { const context = store.context(); return { hostId: 'host', profileId: context.profileId, role: 'main', brokerInstance: 'browser', label: name, documentIncarnation: randomUUID(), viewId: name }; };
  return { path, get store() { return store; }, id, window, restart() { store.close(); store = new UiStore(path, 'host'); },
    state(context, visible = true, presenceSequence = 1) { return store.execute({ op: 'state', context, visible, presenceSequence, after: null, waitMs: 0 }); } };
}
const envelope = receipt => Object.fromEntries(['requestId', 'deliveryGeneration', 'selectionRevision', 'digest'].map(key => [key, receipt[key]]));
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
  assert.equal((await f.store.execute(ack)).outcome, 'pending');
  assert.deepEqual(await f.store.execute(ack), await f.store.execute(ack));
  await assert.rejects(f.store.execute({ ...ack, session: hidden.documentIncarnation }), /visible/);
  const unrelated = f.window('late'); await f.state(unrelated);
  await assert.rejects(f.store.execute({ ...ack, session: unrelated.documentIncarnation }), /participant/);
  await f.state(hidden, true, 2);
  assert.equal((await f.store.execute({ ...ack, session: hidden.documentIncarnation })).outcome, 'all-rendered');
  const next = await f.store.execute({ op: 'refresh', requestId: f.id(), expectedRevision: 1 });
  assert.equal(next.receipt.selectionRevision, 1); assert.equal(next.receipt.deliveryGeneration, receipt.deliveryGeneration + 1);
  const replacement = { ...one, documentIncarnation: randomUUID() }; await f.state(replacement);
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
