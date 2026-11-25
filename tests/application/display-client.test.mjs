import assert from 'node:assert/strict';
import test from 'node:test';
import { DisplayClient } from '../../apps/desktop/dist/application/display-client.js';

const a = { hostId: 'host', conversationId: 'A' }, b = { ...a, conversationId: 'B' };
const publication = (scope, n) => ({ scope, publicationId: `pub-${n}`, sequence: n, publishedAtMs: n, digest: 'a'.repeat(64),
  event: { type: 'CUSTOM', name: 'openpane.datadog.metrics.v1', value: { schemaVersion: 1, title: 'CPU', query: 'metric', fromMs: 0, toMs: 1000, fetchedAtMs: 1000, series: [] } } });
const snapshot = (subscription, publications, next, snapshotId = 'snapshot', highWater = 20) => ({ kind: 'page', page: { kind: 'snapshot', scope: subscription.scope, subscriptionId: subscription.subscriptionId, from: subscription.cursor, snapshotId, highWater, publications, next } });
const live = sequence => ({ kind: 'live', epoch: 1, sequence });
const changes = (subscription, values, sequence) => ({ kind: 'page', page: { kind: 'changes', highWater: sequence, scope: subscription.scope, subscriptionId: subscription.subscriptionId, from: subscription.cursor, changes: values, next: live(sequence) } });

test('a delayed A response cannot enter B, or a newer subscription to A', () => {
  const client = new DisplayClient(); client.profile('profile', 'host'); client.select(a);
  const old = client.subscription(), reply = snapshot(old, [publication(a, 1)], live(20));
  client.select(b); assert.equal(client.accept(reply), false); assert.deepEqual(client.getSnapshot().publications, []);
  client.select(a); assert.notEqual(client.subscription().subscriptionId, old.subscriptionId);
  assert.equal(client.accept(reply), false); assert.deepEqual(client.getSnapshot().publications, []);
  const current = client.subscription(); assert.equal(client.accept(snapshot(current, [publication(a, 1)], live(20))), true);
  assert.equal(client.getSnapshot().publications[0].scope.conversationId, 'A');
});
test('snapshot paging stages a fixed high-water image before later publications and removals', () => {
  const client = new DisplayClient(); client.profile('profile', 'host'); client.select(a);
  const first = client.subscription(), one = publication(a, 1), two = publication(a, 2), next = { kind: 'snapshot', snapshotId: 'snapshot', highWater: 20, after: 1 };
  client.accept(snapshot(first, [one], next)); assert.equal(client.getSnapshot().kind, 'loading'); assert.deepEqual(client.getSnapshot().publications, []);
  const second = client.subscription(); client.accept(snapshot(second, [two], live(20)));
  assert.equal(client.getSnapshot().kind, 'ready'); assert.deepEqual(client.getSnapshot().publications, [one, two]);
  assert.equal(client.accept(snapshot(first, [one], next)), false, 'an old cached page does not replay after the cursor advances');
  client.accept(changes(client.subscription(), [{ kind: 'published', publication: publication(a, 21) }, { kind: 'removed', publicationId: 'pub-1', sequence: 22 }], 22));
  assert.deepEqual(client.getSnapshot().publications.map(publication => publication.publicationId), ['pub-2', 'pub-21']);
});
test('reset and temporary data failure retain the last complete cards and snapshot refresh preserves their identities', () => {
  const client = new DisplayClient(); client.profile('profile', 'host'); client.select(a); const one = publication(a, 1);
  client.accept(snapshot(client.subscription(), [one], live(20))); const shown = client.getSnapshot().publications[0];
  const current = client.subscription(); client.accept({ kind: 'unavailable', scope: a, subscriptionId: current.subscriptionId, from: current.cursor, reason: 'Storage unavailable' });
  assert.equal(client.getSnapshot().kind, 'unavailable'); assert.equal(client.getSnapshot().publications[0], shown); assert.equal(client.needsPaging(), false);
  client.accept({ kind: 'page', page: { kind: 'reset', scope: a, subscriptionId: current.subscriptionId, from: current.cursor } });
  assert.equal(client.getSnapshot().kind, 'loading'); assert.equal(client.subscription().cursor, null); assert.equal(client.getSnapshot().publications[0], shown);
  client.accept(snapshot(client.subscription(), [structuredClone(one)], live(20), 'replacement'));
  assert.equal(client.getSnapshot().publications[0], shown);
  const ready = client.getSnapshot(); client.accept(changes(client.subscription(), [], 20)); assert.equal(client.getSnapshot(), ready, 'an idle page does not recreate cards');
});
test('profile changes drop old staged data and scope objects cannot mutate an in-flight subscription', () => {
  const client = new DisplayClient(), selected = { ...a }; client.profile('profile', 'host'); client.select(selected);
  const previous = client.subscription(); selected.conversationId = 'B'; assert.equal(previous.scope.conversationId, 'A');
  const reply = snapshot(previous, [publication(a, 1)], live(20)); client.profile('replacement-profile', 'host');
  assert.notEqual(client.subscription().subscriptionId, previous.subscriptionId); assert.equal(client.accept(reply), false); assert.deepEqual(client.getSnapshot().publications, []);
  client.profile('other-profile', 'other-host'); assert.equal(client.subscription(), null); assert.equal(client.getSnapshot().kind, 'unavailable');
});

for (const samePage of [false, true]) test(`removed card identity remains immutable across changes (same page ${samePage})`, () => {
  const client = new DisplayClient(); client.profile('profile', 'host'); client.select(a); const original = publication(a, 1);
  client.accept(snapshot(client.subscription(), [original], live(20)));
  const removal = { kind: 'removed', publicationId: original.publicationId, sequence: 21 }, changed = { kind: 'published', publication: { ...original, sequence: 22, digest: 'b'.repeat(64) } };
  if (samePage) client.accept(changes(client.subscription(), [removal, changed], 22));
  else { client.accept(changes(client.subscription(), [removal], 21)); client.accept(changes(client.subscription(), [changed], 22)); }
  assert.equal(client.getSnapshot().kind, 'unavailable');
  assert.equal(client.subscription().cursor.sequence, samePage ? 20 : 21);
  assert.deepEqual(client.getSnapshot().publications, samePage ? [original] : []);
});


test('successful display compaction retires old identity history without exhausting an open reader', () => {
  const client = new DisplayClient(); client.profile('profile', 'host'); client.select(a); let sequence = 0;
  client.accept(snapshot(client.subscription(), [], { kind: 'live', epoch: 1, sequence }, 'first', sequence));
  for (let epoch = 1; epoch <= 9; epoch++) {
    for (let n = 0; n < 512; n++) {
      const card = publication(a, ++sequence);
      const published = changes(client.subscription(), [{ kind: 'published', publication: card }], sequence); published.page.next.epoch = epoch; client.accept(published);
      assert.equal(client.getSnapshot().kind, 'ready');
      const removed = changes(client.subscription(), [{ kind: 'removed', publicationId: card.publicationId, sequence: ++sequence }], sequence); removed.page.next.epoch = epoch; client.accept(removed);
    }
    const current = client.subscription(); client.accept({ kind: 'page', page: { kind: 'reset', scope: a, subscriptionId: current.subscriptionId, from: current.cursor } });
    client.accept(snapshot(client.subscription(), [], { kind: 'live', epoch: epoch + 1, sequence }, `epoch-${epoch + 1}`, sequence));
    assert.equal(client.getSnapshot().kind, 'ready'); assert.deepEqual(client.getSnapshot().publications, []);
  }
});
