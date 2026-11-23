import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fixture, connected, draft, wait } from './browser-support.mjs';
import { createExperienceBundle, sha256 } from '../../apps/host/build/tsc/experience-bundle.js';
import { requestUi } from '../../apps/host/build/tsc/ui-control.js';

const stack = panes => ({ kind: 'stack', panes });
function bundle(home, color = '#123456') {
  const css = `[data-openpane-part="header"] { background-color: ${color}; }`;
  return createExperienceBundle({ schemaVersion: 2, id: 'home-test', label: 'Home test',
    theme: { mode: 'light', density: 'compact', light: {}, dark: {} },
    presentation: { home, transcript: 'lines', navigation: 'pages', chats: 'inline', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } },
    stylesheet: 'style.css', assets: [{ name: 'style.css', mimeType: 'text/css', bytes: Buffer.byteLength(css), sha256: sha256(css) }] }, css, []);
}
async function apply(host, value) {
  const socket = join(host.directory, 'ui.sock'), context = await requestUi(socket, { op: 'context' });
  return requestUi(socket, { op: 'apply', requestId: `${context.requestEpoch}:${randomUUID()}`, expectedRevision: context.revision, bundle: value });
}
async function rendered(host, result) {
  const socket = join(host.directory, 'ui.sock'); let outcome;
  await wait(async () => { outcome = await requestUi(socket, { op: 'status', requestId: result.receipt.requestId }); return outcome.outcome !== 'pending'; }, 'Home render outcome');
  assert.equal(outcome.outcome, 'all-rendered', JSON.stringify(outcome));
}
const route = (page, name) => page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name, exact: true });
const panes = page => page.locator('[data-home-pane]:visible').evaluateAll(nodes => nodes.map(node => node.dataset.homePane));

test('real home panes share one editor across opposite order, routes, omission and inline open', { timeout: 60000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  const editor = page.locator('textarea#message');
  await editor.fill('Approval stability probe'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  const approval = page.getByRole('region', { name: 'Approval required', exact: true, includeHidden: true }); await approval.waitFor();
  await draft(page, 'Home preserves this exact unsent draft');
  const original = await editor.elementHandle(), decision = await approval.elementHandle(), commands = (await host.entries()).length;
  await editor.focus(); await editor.evaluate(node => node.setSelectionRange(3, 8));
  const value = bundle({ kind: 'columns', primary: ['conversation'], secondary: ['conversations'], balance: 'primary-wide' });
  await rendered(host, await apply(host, value));
  assert.equal(await route(page, 'Chats').getAttribute('aria-pressed'), 'true', 'live apply preserves route');
  for (const name of ['Home', 'Chats', 'Settings', 'Home', 'Chats']) {
    await route(page, name).click();
    assert.equal(await editor.evaluate((node, old) => node === old, original), true);
    assert.equal(await approval.evaluate((node, old) => node === old, decision), true);
    assert.equal(await editor.inputValue(), 'Home preserves this exact unsent draft');
  }
  await route(page, 'Home').click(); assert.deepEqual(await panes(page), ['conversation', 'conversations']);
  await editor.focus();
  await rendered(host, await apply(host, bundle(stack(['agents', 'conversations']), '#234567')));
  assert.deepEqual(await panes(page), ['agents', 'conversations']);
  assert.equal(await page.locator('.home-heading').evaluate(node => document.activeElement === node), true);
  assert.equal(await page.locator('textarea#message').count(), 1, 'hidden editor remains owned once');
  assert.equal(await editor.isVisible(), false);
  assert.ok(await page.locator('[data-openpane-role="agent-row"]').count() > 0);
  await page.getByRole('navigation', { name: 'Host conversations' }).getByRole('button').first().click();
  await wait(() => editor.isVisible(), 'inline open reveals omitted editor');
  assert.equal(await route(page, 'Chats').getAttribute('aria-pressed'), 'true');
  assert.equal(await editor.evaluate((node, old) => node === old, original), true);
  assert.equal((await host.entries()).length, commands, 'composition/navigation did not send or approve');
  await route(page, 'Home').click(); await page.setViewportSize({ width: 600, height: 850 });
  const boxes = await page.locator('[data-home-pane]:visible').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; }));
  assert.ok(boxes[1].top >= boxes[0].bottom - 1, 'narrow Home stacks in reading order');
  await route(page, 'Extensions').click(); assert.equal(await route(page, 'Settings').isVisible(), true);
});

test('structural deliveries and builtin restore wait for IME without exposing a partial or superseded frame', { timeout: 60000 }, async t => {
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page); await draft(page, 'Keep composition');
  const first = bundle(stack(['conversation', 'conversations'])); await rendered(host, await apply(host, first));
  const editor = page.getByRole('textbox', { name: 'Message', exact: true }), original = await editor.elementHandle(); await editor.focus();
  await editor.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionstart', { data: 'composing', bubbles: true })));
  const second = await apply(host, bundle({ kind: 'columns', primary: ['conversations'], secondary: ['conversation'], balance: 'secondary-wide' }, '#abcdef'));
  await wait(() => page.locator('.experience-content').getAttribute('data-experience-phase').then(value => value === 'composition-deferred'), 'composition deferral');
  assert.equal((await requestUi(socket, { op: 'status', requestId: second.receipt.requestId })).outcome, 'pending');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), first.digest);
  assert.equal(await page.locator('.shell-header').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(18, 52, 86)');
  const latest = bundle(stack(['conversations', 'conversation', 'status']), '#345678');
  const third = await apply(host, latest);
  await wait(async () => (await requestUi(socket, { op: 'status', requestId: second.receipt.requestId })).outcome === 'superseded', 'older held candidate superseded');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), first.digest);
  await editor.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { data: 'composing', bubbles: true })));
  await rendered(host, third);
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), latest.digest);
  assert.equal(await editor.evaluate((node, old) => node === old, original), true);
  await editor.focus(); await editor.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionstart', { data: 'restore', bubbles: true })));
  await page.keyboard.press('Control+Shift+Backspace');
  await wait(() => page.locator('.experience-content').getAttribute('data-experience-phase').then(value => value === 'composition-deferred'), 'restore deferral');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), latest.digest);
  await editor.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { data: 'restore', bubbles: true })));
  await wait(() => page.locator('.experience-content').getAttribute('data-openpane-experience').then(value => value === null), 'builtin visual restore');
  assert.equal(await editor.evaluate((node, old) => node === old, original), true); assert.equal(await editor.inputValue(), 'Keep composition');
  assert.equal((await host.entries()).length, 0);
});

test('cold v2 startup chooses Home while the first live apply on Settings preserves explicit navigation', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await route(page, 'Settings').click();
  await rendered(host, await apply(host, bundle(stack(['agents', 'status']))));
  assert.equal(await route(page, 'Settings').getAttribute('aria-pressed'), 'true');
  await page.reload();
  await wait(() => route(page, 'Home').getAttribute('aria-pressed').then(value => value === 'true'), 'cold selected v2 Home');
  assert.deepEqual(await panes(page), ['agents', 'status']);
  assert.equal(await route(page, 'Chats').isVisible(), true);
  await page.getByRole('button', { name: 'Restore OpenPane appearance', exact: true }).click();
  await wait(() => route(page, 'Chats').getAttribute('aria-pressed').then(value => value === 'true'), 'restore Home to builtin Chats');
  assert.equal((await host.entries()).length, 0);
});

test('AIM example restyles real controls and saved cards, compacts fine-pointer rows, and retains coarse targets', { timeout: 60000 }, async t => {
  const { readExperienceDirectory } = await import('../../apps/host/build/tsc/experience-bundle.js');
  const { publishCard } = await import('./metrics-card-support.mjs');
  const { default: Ajv } = await import('ajv');
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  const discovery = await requestUi(socket, { op: 'schema' });
  const validate = new Ajv({ strict: true }).compile(discovery.manifest);
  const value = await readExperienceDirectory(new URL('../../examples/experiences/aim-classic/', import.meta.url).pathname);
  assert.ok(validate(value.manifest)); assert.ok(discovery.roles.button.includes('send'));
  const invalid = structuredClone(value.manifest); invalid.presentation.home = { kind: 'columns', primary: ['agents'], secondary: ['agents'], balance: 'even' };
  assert.equal(validate(invalid), false, 'CLI-returned schema enforces cross-region uniqueness');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Synthetic style specimen');
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.getByRole('region', { name: 'Approval required', exact: true }).waitFor();
  await draft(page, 'AIM keeps this draft');
  const saved = await publishCard(host, page, 'Synthetic style card');
  const card = page.locator(`[data-publication-id="${saved.publicationId}"]`); await card.waitFor();
  const originalCard = await card.elementHandle(), editor = page.locator('textarea#message'), originalEditor = await editor.elementHandle();
  const before = await requestUi(socket, { op: 'display-status', scope: saved.scope, publicationId: saved.publicationId });
  const commandCount = (await host.entries()).length;
  await rendered(host, await apply(host, value));
  assert.equal(await card.evaluate((node, old) => node === old, originalCard), true);
  assert.equal(await editor.evaluate((node, old) => node === old, originalEditor), true);
  assert.equal(await card.evaluate(node => getComputedStyle(node).borderRadius), '0px');
  assert.equal(await card.locator('.metrics-card-title > span').evaluate(node => getComputedStyle(node).color), 'rgb(255, 255, 255)');
  assert.equal(await editor.evaluate(node => getComputedStyle(node).borderRadius), '0px');
  assert.match(await page.locator('[data-openpane-part="message-author"]').first().evaluate(node => getComputedStyle(node).fontFamily), /Times/);
  assert.equal(await page.locator('[data-openpane-part="message-author"][data-openpane-state="local"]').first().evaluate(node => getComputedStyle(node).color), 'rgb(176, 0, 0)');
  assert.match(await page.locator('.shell-header').evaluate(node => getComputedStyle(node).backgroundImage), /linear-gradient/);
  const chats = route(page, 'Chats');
  const buttonBox = await chats.boundingBox();
  await page.mouse.move(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2); await page.mouse.down();
  assert.equal(await chats.evaluate(node => getComputedStyle(node).borderTopStyle), 'inset');
  await page.mouse.move(2, 2); await page.mouse.up();
  await route(page, 'Home').click();
  const rowHeight = await page.locator('[data-openpane-role="agent-row"]').first().evaluate(node => node.getBoundingClientRect().height);
  assert.ok(rowHeight >= 24 && rowHeight <= 32, `compact row is ${rowHeight}px`);
  await route(page, 'Settings').click();
  const checkbox = page.locator('input[type="checkbox"]').first(), select = page.locator('select:visible').first();
  assert.equal(await checkbox.evaluate(node => getComputedStyle(node).appearance), 'none');
  assert.equal(await select.evaluate(node => getComputedStyle(node).appearance), 'none');
  await page.keyboard.press('Tab'); await checkbox.focus(); assert.notEqual(await checkbox.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await wait(() => checkbox.evaluate(node => getComputedStyle(node).appearance === 'auto'), 'native forced-color checkbox');
  assert.notEqual(await checkbox.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });
  const touch = await host.browser.newContext({ hasTouch: true, viewport: { width: 900, height: 820 } });
  try {
    const coarse = await touch.newPage(); await coarse.goto(`${host.origin}/browser.html`);
    await wait(() => route(coarse, 'Home').getAttribute('aria-pressed').then(value => value === 'true'), 'coarse Home startup');
    const target = coarse.locator('[data-openpane-role="agent-row"]').first();
    assert.ok(await target.evaluate(node => node.getBoundingClientRect().height) >= 44);
    assert.ok(await coarse.getByRole('button', { name: 'Restore OpenPane appearance', exact: true }).evaluate(node => node.getBoundingClientRect().height) >= 44);
    await coarse.close();
  } finally { await touch.close(); }
  assert.deepEqual(await requestUi(socket, { op: 'display-status', scope: saved.scope, publicationId: saved.publicationId }), before);
  assert.equal((await host.entries()).length, commandCount, 'styling, navigation and control inspection did not send/query');
});


test('off-route unusable Home and transparent Send fail without painting the candidate', { timeout: 60000 }, async t => {
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  await draft(page, 'Protected validation draft');
  const good = bundle(stack(['agents', 'conversations'])); await rendered(host, await apply(host, good));
  for (const [destination, css] of [['Settings', '[data-openpane-part="pane-heading"] { color: transparent; }'], ['Settings', '[data-openpane-part="button"][data-openpane-role="send"] { color: transparent; }']]) {
    await route(page, destination).click();
    const bad = createExperienceBundle({ ...good.manifest, assets: [{ name: 'style.css', mimeType: 'text/css', bytes: Buffer.byteLength(css), sha256: sha256(css) }] }, css, []);
    await page.evaluate(() => { globalThis.paintedDigests = []; globalThis.sampleAppearance = true; const frame = () => { globalThis.paintedDigests.push(document.querySelector('.experience-content').dataset.openpaneExperience); if (globalThis.sampleAppearance) requestAnimationFrame(frame); }; requestAnimationFrame(frame); });
    const result = await apply(host, bad);
    await wait(async () => (await requestUi(socket, { op: 'status', requestId: result.receipt.requestId })).outcome === 'failed', 'invalid candidate fails');
    const painted = await page.evaluate(() => { globalThis.sampleAppearance = false; return globalThis.paintedDigests; });
    assert.ok(!painted.includes(bad.digest), 'invalid appearance never reaches an animation frame');
    assert.equal(await route(page, destination).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('textarea#message').inputValue(), 'Protected validation draft');
  }
});

test('failed pane replacement restores the same focused editor and caret', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  await draft(page, 'Keep the exact selected draft');
  await rendered(host, await apply(host, bundle(stack(['conversation', 'conversations'])))); await route(page, 'Home').click();
  const editor = page.locator('textarea#message'), original = await editor.elementHandle();
  await editor.focus(); await editor.evaluate(node => node.setSelectionRange(4, 13, 'backward'));
  const css = '[data-openpane-part="pane-heading"] { color: transparent; }', base = bundle(stack(['agents', 'conversations']));
  const bad = createExperienceBundle({ ...base.manifest, assets: [{ name: 'style.css', mimeType: 'text/css', bytes: Buffer.byteLength(css), sha256: sha256(css) }] }, css, []);
  const result = await apply(host, bad);
  await wait(async () => (await requestUi(socket, { op: 'status', requestId: result.receipt.requestId })).outcome === 'failed', 'bad replacement fails');
  assert.deepEqual(await editor.evaluate((node, old) => ({ same: node === old, focused: node === document.activeElement, start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection }), original), { same: true, focused: true, start: 4, end: 13, direction: 'backward' });
  assert.equal(await route(page, 'Home').getAttribute('aria-pressed'), 'true');
});

test('a locally validated frame survives supersession while its editor is composing and paint confirmation is held', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page); await draft(page, 'Composition stays on the validated frame');
  await rendered(host, await apply(host, bundle(stack(['conversation', 'conversations'])))); await route(page, 'Home').click();
  const next = bundle(stack(['conversations', 'conversation']), '#345678');
  await page.evaluate(digest => {
    globalThis.originalAppearanceFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = callback => globalThis.originalAppearanceFrame(time => {
      if (document.querySelector('.experience-content')?.dataset.openpaneExperience === digest) (globalThis.heldAppearanceFrames ??= []).push(() => callback(time)); else callback(time);
    });
  }, next.digest);
  await apply(host, next);
  await wait(() => page.locator('.experience-content').getAttribute('data-openpane-experience').then(value => value === next.digest), 'locally validated B');
  const editor = page.locator('textarea#message'), original = await editor.elementHandle(); await editor.focus();
  await editor.evaluate(node => { node.setSelectionRange(2, 9); node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'composing' })); });
  const last = bundle(stack(['conversation', 'status', 'conversations']), '#456789'), receipt = await apply(host, last);
  await wait(() => page.locator('.experience-content').getAttribute('data-experience-phase').then(value => value === 'composition-deferred'), 'C is held for composition');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), next.digest);
  assert.deepEqual(await panes(page), ['conversations', 'conversation']);
  assert.deepEqual(await editor.evaluate((node, old) => ({ same: node === old, focused: node === document.activeElement, start: node.selectionStart, end: node.selectionEnd }), original), { same: true, focused: true, start: 2, end: 9 });
  await editor.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'composing' })));
  await page.evaluate(() => { window.requestAnimationFrame = globalThis.originalAppearanceFrame; for (const release of globalThis.heldAppearanceFrames ?? []) release(); });
  await rendered(host, receipt); assert.deepEqual(await panes(page), ['conversation', 'status', 'conversations']);
});

test('keyboard builtin restore preserves a non-composing editor and backward selection through pane reorder', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page); await draft(page, 'Restore keeps this selected draft');
  await rendered(host, await apply(host, bundle(stack(['conversation', 'conversations'])))); await route(page, 'Home').click();
  const editor = page.locator('textarea#message'), original = await editor.elementHandle(); await editor.focus(); await editor.evaluate(node => node.setSelectionRange(3, 11, 'backward'));
  await page.keyboard.press('Control+Shift+Backspace');
  await wait(() => page.locator('.experience-content').getAttribute('data-openpane-experience').then(value => value === null), 'keyboard local builtin restore');
  assert.deepEqual(await editor.evaluate((node, old) => ({ same: node === old, focused: node === document.activeElement, start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection }), original), { same: true, focused: true, start: 3, end: 11, direction: 'backward' });
  assert.equal(await editor.inputValue(), 'Restore keeps this selected draft');
});
