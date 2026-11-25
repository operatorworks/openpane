import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import { createConversationStore } from '@openpane/client';
import { createViewLeasePool } from '../../apps/desktop/dist/application/view-leases.js';
import { deferred, fakePort, projection, scope, storage } from '../client/support.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const drafts = storage(), captures = [], stores = [], failures = [];
  let closes = 0;
  const physical = { viewId: 'view', close() { closes++; } };
  const pool = createViewLeasePool({
    createStore(_storage, selected, _agentId, capture) {
      captures.push(capture);
      const store = createConversationStore({ scope: selected, drafts, projection, port: fakePort(selected) });
      stores.push(store); return store;
    },
    failed(owner, error) { failures.push([owner, error]); },
  });
  const view = pool.adopt(physical);
  t.after(() => pool.dispose());
  return { pool, view, drafts, captures, stores, failures, closes: () => closes };
}

test('a waiting successor retains physical storage while the old writer drains', async t => {
  const f = fixture(t), first = await f.pool.active(f.view, scope, 'agent');
  const entered = deferred(), gate = deferred(), save = f.drafts.save.bind(f.drafts);
  t.after(gate.resolve);
  f.drafts.save = async value => { entered.resolve(); await gate.promise; await save(value); };
  const writing = first.store.setDraft('Predecessor write'); await entered.promise;
  first.release();
  let acquired = false;
  const next = f.pool.active(f.view, scope, 'agent').then(value => { acquired = true; return value; });
  f.view.release();
  await flush();
  assert.equal(acquired, false); assert.equal(f.stores.length, 1); assert.equal(f.closes(), 0);
  gate.resolve(); await writing;
  const successor = await next;
  assert.notEqual(successor.store, first.store);
  assert.equal(successor.storage, f.view.storage);
  assert.equal(successor.store.getSnapshot().draft, 'Predecessor write');
  await successor.store.setDraft('Successor write');
  assert.equal(f.drafts.value.draft, 'Successor write');
  successor.release(); await flush();
  assert.equal(f.stores.length, 2); assert.equal(f.closes(), 1); assert.deepEqual(f.failures, []);
});

test('the closing slot refuses synchronous capture in its disposal listener', async t => {
  const f = fixture(t), first = await f.pool.active(f.view, scope, 'agent');
  let checked = false;
  first.store.subscribe(() => {
    checked = true;
    assert.throws(() => f.captures[0].borrow(), /closing/);
  });
  first.release(); await flush();
  assert.equal(checked, true);
  assert.equal(f.stores.length, 1);
  assert.equal(f.closes(), 0);
  f.view.release(); await flush();
  assert.equal(f.closes(), 1);
});

test('pool disposal drains admitted writes without waiting for an arbitrary capture handle', async t => {
  const f = fixture(t), first = await f.pool.active(f.view, scope, 'agent');
  const capture = f.captures[0].borrow(), gate = deferred(), entered = deferred();
  const save = f.drafts.save.bind(f.drafts);
  t.after(gate.resolve);
  f.drafts.save = async value => { entered.resolve(); await gate.promise; await save(value); };
  const writing = first.store.setDraft('Admitted write'); await entered.promise;
  const closing = f.pool.dispose();
  assert.equal(f.pool.dispose(), closing);
  assert.throws(() => f.captures[0].borrow(), /closing/);
  await flush(); assert.equal(f.closes(), 0);
  gate.resolve(); await Promise.all([writing, closing]);
  assert.equal(f.drafts.value.draft, 'Admitted write'); assert.equal(f.closes(), 1);
  capture.release(); first.release(); f.view.release();
  assert.deepEqual(f.failures, []);
});


for (const purpose of ['active', 'recovery']) test(`${purpose} readiness failure respects its purpose while a capture still retains the view`, async t => {
  const f = fixture(t), first = await f.pool.active(f.view, scope, 'agent');
  const capture = f.captures[0].borrow(), original = f.view.storage;
  const selected = { ...scope, conversationId: 'corrupt' }, corrupt = { version: 99, scope: selected };
  f.drafts.value = corrupt;
  const gate = deferred(), entered = deferred();
  t.after(gate.resolve);
  f.drafts.load = async () => { entered.resolve(); await gate.promise; return corrupt; };
  const acquiring = purpose === 'active' ? f.pool.active(f.view, selected, 'agent') : f.pool.recovery(f.view, selected);
  const rejected = assert.rejects(acquiring, /Unsupported local storage version/);
  await entered.promise;
  first.release(); f.view.release();
  gate.resolve(); await rejected; await flush();
  assert.equal(f.failures.length, purpose === 'active' ? 1 : 0);
  assert.equal(f.closes(), 0);
  assert.equal(f.drafts.value, corrupt);
  const failure = new Error('Live captured write failed');
  capture.failed(failure);
  assert.deepEqual(f.failures.at(-1), [original, failure]);
  capture.release(); await flush();
  assert.equal(f.closes(), 1);
});

test('an explicit editor reopen retries its own loader after shared background recovery declines the view', async () => {
  const pool = createViewLeasePool({ createStore() { throw new Error('No store requested'); }, failed() {} });
  const entered = deferred(), release = deferred(); let editorLoads = 0, closed = 0;
  const background = pool.open('reserved-view', async () => { entered.resolve(); await release.promise; return null; }, { interested: false, kind: 'recovery' });
  await entered.promise;
  const editor = pool.open('reserved-view', async () => { editorLoads++; return { viewId: 'reserved-view', close() { closed++; } }; }, { required: true });
  release.resolve(); assert.equal(await background, null); const owned = await editor;
  assert.equal(owned.storage.viewId, 'reserved-view'); assert.equal(editorLoads, 1);
  owned.release(); await pool.dispose(); assert.equal(closed, 1);
});

test('disposal waits for an acquired physical owner to finish opening and release its locks', async () => {
  const pool = createViewLeasePool({ createStore() { throw new Error('No store requested'); }, failed() {} });
  const entered = deferred(), read = deferred(); let locked = false, finished = false, closed = 0;
  const acquiring = pool.open('opening-view', async () => { locked = true; entered.resolve(); await read.promise; return { viewId: 'opening-view', close() { closed++; locked = false; } }; });
  await entered.promise; const closing = pool.dispose(); void closing.then(() => { finished = true; });
  await flush(); assert.equal(finished, false); assert.equal(locked, true);
  read.resolve(); await closing; assert.equal(await acquiring, null); assert.equal(locked, false); assert.equal(closed, 1);
});

test('ignored recovery release handles cleanup rejection while disposal still reports it', () => {
  const source = `import {createViewLeasePool} from ${JSON.stringify(new URL('../../apps/desktop/dist/application/view-leases.js',import.meta.url).href)};
    const unhandled=[];process.on('unhandledRejection',error=>unhandled.push(error.message));
    const pool=createViewLeasePool({createStore(){return{ready:Promise.resolve(),dispose(){return Promise.reject(Error('Final recovery flush failed'));}};},failed(){}});
    const view=pool.adopt({viewId:'recovery-view',close(){}}),held=await pool.recovery(view,{hostId:'host',conversationId:'recovery'});
    held.release();pool.releaseRecovery(view);
    await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
    const disposal=await pool.dispose().then(()=>null,error=>error.message);
    await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
    console.log(JSON.stringify({unhandled,disposal}));`;
  const result = spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000});
  assert.equal(result.error,undefined); assert.equal(result.signal,null);
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{unhandled:[],disposal:'Final recovery flush failed'});
});

test('awaited recovery release keeps its final flush rejection observable', async () => {
  const pool=createViewLeasePool({createStore(){return{ready:Promise.resolve(),dispose(){return Promise.reject(Error('Final recovery flush failed'));}};},failed(){}});
  const view=pool.adopt({viewId:'awaited-recovery-view',close(){}}),held=await pool.recovery(view,scope);
  held.release();await assert.rejects(pool.releaseRecovery(view),/Final recovery flush failed/);
  await assert.rejects(pool.dispose(),/Final recovery flush failed/);
});

for (const point of ['held', 'pending']) test(`an editor waits for a ${point} recovery-only view and its captured store to physically close`, { timeout: 3000 }, async () => {
  const loadEntered = deferred(), loadGate = deferred(), drain = deferred(), closeEntered = deferred(), closeGate = deferred();
  let capture, loads = 0, closed = false, settled = false;
  const recoveryStorage = { viewId: 'role-view', async close() { closeEntered.resolve(); await closeGate.promise; closed = true; } };
  const pool = createViewLeasePool({ createStore(_storage, _scope, _agent, owner) { capture = owner; return { ready: Promise.resolve(), dispose: () => drain.promise }; }, failed() {} });
  let recovery, store, retained, editor;
  try {
    const background = pool.open('role-view', async () => { loadEntered.resolve(); if (point === 'pending') await loadGate.promise; return recoveryStorage; }, { kind: 'recovery', interested: false });
    await loadEntered.promise;
    if (point === 'held') recovery = await background;
    const opening = pool.open('role-view', async () => { loads++; assert.equal(closed, true); return { viewId: 'role-view', close() {} }; }, { required: true }).then(value => { settled = true; return value; });
    loadGate.resolve(); recovery ??= await background; store = await pool.recovery(recovery, scope); retained = capture.borrow();
    await flush(); const during = { settled, loads, holds: pool.holds('role-view'), reserved: pool.reserve('role-view') }; during.reserved?.release();
    if (settled) { editor = await opening; editor?.release(); editor = null; }
    store.release(); store = null; recovery.release(); recovery = null; await flush(); const retainedBeforeRelease = closed;
    retained.release(); retained = null; await flush(); const beforeDrain = loads; drain.resolve(); await closeEntered.promise; const beforePhysicalClose = loads;
    closeGate.resolve(); editor ??= await opening; editor?.release(); editor = null;
    assert.deepEqual({ ...during, reserved: during.reserved === null }, { settled: false, loads: 0, holds: false, reserved: true });
    assert.equal(retainedBeforeRelease, false); assert.equal(beforeDrain, 0); assert.equal(beforePhysicalClose, 0); assert.equal(loads, 1);
  } finally { loadGate.resolve(); drain.resolve(); closeGate.resolve(); retained?.release(); store?.release(); recovery?.release(); editor?.release(); await pool.dispose(); }
});

test('background recovery may borrow a current editor without replacing its admission', async () => {
  const storage = { viewId: 'editor-view', close() {} }, pool = createViewLeasePool({ createStore() { throw new Error('No store requested'); }, failed() {} });
  const editor = pool.adopt(storage);
  try {
    const recovery = await pool.open('editor-view', async () => { throw new Error('Recovery must reuse the editor'); }, { kind: 'recovery', interested: false });
    assert.equal(recovery.storage, storage); assert.equal(pool.holds('editor-view'), true); const again = pool.reserve('editor-view'); assert.equal(again.storage, storage); again.release(); recovery.release();
  } finally { editor.release(); await pool.dispose(); }
});

test('an editor runs its own admission after a recovery-only pending loader fails', { timeout: 3000 }, async () => {
  const gate = deferred(), entered = deferred(); let loads = 0;
  const pool = createViewLeasePool({ createStore() { throw new Error('No store requested'); }, failed() {} });
  try {
    const background = pool.open('failed-scout', async () => { entered.resolve(); await gate.promise; throw new Error('Recovery lookup unavailable'); }, { kind: 'recovery', interested: false });
    const refused = assert.rejects(background, /Recovery lookup unavailable/); await entered.promise;
    const editor = pool.open('failed-scout', async () => { loads++; return { viewId: 'failed-scout', close() {} }; }, { required: true });
    gate.resolve(); await refused; const admitted = await editor; assert.equal(loads, 1); admitted.release();
  } finally { gate.resolve(); await pool.dispose(); }
});
