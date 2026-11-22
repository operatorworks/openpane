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
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'message', 'focus follows the composer into the conversation');
  // Transition names apply only while the morph runs.
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-morphing'), null, { timeout: 3000 });
});

test('with reduced motion the same start swaps instantly and still sends', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { window.transitions = 0; const start = document.startViewTransition?.bind(document); if (start) document.startViewTransition = update => { window.transitions++; return start(update); }; });
  await first(page).fill('No motion please');
  await page.getByRole('region', { name: 'Start a conversation', exact: true }).getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.message-user p').filter({ hasText: 'No motion please' }).waitFor();
  assert.equal(await page.evaluate(() => window.transitions), 0);
});

test('choosing a model from the new-conversation screen starts that chat and keeps the typed text as its draft', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await greeting(page).waitFor();
  const launch = { greeting: await greeting(page).boundingBox(), composer: await page.locator('.new-conversation .composer').boundingBox() };
  await first(page).fill('Keep this for the new chat');
  await page.getByRole('button', { name: /^Model,/ }).click();
  await page.getByRole('dialog', { name: 'Choose model' }).getByRole('button', { name: /^Start new chat with / }).first().click();
  await page.getByRole('region', { name: 'Conversation', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#message')?.value === 'Keep this for the new chat');
  assert.equal(await page.locator('.conversation-panel').getAttribute('data-empty'), 'true', 'nothing was sent');
  assert.equal(await page.locator('.message').count(), 0);
  // The empty conversation draws the greeting and composer where the new-conversation screen drew them.
  const empty = { greeting: await page.locator('.conversation-panel .conversation-greeting').boundingBox(), composer: await page.locator('.conversation-panel .composer').boundingBox() };
  for (const part of ['greeting', 'composer']) for (const key of ['x', 'width']) assert.ok(Math.abs(launch[part][key] - empty[part][key]) <= 2, `${part} ${key}`);
  assert.ok(Math.abs(launch.greeting.y - empty.greeting.y) <= 24, 'greeting stays in place');
});
