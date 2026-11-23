import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { requestUi } from '../../apps/host/build/tsc/ui-control.js';
import { createExperienceBundle, sha256 } from '../../apps/host/build/tsc/experience-bundle.js';
import { wait } from './browser-support.mjs';
export const metricsEvent = (title = 'CPU snapshot') => ({ type: 'CUSTOM', name: 'openpane.datadog.metrics.v1', value: {
  schemaVersion: 1, title, query: 'avg:system.cpu.user{*}', fromMs: 1795374000000, toMs: 1795374060000, fetchedAtMs: 1795374061000,
  series: [{ label: '<b>Example host</b>', unit: '%', points: [[1795374000000, 0], [1795374020000, null], [1795374040000, 3]] }, { label: 'Memory', unit: 'byte', points: [[1795374000000, 4], [1795374040000, 8]] }] } });
export async function publishCard(host, page, title) {
  const socket = join(host.directory, 'ui.sock'), context = await requestUi(socket, { op: 'context' });
  const scope = { hostId: host.hostId, conversationId: await page.locator('.conversation-panel:visible .scope-label').textContent() };
  const publicationId = `${context.requestEpoch}:${randomUUID()}`;
  const result = await requestUi(socket, { op: 'display-publish', scope, publicationId, event: metricsEvent(title) });
  return { socket, context, scope, publicationId, result };
}
export async function qualifyCardRestyle(host, page) {
  const f = await publishCard(host, page), card = page.locator(`[data-publication-id="${f.publicationId}"]`);
  await card.waitFor(); assert.equal(await page.locator('.metrics-card:visible').count(), 1);
  assert.equal(await card.locator('[data-openpane-part="plot-frame"]').count(), 2);
  assert.equal(await card.locator('b').count(), 0, 'labels are text');
  assert.equal(await card.locator('[data-openpane-part="plot-trace"]').count(), 3, 'null breaks the CPU trace');
  await card.getByText('Read values table', { exact: true }).click();
  await card.getByRole('cell', { name: 'Missing', exact: true }).waitFor();
  const original = await card.elementHandle(), editor = page.locator('.conversation-panel:visible #message'), editorNode = await editor.elementHandle();
  const before = await requestUi(f.socket, { op: 'display-status', scope: f.scope, publicationId: f.publicationId });
  const css = '[data-openpane-part="card"] { border-radius: 0px; border-width: 3px; } [data-openpane-part="plot-trace"] { stroke-width: 3px; }';
  const bundle = createExperienceBundle({ schemaVersion: 1, id: 'metrics-restyle', label: 'Metrics restyle', theme: { mode: 'light', light: { chart: { trace1: '#3355aa', grid: '#d0d0d0' } }, dark: {} },
    presentation: { navigation: 'pages', chats: 'inline', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, stylesheet: 'style.css', assets: [{ name: 'style.css', mimeType: 'text/css', bytes: Buffer.byteLength(css), sha256: sha256(css) }] }, css, []);
  const apply = await requestUi(f.socket, { op: 'apply', requestId: `${f.context.requestEpoch}:${randomUUID()}`, expectedRevision: f.context.revision, bundle });
  await wait(async () => (await requestUi(f.socket, { op: 'status', requestId: apply.receipt.requestId })).outcome === 'all-rendered', 'card restyle painted');
  assert.equal(await card.evaluate((node, old) => node === old, original), true);
  assert.equal(await editor.evaluate((node, old) => node === old, editorNode), true);
  assert.equal(await card.evaluate(node => getComputedStyle(node).borderTopWidth), '3px');
  assert.equal(await card.locator('.metrics-trace').first().evaluate(node => getComputedStyle(node).stroke), 'rgb(51, 85, 170)');
  assert.deepEqual(await requestUi(f.socket, { op: 'display-status', scope: f.scope, publicationId: f.publicationId }), before);
  await page.getByRole('button', { name: 'Restore OpenPane appearance', exact: true }).click();
  await wait(async () => (await requestUi(f.socket, { op: 'context' })).selection.selected.kind === 'builtin', 'restore after card restyle');
  assert.equal(await card.evaluate((node, old) => node === old, original), true);
  return f;
}
