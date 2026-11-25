import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture, connected, draft, wait } from './browser-support.mjs';
import { requestUi } from '../../apps/host/build/tsc/ui-control.js';
import { metricsEvent, publishCard, qualifyCardRestyle } from './metrics-card-support.mjs';

test('default chat renders a saved card once and restyles the same data and editor without querying a provider', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page); await draft(page, 'Keep this draft');
  const f = await qualifyCardRestyle(host, page);
  await page.reload(); await connected(page);
  await page.locator(`[data-publication-id="${f.publicationId}"]`).waitFor();
  assert.equal(await page.locator('.metrics-card').count(), 1);
  assert.equal(await page.locator('.metrics-axis path').first().evaluate(node => getComputedStyle(node).fill), 'none', 'axes draw lines without obscuring the data');
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Keep this draft');
  const removed = await requestUi(f.socket, { op: 'display-remove', scope: f.scope, publicationId: f.publicationId, requestId: `${f.context.requestEpoch}:${randomUUID()}` });
  assert.equal(removed.kind, 'removed'); await wait(async () => await page.locator('.metrics-card').count() === 0, 'card tombstone');
});

test('a new card preserves an earlier scroll position and offers a reachable notice, while bottom readers follow new cards', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  const f = await publishCard(host, page, 'Initial snapshot'); await page.locator('.metrics-card').waitFor();
  for (let n = 0; n < 6; n++) await requestUi(f.socket, { op: 'display-publish', scope: f.scope, publicationId: `${f.context.requestEpoch}:${randomUUID()}`, event: metricsEvent(`History ${n}`) });
  await wait(async () => await page.locator('.metrics-card').count() === 7, 'long card history');
  const scroll = page.locator('.conversation-content');
  await scroll.evaluate(node => { node.scrollTop = 10; node.dispatchEvent(new Event('scroll')); });
  const editor = page.getByRole('textbox', { name: 'Message', exact: true }); await editor.focus();
  await requestUi(f.socket, { op: 'display-publish', scope: f.scope, publicationId: `${f.context.requestEpoch}:${randomUUID()}`, event: metricsEvent('New above composer') });
  const notice = page.getByRole('button', { name: 'New card ↓', exact: true }); await notice.waitFor();
  assert.equal(await scroll.evaluate(node => node.scrollTop), 10); assert.equal(await editor.evaluate(node => document.activeElement === node), true);
  assert.ok(await notice.evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }));
  await notice.click();
  await wait(() => scroll.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop <= 48), 'new card revealed');
  await requestUi(f.socket, { op: 'display-publish', scope: f.scope, publicationId: `${f.context.requestEpoch}:${randomUUID()}`, event: metricsEvent('Bottom follows') });
  await page.getByRole('heading', { name: 'Bottom follows', exact: true }).waitFor();
  assert.ok(await scroll.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop <= 48));
  assert.equal(await notice.count(), 0);
});

test('the original-values table keeps distinct millisecond timestamps in UTC', { timeout: 30000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  const f = await publishCard(host, page, 'Initial snapshot'), publicationId = `${f.context.requestEpoch}:${randomUUID()}`;
  const event = metricsEvent('Millisecond samples');
  event.value.series = [{ label: 'Precise samples', unit: 'count', points: [[1795374000123, 1], [1795374000456, 2]] }];
  await requestUi(f.socket, { op: 'display-publish', scope: f.scope, publicationId, event });
  const card = page.locator(`[data-publication-id="${publicationId}"]`); await card.waitFor();
  await card.getByText('Read values table', { exact: true }).click();
  await card.getByRole('region', { name: 'Metrics values', exact: true }).waitFor();
  assert.equal(await card.getByRole('cell', { name: '2026-11-22T19:00:00.123Z', exact: true }).count(), 1);
  assert.equal(await card.getByRole('cell', { name: '2026-11-22T19:00:00.456Z', exact: true }).count(), 1);
});
test('expanding exact card values preserves the reading position when another card arrives', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page(); await page.setViewportSize({ width: 1280, height: 600 });
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  const f = await publishCard(host, page, 'Before expansion'), publicationId = `${f.context.requestEpoch}:${randomUUID()}`, event = metricsEvent('Expanded exact values');
  event.value.series = [{ label: 'Samples', unit: 'count', points: Array.from({ length: 100 }, (_, n) => [event.value.fromMs + n * 600, n]) }];
  await requestUi(f.socket, { op: 'display-publish', scope: f.scope, publicationId, event });
  const card = page.locator(`[data-publication-id="${publicationId}"]`); await card.waitFor();
  const scroll = page.locator('.conversation-content');
  await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
  await card.getByText('Read values table', { exact: true }).click();
  await wait(() => scroll.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop > 48), 'expanded values extend below the viewport');
  const before = await scroll.evaluate(node => node.scrollTop);
  await requestUi(f.socket, { op: 'display-publish', scope: f.scope, publicationId: `${f.context.requestEpoch}:${randomUUID()}`, event: metricsEvent('Arrived during reading') });
  await page.getByRole('button', { name: 'New card ↓', exact: true }).waitFor();
  assert.equal(await scroll.evaluate(node => node.scrollTop), before);
});

test('the builtin eight-series plot gives every legend key a distinct trace color', { timeout: 30000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  const f = await publishCard(host, page, 'Initial snapshot'), publicationId = `${f.context.requestEpoch}:${randomUUID()}`;
  const event = metricsEvent('Eight distinct series');
  event.value.series = Array.from({ length: 8 }, (_, i) => ({ label: `Series ${i + 1}`, unit: 'count', points: [[1795374000000, i], [1795374040000, i + 1]] }));
  await requestUi(f.socket, { op: 'display-publish', scope: f.scope, publicationId, event });
  const card = page.locator(`[data-publication-id="${publicationId}"]`); await card.waitFor();
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await wait(() => card.evaluate((node, appearance) => node.closest('.aui-theme').getAttribute('data-appearance') === appearance, colorScheme), `${colorScheme} card theme`);
    const colors = await card.locator('.metrics-legend-key').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
    assert.equal(new Set(colors).size, 8, 'color-coded legend entries must distinguish all eight supported series');
    const axis = await card.locator('.metrics-axis').evaluate(node => getComputedStyle(node).stroke);
    assert.equal(colors.includes(axis), false, 'a series must remain distinguishable from the axis');
  }
});
