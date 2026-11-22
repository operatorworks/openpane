import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPaletteText, palettes, starterPalette } from '@openpane/theme';
import { fixture, connected, draft, wait } from './browser-support.mjs';
const settings = page => page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Settings', exact: true }).click();
const chats = page => page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).click();
const rootAppearance = page => page.locator('.desktop-shell').getAttribute('data-appearance');
const colors = (page, selector) => page.locator(selector).first().evaluate(node => Object.fromEntries(['canvas','surface','raised','text','muted','border','controlBorder','accent','onAccent','danger','onDanger','focus'].map(role => [role, getComputedStyle(node).getPropertyValue('--aui-color-' + role.replace(/[A-Z]/g, x => '-' + x.toLowerCase())).trim()])));

test('palette exchange persists without activating code and recovery stays builtin across all roles', async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page); await draft(page, 'keep this draft');
  await settings(page);
  await page.getByLabel('Appearance mode', { exact: true }).selectOption('dark');
  await wait(async () => await rootAppearance(page) === 'dark', 'dark appearance');
  const starter = starterPalette();
  const document = { ...starter, namespace: 'exchange', name: 'unreadable', label: 'Exchange palette', colors: {
    light: { ...starter.colors.light, text: starter.colors.light.canvas, accent: '#114477' },
    dark: { ...starter.colors.dark, text: starter.colors.dark.canvas, accent: '#cc55aa' },
  } };
  await page.getByLabel('Palette JSON', { exact: true }).fill(JSON.stringify(document));
  await page.getByRole('button', { name: 'Preview palette', exact: true }).click();
  await page.getByRole('button', { name: 'Import palette', exact: true }).click();
  const select = page.getByRole('button', { name: /^Select Exchange palette / }); await select.waitFor();
  assert.equal((await colors(page, '.chat-view')).accent, palettes.dark.accent, 'import alone does not select');
  await select.click(); await wait(async () => (await colors(page, '.chat-view')).accent === '#cc55aa', 'selected content palette');
  assert.deepEqual(await colors(page, '.desktop-shell'), palettes.dark);
  assert.deepEqual(await colors(page, '.settings-panel'), palettes.dark);
  assert.deepEqual(await colors(page, '.recovery-menu summary'), palettes.dark);
  await page.reload(); await settings(page);
  await wait(async () => await rootAppearance(page) === 'dark', 'saved dark appearance');
  await page.getByRole('button', { name: /^Export Exchange palette / }).click();
  const exported = await page.getByLabel('Exported JSON', { exact: true }).inputValue();
  assert.equal(exported, canonicalPaletteText(document));
  await page.getByRole('button', { name: /^Remove palette / }).click();
  await wait(async () => await page.getByRole('button', { name: /^Select Exchange palette / }).count() === 0, 'removed resource');
  assert.equal((await colors(page, '.chat-view')).accent, palettes.dark.accent);
  await page.getByLabel('Palette JSON', { exact: true }).fill(exported);
  await page.getByRole('button', { name: 'Preview palette', exact: true }).click(); await page.getByRole('button', { name: 'Import palette', exact: true }).click();
  await page.getByRole('button', { name: /^Select Exchange palette / }).click();
  await chats(page); assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'keep this draft');
  await page.locator('.recovery-menu summary').click(); await page.getByRole('button', { name: 'Restore default appearance', exact: true }).first().click();
  await wait(async () => (await colors(page, '.chat-view')).accent === palettes.light.accent, 'appearance recovery');
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'keep this draft');
  await page.emulateMedia({ colorScheme: 'dark' }); await wait(async () => await rootAppearance(page) === 'dark', 'live OS appearance');
  assert.deepEqual(await colors(page, '.recovery-menu summary'), palettes.dark);
  // A fresh browser profile starts with independent choices and can import the portable export.
  const context = await host.browser.newContext(); const fresh = await context.newPage(); await fresh.goto(`${host.origin}/browser.html`); await settings(fresh);
  assert.equal(await rootAppearance(fresh), 'light');
  await fresh.getByLabel('Palette JSON', { exact: true }).fill(exported); await fresh.getByRole('button', { name: 'Preview palette', exact: true }).click(); await fresh.getByRole('button', { name: 'Import palette', exact: true }).click();
  await fresh.getByRole('button', { name: /^Select Exchange palette / }).waitFor(); await context.close();
});

test('JSON editor retains a stale draft and refuses to overwrite another window', async t => {
  const host = await fixture(t), page = await host.page(); await settings(page);
  await page.getByRole('button', { name: 'Edit preferences JSON', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Preferences JSON', exact: true }); const original = await editor.inputValue();
  const other = await page.context().newPage(); await other.goto(`${host.origin}/browser.html`); await settings(other);
  await other.getByLabel('Appearance mode', { exact: true }).selectOption('dark'); await wait(async () => await rootAppearance(other) === 'dark', 'other window committed');
  await page.getByRole('button', { name: 'Save JSON', exact: true }).click();
  await wait(async () => /changed|stale|newer|another/i.test(await page.locator('[role="status"]').allTextContents().then(x => x.join(' '))), 'stale editor diagnostic');
  assert.equal(await editor.inputValue(), original); assert.equal(await rootAppearance(page), 'dark');
});
