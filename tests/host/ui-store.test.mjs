import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, symlink, link, mkdir } from 'node:fs/promises';
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
const paint = (store, window, receipt) => store.execute({ op: 'paint', session: window.documentIncarnation, deliveryGeneration: receipt.deliveryGeneration, selectionRevision: receipt.selectionRevision, digest: receipt.digest });
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
  await f.store.execute(reserve); await f.store.execute(reserve);
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
  const target={scope:{hostId:'host',conversationId:'two'},viewId:'two',label:'two',nativeTransitionId:'transition',bindingRevision:3};await f.store.execute({op:'placement-reserve',session:main.documentIncarnation,envelope:env,transitionId:slot.transitionId,target});
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
