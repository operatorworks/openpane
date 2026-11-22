import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, connected, customRuntime, wait, chats } from './browser-support.mjs';
const settings = page => page.getByRole('button', { name: 'Settings', exact: true }).click();
const entry = name => `load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.13.0', activate() {
  window.counts ??= {}; window.counts['${name}'] = (window.counts['${name}'] ?? 0) + 1;
  return { modules: [], overrides: { transcript: () => <p>${name} transcript</p> }, dispose() { window.disposals ??= {}; window.disposals['${name}'] = (window.disposals['${name}'] ?? 0) + 1; } };
} } })`;

test('StrictMode replay keeps one activation; explicit owner persists and selective disable preserves its neighbor', async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  const extra = `,{manifest: { namespace: 'other', trust: 'full', sdkVersion: '0.13.0', entries: [{kind:'desktop', module:'./other.js'}]}, ${entry('other')}}`;
  await customRuntime(page, host, entry('fixture'), false, extra, true);
  await page.getByRole('alert').filter({ hasText: 'Transcript override conflict' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.counts), { fixture: 1, other: 1 });
  await settings(page); await page.getByLabel('Transcript owner', { exact: true }).selectOption('other'); await chats(page);
  await page.getByText('other transcript', { exact: true }).waitFor();
  await settings(page); await page.getByLabel('Enable fixture desktop UI', { exact: true }).uncheck(); await chats(page);
  await page.getByText('other transcript', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.counts), { fixture: 1, other: 1 });
  assert.equal(await page.evaluate(() => window.disposals.fixture), 1);
  await settings(page); await page.getByLabel('Enable other desktop UI', { exact: true }).uncheck(); await chats(page);
  await page.getByRole('alert').filter({ hasText: 'Selected other view is unavailable' }).waitFor();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Send remains eligible without executable generations');
  await wait(() => page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), 'saved draft send eligibility');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(async () => (await host.entries()).some(row => row.type === 'submit' || JSON.stringify(row).includes('Send remains eligible')), 'real submitted send');
  await page.reload(); await connected(page); await settings(page);
  assert.equal(await page.getByLabel('Transcript owner', { exact: true }).inputValue(), 'other');
  assert.equal(await page.getByLabel('Enable other desktop UI', { exact: true }).isChecked(), false);
});
