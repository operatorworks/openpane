import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalPaletteText, palettes, starterPalette } from '@openpane/theme';
import { fixture, connected, draft, wait, customRuntime } from './browser-support.mjs';
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
  assert.equal((await colors(page, '.conversation-content')).accent, palettes.dark.accent, 'import alone does not select');
  await select.click(); await wait(async () => (await colors(page, '.conversation-content')).accent === '#cc55aa', 'selected content palette');
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
  assert.equal((await colors(page, '.conversation-content')).accent, palettes.dark.accent);
  await page.getByLabel('Palette JSON', { exact: true }).fill(exported);
  await page.getByRole('button', { name: 'Preview palette', exact: true }).click(); await page.getByRole('button', { name: 'Import palette', exact: true }).click();
  await page.getByRole('button', { name: /^Select Exchange palette / }).click();
  await chats(page); assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'keep this draft');
  await page.locator('.recovery-menu summary').click(); await page.getByRole('button', { name: 'Restore default appearance', exact: true }).first().click();
  await wait(async () => (await colors(page, '.conversation-content')).accent === palettes.light.accent, 'appearance recovery');
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

test('the same JSON editor advances its own saved base across consecutive successful edits', async t => {
  const host = await fixture(t), page = await host.page(); await settings(page);
  await page.getByRole('button', { name: 'Edit preferences JSON', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Preferences JSON', exact: true });
  const original = JSON.parse(await editor.inputValue());
  for (const appearance of ['dark', 'light']) {
    const text = JSON.stringify({ ...original, appearance }, null, 2);
    await editor.fill(text); await page.getByRole('button', { name: 'Save JSON', exact: true }).click();
    await wait(async () => await rootAppearance(page) === appearance, `saved ${appearance} in the same editor`);
    assert.equal(await editor.inputValue(), text);
    assert.equal(await page.getByRole('status').filter({ hasText: 'Saved locally.' }).count(), 1);
  }
  const saved = await page.evaluate(async () => {
    const opening = indexedDB.open('openpane-personalization', 1), db = await new Promise(resolve => { opening.onsuccess = () => resolve(opening.result); });
    const request = db.transaction('preferences').objectStore('preferences').get('current');
    const row = await new Promise(resolve => { request.onsuccess = () => resolve(request.result); }); db.close(); return row;
  });
  assert.equal(saved.revision, 2);
  assert.equal(saved.document.appearance, 'light');
});

test('valid preferences larger than the palette limit export and import in a fresh profile', async t => {
  const host = await fixture(t), page = await host.page(); await settings(page);
  await page.getByRole('button', { name: 'Edit preferences JSON', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Preferences JSON', exact: true });
  const original = JSON.parse(await editor.inputValue());
  const document = { ...original, appearance: 'dark', ui: { ...original.ui, enabled: false,
    disabledNamespaces: Array.from({ length: 5000 }, (_, index) => `namespace-${index.toString(36).padStart(4, '0')}`) } };
  await editor.fill(JSON.stringify(document)); await page.getByRole('button', { name: 'Save JSON', exact: true }).click();
  await wait(async () => await rootAppearance(page) === 'dark', 'large preference save');
  await page.getByRole('button', { name: 'Export preferences', exact: true }).click();
  const exported = await page.getByRole('textbox', { name: 'Exported JSON', exact: true }).inputValue();
  assert.ok(Buffer.byteLength(exported, 'utf8') > 65536, 'actual exported file exceeds the palette-specific limit');
  assert.deepEqual(JSON.parse(exported), document);
  assert.deepEqual(Object.keys(JSON.parse(exported)), ['version', 'appearance', 'palette', 'ui']);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON', exact: true }).click()]);
  const downloaded = await download.path();
  assert.equal(await readFile(downloaded, 'utf8'), exported);
  const context = await host.browser.newContext(); t.after(() => context.close());
  const fresh = await context.newPage(); await fresh.goto(`${host.origin}/browser.html`); await settings(fresh);
  await fresh.getByLabel('Import preferences file', { exact: true }).setInputFiles(downloaded);
  assert.equal(await fresh.getByRole('textbox', { name: 'Preferences JSON', exact: true }).inputValue(), exported);
  await fresh.getByRole('button', { name: 'Save JSON', exact: true }).click();
  await wait(async () => await rootAppearance(fresh) === 'dark', 'large preference import committed');
  await fresh.getByRole('button', { name: 'Export preferences', exact: true }).click();
  assert.deepEqual(JSON.parse(await fresh.getByRole('textbox', { name: 'Exported JSON', exact: true }).inputValue()), document);
  assert.equal(await fresh.getByLabel('Enable executable UI customizations', { exact: true }).isChecked(), false);
});

test('reserved mode names remain selectable as explicit extension namespaces after reload', async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  const entry = namespace => `load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.14.0', activate() {
    return { modules: [], overrides: { transcript() { return <p>${namespace} claimant transcript</p>; } }, dispose() {} };
  } } })`;
  await customRuntime(page, host, entry('fixture'), false,
    `, {manifest:{...manifest,namespace:'builtin'},${entry('builtin')}}, {manifest:{...manifest,namespace:'automatic'},${entry('automatic')}}`);
  for (const namespace of ['builtin', 'automatic']) {
    await settings(page);
    const select = page.getByLabel('Transcript owner', { exact: true });
    await select.selectOption({ label: namespace });
    await chats(page); await page.getByText(`${namespace} claimant transcript`, { exact: true }).waitFor();
    await page.reload(); await connected(page); await settings(page);
    assert.equal(await select.inputValue(), `extension:${namespace}`);
    await page.getByRole('button', { name: 'Export preferences', exact: true }).click();
    const saved = JSON.parse(await page.getByRole('textbox', { name: 'Exported JSON', exact: true }).inputValue());
    assert.deepEqual(saved.ui.slots.transcript, { kind: 'extension', namespace });
    await chats(page); await page.getByText(`${namespace} claimant transcript`, { exact: true }).waitFor();
  }
});

test('Copy JSON explains the selectable fallback when clipboard capability is absent', async t => {
  const host = await fixture(t), page = await host.page(); await settings(page);
  await page.getByRole('button', { name: 'Export starter palette', exact: true }).click();
  const exported = page.getByRole('textbox', { name: 'Exported JSON', exact: true });
  const text = await exported.inputValue();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));
  await page.getByRole('button', { name: 'Copy JSON', exact: true }).click();
  assert.match((await page.getByRole('status').allTextContents()).join('\n'), /Select and copy the exported JSON\./);
  assert.equal(await exported.inputValue(), text);
});

test('a reopened JSON editor cannot inherit a prior editor save base while readback is pending', async t => {
  const host = await fixture(t), page = await host.page(); await settings(page);
  await page.getByRole('textbox', { name: 'Palette JSON', exact: true }).fill(JSON.stringify(starterPalette()));
  await page.getByRole('button', { name: 'Preview palette', exact: true }).click(); await page.getByRole('button', { name: 'Import palette', exact: true }).click();
  await page.getByRole('button', { name: /^Select My palette / }).waitFor();
  await page.getByRole('button', { name: 'Edit preferences JSON', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Preferences JSON', exact: true });
  const original = JSON.parse(await editor.inputValue());
  await editor.fill(JSON.stringify({ ...original, appearance: 'dark' }));
  await page.evaluate(() => {
    const original = crypto.subtle.digest.bind(crypto.subtle); let first = true;
    globalThis.digestHeld = false; globalThis.priorSaveReadbackComplete = false;
    crypto.subtle.digest = async (...args) => {
      if (!first) return original(...args);
      first = false; globalThis.digestHeld = true; await new Promise(resolve => { globalThis.releaseDigest = resolve; });
      const result = await original(...args); globalThis.priorSaveReadbackComplete = true; return result;
    };
  });
  await page.getByRole('button', { name: 'Save JSON', exact: true }).click(); await page.waitForFunction(() => globalThis.digestHeld);
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await page.getByRole('button', { name: 'Edit preferences JSON', exact: true }).click();
  assert.equal(JSON.parse(await editor.inputValue()).appearance, original.appearance);
  await page.evaluate(() => globalThis.releaseDigest()); await page.waitForFunction(() => globalThis.priorSaveReadbackComplete);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await wait(async () => await rootAppearance(page) === 'dark', 'prior editor save confirmed');
  const reopened = JSON.parse(await editor.inputValue());
  await editor.fill(JSON.stringify({ ...reopened, ui: { ...reopened.ui, slots: { ...reopened.ui.slots, activity: { kind: 'builtin' } } } }));
  await page.getByRole('button', { name: 'Save JSON', exact: true }).click();
  await wait(async () => /preferences changed/.test((await page.getByRole('status').allTextContents()).join(' ')), 'reopened stale editor refusal');
  assert.equal(await rootAppearance(page), 'dark');
  assert.equal(JSON.parse(await editor.inputValue()).appearance, original.appearance);
});

test('an older JSON save acknowledgment cannot overwrite a newer refused draft status', async t => {
  const host = await fixture(t), page = await host.page(); await settings(page);
  await page.getByRole('textbox', { name: 'Palette JSON', exact: true }).fill(JSON.stringify(starterPalette()));
  await page.getByRole('button', { name: 'Preview palette', exact: true }).click(); await page.getByRole('button', { name: 'Import palette', exact: true }).click();
  await page.getByRole('button', { name: /^Select My palette / }).waitFor();
  await page.getByRole('button', { name: 'Edit preferences JSON', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Preferences JSON', exact: true }), original = JSON.parse(await editor.inputValue());
  await editor.fill(JSON.stringify({ ...original, appearance: 'dark' }));
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle); let first = true;
    globalThis.firstSaveReadbackComplete = false;
    crypto.subtle.digest = async (...args) => {
      if (!first) return digest(...args);
      first = false; globalThis.firstSaveHeld = true;
      await new Promise(resolve => { globalThis.releaseFirstSave = resolve; });
      const result = await digest(...args); globalThis.firstSaveReadbackComplete = true; return result;
    };
  });
  await page.getByRole('button', { name: 'Save JSON', exact: true }).click(); await page.waitForFunction(() => globalThis.firstSaveHeld);
  const newestDraft = JSON.stringify({ ...original, appearance: 'light' }); await editor.fill(newestDraft);
  await page.getByRole('button', { name: 'Save JSON', exact: true }).click();
  await wait(async () => /preferences changed/.test((await page.getByRole('status').allTextContents()).join(' ')), 'newest draft refusal shown');
  await page.evaluate(() => globalThis.releaseFirstSave()); await page.waitForFunction(() => globalThis.firstSaveReadbackComplete);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.match((await page.getByRole('status').allTextContents()).join(' '), /preferences changed/);
  assert.equal(await editor.inputValue(), newestDraft);
  assert.equal(await rootAppearance(page), 'dark');
});
