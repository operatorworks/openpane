import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, connected, draft, wait } from './browser-support.mjs';

test('production browser entry uses dedicated bindings, preserves each draft and reopens navigation after reload', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(page);
  const first = await page.locator('.scope-label').textContent(); await draft(page, 'First private draft');
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await wait(async () => await page.locator('.scope-label').textContent() !== first, 'second conversation'); await connected(page);
  const second = await page.locator('.scope-label').textContent(); assert.notEqual(first, second); await draft(page, 'Second private draft');
  await page.getByRole('button', { name: new RegExp(`Open conversation ${first}$`) }).click();
  await wait(async () => await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue() === 'First private draft', 'first dedicated draft');
  await page.reload(); await connected(page);
  assert.equal(await page.locator('.scope-label').textContent(), first);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'First private draft');
  await page.getByRole('button', { name: new RegExp(`Open conversation ${second}$`) }).click();
  await wait(async () => await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue() === 'Second private draft', 'second dedicated draft');
  const records = await page.evaluate(async () => {
    const open = indexedDB.open('openpane-browser-views', 1), db = await new Promise(resolve => { open.onsuccess = () => resolve(open.result); });
    const transaction = db.transaction('records'), store = transaction.objectStore('records'), keys = store.getAllKeys(), values = store.getAll();
    await new Promise(resolve => { transaction.oncomplete = resolve; });
    const rows = keys.result.map((key, index) => ({ key, value: values.result[index] })); db.close();
    return { bindings: rows.filter(row => row.key[0] === 'editor-binding').map(row => row.value), drafts: rows.filter(row => row.key[0] === 'draft').map(row => ({ view: row.key[1], draft: row.value.draft })), catalog: sessionStorage.getItem('openpane.catalogViewId') };
  });
  assert.equal(records.bindings.length, 2); assert.notEqual(records.bindings[0].viewId, records.bindings[1].viewId);
  assert.ok(records.bindings.every(binding => binding.viewId !== records.catalog && binding.kind === 'editing'));
  assert.deepEqual(records.drafts.map(row => row.draft).sort(), ['First private draft', 'Second private draft']); assert.deepEqual(errors, []);
});
