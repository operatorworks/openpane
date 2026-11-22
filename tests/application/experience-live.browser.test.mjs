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
