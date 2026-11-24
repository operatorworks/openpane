import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t) {
  const bundle = await build({ stdin: { contents: `import { continuationNotice } from './apps/desktop/src/application/continuation-copy.ts';
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
    Object.assign(globalThis, { continuationNotice, recordNativeEditorOrigin, ServiceError, ServiceConnectionLost, controllerFixture, WindowCoordinator, WindowRuntime, UiConnection, BrowserViewStorage, carries, createConversationStore, transcriptProjection });`, resolveDir: root }, bundle: true, write: false, format: 'iife' });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Native placement policy</title>' }));
  await page.goto('http://localhost/policy'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return page;
}

for (const mode of ['passive', 'check', 'catalog-open', 'continue', 'default-capture']) test(`main native capture preserves draft merge consent (${mode})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async mode => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, scope = { hostId: 'host', conversationId: 'main-consent-source' }, targetScope = { hostId: 'host', conversationId: 'main-consent-target' }, context = { role: 'main', version: 1, label: 'main', brokerInstance: 'broker', documentIncarnation: 'main', viewId: 'main-consent-source-view', reservation: null, liveRelay: true };
    const target = await S.claimEditor({ scope: targetScope, viewId: 'main-consent-target-view', label: 'populated-native-child', transitionId: null, creation: { agentId: 'default' } }, () => {}), b = globalThis.createConversationStore({ scope: targetScope, port: { scope: targetScope }, projection: globalThis.transcriptProjection, drafts: target.drafts(() => {}) }); await b.ready; await b.setDraft('Existing native child saved bytes');
    const binding = target.editorBinding(), reservation = { scope: targetScope, viewId: target.viewId, label: 'populated-native-child', transitionId: 'main-consent-ready', creationAgentId: null, phase: 'target-ready', bindingRevision: binding.revision, writerGeneration: binding.writerGeneration }, focuses = []; let owner, confirmed = false;
    const port = { context, async request(command) { if (command.kind === 'lookup') return command.scope.conversationId === scope.conversationId ? { kind: 'absent' } : { kind: 'ready', reservation }; if (command.kind === 'intent-context') return { epoch: 1, pendingCarryRequests: [] }; if (command.kind === 'launch') { focuses.push(command); return { kind: 'detached', scope: targetScope, label: reservation.label }; } throw new Error(command.kind); } };
    const coordinator = new globalThis.WindowCoordinator(port), f = globalThis.controllerFixture({ placement: coordinator }); f.storage.open = async failure => { owner = await S.claimEditor({ scope, viewId: context.viewId, label: 'main', transitionId: null, creation: { agentId: 'default' } }, failure); await owner.saveView('host', { version: 2, route: scope, pendingCreation: null }); return owner; };
    f.behavior.continuation = async input => { const own = input.scope.conversationId === scope.conversationId; if (own && input.action === 'start') confirmed = true; return { predecessor: null, carried: null, closure: own ? 'cancelled' : null, successor: own ? confirmed ? { kind: 'confirmed', scope: targetScope } : mode === 'continue' ? null : { kind: mode === 'check' ? 'pending' : 'starting' } : null }; };
    await f.app.start(); const active = f.app.getSnapshot().active; await active.store.setDraft('Main continuation exact source text');
    const main = Object.assign(new globalThis.WindowRuntime(context), { controller: f.app, coordinator, port, drive: async () => {} }); main.configurePlacementTracking(); let placement; const initialNotice = globalThis.continuationNotice(f.app.getSnapshot().continuation);
    try { if (mode === 'continue') await f.app.conversationActions(active).continueConversation(); else if (mode === 'default-capture') placement = await coordinator.acquire({ scope: targetScope, creation: false, carryFrom: scope, initialDraft: null, agentId: 'default', agentLabel: 'Agent' }, { storage: owner, holds: id => id === owner.viewId, async quiesce() { throw new Error('No source quiesce'); }, async release() { throw new Error('No source release'); } }); else { confirmed = true; if (mode === 'check') await f.app.conversationActions(active).checkContinuation(); if (mode === 'catalog-open') placement = await f.app.open(scope); }
      const deadline = performance.now() + 3000; let offered; for (;;) { offered = (await c.sourceCarries(scope))[0]; placement ??= f.app.getSnapshot().lastPlacement?.kind === 'detached' ? f.app.getSnapshot().lastPlacement : undefined; if (offered?.target && placement?.kind === 'detached') break; if (performance.now() > deadline) throw new Error('Actual main continuation did not reach its native target'); await new Promise(resolve => setTimeout(resolve, 5)); }
      const child = Object.assign(Object.create(globalThis.WindowRuntime.prototype), { context: { role: 'chat' }, port: { async request(command) { if (command.kind === 'carry-applied') return {}; throw new Error(command.kind); } }, controller: { getSnapshot: () => ({ host: { kind: 'ready', metadata: { hostId: 'host' } }, active: { scope: targetScope, viewId: target.viewId, store: b } }) } });
      await child.syncDraftCarries(); await main.syncDraftCarries(); return { offered, carry: (await c.sourceCarries(scope))[0], source: (await active.store.captureDraft()).text, target: (await b.captureDraft()).text, placement, focuses, initialNotice, finalNotice: globalThis.continuationNotice(f.app.getSnapshot().continuation), sent: f.submitted.length, created: f.created.length };
    } finally { await f.app.dispose(); await b.dispose(); await target.close(); }
  }, mode);
  const merge = mode === 'continue';
  assert.deepEqual({ emptyOnly: result.offered.emptyOnly ?? false, source: result.source, target: result.target, state: result.carry.kind }, { emptyOnly: !merge, source: merge ? '' : 'Main continuation exact source text', target: merge ? 'Main continuation exact source text\n\nExisting native child saved bytes' : 'Existing native child saved bytes', state: merge ? 'settled' : 'refused' });
  if (mode === 'continue') assert.ok(result.initialNotice.choices.includes('Continue')); if (mode === 'check') assert.ok(result.initialNotice.choices.includes('Check again')); if (mode !== 'default-capture') assert.equal(result.finalNotice.choices.includes('Continue'), false);
  assert.equal(result.placement.kind, 'detached'); assert.ok(result.focuses.length > 0); assert.ok(result.focuses.every(command => command.existingOnly === true)); assert.equal(result.sent, 0); assert.equal(result.created, 0);
});
