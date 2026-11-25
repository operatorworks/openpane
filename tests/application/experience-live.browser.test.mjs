import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rename } from 'node:fs/promises';
import { fixture, connected, draft, wait } from './browser-support.mjs';
import { requestUi } from '../../apps/host/build/tsc/ui-control.js';
import { createExperienceBundle, sha256 } from '../../apps/host/build/tsc/experience-bundle.js';
function experience(color, textCss = '') {
  const css = `[data-openpane-part="composer"] { border: 2px solid ${color}; }${textCss}`;
  return createExperienceBundle({ schemaVersion: 2, id: 'live-test', label: 'Live test', theme: { density: 'comfortable', mode: 'light', light: { typography: { body: { size: 13 } }, fonts: { body: 'Tahoma, Verdana, sans-serif' }, spacing: { sm: 6 } }, dark: {} },
    presentation: { home: { kind: 'stack', panes: ['conversations', 'conversation'] }, transcript: 'bubbles', navigation: 'rail', chats: 'inline', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } },
    stylesheet: 'style.css', assets: [{ name: 'style.css', mimeType: 'text/css', bytes: Buffer.byteLength(css), sha256: sha256(css) }] }, css, []);
}
async function completed(socket, id) {
  let latest;
  await wait(async () => { latest = await requestUi(socket, { op: 'status', requestId: id }); return latest.outcome !== 'pending'; }, 'per-window rendering receipt');
  return latest;
}
test('real UI socket delivers an immutable visual edit into the running app and records painted windows', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  await draft(page, 'Keep my editor');
  const editor = page.getByRole('textbox', { name: 'Message', exact: true }), original = await editor.elementHandle();
  const context = await requestUi(socket, { op: 'context' });
  const command = { op: 'apply', requestId: `${context.requestEpoch}:${randomUUID()}`, expectedRevision: context.revision, bundle: experience('#3355aa') };
  await requestUi(socket, command);
  const first = await completed(socket, command.requestId);
  assert.equal(first.outcome, 'all-rendered', JSON.stringify(first));
  assert.equal(first.receipt.participants.length, 1);
  assert.equal(await editor.evaluate((node, old) => node === old, original), true);
  assert.equal(await editor.inputValue(), 'Keep my editor');
  assert.equal(await page.locator('.composer').evaluate(node => getComputedStyle(node).borderTopColor), 'rgb(51, 85, 170)');
  assert.equal(await page.locator('.desktop-shell').evaluate(node => getComputedStyle(node).fontFamily), 'Tahoma, Verdana, sans-serif');
  assert.equal((await requestUi(socket, command)).receipt.deliveryGeneration, first.receipt.deliveryGeneration);
  const refreshId = `${context.requestEpoch}:${randomUUID()}`;
  await requestUi(socket, { op: 'refresh', requestId: refreshId, expectedRevision: 1 });
  assert.equal((await completed(socket, refreshId)).outcome, 'all-rendered');
  await page.getByRole('button', { name: 'Restore OpenPane appearance', exact: true }).click();
  await wait(async () => (await requestUi(socket, { op: 'context' })).selection.selected.kind === 'builtin', 'persisted builtin recovery');
  await wait(() => page.locator('.experience-content').evaluate(node => node.getAttribute('data-openpane-experience') === null), 'builtin frame');
  assert.equal(await editor.inputValue(), 'Keep my editor');
  assert.equal(await editor.evaluate((node, old) => node === old, original), true);
});
test('failed CSS load retains the last painted frame and refresh reuses immutable bytes', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  await draft(page, 'Survive failed appearance');
  const context = await requestUi(socket, { op: 'context' }), id = () => `${context.requestEpoch}:${randomUUID()}`;
  const first = { op: 'apply', requestId: id(), expectedRevision: 0, bundle: experience('#3355aa') };
  await requestUi(socket, first); assert.equal((await completed(socket, first.requestId)).outcome, 'all-rendered');
  const failed = { op: 'apply', requestId: id(), expectedRevision: 1, bundle: experience('#aa5533') };
  await page.route(`**/ui-assets/${failed.bundle.digest}/style.css`, route => route.fulfill({ status: 404, body: 'missing' }));
  await requestUi(socket, failed);
  assert.equal((await completed(socket, failed.requestId)).outcome, 'failed');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), first.bundle.digest);
  assert.equal(await page.locator('.composer').evaluate(node => getComputedStyle(node).borderTopColor), 'rgb(51, 85, 170)');
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Survive failed appearance');
  await page.unroute(`**/ui-assets/${failed.bundle.digest}/style.css`);
  const refresh = { op: 'refresh', requestId: id(), expectedRevision: 2 };
  await requestUi(socket, refresh); assert.equal((await completed(socket, refresh.requestId)).outcome, 'all-rendered');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), failed.bundle.digest);
});

test('offline builtin recovery survives reload and never overwrites a newer selection without another explicit restore', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  await draft(page, 'Offline recovery keeps this draft');
  const context = await requestUi(socket, { op: 'context' }), id = () => `${context.requestEpoch}:${randomUUID()}`;
  const first = { op: 'apply', requestId: id(), expectedRevision: 0, bundle: experience('#3355aa') };
  await requestUi(socket, first); assert.equal((await completed(socket, first.requestId)).outcome, 'all-rendered');
  let paused = true;
  await page.route('**/api/ui/v1', route => paused ? route.abort('connectionfailed') : route.continue());
  await page.getByRole('button', { name: 'Restore OpenPane appearance', exact: true }).click();
  await wait(() => page.locator('.experience-content').evaluate(node => node.getAttribute('data-openpane-experience') === null), 'local builtin during UI outage');
  await wait(() => page.evaluate(() => JSON.parse(localStorage.getItem('openpane.ui-recovery.v1') ?? 'null')?.kind === 'reserved'), 'reserved recovery persistence');
  const original = await page.evaluate(() => JSON.parse(localStorage.getItem('openpane.ui-recovery.v1')));
  await page.reload(); await connected(page);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Offline recovery keeps this draft');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), null);
  const newer = { op: 'apply', requestId: id(), expectedRevision: 1, bundle: experience('#aa5533') }; await requestUi(socket, newer);
  paused = false;
  await wait(() => page.evaluate(() => JSON.parse(localStorage.getItem('openpane.ui-recovery.v1') ?? 'null')?.kind === 'conflicted'), 'stale recovery refusal');
  const refused = await page.evaluate(() => JSON.parse(localStorage.getItem('openpane.ui-recovery.v1')));
  assert.deepEqual(refused.request, original.request);
  assert.equal((await requestUi(socket, { op: 'context' })).selection.selected.digest, newer.bundle.digest);
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), null);
  await page.getByRole('button', { name: 'Restore OpenPane appearance', exact: true }).click();
  await wait(async () => (await requestUi(socket, { op: 'context' })).selection.selected.kind === 'builtin', 'explicit current-generation recovery');
  assert.equal((await requestUi(socket, { op: 'context' })).revision, 3);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Offline recovery keeps this draft');
});

test('superseding a staged candidate restores the last validated appearance when the successor fails', { timeout: 30000 }, async t => {
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  await draft(page, 'Keep the validated editor');
  const editor = page.getByRole('textbox', { name: 'Message', exact: true }), original = await editor.elementHandle();
  const context = await requestUi(socket, { op: 'context' }), id = () => `${context.requestEpoch}:${randomUUID()}`;
  const a = experience('#3355aa'), b = experience('#aa5533'), c = experience('#338855');
  const first = { op: 'apply', requestId: id(), expectedRevision: 0, bundle: a };
  await requestUi(socket, first); assert.equal((await completed(socket, first.requestId)).outcome, 'all-rendered');
  let release, staging = false;
  const held = new Promise(resolve => { release = resolve; });
  await page.route(`**/ui-assets/${b.digest}/style.css`, async route => { staging = true; await held; await route.continue().catch(() => {}); });
  t.after(() => release());
  await requestUi(socket, { op: 'apply', requestId: id(), expectedRevision: 1, bundle: b });
  await wait(() => staging, 'B stylesheet is held in staging');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), a.digest);
  await page.route(`**/ui-assets/${c.digest}/style.css`, route => route.fulfill({ status: 404, body: 'missing' }));
  const failed = { op: 'apply', requestId: id(), expectedRevision: 2, bundle: c };
  await requestUi(socket, failed); assert.equal((await completed(socket, failed.requestId)).outcome, 'failed');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), a.digest);
  assert.equal(await page.locator('.composer').evaluate(node => getComputedStyle(node).borderTopColor), 'rgb(51, 85, 170)');
  assert.equal(await editor.inputValue(), 'Keep the validated editor');
  assert.equal(await editor.evaluate((node, old) => node === old, original), true);
});

test('a lost failed-render acknowledgement retries the same delivery without a refresh', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  const context = await requestUi(socket, { op: 'context' });
  const failed = { op: 'apply', requestId: `${context.requestEpoch}:${randomUUID()}`, expectedRevision: 0, bundle: experience('#aa5533') };
  await page.route(`**/ui-assets/${failed.bundle.digest}/style.css`, route => route.fulfill({ status: 404, body: 'missing' }));
  let dropped = 0;
  await page.route('**/api/ui/v1', route => {
    const request = route.request().postDataJSON();
    if (request.op === 'ack' && request.result.kind === 'failed' && !dropped++) return route.abort('connectionfailed');
    return route.continue();
  });
  await requestUi(socket, failed);
  assert.equal((await completed(socket, failed.requestId)).outcome, 'failed');
  assert.ok(dropped >= 2, 'the rejected appearance is retried after the lost reply');
});
test('an open application picker does not fail a visual delivery or builtin recovery', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  await page.setViewportSize({ width: 640, height: 720 });
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  await page.getByRole('button', { name: 'Harness, Recorded', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose harness', exact: true }).waitFor();
  const context = await requestUi(socket, { op: 'context' });
  const command = { op: 'apply', requestId: `${context.requestEpoch}:${randomUUID()}`, expectedRevision: 0, bundle: experience('#3355aa') };
  await requestUi(socket, command); const painted = await completed(socket, command.requestId);
  const controls = await page.locator('[data-openpane-essential]').evaluateAll(nodes => nodes.map(n => { const b=n.getBoundingClientRect(),hit=document.elementFromPoint(Math.max(0,Math.min(innerWidth-1,b.x+b.width/2)),Math.max(0,Math.min(innerHeight-1,b.y+b.height/2))); return {control:n.getAttribute('data-openpane-essential'),hit:hit?.outerHTML.slice(0,300)}; }));
  assert.equal(painted.outcome, 'all-rendered', JSON.stringify({painted,controls}));
  const recovery = await requestUi(socket, { op: 'context' });
  const restored = { op: 'restore', requestId: `recovery:${recovery.recoveryGeneration}:${randomUUID()}`, expectedRevision: recovery.revision, expectedRecoveryGeneration: recovery.recoveryGeneration };
  await requestUi(socket, restored); assert.equal((await completed(socket, restored.requestId)).outcome, 'all-rendered');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), null);
});

test('a retried painted acknowledgement clears the waiting notice for that exact delivery', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  let dropped = 0, release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  await page.route('**/api/ui/v1', async route => {
    const request = route.request().postDataJSON();
    if (request.op === 'paint' && request.deliveryGeneration > 0) {
      if (!dropped++) return route.abort('connectionfailed');
      await gate;
    }
    return route.continue();
  });
  const context = await requestUi(socket, { op: 'context' }), command = { op: 'apply', requestId: `${context.requestEpoch}:${randomUUID()}`, expectedRevision: 0, bundle: experience('#3355aa') };
  await requestUi(socket, command);
  await page.getByText('Appearance is visible locally; waiting for host confirmation.', { exact: true }).waitFor();
  release();
  assert.equal((await completed(socket, command.requestId)).outcome, 'all-rendered'); assert.ok(dropped >= 2);
  await wait(async () => await page.getByText('Appearance is visible locally; waiting for host confirmation.', { exact: true }).count() === 0, 'cleared confirmation notice');
});

for (const [label, css] of [
  ['transparent message text', '[data-openpane-part="textarea"] { color: transparent; }'],
  ['transparent message text via alpha', '[data-openpane-part="textarea"] { color: #12345600; }'],
  ['clipped controls', '[data-openpane-part="button"] { padding: 64px; font-size: 48px; } [data-openpane-part="pane-heading"] { padding: 64px; font-size: 48px; }'],
]) test(`unusable appearance rejects ${label} and retains the editor`, { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  await draft(page, 'Readable saved text');
  if (label === 'clipped controls') await page.setViewportSize({ width: 1000, height: 320 });
  const editor = page.getByRole('textbox', { name: 'Message', exact: true }), original = await editor.elementHandle();
  const first = experience('#3355aa'), bundle = createExperienceBundle({ ...first.manifest, assets: [{ name: 'style.css', mimeType: 'text/css', bytes: Buffer.byteLength(css), sha256: sha256(css) }] }, css, []);
  const context = await requestUi(socket, { op: 'context' }), requestId = `${context.requestEpoch}:${randomUUID()}`;
  await requestUi(socket, { op: 'apply', requestId, expectedRevision: context.revision, bundle });
  assert.equal((await completed(socket, requestId)).outcome, 'failed');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), null);
  assert.equal(await editor.inputValue(), 'Readable saved text'); assert.equal(await editor.evaluate((node, old) => node === old, original), true);
});


test('same-origin UI profile replacement stages the new digest before reporting the reused generation', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page); await draft(page, 'Profile replacement keeps editor text');
  const firstContext = await requestUi(socket, { op: 'context' }), first = experience('#3355aa');
  const firstId = `${firstContext.requestEpoch}:${randomUUID()}`;
  await requestUi(socket, { op: 'apply', requestId: firstId, expectedRevision: 0, bundle: first }); assert.equal((await completed(socket, firstId)).outcome, 'all-rendered');
  let paused = true; const paints = [];
  await page.route('**/api/ui/v1', async route => {
    if (paused) return route.abort('connectionfailed');
    const request = route.request().postDataJSON();
    if (request.op === 'paint') paints.push({ request, shown: await page.locator('.experience-content').getAttribute('data-openpane-experience') });
    return route.continue();
  });
  await host.stop(); await rename(join(host.directory, 'ui.sqlite'), join(host.directory, 'original-ui.sqlite'));
  await host.start(Number(new URL(host.origin).port));
  const replacement = await requestUi(socket, { op: 'context' }), second = experience('#aa5533'), secondId = `${replacement.requestEpoch}:${randomUUID()}`;
  assert.notEqual(replacement.profileId, firstContext.profileId);
  const applied = await requestUi(socket, { op: 'apply', requestId: secondId, expectedRevision: 0, bundle: second }); assert.equal(applied.receipt.deliveryGeneration, 1);
  assert.equal(applied.outcome, 'selected-with-no-clients');
  paused = false; await wait(() => paints.some(paint => paint.request.digest === second.digest), 'replacement profile paint');
  await wait(() => page.locator('.experience-content').getAttribute('data-openpane-experience').then(digest => digest === second.digest), 'replacement visual');
  assert.ok(paints.some(paint => paint.request.digest === second.digest));
  assert.ok(paints.filter(paint => paint.request.digest === second.digest).every(paint => paint.shown === second.digest));
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Profile replacement keeps editor text');
});


test('local and remote message-text states style their actual sent transcript text', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  await draft(page, 'Semantic local message'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  const local = page.locator('p[data-openpane-part="message-text"]').filter({ hasText: 'Semantic local message' });
  await local.waitFor(); const remote = page.locator('.assistant-reply').first(); await remote.waitFor();
  const context = await requestUi(socket, { op: 'context' }), requestId = `${context.requestEpoch}:${randomUUID()}`;
  await requestUi(socket, { op: 'apply', requestId, expectedRevision: context.revision, bundle: experience('#3355aa',
    '[data-openpane-part="message-text"][data-openpane-state="local"] { color: #133357; } [data-openpane-part="message-text"][data-openpane-state="remote"] { color: #462244; }') });
  assert.equal((await completed(socket, requestId)).outcome, 'all-rendered');
  assert.equal(await local.evaluate(node => getComputedStyle(node).color), 'rgb(19, 51, 87)');
  assert.equal(await remote.evaluate(node => getComputedStyle(node).color), 'rgb(70, 34, 68)');
});
