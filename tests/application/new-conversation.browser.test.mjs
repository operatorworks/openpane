import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './browser-support.mjs';

const greeting = page => page.getByRole('heading', { name: 'A conversation that stays with you.', exact: true });
const message = page => page.getByRole('textbox', { name: 'Message', exact: true });
const first = page => page.getByRole('textbox', { name: 'First message', exact: true });

test('the new-conversation screen is the empty conversation, and sending from it opens the chat with that first message', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await greeting(page).waitFor();
  const launch = page.getByRole('region', { name: 'Start a conversation', exact: true });
  const send = launch.getByRole('button', { name: 'Send', exact: true });
  assert.equal(await send.isDisabled(), true, 'nothing to send yet');
  const before = await launch.locator('.composer').boundingBox();
  await first(page).fill('Explain the chart labels');
  assert.equal(await send.isEnabled(), true);
  await send.click();
  await page.locator('.message-user p').filter({ hasText: 'Explain the chart labels' }).waitFor();
  assert.equal(await launch.count(), 0, 'the conversation replaced the new-conversation screen');
  assert.equal(await message(page).inputValue(), '', 'the first message left the composer');
  assert.equal(await page.locator('.conversation-panel').getAttribute('data-empty'), null);
  const after = await page.locator('.conversation-panel .composer').boundingBox();
  assert.ok(after.y > before.y, 'the composer moved from the centre toward the bottom');
});

test('choosing a model from the new-conversation screen starts that chat and keeps the typed text as its draft', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await greeting(page).waitFor();
  await first(page).fill('Keep this for the new chat');
  await page.getByRole('button', { name: /^Model,/ }).click();
  await page.getByRole('dialog', { name: 'Choose model' }).getByRole('button', { name: /^Start new chat with / }).first().click();
  await page.getByRole('region', { name: 'Conversation', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#message')?.value === 'Keep this for the new chat');
  assert.equal(await page.locator('.conversation-panel').getAttribute('data-empty'), 'true', 'nothing was sent');
  assert.equal(await page.locator('.message').count(), 0);
});
