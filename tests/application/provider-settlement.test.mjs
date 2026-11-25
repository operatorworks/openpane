import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderRegistry } from '@openpane/host';
import { transcriptProjection } from '@openpane/contracts/conversation';
import { fixture as hostFixture, scope as hostScope } from '../host/fixture.mjs';
import { providerService, fixture, saved, send } from './provider-stream-fixture.mjs';
import { until } from '../host/fixture.mjs';

const receiptKind = f => JSON.parse(saved(f).commands.find(row => row.id === 'send').receipt).state.kind;
const ended = f => JSON.parse(saved(f).conversation.document).domain.currentRun?.kind === 'ended';
const sendLookups = remote => remote.requests.filter(request => request.path === '/lookup' && request.input.kind === 'send');

async function streaming(t, lookupState) {
  const remote = await providerService(t), a = remote.extension({ controls: true });
  const f = await fixture(t, [a]), scope = await f.create();
  await until(() => a.calls.ready === 1);
  const run = binding => remote.ref(binding, 'run', 'same-run');
  remote.command((operation, path) => ({ kind: 'confirmed', evidence: null,
    value: { kind: 'send', state: path === '/lookup' ? lookupState() : 'accepted', run: run(operation.binding) } }));
  assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'accepted');
  const binding = remote.conversations.get('chat').snapshot.binding;
  const started = remote.emit(remote.makeEvent(binding, 'Partial', 1));
  await until(() => a.calls.ack.some(item => item.eventId === started.eventId));
  return { remote, a, f, scope, binding };
}

// Direct callers reach the sharing decision before returning their promise; HTTP delivery is not a synchronization fence.
async function directStreaming(t, assertAuthorized = () => {}) {
  const remote = await providerService(t), a = remote.extension({ controls: true });
  const registry = createProviderRegistry([{ ...a.value, authority: {
    credentials: { use: async (_input, action) => action('STREAM_PRIVATE_SECRET') },
    issue: () => ({ credential: null, expectedAuthority: 'remote-provider', assertAuthorized }), async close() {},
  } }]);
  await registry.activate();
  const f = hostFixture(t), host = f.open({ providers: registry, projection: transcriptProjection });
  const close = async () => { host.close(); await host.drained; await registry.close(); };
  try {
    const [discovered] = await registry.discover();
    const target = { kind: 'provider', contributionId: discovered.contributionId, instance: discovered.instance, agent: discovered.agents[0], presentationVersion: 1, expectedAuthority: discovered.expectedAuthority };
    await host.createProviderConversation(hostScope, target, registry);
    await host.observeProvider(hostScope);
    await until(() => a.calls.ready === 1);
    remote.command((operation, path) => ({ kind: 'confirmed', evidence: null,
      value: { kind: 'send', state: path === '/lookup' ? 'completed' : 'accepted', run: remote.ref(operation.binding, 'run', 'same-run') } }));
    await host.conversation(hostScope).submit(send(hostScope));
    const binding = remote.conversations.get(hostScope.conversationId).snapshot.binding;
    const started = remote.emit(remote.makeEvent(binding, 'Partial', 1));
    await until(() => a.calls.ack.some(item => item.eventId === started.eventId));
    return { remote, a, registry, host, binding, scope: hostScope, close };
  } catch (error) { await close(); throw error; }
}

test('an observed run end performs one admitted status read, and a later run end for the same run does not read again', async t => {
  const { remote, a, f, scope, binding } = await streaming(t, () => 'accepted');
  const final = remote.emit(remote.makeEvent(binding, 'Done', 2, true));
  await until(() => a.calls.ack.some(item => item.eventId === final.eventId));
  await until(() => sendLookups(remote).length === 1);
  assert.equal(receiptKind(f), 'accepted');
  const snapshot = structuredClone(remote.conversations.get('chat').snapshot);
  snapshot.cursor = remote.cursor(binding);
  remote.emit({ kind: 'snapshot', snapshot });
  await until(() => a.calls.ack.some(item => item.kind === 'snapshot' && item.snapshot.cursor.opaque.token === snapshot.cursor.opaque.token));
  assert(ended(f));
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, 'accepted');
  assert.equal(sendLookups(remote).length, 2);
  assert.equal(receiptKind(f), 'accepted');
});

test('an inconclusive run-end read is read again after observation goes live on restart', async t => {
  let reads = 0;
  const { remote, a, f, binding } = await streaming(t, () => ++reads === 1 ? 'accepted' : 'completed');
  const final = remote.emit(remote.makeEvent(binding, 'Done', 2, true));
  await until(() => a.calls.ack.some(item => item.eventId === final.eventId));
  await until(() => sendLookups(remote).length === 1);
  assert.equal(receiptKind(f), 'accepted');
  await f.restart([remote.extension({ controls: true })]);
  await until(() => receiptKind(f) === 'completed');
  assert.equal(sendLookups(remote).length, 2);
});

test('a reconcile that overlaps a run-end read joins it and makes one status read', { timeout: 10000 }, async t => {
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const { remote, a, host, scope, binding, close } = await directStreaming(t);
  try {
    remote.command(async (operation, path) => {
      if (path === '/lookup') await gate.promise;
      return { kind: 'confirmed', evidence: null, value: { kind: 'send', state: 'accepted', run: remote.ref(operation.binding, 'run', 'same-run') } };
    });
    const final = remote.emit(remote.makeEvent(binding, 'Done', 2, true));
    await until(() => a.calls.ack.some(item => item.eventId === final.eventId));
    await until(() => sendLookups(remote).length === 1);
    const reconciled = host.reconcile(scope, 'send');
    gate.resolve();
    assert.equal((await reconciled).state.kind, 'accepted');
    assert.equal(sendLookups(remote).length, 1);
    assert.equal((await host.reconcile(scope, 'send')).state.kind, 'accepted');
    assert.equal(sendLookups(remote).length, 2);
  } finally { gate.resolve(); await close(); }
});

test('a run that ends during submit is read once the reply is stored', async t => {
  const remote = await providerService(t), a = remote.extension({ controls: true });
  const f = await fixture(t, [a]), scope = await f.create();
  await until(() => a.calls.ready === 1);
  remote.command(async (operation, path) => {
    const run = remote.ref(operation.binding, 'run', 'same-run');
    if (path === '/lookup') return { kind: 'confirmed', evidence: null, value: { kind: 'send', state: 'completed', run } };
    const final = remote.emit(remote.makeEvent(operation.binding, 'Done', 1, true));
    await until(() => a.calls.ack.some(item => item.eventId === final.eventId));
    return { kind: 'confirmed', evidence: null, value: { kind: 'send', state: 'accepted', run } };
  });
  assert(!ended(f));
  assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'accepted');
  assert(ended(f));
  await until(() => receiptKind(f) === 'completed');
  assert.equal(sendLookups(remote).length, 1);
});

test('a run end committed while the provider is replaced is read once the replacement observes, not skipped', async t => {
  const { remote, a, f, binding } = await streaming(t, () => 'completed');
  const final = remote.makeEvent(binding, 'Done', 2, true);
  // Record the run end remotely without streaming it, then hand it to the old observer as replacement begins.
  const listeners = [...remote.clients]; remote.clients.clear();
  remote.emit(final);
  for (const client of listeners) remote.clients.add(client);
  const b = remote.extension({ controls: true });
  const committed = a.calls.receive(final);
  const replaced = f.running.replaceProviderExtensions([b.value]);
  await committed;
  assert(ended(f));
  assert.equal((await replaced).kind, 'replaced');
  await until(() => receiptKind(f) === 'completed');
  assert.equal(sendLookups(remote).length, 1);
  const evidence = JSON.parse(saved(f).commands.find(row => row.id === 'send').observation).evidence.source;
  assert.equal(evidence.source, 'provider-lookup');
});


test('a final authorization refusal does not spend the run-end status read', { timeout: 10000 }, async t => {
  let denyNext = false;
  const denied = Promise.withResolvers();
  const { remote, a, registry, host, binding, scope, close } = await directStreaming(t, () => {
    if (denyNext) { denyNext = false; denied.resolve(); throw new Error('Fixture credential changed'); }
  });
  try {
    const execute = registry.executeCommand;
    let reads = 0;
    registry.executeCommand = (capture, fresh, beforeEffect, onEnter) => execute(capture, fresh, () => {
      beforeEffect();
      if (!fresh && ++reads === 1) denyNext = true;
    }, onEnter);
    const final = remote.emit(remote.makeEvent(binding, 'Done', 2, true));
    await until(() => a.calls.ack.some(item => item.eventId === final.eventId));
    await denied.promise;
    await new Promise(setImmediate);
    assert.equal(sendLookups(remote).length, 0, 'final authorization prevents provider entry');
    const next = structuredClone(remote.conversations.get(scope.conversationId).snapshot);
    next.cursor = remote.cursor(binding);
    remote.emit({ kind: 'snapshot', snapshot: next });
    await until(() => a.calls.ack.some(item => item.kind === 'snapshot' && item.snapshot.cursor.opaque.token === next.cursor.opaque.token));
    await until(() => sendLookups(remote).length === 1);
    assert.equal((await host.reconcile(scope, 'send')).state.kind, 'completed');
    assert.equal(sendLookups(remote).length, 1);
    assert.equal(reads, 2, 'the refused read leaves exactly one admitted retry available');
  } finally { await close(); }
});
