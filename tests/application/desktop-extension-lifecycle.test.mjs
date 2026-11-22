import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopExtensionLifecycle } from '../../apps/desktop/dist/application/desktop-extension-lifecycle.js';
import { createGenerationSource } from '../../apps/desktop/dist/application/frontend-sends.js';
import { pinFrontendTools, retainFrontendTools } from '@openpane/sdk/tools';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
const manifest = namespace => ({ namespace, trust: 'full', sdkVersion: '0.13.0', entries: [{ kind: 'desktop', module: './entry.js' }] });
function fixture(namespace, activate) {
  return { manifest: manifest(namespace), async load() { return { default: { sdkVersion: '0.13.0', kind: 'desktop', activate } }; } };
}
const run = { conversation: { hostId: 'host', conversationId: 'conversation' }, runId: 'run', authority: { kind: 'remote-provider', binding: { namespace: 'provider', installationId: 'i', opaqueSessionId: 's' } } };

test('selective loading and subscriber replay preserve healthy generation, ready admission and sink token', async () => {
  const owner = new DesktopExtensionLifecycle(), source = createGenerationSource();
  let begins = 0, activations = 0, disposals = 0;
  const sink = { begin(token) { begins++; source.begin(token); }, publish: source.publish, clear: source.clear };
  const a = fixture('alpha', () => { activations++; return { modules: [], dispose() { disposals++; } }; });
  owner.attach(sink); owner.reconcile([a]); await tick();
  assert.equal(owner.getSnapshot()[0].kind, 'ready');
  const generation = source.snapshot().generations[0];
  const loading = deferred(); const b = fixture('beta', () => loading.promise);
  owner.reconcile([a, b]); await tick();
  assert.equal(source.snapshot().kind, 'ready'); assert.equal(source.snapshot().generations[0], generation);
  const unsubscribe = owner.subscribe(() => {}); unsubscribe(); owner.attach(sink); owner.reconcile([a, b]);
  assert.equal(begins, 1); assert.equal(activations, 1); assert.equal(disposals, 0);
  loading.resolve({ modules: [], dispose() {} }); await tick();
  owner.reconcile([a]); await tick();
  assert.equal(source.snapshot().generations[0], generation);
  await owner.close(); assert.equal(disposals, 1);
});

test('reenable waits for unresolved activation and its late retirement, without overlapping activations', async () => {
  const owner = new DesktopExtensionLifecycle(), activation = deferred(), cleanup = deferred();
  let calls = 0, disposals = 0;
  const a = fixture('alpha', () => { calls++; return calls === 1 ? activation.promise : { modules: [], dispose() { disposals++; } }; });
  owner.reconcile([a]); await tick(); owner.reconcile([]); owner.reconcile([a]); await tick(); assert.equal(calls, 1);
  activation.resolve({ modules: [], dispose() { disposals++; return cleanup.promise; } }); await tick();
  assert.equal(calls, 1); assert.equal(disposals, 1); assert.equal(owner.getSnapshot()[0].kind, 'loading');
  cleanup.resolve(); await tick(); assert.equal(calls, 2); assert.equal(owner.getSnapshot()[0].kind, 'ready');
  await owner.close(); assert.equal(disposals, 2);
});

test('late cleanup rejection remains visible and prevents restart after subscription replay', async () => {
  const owner = new DesktopExtensionLifecycle(), activation = deferred(); let calls = 0;
  const a = fixture('alpha', () => { calls++; return activation.promise; });
  owner.reconcile([a]); await tick(); owner.reconcile([]); owner.reconcile([a]);
  activation.resolve({ modules: [], dispose() { throw new Error('cleanup failed'); } }); await tick(); await tick();
  assert.equal(owner.getSnapshot()[0].kind, 'failed'); assert.match(owner.getSnapshot()[0].message, /Restart/);
  const unsub = owner.subscribe(() => {}); unsub(); owner.reconcile([]); owner.reconcile([a]); await tick(); assert.equal(calls, 1);
  await owner.close();
});

test('withdrawn namespace cannot serve new pins while an existing tool binding drains before disposal', async () => {
  const owner = new DesktopExtensionLifecycle(), source = createGenerationSource(); let disposals = 0;
  const a = fixture('alpha', ({ frontendTools }) => {
    frontendTools.add({ definition: { name: 'echo', description: 'Echo' }, decodeInput: x => x, async execute() { return 'original'; } });
    return { modules: [], dispose() { disposals++; } };
  });
  owner.attach(source); owner.reconcile([a]); await tick();
  const pin = pinFrontendTools({ generations: source.snapshot().generations, platform: 'desktop', run, capabilities: { tools: { clientProvided: true } } });
  const savedGeneration = source.snapshot().generations[0];
  owner.reconcile([]);
  assert.throws(() => retainFrontendTools({ generations: [savedGeneration], platform: 'desktop' }), /retired/, 'withdrawal closes fresh retention in the same turn');
  await tick(); assert.deepEqual(source.snapshot().generations, []); assert.equal(disposals, 0);
  assert.deepEqual(await pin.invoke('alpha__echo', {}, pin.bindings[0].activationId), { kind: 'completed', output: 'original' });
  pin.release(); await tick(); assert.equal(disposals, 1); await owner.close();
});

test('a render-failed retired generation can be disabled and reenabled after cleanup already settled', async () => {
  const owner = new DesktopExtensionLifecycle(); let calls = 0;
  const a = fixture('alpha', () => { calls++; return { modules: [], dispose() {} }; });
  owner.reconcile([a]); await tick(); owner.getSnapshot()[0].fail(new Error('render')); await tick();
  assert.equal(owner.getSnapshot()[0].kind, 'failed');
  owner.reconcile([]); await tick(); owner.reconcile([a]); await tick();
  assert.equal(calls, 2); assert.equal(owner.getSnapshot()[0].kind, 'ready'); await owner.close();
});

for (const phase of ['load', 'activation', 'presentation']) test(`producer AggregateError during ${phase} remains retryable without a cleanup failure`, async () => {
  const owner = new DesktopExtensionLifecycle(); let attempts = 0;
  const failure = () => { attempts++; throw new AggregateError([new Error('producer failure')], 'ordinary activation problem'); };
  const a = phase === 'load' ? { manifest: manifest('alpha'), load: failure } : fixture('alpha', phase === 'activation' ? failure : () => {
    attempts++; return { get modules() { throw new AggregateError([], 'producer presentation failed'); }, dispose() {} };
  });
  owner.reconcile([a]); await tick();
  assert.equal(owner.getSnapshot()[0].kind, 'failed');
  owner.reconcile([]); await tick(); owner.reconcile([a]); await tick();
  assert.equal(attempts, 2, 'an author AggregateError alone does not require a process restart');
  await owner.close();
});

test('presentation failure with rejected acquired cleanup remains unavailable after reenable', async () => {
  const owner = new DesktopExtensionLifecycle(); let attempts = 0, disposals = 0;
  const a = fixture('alpha', () => {
    attempts++;
    return { get modules() { throw new Error('presentation failed'); }, dispose() { disposals++; throw new Error('cleanup rejected'); } };
  });
  owner.reconcile([a]); await tick();
  assert.equal(owner.getSnapshot()[0].kind, 'failed');
  owner.reconcile([]); await tick(); owner.reconcile([a]); await tick();
  assert.equal(attempts, 1); assert.equal(disposals, 1); assert.match(owner.getSnapshot()[0].message, /Restart/);
  await owner.close();
});
