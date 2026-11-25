import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readExperienceDirectory } from '../../apps/host/build/tsc/experience-bundle.js';
import { requestUi } from '../../apps/host/build/tsc/ui-control.js';
import { fixture, connected, draft, root, wait } from './browser-support.mjs';

test('optional messenger experience validates, preserves keyboard controls and follows system accessibility preferences', { timeout: 45000 }, async t => {
  const bundle = await readExperienceDirectory(join(root, 'examples/experiences/messenger-2002'));
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page); await draft(page, 'Example keeps my draft');
  const context = await requestUi(socket, { op: 'context' }); assert.equal(context.selection.selected.kind, 'builtin');
  const result = await requestUi(socket, { op: 'apply', expectedRevision: context.revision, requestId: `${context.requestEpoch}:${randomUUID()}`, bundle });
  await wait(async () => (await requestUi(socket, { op: 'status', requestId: result.receipt.requestId })).outcome === 'all-rendered', 'optional example painted');
  for (const name of ['Chats', 'Extensions', 'Settings']) {
    const button = page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name, exact: true });
    assert.equal(await button.isVisible(), true); await button.focus(); assert.equal(await button.evaluate(node => node === document.activeElement), true);
    await button.press('Enter');
  }
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).click();
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce', forcedColors: 'active' });
    await wait(() => page.locator('.desktop-shell').getAttribute('data-appearance').then(value => value === colorScheme), `system ${colorScheme}`);
    await wait(() => page.locator('.desktop-shell').getAttribute('data-reduced-motion').then(value => value === 'true'), 'system reduced motion');
    const recovery = page.getByRole('button', { name: 'Restore OpenPane appearance', exact: true }); assert.equal(await recovery.isVisible(), true);
    await recovery.focus(); assert.equal(await recovery.evaluate(node => document.activeElement === node), true);
  }
  await page.getByRole('button', { name: 'Restore OpenPane appearance', exact: true }).click();
  await wait(async () => (await requestUi(socket, { op: 'context' })).selection.selected.kind === 'builtin', 'example restore');
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Example keeps my draft');
});
