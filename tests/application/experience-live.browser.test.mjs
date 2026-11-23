import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fixture, connected, draft, wait } from './browser-support.mjs';
import { requestUi } from '../../apps/host/build/tsc/ui-control.js';
import { createExperienceBundle, sha256 } from '../../apps/host/build/tsc/experience-bundle.js';
function experience(color) {
  const css = `[data-openpane-part="composer"] { border: 2px solid ${color}; }`;
  return createExperienceBundle({ schemaVersion: 1, id: 'live-test', label: 'Live test', theme: { mode: 'light', light: { typography: { body: { size: 13 } }, fonts: { body: 'Tahoma, Verdana, sans-serif' }, spacing: { sm: 6 } }, dark: {} },
    presentation: { navigation: 'rail', chats: 'inline', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } },
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

test('superseding an unpainted candidate restores the last validated appearance when the successor fails', { timeout: 30000 }, async t => {
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  await draft(page, 'Keep the validated editor');
  const editor = page.getByRole('textbox', { name: 'Message', exact: true }), original = await editor.elementHandle();
  const context = await requestUi(socket, { op: 'context' }), id = () => `${context.requestEpoch}:${randomUUID()}`;
  const a = experience('#3355aa'), b = experience('#aa5533'), c = experience('#338855');
  const first = { op: 'apply', requestId: id(), expectedRevision: 0, bundle: a };
  await requestUi(socket, first); assert.equal((await completed(socket, first.requestId)).outcome, 'all-rendered');
  await page.evaluate(digest => {
    const frame = window.requestAnimationFrame;
    window.requestAnimationFrame = callback => frame(time => {
      if (document.querySelector('.experience-content')?.getAttribute('data-openpane-experience') === digest) (window.heldAppearanceFrames ??= []).push(() => callback(time));
      else callback(time);
    });
  }, b.digest);
  await requestUi(socket, { op: 'apply', requestId: id(), expectedRevision: 1, bundle: b });
  await wait(() => page.locator('.experience-content').evaluate((node, digest) => node.getAttribute('data-openpane-experience') === digest, b.digest), 'unvalidated B in the frame');
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
