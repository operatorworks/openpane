import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { METRICS_EVENT_NAME } from '@openpane/contracts';
import { UiStore } from '../../apps/host/build/tsc/ui-store.js';
import { startUiControl, openUiQuerySession, requestUi } from '../../apps/host/build/tsc/ui-control.js';
import { UiFrames, uiFrame, uiResponse } from '../../apps/host/build/tsc/ui-frames.js';

const scope = { hostId: 'host', conversationId: 'chat' };
const queryInput = { query: 'avg:system.cpu.user{*}', title: 'CPU', from: '1795374000', to: '1795377600', executable: '/fixture/pup', executableHint: 'PATH:pup', version: '2.0.1', site: 'us3.datadoghq.com', siteHint: 'us3.datadoghq.com' };
const event = { type: 'CUSTOM', name: METRICS_EVENT_NAME, value: { schemaVersion: 1, query: queryInput.query, title: queryInput.title, fromMs: 1795374000000, toMs: 1795377600000, fetchedAtMs: 1795377600001, series: [] } };
async function wait(check) { const until = Date.now() + 4000; while (!await check()) { if (Date.now() > until) throw new Error('UI session did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'openpane-display-socket-')), socket = join(directory, 'ui.sock');
  const store = new UiStore(join(directory, 'ui.sqlite'), 'host', undefined, value => value.hostId === scope.hostId && value.conversationId === scope.conversationId);
  const behavior = { after: async () => {} };
  const control = await startUiControl(socket, async (request, session) => { const value = await store.execute(request, session); await behavior.after(request, value); return value; }, { disconnected: owner => store.endUiSession(owner) });
  t.after(async () => { await control.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const id = () => `${store.context().requestEpoch}:${randomUUID()}`;
  return { socket, store, behavior, id, reserve: publicationId => ({ op: 'display-query-reserve', scope, publicationId, input: queryInput }), status: publicationId => requestUi(socket, { op: 'display-status', scope, publicationId }) };
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
