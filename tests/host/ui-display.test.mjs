import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { METRICS_EVENT_NAME, parseMetricsCard } from '@openpane/contracts';
import { UiStore } from '../../apps/host/build/tsc/ui-store.js';
import { parseUiRequest } from '../../apps/host/build/tsc/ui-protocol.js';

const scope = { hostId: 'host', conversationId: 'chat' };
const card = (title = 'CPU') => ({ schemaVersion: 1, title, query: 'avg:system.cpu.user{*}', fromMs: 1795374000000, toMs: 1795377600000, fetchedAtMs: 1795377600001,
  series: [{ label: 'Example', unit: '%', points: [[1795374000000, 1], [1795374020000, null], [1795374040000, 3]] }] });
const event = (value = card()) => ({ type: 'CUSTOM', name: METRICS_EVENT_NAME, value });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'openpane-display-')), path = join(directory, 'ui.sqlite'), members = new Set([JSON.stringify(scope)]);
  const open = () => new UiStore(path, 'host', () => ({ items: [], after: null }), value => members.has(JSON.stringify(value)));
  let store = open(); t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const execute = (request, owner) => store.execute(parseUiRequest(request), owner ? { owner } : undefined);
  return { members, get store() { return store; }, execute, id: () => `${store.context().requestEpoch}:${randomUUID()}`,
    restart() { store.close(); store = open(); }, subscription: (cursor = null, target = scope, subscriptionId = randomUUID()) => ({ scope: target, subscriptionId, cursor }) };
}
const input = () => ({ query: 'avg:system.cpu.user{*}', title: 'CPU', from: '1h', to: 'now', executable: '/fixture/pup', executableHint: 'PATH:pup', version: '1.23.6', site: 'us3.datadoghq.com', siteHint: 'us3.datadoghq.com' });
const queryEvent = reservation => event({ ...card(), query: reservation.query, fromMs: reservation.fromSeconds * 1000, toMs: reservation.toSeconds * 1000 });

test('display publication replay, conflict, removal and restart preserve exactly one scoped event', async t => {
  const f = await fixture(t), publicationId = f.id(), request = { op: 'display-publish', scope, publicationId, event: event() };
  const published = await f.execute(request); assert.equal(published.kind, 'published');
  assert.deepEqual(await f.execute(request), published);
  await assert.rejects(f.execute({ ...request, event: event(card('Changed')) }), /different mode or input/);
  await assert.rejects(f.execute({ op: 'display-query-reserve', scope, publicationId, input: input() }, 'other'), /raw display/);
  const subscription = f.subscription(), first = await f.execute({ op: 'display-list', subscription });
  assert.equal(first.kind, 'snapshot'); assert.equal(first.publications.length, 1); assert.equal(first.publications[0].digest, published.receipt.digest);
  f.restart(); assert.deepEqual(await f.execute(request), published);
  const removal = { op: 'display-remove', scope, publicationId, requestId: f.id() }, removed = await f.execute(removal);
  assert.deepEqual(await f.execute(removal), removed); assert.ok(removed.sequence > published.receipt.sequence);
  assert.equal((await f.execute(request)).kind, 'removed', 'an identical retry never resurrects a removed payload');
  assert.deepEqual((await f.execute({ op: 'display-list', subscription: f.subscription() })).publications, []);
  await assert.rejects(f.execute({ ...removal, publicationId: f.id() }), /different input/);
  const otherScope = { ...scope, conversationId: 'other' }; f.members.add(JSON.stringify(otherScope));
  assert.deepEqual((await f.execute({ op: 'display-list', subscription: f.subscription(null, otherScope) })).publications, []);
  for (const foreign of [{ ...scope, hostId: 'foreign' }, { ...scope, conversationId: 'absent' }]) {
    await assert.rejects(f.execute({ ...request, scope: foreign, publicationId: f.id() }), /another host|unavailable/);
    await assert.rejects(f.execute({ op: 'display-list', subscription: f.subscription(null, foreign) }), /another host|unavailable/);
  }
});

test('query sessions reserve fixed bounds once and fence raw publication, old owners and old attempts', async t => {
  const f = await fixture(t), publicationId = f.id(), request = { op: 'display-query-reserve', scope, publicationId, input: input() };
  const first = await f.execute(request, 'owner-one'); assert.equal(first.granted, true);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 3600000);
  const replay = await f.execute(request, 'owner-two'); assert.equal(replay.granted, false); assert.deepEqual(replay.reservation, first.reservation);
  assert.deepEqual((await f.execute({ op: 'display-list', subscription: f.subscription() })).publications, []);
  await assert.rejects(f.execute({ op: 'display-publish', scope, publicationId, event: event() }), /different mode or input/);
  await assert.rejects(f.execute({ ...request, input: { ...input(), query: 'different' } }, 'owner-two'), /different arguments/);
  const finalize = { op: 'display-query-finalize', scope, publicationId, attempt: 1, event: queryEvent(first.reservation) };
  await assert.rejects(f.execute(finalize, 'owner-two'), /no longer current/);
  f.store.endUiSession('owner-one');
  assert.equal((await f.execute({ op: 'display-status', scope, publicationId })).reservation.kind, 'interrupted');
  await assert.rejects(f.execute({ op: 'display-publish', scope, publicationId, event: event() }), /different mode or input/);
  const second = await f.execute({ op: 'display-query-retry', scope, publicationId, expectedAttempt: 1 }, 'owner-two');
  assert.equal(second.reservation.attempt, 2); assert.deepEqual([second.reservation.fromSeconds, second.reservation.toSeconds], [first.reservation.fromSeconds, first.reservation.toSeconds]);
  await assert.rejects(f.execute(finalize, 'owner-one'), /no longer current/);
  await assert.rejects(f.execute({ ...finalize, attempt: 2, event: event(card('Unreserved title')) }, 'owner-two'), /fixed reservation/);
  const committed = await f.execute({ ...finalize, attempt: 2 }, 'owner-two'); assert.equal(committed.reservation.kind, 'published');
  f.store.endUiSession('owner-two'); f.restart();
  assert.deepEqual((await f.execute(request, 'lost-reply-retry')).reservation, committed.reservation);
  assert.equal((await f.execute({ op: 'display-list', subscription: f.subscription() })).publications.length, 1);
});

test('a restarted or failed query remains explicit and retry uses a compare-and-set generation', async t => {
  const f = await fixture(t), publicationId = f.id(), reserve = { op: 'display-query-reserve', scope, publicationId, input: input() };
  const original = await f.execute(reserve, 'original'); f.restart();
  const interrupted = await f.execute({ op: 'display-status', scope, publicationId }); assert.equal(interrupted.reservation.kind, 'interrupted');
  assert.equal((await f.execute(reserve, 'duplicate')).granted, false);
  await assert.rejects(f.execute({ op: 'display-query-retry', scope, publicationId, expectedAttempt: 2 }, 'new'), /current failed/);
  await assert.rejects(f.execute({ op: 'display-query-retry', scope, publicationId, expectedAttempt: 1 }, 'new'), /draining/);
  t.mock.method(Date, 'now', () => original.executeUntilMs + 2001);
  await f.execute({ op: 'display-query-retry', scope, publicationId, expectedAttempt: 1 }, 'new');
  const failed = await f.execute({ op: 'display-query-fail', scope, publicationId, attempt: 2, reason: 'pup-timeout' }, 'new');
  assert.equal(failed.reservation.kind, 'failed'); assert.equal(failed.reservation.reason, 'pup-timeout');
  await assert.rejects(f.execute({ op: 'display-query-fail', scope, publicationId, attempt: 1, reason: 'cancelled' }, 'original'), /no longer current/);
  assert.deepEqual((await f.execute({ op: 'display-list', subscription: f.subscription() })).publications, []);
});

test('bounded snapshots have a fixed high-water mark and reset after deletion or an unknown cursor', async t => {
  const f = await fixture(t), ids = [];
  for (let n = 0; n < 18; n++) { const publicationId = f.id(); ids.push(publicationId); await f.execute({ op: 'display-publish', scope, publicationId, event: event(card(`Card ${n}`)) }); }
  let subscription = f.subscription(); const first = await f.execute({ op: 'display-list', subscription }); assert.equal(first.publications.length, 8);
  assert.deepEqual(await f.execute({ op: 'display-list', subscription }), first, 'a missed initial page reuses its snapshot');
  await f.execute({ op: 'display-publish', scope, publicationId: f.id(), event: event(card('Arrived during snapshot')) });
  const collected = [...first.publications]; let page = first;
  while (page.next.kind === 'snapshot') { subscription = { ...subscription, cursor: page.next }; page = await f.execute({ op: 'display-list', subscription }); collected.push(...page.publications); }
  assert.equal(collected.length, 18); assert.equal(page.next.sequence, first.highWater);
  const changes = await f.execute({ op: 'display-list', subscription: { ...subscription, cursor: page.next } }); assert.equal(changes.changes.length, 1);
  const next = f.subscription(), partial = await f.execute({ op: 'display-list', subscription: next });
  await f.execute({ op: 'display-remove', scope, publicationId: ids[12], requestId: f.id() });
  assert.equal((await f.execute({ op: 'display-list', subscription: { ...next, cursor: partial.next } })).kind, 'reset');
  assert.equal((await f.execute({ op: 'display-list', subscription: f.subscription({ kind: 'live', epoch: 1, sequence: 1 }) })).kind, 'reset');
  const epoch = f.store.context().requestEpoch, knownId = ids[0];
  await f.execute({ op: 'compact', expectedEpoch: epoch });
  assert.equal((await f.execute({ op: 'display-list', subscription: { ...subscription, cursor: changes.next } })).kind, 'reset');
  assert.equal((await f.execute({ op: 'display-publish', scope, publicationId: knownId, event: event(card('Card 0')) })).kind, 'published');
  await assert.rejects(f.execute({ op: 'display-publish', scope, publicationId: `${epoch}:${randomUUID()}`, event: event() }), /epoch expired/);
});

test('32 cards include live query reservations, and removal frees one slot without evicting saved cards', async t => {
  const f = await fixture(t), ids = [];
  for (let n = 0; n < 31; n++) { const publicationId = f.id(); ids.push(publicationId); await f.execute({ op: 'display-publish', scope, publicationId, event: event() }); }
  const reserved = f.id(); const grant = await f.execute({ op: 'display-query-reserve', scope, publicationId: reserved, input: input() }, 'query');
  await assert.rejects(f.execute({ op: 'display-publish', scope, publicationId: f.id(), event: event() }), /Display capacity/);
  f.store.endUiSession('query');
  t.mock.method(Date, 'now', () => grant.executeUntilMs + 2001);
  await f.execute({ op: 'display-publish', scope, publicationId: f.id(), event: event() });
  await assert.rejects(f.execute({ op: 'display-query-retry', scope, publicationId: reserved, expectedAttempt: 1 }, 'retry'), /Display capacity/);
  await f.execute({ op: 'display-remove', scope, publicationId: ids[0], requestId: f.id() });
  await f.execute({ op: 'display-query-retry', scope, publicationId: reserved, expectedAttempt: 1 }, 'retry');
  f.members.delete(JSON.stringify(scope));
  await assert.rejects(f.execute({ op: 'display-list', subscription: f.subscription() }), /unavailable/);
  assert.equal((await f.execute({ op: 'display-remove', scope, publicationId: ids[1], requestId: f.id() })).kind, 'removed', 'an exact known orphan can release its retained UI payload');
});

test('display pages respect their serialized byte limit and total retained payload capacity', { timeout: 60000 }, async t => {
  const f = await fixture(t), large = card(); large.query = 'q'.repeat(4096);
  large.series = Array.from({ length: 4 }, (_, series) => ({ label: `Series ${series}`, unit: '%', points: Array.from({ length: 400 }, (_, n) => [1795374000000 + n * 20000, Number.MAX_VALUE]) }));
  while (Buffer.byteLength(JSON.stringify(large)) > 65536) large.series.at(-1).points.pop();
  parseMetricsCard(large);
  let firstId, lastScope, published = 0;
  for (let n = 0; n < 1024; n++) {
    const target = { ...scope, conversationId: `scope-${Math.floor(n / 32)}` }; f.members.add(JSON.stringify(target)); const publicationId = f.id();
    try { await f.execute({ op: 'display-publish', scope: target, publicationId, event: event(large) }); published++; firstId ??= publicationId; }
    catch (error) { assert.match(error.message, /Display capacity/); lastScope = target; break; }
  }
  assert.ok(published > 400 && published < 1024, 'the global payload limit is reached before the metadata horizon');
  const firstScope = { ...scope, conversationId: 'scope-0' }, page = await f.execute({ op: 'display-list', subscription: f.subscription(null, firstScope) });
  assert.ok(page.publications.length > 0 && page.publications.length < 8); assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, value: page })) <= 512 * 1024);
  await f.execute({ op: 'display-remove', scope: firstScope, publicationId: firstId, requestId: f.id() });
  await f.execute({ op: 'display-publish', scope: lastScope, publicationId: f.id(), event: event(large) });
});

test('native relay fairly pages eight visible scoped children under one combined budget and preserves visual envelopes', async t => {
  const f = await fixture(t), context = f.store.context();
  const main = { role: 'main', hostId: 'host', profileId: context.profileId, brokerInstance: 'broker', label: 'main', documentIncarnation: 'main', viewId: 'main-view' };
  await f.execute({ op: 'state', context: main, visible: true, presenceSequence: 1, after: null, waitMs: 0 });
  const children = Array.from({ length: 8 }, (_, n) => {
    const scope = { hostId: 'host', conversationId: `relay-${n}` }; f.members.add(JSON.stringify(scope));
    return { context: { ...main, role: 'chat', label: `child-${n}`, documentIncarnation: `child-${n}`, viewId: `view-${n}`, scope }, visible: true, presenceSequence: 1, display: f.subscription(null, scope), placement: null };
  });
  for (const child of children) for (let n = 0; n < 12; n++) await f.execute({ op: 'display-publish', scope: child.context.scope, publicationId: f.id(), event: event(card(`Card ${n}`)) });
  const seen = new Map(children.map(child => [child.context.documentIncarnation, new Set()]));
  children[7].visible = false;
  for (let turn = 0; turn < 40 && [...seen.values()].some((ids, n) => n < 7 && ids.size !== 12); turn++) {
    const response = await f.execute({ op: 'relay', main, children, departed: [] });
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, value: response })) <= 512 * 1024);
    let count = 0;
    for (const reply of response.children) {
      assert.equal(reply.envelope, null);
      const child = children.find(child => child.context.documentIncarnation === reply.incarnation); child.presenceSequence++;
      if (!reply.display) continue;
      assert.equal(reply.display.kind, 'page'); const page = reply.display.page;
      assert.deepEqual(page.scope, child.context.scope);
      if (page.kind === 'snapshot') { for (const publication of page.publications) seen.get(reply.incarnation).add(publication.publicationId); count += page.publications.length; child.display = { ...child.display, cursor: page.next }; }
      else if (page.kind === 'changes') { count += page.changes.length; child.display = { ...child.display, cursor: page.next }; }
    }
    assert.ok(count <= 8);
  }
  for (const [id, cards] of seen) assert.equal(cards.size, id === 'child-7' ? 0 : 12);
  children[7].visible = true;
  for (let n = 0; n < 8 && seen.get('child-7').size < 12; n++) {
    for (const child of children) child.presenceSequence++;
    const response = await f.execute({ op: 'relay', main, children, departed: [] }), reply = response.children[7];
    if (reply.display?.kind === 'page' && reply.display.page.kind === 'snapshot') {
      for (const publication of reply.display.page.publications) seen.get('child-7').add(publication.publicationId);
      children[7].display = { ...children[7].display, cursor: reply.display.page.next };
    }
  }
  assert.equal(seen.get('child-7').size, 12);
  assert.throws(() => f.execute({ op: 'relay', main, children: [{ ...children[0], display: children[1].display }], departed: [] }), /Foreign relay display/);
});

test('a fresh cursorless read advances completed snapshots without leaking subscription capacity', async t => {
  const f = await fixture(t), subscription = f.subscription(null, scope, 'repeated-cli-reader');
  assert.equal((await f.execute({ op: 'display-list', subscription })).publications.length, 0);
  const publicationId = f.id(); await f.execute({ op: 'display-publish', scope, publicationId, event: event() });
  for (let i = 0; i < 140; i++) {
    const page = await f.execute({ op: 'display-list', subscription });
    assert.deepEqual(page.publications.map(p => p.publicationId), [publicationId]);
    assert.equal(page.next.kind, 'live');
  }
});

test('active cards remain removable at the shared metadata limit after repeated compaction', { timeout: 60000 }, async t => {
  const f = await fixture(t); let published = 0, first;
  for (let cycle = 0; cycle < 20; cycle++) {
    let added = 0;
    for (;;) {
      const target = { ...scope, conversationId: `metadata-${Math.floor(published / 32)}` }; f.members.add(JSON.stringify(target));
      const publicationId = f.id();
      try { await f.execute({ op: 'display-publish', scope: target, publicationId, event: event() }); }
      catch (error) { assert.match(error.message, /capacity/i); break; }
      first ??= { scope: target, publicationId }; published++; added++;
    }
    if (!added) break;
    await f.execute({ op: 'compact', expectedEpoch: f.store.context().requestEpoch });
  }
  assert.ok(published > 1000, 'the fixture must saturate metadata across many scopes');
  const removed = await f.execute({ op: 'display-remove', ...first, requestId: f.id() });
  assert.equal(removed.kind, 'removed');
  await f.execute({ op: 'compact', expectedEpoch: f.store.context().requestEpoch });
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM ui_display_cards').get().count, published - 1);
  await f.execute({ op: 'display-publish', scope: first.scope, publicationId: f.id(), event: event() });
});

test('compaction retains interrupted query attempts until explicit removal abandons them', async t => {
  const f = await fixture(t), publicationId = f.id(), request = { op: 'display-query-reserve', scope, publicationId, input: input() };
  const initial = await f.execute(request, 'first-owner'); f.store.endUiSession('first-owner');
  await f.execute({ op: 'compact', expectedEpoch: f.store.context().requestEpoch });
  const status = await f.execute({ op: 'display-status', scope, publicationId });
  assert.equal(status.reservation.kind, 'interrupted'); assert.equal(status.reservation.attempt, 1);
  await assert.rejects(f.execute({ op: 'display-query-retry', scope, publicationId, expectedAttempt: 1 }, 'retry-owner'), /draining/);
  t.mock.method(Date, 'now', () => initial.executeUntilMs + 2001);
  const retry = await f.execute({ op: 'display-query-retry', scope, publicationId, expectedAttempt: 1 }, 'retry-owner');
  assert.deepEqual([retry.reservation.fromSeconds, retry.reservation.toSeconds], [initial.reservation.fromSeconds, initial.reservation.toSeconds]);
  f.store.endUiSession('retry-owner');
  const requestId = f.id(), removed = await f.execute({ op: 'display-remove', scope, publicationId, requestId });
  assert.equal(removed.kind, 'removed'); assert.deepEqual(await f.execute({ op: 'display-remove', scope, publicationId, requestId }), removed);
  assert.equal((await f.execute({ op: 'display-status', scope, publicationId })).reservation.kind, 'abandoned');
  assert.deepEqual((await f.execute({ op: 'display-list', subscription: f.subscription() })).publications, []);
  await f.execute({ op: 'compact', expectedEpoch: f.store.context().requestEpoch });
  assert.equal((await f.execute({ op: 'display-status', scope, publicationId })).mode, 'missing');
  await assert.rejects(f.execute(request, 'new-owner'), /epoch expired/);
});
