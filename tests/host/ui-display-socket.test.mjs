import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { METRICS_EVENT_NAME } from '@openpane/contracts';
import { UiStore } from '../../apps/host/build/tsc/ui-store.js';
import { startUiControl, openUiQuerySession, requestUi } from '../../apps/host/build/tsc/ui-control.js';
import { publishDatadog } from '../../apps/host/build/tsc/ui-display-client.js';
import { runDisplayCli } from '../../apps/host/build/tsc/ui-display-cli.js';
import { UiFrames, uiFrame, uiResponse } from '../../apps/host/build/tsc/ui-frames.js';

const scope = { hostId: 'host', conversationId: 'chat' };
const queryInput = { query: 'avg:system.cpu.user{*}', title: 'CPU', from: '1795374000', to: '1795377600', executable: '/fixture/pup', executableHint: 'PATH:pup', version: '2.0.1', site: 'us3.datadoghq.com', siteHint: 'us3.datadoghq.com' };
const event = { type: 'CUSTOM', name: METRICS_EVENT_NAME, value: { schemaVersion: 1, query: queryInput.query, title: queryInput.title, fromMs: 1795374000000, toMs: 1795377600000, fetchedAtMs: 1795377600001, series: [] } };
async function wait(check) { const until = Date.now() + 4000; while (!await check()) { if (Date.now() > until) throw new Error('UI session did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'openpane-display-socket-')), socket = join(directory, 'ui.sock');
  const store = new UiStore(join(directory, 'ui.sqlite'), 'host', undefined, value => value.hostId === scope.hostId && value.conversationId === scope.conversationId);
  const behavior = { after: async () => {}, readOptions: undefined };
  const control = await startUiControl(socket, async (request, session) => { const value = request.op === 'display-list' && behavior.readOptions ? store.readDisplay(request.subscription, behavior.readOptions) : await store.execute(request, session); await behavior.after(request, value); return value; }, { disconnected: owner => store.endUiSession(owner) });
  t.after(async () => { await control.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const id = () => `${store.context().requestEpoch}:${randomUUID()}`;
  return { directory, socket, store, behavior, id, reserve: publicationId => ({ op: 'display-query-reserve', scope, publicationId, input: queryInput }), status: publicationId => requestUi(socket, { op: 'display-status', scope, publicationId }) };
}

test('a live socket owns its winning query attempt and other connections cannot publish its result', async t => {
  const f = await fixture(t), publicationId = f.id(), session = await openUiQuerySession(f.socket, f.reserve(publicationId)); t.after(() => session.close());
  assert.equal(session.first.granted, true);
  const duplicate = await requestUi(f.socket, f.reserve(publicationId)); assert.equal(duplicate.granted, false);
  const final = { op: 'display-query-finalize', scope, publicationId, attempt: 1, event };
  await assert.rejects(requestUi(f.socket, final), /no longer current/);
  const result = await session.request(final); assert.equal(result.reservation.kind, 'published');
  assert.equal((await f.status(publicationId)).reservation.digest, result.reservation.digest);
  const replay = await openUiQuerySession(f.socket, f.reserve(publicationId)); t.after(() => replay.close());
  assert.equal(replay.first.granted, false); assert.equal(replay.first.reservation.sequence, result.reservation.sequence);
});

test('losing a reservation reply interrupts its exact scope and never grants a duplicate connection', async t => {
  const f = await fixture(t), publicationId = f.id(), held = Promise.withResolvers(), reserved = Promise.withResolvers();
  f.behavior.after = async request => { if (request.op === 'display-query-reserve' && request.publicationId === publicationId) { reserved.resolve(); await held.promise; } };
  t.after(() => held.resolve());
  const socket = createConnection(f.socket); socket.on('error', () => {}); socket.once('connect', () => socket.write(uiFrame(f.reserve(publicationId))));
  await reserved.promise; socket.destroy();
  await wait(async () => (await f.status(publicationId)).reservation.kind === 'interrupted');
  held.resolve();
  const replay = await openUiQuerySession(f.socket, f.reserve(publicationId)); t.after(() => replay.close());
  assert.equal(replay.first.granted, false); assert.equal(replay.first.reservation.kind, 'interrupted');
});

test('a lost commit reply recovers the published receipt without another live query grant', async t => {
  const f = await fixture(t), publicationId = f.id(), held = Promise.withResolvers(), committed = Promise.withResolvers();
  f.behavior.after = async (request, value) => { if (request.op === 'display-query-finalize') { committed.resolve(value); await held.promise; } };
  t.after(() => held.resolve());
  const session = await openUiQuerySession(f.socket, f.reserve(publicationId));
  const reply = session.request({ op: 'display-query-finalize', scope, publicationId, attempt: 1, event }).then(() => 'received', () => 'lost');
  const saved = await committed.promise; session.close(); assert.equal(await reply, 'lost'); held.resolve();
  assert.deepEqual((await f.status(publicationId)).reservation, saved.reservation);
  const replay = await requestUi(f.socket, f.reserve(publicationId)); assert.equal(replay.granted, false); assert.equal(replay.reservation.sequence, saved.reservation.sequence);
});

test('query frames arriving together are retained, while ordinary UI requests reject a second frame', async t => {
  const f = await fixture(t), publicationId = f.id(), socket = createConnection(f.socket), reader = new UiFrames(socket); t.after(() => reader.close());
  socket.once('connect', () => socket.write(uiFrame(f.reserve(publicationId)) + uiFrame({ op: 'display-query-finalize', scope, publicationId, attempt: 1, event })));
  assert.equal(uiResponse(await reader.next()).granted, true); assert.equal(uiResponse(await reader.next()).reservation.kind, 'published');
  const otherId = f.id(), other = createConnection(f.socket), rejected = new UiFrames(other); t.after(() => rejected.close());
  other.once('connect', () => other.write(uiFrame({ op: 'display-publish', scope, publicationId: otherId, event }) + uiFrame({ op: 'context' })));
  const response = await rejected.next(); assert.equal(response.ok, false); assert.equal((await f.status(otherId)).mode, 'missing');
});

test('the host bounds an unfinished raw query connection and persists interruption on deadline', { timeout: 7000 }, async t => {
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (handler, ms, ...args) => original(handler, ms > 44000 && ms <= 45000 ? 1200 : ms, ...args));
  const f = await fixture(t), publicationId = f.id(), socket = createConnection(f.socket), reader = new UiFrames(socket); t.after(() => reader.close());
  socket.once('connect', () => socket.write(uiFrame(f.reserve(publicationId))));
  assert.equal(uiResponse(await reader.next()).granted, true);
  await reader.ended;
  await wait(async () => (await f.status(publicationId)).reservation.kind === 'interrupted');
});

test('display CLI accepts a successful null delivery response', async t => {
  const f = await fixture(t), values = { 'scope-json': JSON.stringify(scope), 'subscription-id': 'idle-cli' };
  const page = await runDisplayCli('list', f.socket, values, async () => null);
  assert.ok(page); f.behavior.readOptions = {bytes:1};
  assert.equal(await runDisplayCli('list', f.socket, { ...values, 'cursor-json': JSON.stringify(page.next) }, async () => null), null);
});

test('cancellation while the reservation reply is pending settles without a drain window', async t => {
  const f = await fixture(t), publicationId = f.id(), pup = join(f.directory, 'pup');
  await writeFile(pup, `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('pup 2.0.1');else if(process.argv.includes('auth'))console.log(JSON.stringify({site:'us3.datadoghq.com'}));else require('node:fs').writeFileSync(${JSON.stringify(join(f.directory,'unexpected-query'))},'started');`, {mode:0o700});
  f.behavior.after = async request => { if (request.op === 'display-query-reserve') process.emit('SIGTERM'); };
  await assert.rejects(publishDatadog({ socket:f.socket, scope, publicationId, action:{kind:'query',query:queryInput.query,title:queryInput.title,from:queryInput.from,to:queryInput.to,pup} }), /cancelled/);
  assert.equal((await f.status(publicationId)).reservation.kind, 'failed');
  assert.equal((await f.status(publicationId)).reservation.reason, 'cancelled');
  const retry = await openUiQuerySession(f.socket, {op:'display-query-retry',scope,publicationId,expectedAttempt:1});
  assert.equal(retry.first.granted,true);
  await retry.request({op:'display-query-fail',scope,publicationId,attempt:2,reason:'cancelled'});retry.close();
  await assert.rejects(import('node:fs/promises').then(({access})=>access(join(f.directory,'unexpected-query'))), {code:'ENOENT'});
});

test('cancelling a reserved version probe records cancellation and starts no metrics query', async t => {
  const f = await fixture(t), publicationId = f.id(), pup = join(f.directory, 'pup'), ready = join(f.directory,'version-ready');
  await writeFile(pup, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`, {mode:0o700});
  const initial = await openUiQuerySession(f.socket, {...f.reserve(publicationId),input:{...queryInput,executable:pup,executableHint:pup}});
  await initial.request({op:'display-query-fail',scope,publicationId,attempt:1,reason:'pup-failed'});initial.close();
  const running = publishDatadog({socket:f.socket,scope,publicationId,action:{kind:'retry',expectedAttempt:1}});
  const outcome = running.then(value=>({value}),error=>({error}));
  await wait(()=>import('node:fs/promises').then(({access})=>access(ready)).then(()=>true,()=>false));
  process.emit('SIGTERM');
  assert.match(String((await outcome).error), /cancelled/);
  const reservation = (await f.status(publicationId)).reservation;
  assert.equal(reservation.kind,'failed');assert.equal(reservation.reason,'cancelled');assert.equal(reservation.attempt,2);
});

test('socket input errors retain invalid-input while execution faults report unavailable', async t => {
  const f = await fixture(t);
  await assert.rejects(requestUi(f.socket,{op:'not-real'}),error=>error.code==='invalid-input');
  f.behavior.after = async () => {throw new Error('PRIVATE_STORAGE_DETAIL');};
  await assert.rejects(requestUi(f.socket,{op:'context'}),error=>error.code==='unavailable'&&!error.message.includes('PRIVATE_STORAGE_DETAIL'));
});

test('forced socket shutdown waits for its query recovery fault before settling', {timeout:5000}, async t => {
  const original = globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(handler,ms,...args)=>original(handler,ms===6000?20:ms,...args));
  const directory = await mkdtemp(join(tmpdir(),'openpane-query-close-')), socket=join(directory,'ui.sock'), disconnected=Promise.withResolvers();
  let control, session;
  t.after(async()=>{session?.close();await control?.close().catch(()=>{});await rm(directory,{recursive:true,force:true});});
  control=await startUiControl(socket,async()=>({granted:true}),{disconnected(){disconnected.resolve();throw new Error('fixture recovery fault');}});
  session=await openUiQuerySession(socket,{op:'display-query-reserve',scope,publicationId:'1:fixture',input:queryInput});
  const outcome=await control.close().then(()=>({ok:true}),error=>({error}));
  await disconnected.promise;
  assert.match(String(outcome.error),/Query recovery could not be saved/);
});

test('a new query rechecks its qualified executable after the reservation reply', async t => {
  const f = await fixture(t), publicationId = f.id(), pup = join(f.directory, 'pup'), ran = join(f.directory, 'unexpected-query');
  const raw = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./fixtures/metrics/pup-v1.json', import.meta.url), 'utf8'));
  raw.from_date = Number(queryInput.from) * 1000; raw.to_date = Number(queryInput.to) * 1000; raw.series = [];
  const program = version => `#!${process.execPath}\nif(process.argv.includes('--version')) console.log('pup ${version}');else if(process.argv.includes('auth'))console.log(JSON.stringify({site:'us3.datadoghq.com'}));else{require('node:fs').writeFileSync(${JSON.stringify(ran)},'started');console.log(${JSON.stringify(JSON.stringify(raw))});}`;
  await writeFile(pup, program('2.0.1'), { mode: 0o700 });
  f.behavior.after = async (request, value) => {
    if (request.op === 'display-query-reserve' && value.granted) await writeFile(pup, program('2.0.2'), { mode: 0o700 });
  };
  await assert.rejects(publishDatadog({ socket: f.socket, scope, publicationId, action: {
    kind: 'query', query: queryInput.query, title: queryInput.title, from: queryInput.from, to: queryInput.to, pup,
  } }), /reserved pup version is unavailable/);
  const saved = await f.status(publicationId);
  assert.equal(saved.reservation.kind, 'failed');
  assert.equal(saved.reservation.reason, 'pup-unavailable');
  assert.equal(saved.reservation.version, '2.0.1');
  await assert.rejects(import('node:fs/promises').then(({ access }) => access(ran)), { code: 'ENOENT' });
});
