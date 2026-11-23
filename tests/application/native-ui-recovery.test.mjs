import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UiStore } from '../../apps/host/build/tsc/ui-store.js';
import { createExperienceBundle } from '../../apps/host/build/tsc/experience-bundle.js';
import { MainUiConnection } from '../../apps/desktop/dist/application/window-runtime.js';
import { UI_RECOVERY_KEY } from '../../apps/desktop/dist/application/ui-recovery.js';
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'native-ui-recovery-')), store = new UiStore(join(directory, 'ui.sqlite'), 'host');
  const previousFetch = globalThis.fetch, previousStorage = globalThis.localStorage, saved = new Map();
  globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  let transport = (_request, run) => run(), confirm = async () => {}, sequence = 0, pending = false;
  const confirmations = [], requests = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    return transport(request, async () => Response.json({ ok: true, value: await store.execute(request) }));
  };
  const ui = new MainUiConnection({ context: { liveRelay: true, brokerInstance: 'broker' }, async request(command) {
    if (command.kind === 'restore-builtin') { pending = true; return { sequence: ++sequence }; }
    if (command.kind === 'confirm-recovery') {
      confirmations.push({ sequence: command.sequence, selected: store.context().selection.selected.kind });
      if (sequence === command.sequence) pending = false;
      await confirm(command.sequence); return {};
    }
    throw new Error(command.kind);
  } });
  t.after(async () => { ui.close(); globalThis.fetch = previousFetch; globalThis.localStorage = previousStorage; store.close(); await rm(directory, { recursive: true, force: true }); });
  return { ui, store, confirmations, requests, pending: () => pending, cached: () => JSON.parse(saved.get(UI_RECOVERY_KEY) ?? 'null'),
    transport: fn => { transport = fn; }, confirm: fn => { confirm = fn; }, async apply() {
      const bundle = createExperienceBundle({ schemaVersion: 2, id: 'new-selection', label: 'New selection', theme: { density: 'comfortable', mode: 'system', light: {}, dark: {} }, presentation: { home: { kind: 'stack', panes: ['conversations', 'conversation'] }, transcript: 'bubbles', navigation: 'rail', chats: 'inline', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, stylesheet: null, assets: [] }, null, []);
      await store.execute({ op: 'apply', requestId: `1:${randomUUID()}`, expectedRevision: store.context().revision, bundle });
    } };
}

test('a newer native restore gets its own reservation after an earlier commit loses its reply', async t => {
  const f = await fixture(t), committed = gate(), loseReply = gate(); let held = false;
  t.after(() => loseReply.resolve());
  f.transport(async (request, run) => {
    const response = await run();
    if (request.op === 'restore' && !held) { held = true; committed.resolve(); await loseReply.promise; throw new Error('Committed restore reply lost'); }
    return response;
  });
  const first = f.ui.restore(); await committed.promise; await f.apply(); const second = f.ui.restore(); loseReply.resolve(); await Promise.all([first, second]);
  assert.equal(f.store.context().selection.selected.kind, 'builtin'); assert.equal(f.store.context().revision, 3); assert.equal(f.pending(), false);
  assert.equal(new Set(f.requests.filter(request => request.op === 'restore').map(request => request.requestId)).size, 2);
  assert.ok(f.confirmations.some(row => row.sequence === 2 && row.selected === 'builtin'));
});

test('a delayed earlier native confirmation cannot erase the next persisted reservation', async t => {
  const f = await fixture(t), firstConfirm = gate(), duplicateConfirm = gate(), releaseFirst = gate(), releaseDuplicate = gate(), nextStarted = gate(), releaseNext = gate();
  let confirms = 0, firstId;
  t.after(() => { releaseFirst.resolve(); releaseDuplicate.resolve(); releaseNext.resolve(); });
  f.confirm(async sequence => { if (sequence !== 1) return; confirms++; if (confirms === 1) { firstConfirm.resolve(); await releaseFirst.promise; } else { duplicateConfirm.resolve(); await releaseDuplicate.promise; } });
  f.transport(async (request, run) => {
    if (request.op === 'restore') { firstId ??= request.requestId; if (request.requestId !== firstId) { nextStarted.resolve(); await releaseNext.promise; } }
    return run();
  });
  const first = f.ui.restore(); await firstConfirm.promise; const duplicate = f.ui.finishRecovery(); await duplicateConfirm.promise;
  releaseFirst.resolve(); await first; const next = f.ui.restore(); await nextStarted.promise;
  const pendingRequest = f.cached(); assert.ok(pendingRequest); releaseDuplicate.resolve(); await duplicate;
  assert.deepEqual(f.cached(), pendingRequest); releaseNext.resolve(); await next; assert.equal(f.pending(), false); assert.equal(f.cached(), null);
});
