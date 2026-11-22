import assert from 'node:assert/strict';
import { chats, wait } from './browser-support.mjs';

export async function saveUiEnable(page) {
  const checkbox = page.getByRole('checkbox', { name: 'Enable executable UI customizations', exact: true });
  await checkbox.check();
  await wait(async () => await checkbox.isEnabled() && await checkbox.isChecked(), 'saved executable UI enable');
}

export async function expectStickyCleanupBlocksReenable(page, expectedActivations) {
  const notice = page.getByRole('alert').filter({ hasText: 'Executable UI cleanup failed.' });
  await chats(page); await notice.waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await saveUiEnable(page);
  await chats(page); await notice.waitFor();
  assert.equal(await page.evaluate(() => window.activations), expectedActivations, 'late cleanup rejection prevents reactivation until restart');
}
