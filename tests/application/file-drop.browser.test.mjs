import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, connected } from './browser-support.mjs';

test('a file dropped outside the conversation never navigates the window or attaches', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(page);
  const url = page.url();
  const outcomes = await page.evaluate(() => ['.view-rail', '.application-controls', '#main-content'].map(selector => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(8)], 'outside.png', { type: 'image/png' }));
    const target = document.querySelector(selector);
    const over = new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true });
    const drop = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
    target.dispatchEvent(over); target.dispatchEvent(drop);
    return [selector, over.defaultPrevented, drop.defaultPrevented];
  }));
  assert.deepEqual(outcomes, [['.view-rail', true, true], ['.application-controls', true, true], ['#main-content', true, true]]);
  assert.equal(page.url(), url);
  assert.equal(await page.getByLabel('Attached image').count(), 0);
  assert.equal(await page.locator('.composer').getAttribute('data-drop'), null);
});
