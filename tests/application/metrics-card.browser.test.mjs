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
