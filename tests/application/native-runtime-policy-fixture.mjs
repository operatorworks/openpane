import { desktopSourceModules } from './desktop-source-modules.mjs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
export async function fixture(t) {
  const bundle = await build({ stdin: { contents: `import { windowContext } from './tests/application/window-context-fixture.mjs';
    import { continuationNotice } from './apps/desktop/src/application/continuation-copy.ts';
    import { WindowCoordinator } from './apps/desktop/src/application/window-coordinator.ts';
    import { WindowRuntime } from './apps/desktop/src/application/window-runtime.ts';
    import { UiConnection } from './apps/desktop/src/application/ui-connection.ts';
    import { ServiceConnectionLost, ServiceError } from '@openpane/client/service';
    import { fixture as controllerFixture } from './tests/application/controller-fixture.mjs';
    import { BrowserViewStorage } from './apps/desktop/src/application/browser-storage.ts';
    import { createConversationStore } from './packages/client/src/index.ts';
    import { transcriptProjection } from '@openpane/contracts/conversation';
    import { recordNativeEditorOrigin } from './apps/desktop/src/application/native-editor-origin.ts';
    import * as carries from './apps/desktop/src/application/draft-carry.ts';
    Object.assign(globalThis, { windowContext, continuationNotice, recordNativeEditorOrigin, ServiceError, ServiceConnectionLost, controllerFixture, WindowCoordinator, WindowRuntime, UiConnection, BrowserViewStorage, carries, createConversationStore, transcriptProjection });`, resolveDir: root }, bundle: true, write: false, format: 'iife', plugins: [desktopSourceModules] });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Native placement policy</title>' }));
  await page.goto('http://localhost/policy'); await page.addScriptTag({ content: bundle.outputFiles[0].text });

  await page.evaluate(() => {
    globalThis.bounded = async pending => { let timer; try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Production boundary did not arrive')), 3000); })]); } finally { clearTimeout(timer); } };
    globalThis.waitFor = async predicate => { const until = performance.now() + 3000; while (!predicate()) { if (performance.now() > until) throw new Error('Bounded production completion did not arrive'); await new Promise(resolve => setTimeout(resolve, 1)); } };
    globalThis.paintFixture = async scope => {
      const original = fetch, pending = [], digest = 'a'.repeat(64), context = { role: 'main', hostId: scope.hostId, profileId: 'profile', brokerInstance: 'broker', label: 'main', documentIncarnation: 'paint-document', viewId: 'catalog' }, requests = []; let count = 0, fail = null;
      const state = (generation, chats = 'separate') => ({ version: 1, change: generation, selection: { revision: generation, deliveryGeneration: generation, selected: { kind: 'experience', digest }, previousHealthy: { kind: 'builtin' } }, bundle: { digest, manifest: { schemaVersion: 2, id: 'policy', label: 'Policy', theme: { mode: 'dark', density: 'comfortable', light: {}, dark: {} }, presentation: { home: { kind: 'stack', panes: ['conversation'] }, transcript: 'lines', navigation: 'rail', chats, chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, stylesheet: null, assets: [] } }, envelope: null, fault: null, display: null, transitions: [{ envelope: { requestId: `1:paint-${generation}`, deliveryGeneration: generation, selectionRevision: generation, digest }, slot: { kind: 'transition', transitionId: `slot-${generation}`, source: context, target: null, resolved: null } }] });
      globalThis.fetch = async (_url, options) => { const request = JSON.parse(options.body); requests.push(request); let value;
        if (request.op === 'context') value = { version: 1, hostId: scope.hostId, profileId: 'profile', requestEpoch: 1, recoveryGeneration: 0, revision: 1, selection: state(1).selection, capabilities: [], fault: null };
        else if (request.op === 'state') { if (!count++) value = state(1); else return new Promise((resolve, reject) => { pending.push(value => resolve(new Response(JSON.stringify({ ok: true, value })))); options.signal.addEventListener('abort', () => reject(new DOMException('Closed', 'AbortError')), { once: true }); }); }
        else if (request.op === 'placement-reserve') value = { receipt: null, outcome: 'reserved' };
        else if (request.op === 'restore') value = { outcome: 'restored', receipt: { requestId: request.requestId, deliveryGeneration: 2, selectionRevision: 2, digest: null, requestDigest: digest, participants: [] } };
        else if (request.op === 'placement-failed' && fail) await fail(request); else if (!['paint', 'ack', 'placement-failed', 'placement-idle'].includes(request.op)) throw new Error(request.op);
        return new Response(JSON.stringify({ ok: true, value: value ?? {} }));
      };
      const ui = new globalThis.UiConnection(undefined, async () => context); ui.start(); await globalThis.waitFor(() => ui.getSnapshot().state); await ui.rendered(ui.getSnapshot().state);
      return { ui, requests, fail: handler => { fail = handler; }, async replace(generation, chats = 'separate') { await globalThis.waitFor(() => pending.length); pending.shift()(state(generation, chats)); await globalThis.waitFor(() => ui.getSnapshot().state?.selection.deliveryGeneration === generation); await ui.rendered(ui.getSnapshot().state); }, close() { ui.close(); globalThis.fetch = original; } };
    };
  });
  return page;
}
