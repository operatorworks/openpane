import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { fixture, connected } from '../../application/browser-support.mjs';
import { requestUi } from '../../../apps/host/build/tsc/ui-control.js';

test('fresh desktop keeps builtin inline appearance and an empty display region adds no layout space', { timeout: 30000 }, async t => {
  const host = await fixture(t), page = await host.page();
  assert.equal((await requestUi(join(host.directory, 'ui.sock'), { op: 'context' })).selection.selected.kind, 'builtin');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), null);
  assert.equal(await page.locator('.metrics-card').count(), 0);
  assert.equal(await page.locator('.display-cards').evaluate(node => getComputedStyle(node).display), 'none');
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Restore OpenPane appearance', exact: true }).count(), 0);
});
