import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDisplayPage, parseDisplaySubscription, parseDisplayPublication, METRICS_EVENT_NAME } from '@openpane/contracts';

const scope = { hostId: 'host', conversationId: 'chat' };
const publication = sequence => ({ scope, publicationId: `publication-${sequence}`, sequence, publishedAtMs: 1795374062000, digest: 'a'.repeat(64),
  event: { type: 'CUSTOM', name: METRICS_EVENT_NAME, value: { schemaVersion: 1, title: 'CPU', query: 'avg:system.cpu.user{*}', fromMs: 1795374001000, toMs: 1795374061000, fetchedAtMs: 1795374062000,
    series: [{ label: 'CPU', unit: '%', points: [[1795374000000, 1.25], [1795374020000, null]] }] } } });
const live = sequence => ({ kind: 'live', epoch: 1, sequence });
const identity = { scope, subscriptionId: 'document-subscription', from: null };

test('display publications are named application CUSTOM events with explicit scope and host sequence', () => {
  assert.deepEqual(parseDisplayPublication(publication(1)), publication(1));
  for (const mutate of [value => value.sequence = 0, value => value.digest = 'bad', value => value.event.name = 'provider.observation', value => value.event.type = 'TEXT_MESSAGE_CONTENT', value => value.event.rawEvent = {}, value => value.event.value.schemaVersion = 2]) {
    const value = publication(1); mutate(value); assert.throws(() => parseDisplayPublication(value));
  }
});
test('display subscriptions and snapshot continuations carry their own scope and generation', () => {
  assert.deepEqual(parseDisplaySubscription({ scope, subscriptionId: 'one', cursor: null }), { scope, subscriptionId: 'one', cursor: null });
  const first = { ...identity, kind: 'snapshot', snapshotId: 'snapshot', highWater: 10, publications: [publication(2)], next: { kind: 'snapshot', snapshotId: 'snapshot', highWater: 10, after: 2 } };
  assert.deepEqual(parseDisplayPage(first), first);
  const last = { ...first, from: first.next, publications: [publication(4)], next: live(10) };
  assert.deepEqual(parseDisplayPage(last), last);
  assert.deepEqual(parseDisplayPage({ ...identity, kind: 'reset', from: live(0) }), { ...identity, kind: 'reset', from: live(0) });
  for (const mutate of [value => value.publications[0].scope = { ...scope, conversationId: 'other' }, value => value.next.after = 1, value => value.next.snapshotId = 'different', value => value.publications = [], value => value.publications.push(publication(2))]) {
    const value = structuredClone(first); mutate(value); assert.throws(() => parseDisplayPage(value));
  }
});
test('display changes preserve ordered publications and deletion sequences without accepting a foreign scope', () => {
  const page = { ...identity, kind: 'changes', highWater: 20, from: live(2), changes: [{ kind: 'published', publication: publication(4) }, { kind: 'removed', publicationId: 'publication-4', sequence: 5 }], next: live(7) };
  assert.deepEqual(parseDisplayPage(page), page);
  for (const mutate of [value => value.from = null, value => value.next.epoch = 2, value => value.next.sequence = 4, value => value.changes.reverse(), value => value.changes[0].publication.scope = { ...scope, hostId: 'other' }]) {
    const value = structuredClone(page); mutate(value); assert.throws(() => parseDisplayPage(value));
  }
  assert.throws(() => parseDisplayPage({ ...page, changes: Array.from({ length: 9 }, (_, n) => ({ kind: 'published', publication: publication(n + 3) })), next: live(20) }));
});
