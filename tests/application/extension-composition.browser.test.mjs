import test from 'node:test';
import assert from 'node:assert/strict';
import { palettes, starterPalette } from '@openpane/theme';
import { ledgerExtension, ledgerService } from '../extensions/providers/conformance/ledger.mjs';
import { fixture, extensionFixture, connected, customRuntime, wait, chats, draft, tools } from './browser-support.mjs';
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
  await wait(() => page.evaluate(() => window.strictReplay?.setups === 2 && window.strictReplay.cleanups === 1), 'real development StrictMode effect replay');
  await page.getByRole('alert').filter({ hasText: 'Transcript override conflict' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.counts), { fixture: 1, other: 1 });
  await settings(page); await page.getByLabel('Transcript owner', { exact: true }).selectOption({ label: 'other' }); await chats(page);
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
  assert.equal(await page.getByLabel('Transcript owner', { exact: true }).locator('option:checked').textContent(), 'other · unavailable saved choice');
  assert.equal(await page.getByLabel('Enable other desktop UI', { exact: true }).isChecked(), false);
});

test('global UI disable keeps explicit activity choice dormant until reenable', async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  await customRuntime(page, host, `load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.13.0', activate() {
    return { modules: [], overrides: { activity: () => <p>Saved explicit activity</p> }, dispose() {} };
  } } })`);
  await settings(page); await page.getByLabel('Activity owner', { exact: true }).selectOption({ label: 'fixture' }); await chats(page);
  await page.getByText('Saved explicit activity', { exact: true }).waitFor();
  await settings(page); await page.getByLabel('Enable executable UI customizations', { exact: true }).uncheck(); await chats(page);
  await wait(async () => await page.getByText('Saved explicit activity', { exact: true }).count() === 0, 'saved global UI disablement');
  assert.equal(await page.getByRole('alert').filter({ hasText: 'Selected fixture view is unavailable' }).count(), 0);
  await settings(page);
  assert.match(await page.getByLabel('Activity owner', { exact: true }).locator('option:checked').textContent(), /^fixture/);
  await page.getByLabel('Enable executable UI customizations', { exact: true }).check(); await chats(page);
  await page.getByText('Saved explicit activity', { exact: true }).waitFor();
});

const paletteRoles = Object.keys(palettes.light);
const roleStyle = locator => locator.first().evaluate((node, roles) => Object.fromEntries(roles.map(role =>
  [role, getComputedStyle(node).getPropertyValue('--aui-color-' + role.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())).trim()])), paletteRoles);
const paintedStyle = locator => locator.first().evaluate(node => {
  const style = getComputedStyle(node);
  let painted = node;
  while (painted) {
    const candidate = getComputedStyle(painted);
    if (candidate.display !== 'contents' && candidate.backgroundColor !== 'rgba(0, 0, 0, 0)' && candidate.backgroundColor !== 'transparent') break;
    painted = painted.parentElement;
  }
  return { color: style.color, background: painted ? getComputedStyle(painted).backgroundColor : null,
    display: style.display, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height };
});
async function selectTestPalette(page, document) {
  await settings(page); await page.getByLabel('Appearance mode', { exact: true }).selectOption('light');
  await page.getByLabel('Palette JSON', { exact: true }).fill(JSON.stringify(document));
  await page.getByRole('button', { name: 'Preview palette', exact: true }).click();
  await page.getByRole('button', { name: 'Import palette', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`^Select ${document.label} `) }).click();
}
async function assertBuiltinScopes(locators, appearance = 'light') {
  for (const locator of locators) assert.deepEqual(await roleStyle(locator), palettes[appearance]);
}

test('selected canvas paints content while every host control and failed-namespace notice keeps builtin colors', { timeout: 60_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  await customRuntime(page, host, `load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.13.0', activate() {
    function Module() { const [broken, setBroken] = React.useState(false); if (broken) throw new Error('Protected palette diagnostic');
      return <button onClick={() => setBroken(true)}>Fail palette module</button>; }
    return { modules: [{ id: 'failure', label: 'Failure', component: Module }], dispose() {} };
  } } })`);
  let lostReply = false;
  await page.route('**/api/v1', async route => {
    const body = route.request().postDataJSON();
    if (!lostReply && body.op === 'submit' && body.command.body.kind === 'send') {
      lostReply = true; await route.fetch(); await route.abort();
    } else await route.continue();
  });
  await draft(page, 'Protected controls after a lost submit reply'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('region', { name: 'Approval required', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retry original command', exact: true }).waitFor();
  const controls = [page.locator('.composer'), page.getByRole('textbox', { name: 'Message', exact: true }),
    page.getByRole('button', { name: 'Send', exact: true }), page.getByRole('region', { name: 'Approval required', exact: true }),
    page.getByRole('region', { name: 'Command recovery', exact: true }), page.getByRole('button', { name: 'Retry original command', exact: true }),
    page.locator('.recovery-menu summary'), page.getByRole('navigation', { name: 'Workspace views' })];
  const baseline = await Promise.all(controls.map(paintedStyle));
  await assertBuiltinScopes(controls);
  const starter = starterPalette();
  await selectTestPalette(page, { ...starter, namespace: 'scope-test', name: 'canvas', label: 'Painted canvas', colors: {
    light: { ...starter.colors.light, canvas: '#000000', text: '#ffffff' }, dark: { ...starter.colors.dark, canvas: '#000000', text: '#ffffff' },
  } });
  await chats(page);
  const canvas = await paintedStyle(page.locator('.conversation-content'));
  assert.equal(canvas.display === 'contents', false); assert.ok(canvas.width > 0 && canvas.height > 0);
  assert.equal(canvas.background, 'rgb(0, 0, 0)');
  const assistant = await paintedStyle(page.locator('.message-assistant').first());
  assert.equal(assistant.color, 'rgb(255, 255, 255)'); assert.equal(assistant.background, 'rgb(0, 0, 0)');
  await assertBuiltinScopes(controls);
  for (const [index, control] of controls.entries()) {
    const actual = await paintedStyle(control);
    assert.equal(actual.color, baseline[index].color); assert.equal(actual.background, baseline[index].background);
  }
  const unreadable = Object.fromEntries(paletteRoles.map(role => [role, '#010101']));
  await selectTestPalette(page, { ...starter, namespace: 'scope-test', name: 'unreadable', label: 'Unreadable scopes', colors: { light: unreadable, dark: unreadable } });
  await chats(page); await assertBuiltinScopes(controls);
  assert.deepEqual(await roleStyle(page.locator('.conversation-content')), unreadable);
  for (const [index, control] of controls.entries()) {
    const actual = await paintedStyle(control);
    assert.equal(actual.color, baseline[index].color); assert.equal(actual.background, baseline[index].background);
  }
  // A local render diagnostic must paint its own readable builtin background over dark authored content.
  await tools(page); await page.getByRole('button', { name: 'Fail palette module', exact: true }).click(); await chats(page);
  const notice = page.getByRole('alert').filter({ hasText: 'Protected palette diagnostic' }).first(); await notice.waitFor();
  await assertBuiltinScopes([notice]);
  assert.equal((await paintedStyle(notice)).background, 'rgb(248, 249, 251)');
  assert.equal((await paintedStyle(notice)).color, 'rgb(32, 36, 44)');
  await page.emulateMedia({ colorScheme: 'dark' }); await settings(page); await page.getByLabel('Appearance mode', { exact: true }).selectOption('system'); await chats(page);
  await wait(async () => (await roleStyle(page.locator('.composer'))).canvas === palettes.dark.canvas, 'dark protected controls');
  await assertBuiltinScopes([...controls, notice], 'dark');
  assert.equal((await paintedStyle(notice)).background, 'rgb(21, 23, 28)');
});

test('unreadable workspace palette leaves navigation and uncertain creation recovery under all builtin roles', { timeout: 60_000 }, async t => {
  const service = await ledgerService(t), extension = ledgerExtension({ service: service.origin, key: service.key, namespace: 'fixture', supports: { cancel: true, decide: true } });
  const host = await extensionFixture(t, { extensions: [extension.value] }), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  await customRuntime(page, host, `load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.13.0', activate() {
    function Workspace(props) { return <section aria-label="Palette workspace" style={{ background: 'var(--aui-color-canvas)', color: 'var(--aui-color-text)' }}>
      <p>Authored workspace colors</p>{props.agents.map(agent => <button key={agent.id} onClick={() => props.create(agent.id)}>Start palette workspace</button>)}{props.conversation}</section>; }
    return { modules: [], workspace: { label: 'Palette workspace', component: Workspace }, dispose() {} };
  } } })`);
  const starter = starterPalette(), unreadable = Object.fromEntries(paletteRoles.map(role => [role, '#010101']));
  await selectTestPalette(page, { ...starter, namespace: 'scope-test', name: 'workspace', label: 'Unreadable workspace', colors: { light: unreadable, dark: unreadable } });
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Open Palette workspace', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Palette workspace', exact: true }); await workspace.waitFor();
  assert.deepEqual(await roleStyle(workspace), unreadable);
  assert.equal((await paintedStyle(workspace)).background, 'rgb(1, 1, 1)');
  service.loseRepliesTo('/open'); await workspace.getByRole('button', { name: 'Start palette workspace', exact: true }).click();
  const back = page.getByRole('button', { name: 'All extensions', exact: true }), recover = page.locator('.extension-status-strip').getByRole('button', { name: 'Recover creation', exact: true });
  await recover.waitFor(); await assertBuiltinScopes([back, recover, page.locator('.extension-status-strip'), page.locator('.recovery-menu summary')]);
  assert.notEqual((await paintedStyle(back)).color, 'rgb(1, 1, 1)');
  assert.notEqual((await paintedStyle(recover)).color, 'rgb(1, 1, 1)');
  assert.notEqual((await paintedStyle(recover)).background, 'rgb(1, 1, 1)');
  assert.deepEqual(await roleStyle(workspace), unreadable);
});
