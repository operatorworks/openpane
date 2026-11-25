import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, connected, customRuntime, draft, wait, root } from './browser-support.mjs';
import { createExperienceBundle, readExperienceDirectory, sha256 } from '../../apps/host/build/tsc/experience-bundle.js';
import { requestUi } from '../../apps/host/build/tsc/ui-control.js';

function bundle(css) {
  return createExperienceBundle({ schemaVersion: 2, id: 'interaction', label: 'Interaction',
    theme: { density: 'comfortable', mode: 'system', light: {}, dark: {} },
    presentation: { home: { kind: 'stack', panes: ['conversations', 'conversation'] }, transcript: 'bubbles', navigation: 'rail', chats: 'inline', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } },
    stylesheet: 'style.css', assets: [{ name: 'style.css', mimeType: 'text/css', bytes: Buffer.byteLength(css), sha256: sha256(css) }] }, css, []);
}
async function application(t) {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  await customRuntime(page, host, "load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.14.0', activate() { return { modules: [], dispose() {} }; } } })");
  await wait(() => page.locator('[data-customization-namespace="fixture"]').first().getAttribute('data-customization-state').then(state => state === 'ready'), 'healthy no-op namespace');
  await draft(page, 'Retain text and editor through appearance recovery');
  return { host, page, editor: page.locator('#message'), socket: join(host.directory, 'ui.sock') };
}
async function apply(socket, value) {
  const context = await requestUi(socket, { op: 'context' });
  const requestId = `${context.requestEpoch}:${randomUUID()}`;
  await requestUi(socket, { op: 'apply', requestId, expectedRevision: context.revision, bundle: value });
  let status;
  await wait(async () => { status = await requestUi(socket, { op: 'status', requestId }); return status.outcome !== 'pending'; }, 'appearance paint');
  assert.equal(status.outcome, 'all-rendered', JSON.stringify(status));
}

for (const [stylesheet, composition] of [['loaded', 'none'], ['failed', 'none'], ['loaded', 'before-rejection'], ['loaded', 'after-rejection']]) test(`an installed delivery rejected while its PNG restage is held stays rejected (${stylesheet} CSS, ${composition} IME)`, { timeout: 45000 }, async t => {
  const { png } = await import('../host/image-fixtures.mjs');
  const { page, editor, socket } = await application(t), original = await editor.elementHandle();
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).click();
  await page.mouse.move(0, 0);
  const base = bundle('[data-openpane-part="button"][data-openpane-role="navigation"]:hover { color: #ffffff; background-color: #ffffff; background-image: none; }');
  const bytes = png(), value = createExperienceBundle({ ...base.manifest, assets: [...base.manifest.assets,
    { name: 'frame.png', mimeType: 'image/png', bytes: bytes.length, sha256: sha256(bytes) }] }, base.stylesheet,
  [{ name: 'frame.png', base64: bytes.toString('base64') }]);
  await apply(socket, value);
  let releaseStylesheet, stylesheetRequested;
  const heldStylesheet = new Promise(resolve => { releaseStylesheet = resolve; }), requested = new Promise(resolve => { stylesheetRequested = resolve; });
  await page.route(`**/ui-assets/${value.digest}/style.css`, async route => {
    stylesheetRequested(); await heldStylesheet;
    if (stylesheet === 'failed') await route.fulfill({ status: 404, body: 'missing' });
    else await route.continue();
  });
  try {
    await page.evaluate(digest => {
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = async function () {
        await decode.call(this); window.restageDecodeHeld = true;
        await new Promise(resolve => { window.releaseRestageDecode = resolve; });
      };
      window.restagedSheetOutcome = null;
      window.restagedSheetObserver = new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof HTMLLinkElement && node.href.includes(digest)) {
            window.restagedSheet = node;
            node.addEventListener('load', () => { window.restagedSheetOutcome = 'loaded'; }, { once: true });
            node.addEventListener('error', () => { window.restagedSheetOutcome = 'failed'; }, { once: true });
          }
        }
      });
      window.restagedSheetObserver.observe(document.head, { childList: true });
    }, value.digest);
    for (const visibility of ['hidden', 'visible']) {
      await page.evaluate(visibility => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility }); document.dispatchEvent(new Event('visibilitychange')); }, visibility);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    await page.waitForFunction(() => window.restageDecodeHeld);
    if (composition === 'before-rejection') {
      await editor.focus(); await editor.dispatchEvent('compositionstart', { data: 'あ' });
    }
    await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).hover();
    const rejectedPhase = composition === 'before-rejection' ? 'composition-deferred' : 'failed';
    await wait(async () => await page.locator('.experience-content').getAttribute('data-experience-phase') === rejectedPhase, 'installed frame rejected during restage');
    const diagnostic = await page.locator('.experience-recovery [role="status"]').textContent();
    assert.match(diagnostic, composition === 'before-rejection' ? /Appearance recovery waiting for text input to finish/ : /unreadable text/);
    await page.mouse.move(0, 0);
    if (composition === 'after-rejection') {
      await editor.focus(); await editor.dispatchEvent('compositionstart', { data: 'あ' });
    }
    await page.evaluate(() => window.releaseRestageDecode());
    await requested;
    assert.equal(await page.evaluate(() => window.restagedSheetOutcome), null, 'the later stylesheet has not settled yet');
    releaseStylesheet();
    await page.waitForFunction(expected => window.restagedSheetOutcome === expected && window.restagedSheet &&
      (!window.restagedSheet.isConnected || window.restagedSheet.media === 'all' ||
        document.querySelector('.experience-recovery [role="status"]')?.textContent === 'Appearance waiting for text input to finish'), stylesheet);
    const settledFrame = await page.evaluate(() => ({ connected: window.restagedSheet.isConnected,
      notice: document.querySelector('.experience-recovery [role="status"]')?.textContent,
      phase: document.querySelector('.experience-content')?.getAttribute('data-experience-phase') }));
    assert.equal(settledFrame.connected, false, `the rejected restaged link is removed after its actual load/error: ${JSON.stringify(settledFrame)}`);
    assert.equal(await page.locator('.experience-recovery [role="status"]').textContent(), diagnostic, 'keep the first installed-frame rejection');
    assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), composition === 'before-rejection' ? value.digest : null);
    assert.equal(await page.locator('.experience-content').getAttribute('data-experience-phase'), rejectedPhase);
    if (composition !== 'none') {
      await editor.dispatchEvent('compositionend', { data: 'あ' });
      await wait(async () => await page.locator('.experience-content').getAttribute('data-experience-phase') === 'failed', 'rejection remains after composition ends');
      assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), null);
    }
    assert.equal(await editor.evaluate((node, before) => node === before, original), true);
    assert.equal(await editor.inputValue(), 'Retain text and editor through appearance recovery');
  } finally {
    releaseStylesheet();
    await editor.dispatchEvent('compositionend', { data: 'cleanup' }).catch(() => {});
    await page.evaluate(() => { window.releaseRestageDecode?.(); window.restagedSheetObserver?.disconnect(); });
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

for (const interaction of ['hover', 'focus', 'dark']) test(`an unreadable ${interaction} state recovers locally without replacing the editor or host selection`, { timeout: 45000 }, async t => {
  const { host, page, editor, socket } = await application(t), original = await editor.elementHandle();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).click();
  await page.mouse.move(0, 0);
  const target = '[data-openpane-part="button"][data-openpane-role="navigation"]';
  const css = interaction === 'hover' ? `${target}:hover { color: #ffffff; background-color: #ffffff; background-image: none; }`
    : interaction === 'focus' ? '[data-openpane-part="textarea"]:focus { color: #ffffff; background-color: #ffffff; background-image: none; }'
      : `@media (prefers-color-scheme: dark) { ${target} { color: #000000; background-color: #000000; background-image: none; } }`;
  const value = bundle(css); await apply(socket, value);
  if (interaction === 'hover') await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).hover();
  else if (interaction === 'focus') await editor.focus();
  else await page.emulateMedia({ colorScheme: 'dark' });
  await wait(async () => await page.locator('.experience-content').getAttribute('data-experience-phase') === 'failed', 'local interaction recovery');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), null);
  assert.equal(await editor.inputValue(), 'Retain text and editor through appearance recovery');
  assert.equal(await editor.evaluate((node, before) => node === before, original), true);
  assert.equal((await requestUi(socket, { op: 'context' })).selection.selected.digest, value.digest, 'local recovery does not change the shared selection');
  assert.equal(await page.locator('.experience-recovery').getByRole('button', { name: 'Restore OpenPane appearance' }).isVisible(), true);
  assert.equal((await host.entries()).length, 0);
});

test('AIM and Messenger retain readable hover, focus and dark variants', { timeout: 60000 }, async t => {
  const { page, editor, socket } = await application(t), original = await editor.elementHandle();
  for (const name of ['aim-classic', 'messenger-2002']) {
    await page.emulateMedia({ colorScheme: 'light' }); await page.mouse.move(0, 0);
    await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).click();
    const value = await readExperienceDirectory(fileURLToPath(new URL(`../../examples/experiences/${name}/`, import.meta.url)));
    await apply(socket, value);
    const chats = page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true });
    await chats.hover(); await editor.focus(); await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.experience-content').getAttribute('data-experience-phase'), 'committed', name);
    assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), value.digest);
    assert.equal(await editor.evaluate((node, before) => node === before, original), true);
    assert.equal(await editor.inputValue(), 'Retain text and editor through appearance recovery');
  }
});

test('interaction recovery preserves composition and defers structural builtin fallback until composition ends', { timeout: 45000 }, async t => {
  const { page, editor, socket } = await application(t), original = await editor.elementHandle();
  await page.emulateMedia({ colorScheme: 'light' });
  const value = bundle('@media (prefers-color-scheme: dark) { [data-openpane-part="textarea"] { color: #000000; background-color: #000000; background-image: none; } }');
  await apply(socket, value);
  await editor.focus();
  await editor.dispatchEvent('compositionstart', { data: 'あ' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await wait(async () => await page.locator('.experience-content').getAttribute('data-experience-phase') === 'composition-deferred', 'composition-safe local recovery');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), value.digest);
  assert.equal(await editor.evaluate((node, before) => node === before, original), true);
  assert.equal(await editor.inputValue(), 'Retain text and editor through appearance recovery');
  await editor.dispatchEvent('compositionend', { data: 'あ' });
  await wait(async () => await page.locator('.experience-content').getAttribute('data-experience-phase') === 'failed', 'finished composition recovery');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), null);
  assert.equal(await editor.evaluate((node, before) => node === before, original), true);
  assert.equal(await editor.inputValue(), 'Retain text and editor through appearance recovery');
});


test('a rejected delivery stays rejected after a hide/show cycle', { timeout: 45000 }, async t => {
  const { page, socket } = await application(t);
  const css = '[data-openpane-part="button"][data-openpane-role="navigation"]:hover { color: #ffffff; background-color: #ffffff; background-image: none; }';
  await page.mouse.move(0, 0); await apply(socket, bundle(css));
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).hover();
  await wait(async () => await page.locator('.experience-content').getAttribute('data-experience-phase') === 'failed', 'initial rejection');
  await page.mouse.move(0, 0);
  for (const visibility of ['hidden', 'visible']) {
    await page.evaluate(visibility => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility }); document.dispatchEvent(new Event('visibilitychange')); }, visibility);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.experience-content').getAttribute('data-experience-phase'), 'failed');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), null);
});

test('select chevrons do not bypass the selected text contrast check', { timeout: 45000 }, async t => {
  const { socket } = await application(t), context = await requestUi(socket, { op: 'context' });
  const value = bundle('[data-openpane-part="select"] { color: #ffffff; background-color: #ffffff; }'), requestId = `${context.requestEpoch}:${randomUUID()}`;
  await requestUi(socket, { op: 'apply', requestId, expectedRevision: context.revision, bundle: value });
  let status;
  await wait(async () => { status = await requestUi(socket, { op: 'status', requestId }); return status.outcome !== 'pending'; }, 'select contrast result');
  assert.equal(status.outcome, 'failed', JSON.stringify(status));
});

for (const successor of ['same-delivery', 'builtin']) test(`IME retains its stylesheet and current caret before ${successor} recovery`, { timeout: 45000 }, async t => {
  const { page, socket, editor } = await application(t), original = await editor.elementHandle();
  const css = '[data-openpane-part="textarea"] { font-size: 28px; line-height: 2; } [data-openpane-part="button"][data-openpane-role="navigation"]:hover { color: #ffffff; background-color: #ffffff; background-image: none; }';
  const base = bundle(css), manifest = { ...base.manifest, presentation: { ...base.manifest.presentation, navigation: 'pages', transcript: 'lines' } };
  const value = createExperienceBundle(manifest, css, []);
  await page.mouse.move(0, 0); await apply(socket, value);
  await editor.focus(); await editor.evaluate(node => node.setSelectionRange(4, 4));
  await editor.dispatchEvent('compositionstart', { data: 'あ' });
  const before = await editor.evaluate(node => ({ font: getComputedStyle(node).fontSize, leading: getComputedStyle(node).lineHeight }));
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).hover();
  await wait(async () => await page.locator('.experience-content').getAttribute('data-experience-phase') === 'composition-deferred', 'readability recovery defers');
  if (successor === 'builtin') {
    const context = await requestUi(socket, { op: 'context' });
    await requestUi(socket, { op: 'restore', requestId: `recovery:${context.recoveryGeneration}:${randomUUID()}`, expectedRevision: context.revision, expectedRecoveryGeneration: context.recoveryGeneration });
    await page.locator('.experience-recovery').getByRole('status').filter({ hasText: 'Appearance waiting for text input to finish' }).waitFor();
    assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-navigation'), 'pages');
    assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-transcript'), 'lines');
  }
  assert.deepEqual(await editor.evaluate(node => ({ font: getComputedStyle(node).fontSize, leading: getComputedStyle(node).lineHeight })), before);
  await editor.evaluate(node => node.setSelectionRange(9, 9));
  await editor.dispatchEvent('compositionend', { data: 'あ' });
  await wait(async () => await page.locator('.experience-content').getAttribute('data-openpane-experience') === null, 'composition ends before builtin frame');
  assert.equal(await editor.evaluate((node, old) => node === old, original), true);
  assert.equal(await editor.evaluate(node => node.selectionStart), 9);
  assert.equal(await editor.inputValue(), 'Retain text and editor through appearance recovery');
});

test('an approval inserted while idle is checked before unreadable controls remain active', { timeout: 45000 }, async t => {
  const { page, socket } = await application(t);
  await apply(socket, bundle('[data-openpane-part="button"][data-openpane-role="approval"] { color: #ffffff; background-color: #ffffff; background-image: none; }'));
  let release, seen;
  const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { seen = resolve; });
  t.after(() => release());
  await page.route('**/api/v1', async route => {
    const response = await route.fetch(), text = await response.text();
    if (text.includes('Approve this recorded run?')) { seen(); await held; }
    await route.fulfill({ response, body: text });
  });
  await page.locator('#message').evaluate(node => node.form.requestSubmit());
  await pending;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  release();
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const phase = await page.locator('.experience-content').getAttribute('data-experience-phase');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  assert.equal(phase, 'failed');
});


for (const [name, css, expected] of [
  ['stacked translucent gradients', '[data-openpane-part="button"][data-openpane-role="navigation"] { color: #000000; background-color: transparent; background-image: linear-gradient(to right, #00000010, #00000020); } [data-openpane-part="page-rail"] { background-color: #000000; background-image: linear-gradient(to right, #000000, #080808); }', 'failed'],
  ['paired translucent text contrast', '[data-openpane-part="button"][data-openpane-role="navigation"] { color: #00000080; background-image: linear-gradient(to right, #999999, #ffffff); }', 'all-rendered'],
]) test(`gradient validation handles ${name}`, { timeout: 45000 }, async t => {
  const { socket } = await application(t), context = await requestUi(socket, { op: 'context' }), requestId = `${context.requestEpoch}:${randomUUID()}`;
  await requestUi(socket, { op: 'apply', requestId, expectedRevision: context.revision, bundle: bundle(css) });
  let status;
  await wait(async () => { status = await requestUi(socket, { op: 'status', requestId }); return status.outcome !== 'pending'; }, 'gradient result');
  assert.equal(status.outcome, expected, JSON.stringify(status));
});


test('inserting a full-trust module control does not give it authority over the inert appearance', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page(), socket = join(host.directory, 'ui.sock');
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  await customRuntime(page, host, `load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.14.0', activate() {
    function Module() { const [show, setShow] = React.useState(false); React.useEffect(() => { window.showModuleControl = () => setShow(true); }, []);
      return show ? <button data-openpane-part="button" style={{ color: '#ffffff', backgroundColor: '#ffffff' }}>Module-owned control</button> : null; }
    return { modules: [{ id: 'module', label: 'Module', component: Module }], dispose() {} };
  } } })`);
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Extensions', exact: true }).click();
  await wait(() => page.evaluate(() => typeof window.showModuleControl === 'function'), 'module mounted');
  const value = bundle('[data-openpane-part="page-header"] { color: #20242c; }'); await apply(socket, value);
  await page.evaluate(() => window.showModuleControl());
  await page.getByRole('button', { name: 'Module-owned control', exact: true }).waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.experience-content').getAttribute('data-experience-phase'), 'committed');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), value.digest);
});


test('selective disable withdraws only its ready tool namespace before palette hashing finishes', { timeout: 45000 }, async t => {
  const { build } = await import('esbuild');
  const source = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {PersonalizationSession} from './apps/desktop/src/application/use-personalization.tsx';
    import {useDesktopCustomizations} from './apps/desktop/src/application/DesktopCustomizations.tsx';
    import {createFrontendSends,createGenerationSource} from './apps/desktop/src/application/frontend-sends.ts';
    import {starterPalette} from '@openpane/theme';
    const session=new PersonalizationSession(); session.start();
    const source=createGenerationSource(), owner=createFrontendSends({generations:source,rowsChanged(){}});
    window.ready=owner.session({hostId:'host',principalId:'principal'},{frontendBinding(){throw Error('No network before commit');}});
    const customizations=['fixture','other'].map(namespace=>({manifest:{namespace,sdkVersion:'0.14.0',entries:[{kind:'desktop',module:'./desktop.js'}]},
      load:async()=>({default:{kind:'desktop',sdkVersion:'0.14.0',activate({frontendTools}){frontendTools.add({definition:{name:'echo',description:'Echo'},decodeInput:x=>x,async execute(){return 'ok';}});return {modules:[],dispose(){}};}}})}));
    const captureStore={borrow(){return {failed(error){throw error;},release(){}};}};
    const admission=owner.forStore({recoveryNeeded(){},viewId:'view',scope:{hostId:'host',conversationId:'conversation'},capture:captureStore,eligibility:()=> 'ag-ui-capture-and-bind'});
    function App(){const state=React.useSyncExternalStore(session.subscribe,session.getSnapshot,session.getSnapshot);
      window.custom=useDesktopCustomizations({customizations,enabled:state.document.ui.enabled,disabledNamespaces:state.document.ui.disabledNamespaces,loading:state.readiness==='loading',sink:source});return <input aria-label="Persistent tool draft" defaultValue="Keep draft"/>;}
    window.capture=()=>{const capture=admission.capture();const names=capture.offer.tools.map(tool=>tool.definition.name);capture.release();return names;};
    window.disable=async()=>{await session.importPalette(JSON.stringify(starterPalette()));
      const digest=crypto.subtle.digest.bind(crypto.subtle); let release; const held=new Promise(resolve=>{release=resolve;});
      crypto.subtle.digest=async(...args)=>{window.digestEntered=true;await held;return digest(...args);};
      window.releaseHash=release;window.disabling=session.patchPreferences({kind:'namespace-enabled',namespace:'fixture',enabled:false});
      window.finish=async()=>{release();await window.disabling;crypto.subtle.digest=digest;session.close();owner.dispose();};};
    createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const host = await fixture(t), page = await host.browser.newPage();
  await page.route('**/selective-admission', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto(host.origin + '/selective-admission'); await page.addScriptTag({ content: source.outputFiles[0].text });
  await wait(() => page.evaluate(() => window.custom?.namespaces.filter(owner => owner.kind === 'ready').length === 2), 'two ready namespaces');
  await page.evaluate(() => window.ready);
  assert.deepEqual(await page.evaluate(() => window.capture()), ['fixture__echo', 'other__echo']);
  await page.evaluate(() => window.disable());
  await wait(() => page.evaluate(() => window.digestEntered), 'held unrelated digest');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const names = await page.evaluate(() => window.capture());
  await page.evaluate(() => window.finish());
  assert.deepEqual(names, ['other__echo']);
  assert.equal(await page.getByRole('textbox', { name: 'Persistent tool draft' }).inputValue(), 'Keep draft');
});


test('a failed successor delivery cannot cancel an IME-deferred readability recovery', { timeout: 45000 }, async t => {
  const { page, socket, editor, host } = await application(t), original = await editor.elementHandle();
  const css = '[data-openpane-part="textarea"] { font-size: 28px; line-height: 2; } [data-openpane-part="button"][data-openpane-role="navigation"]:hover { color: #ffffff; background-color: #ffffff; background-image: none; }';
  const base = bundle(css), value = createExperienceBundle({ ...base.manifest, presentation: { ...base.manifest.presentation, navigation: 'pages' } }, css, []);
  await page.mouse.move(0, 0); await apply(socket, value);
  await editor.focus(); await editor.evaluate(node => node.setSelectionRange(4, 4));
  await editor.dispatchEvent('compositionstart', { data: 'あ' });
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).hover();
  await wait(async () => await page.locator('.experience-content').getAttribute('data-experience-phase') === 'composition-deferred', 'readability recovery held for composition');
  const failed = bundle('[data-openpane-part="page-header"] { color: #123456; }');
  await page.route(`**/ui-assets/${failed.digest}/style.css`, route => route.fulfill({ status: 404, body: 'missing' }));
  const context = await requestUi(socket, { op: 'context' }), requestId = `${context.requestEpoch}:${randomUUID()}`;
  await requestUi(socket, { op: 'apply', requestId, expectedRevision: context.revision, bundle: failed });
  await wait(async () => (await requestUi(socket, { op: 'status', requestId })).outcome === 'failed', 'successor stylesheet refused');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), value.digest, 'the mounted IME frame waits for composition to finish');
  assert.equal(await editor.evaluate(node => getComputedStyle(node).fontSize), '28px');
  await editor.evaluate(node => node.setSelectionRange(9, 9));
  await editor.dispatchEvent('compositionend', { data: 'あ' });
  await wait(async () => await page.locator('.experience-content').getAttribute('data-openpane-experience') === null, 'rejected prior visual is removed after composition');
  assert.equal(await page.locator(`link[href*="${value.digest}"]`).count(), 0);
  assert.equal(await editor.evaluate((node, before) => node === before, original), true);
  assert.equal(await editor.inputValue(), 'Retain text and editor through appearance recovery');
  assert.equal(await editor.evaluate(node => node.selectionStart), 9);
  assert.equal((await host.entries()).length, 0);
});

test('deferred readability recovery settles when React unmounts the composing Settings editor', { timeout: 45000 }, async t => {
  const { page, socket, editor } = await application(t);
  await page.emulateMedia({ colorScheme: 'light' });
  const value = bundle('@media (prefers-color-scheme: dark) { [data-openpane-part="button"][data-openpane-role="navigation"] { color: #000000; background-color: #000000; background-image: none; } }');
  await apply(socket, value);
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Edit preferences JSON', exact: true }).click();
  const preferences = page.getByRole('textbox', { name: 'Preferences JSON', exact: true });
  await preferences.focus(); await preferences.dispatchEvent('compositionstart', { data: 'あ' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await wait(async () => await page.locator('.experience-content').getAttribute('data-experience-phase') === 'composition-deferred', 'readability recovery held for composition');
  await page.getByRole('button', { name: 'Close editor', exact: true }).evaluate(node => node.click());
  assert.equal(await preferences.count(), 0);
  await wait(async () => await page.locator('.experience-content').getAttribute('data-experience-phase') === 'failed', 'React unmount settles pending recovery');
  assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), null);
  assert.equal(await page.locator(`link[href*="${value.digest}"]`).count(), 0);
  assert.equal(await editor.inputValue(), 'Retain text and editor through appearance recovery');
});

test('essential Settings field captions must remain readable independently of their controls', { timeout: 45000 }, async t => {
  const { socket } = await application(t), context = await requestUi(socket, { op: 'context' }), requestId = `${context.requestEpoch}:${randomUUID()}`;
  const css = '[data-openpane-part="field-label"] { color: #000000; background-color: #000000; } [data-openpane-part="checkbox"], [data-openpane-part="input"], [data-openpane-part="textarea"], [data-openpane-part="select"] { color: #000000; background-color: #ffffff; }';
  await requestUi(socket, { op: 'apply', requestId, expectedRevision: context.revision, bundle: bundle(css) });
  let status;
  await wait(async () => { status = await requestUi(socket, { op: 'status', requestId }); return status.outcome !== 'pending'; }, 'caption validation result');
  assert.equal(status.outcome, 'failed', JSON.stringify(status));
});


for (const successor of ['loading-failure', 'loading-success', 'failed-before-interaction']) test(`the installed appearance remains monitored through ${successor}`, { timeout: 45000 }, async t => {
  const { page, socket, editor, host } = await application(t), original = await editor.elementHandle();
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).click();
  await page.mouse.move(0, 0);
  const installed = bundle('[data-openpane-part="textarea"]:focus { color: #ffffff; background-color: #ffffff; background-image: none; }');
  await apply(socket, installed);
  const replacement = bundle('[data-openpane-part="page-header"] { border: 2px solid #123456; }');
  let release, entered, requests = 0;
  const held = new Promise(resolve => { release = resolve; }), staging = new Promise(resolve => { entered = resolve; });
  await page.route(`**/ui-assets/${replacement.digest}/style.css`, async route => {
    requests++; entered(); await held;
    if (successor === 'loading-success') await route.continue();
    else await route.fulfill({ status: 404, body: 'missing' });
  });
  try {
    const context = await requestUi(socket, { op: 'context' }), requestId = `${context.requestEpoch}:${randomUUID()}`;
    await requestUi(socket, { op: 'apply', requestId, expectedRevision: context.revision, bundle: replacement });
    await staging;
    if (successor === 'failed-before-interaction') {
      release();
      await wait(async () => (await requestUi(socket, { op: 'status', requestId })).outcome === 'failed', 'replacement fails before interaction');
      assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), installed.digest);
    }
    await editor.focus();
    await wait(async () => await page.locator('.experience-content').getAttribute('data-openpane-experience') === null, 'the installed frame rejects unreadable focus');
    assert.equal(await page.locator(`link[href*="${installed.digest}"]`).count(), 0);
    assert.equal(await editor.inputValue(), 'Retain text and editor through appearance recovery');
    assert.equal(await editor.evaluate((node, before) => node === before, original), true);
    if (successor !== 'failed-before-interaction') {
      assert.equal((await requestUi(socket, { op: 'status', requestId })).outcome, 'pending', 'rejecting the installed frame does not fail its pending successor');
      release();
    }
    const expected = successor === 'loading-success' ? 'all-rendered' : 'failed';
    await wait(async () => (await requestUi(socket, { op: 'status', requestId })).outcome === expected, 'the replacement gets its own outcome');
    assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), successor === 'loading-success' ? replacement.digest : null);
    if (successor === 'failed-before-interaction') {
      for (const visibility of ['hidden', 'visible']) {
        await page.evaluate(visibility => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility }); document.dispatchEvent(new Event('visibilitychange')); }, visibility);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      await page.waitForTimeout(100);
      assert.equal(requests, 1, 'the newer failed delivery remains sticky after its old frame also fails');
    }
    assert.equal((await host.entries()).length, 0);
  } finally { release(); await page.unrouteAll({ behavior: 'ignoreErrors' }); }
});


test('a delayed paint failure cannot replace the installed appearance rejection notice', { timeout: 45000 }, async t => {
  const { page, socket, editor } = await application(t), original = await editor.elementHandle();
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).click();
  await page.mouse.move(0, 0);
  const value = bundle('[data-openpane-part="button"][data-openpane-role="navigation"]:hover { color: #ffffff; background-color: #ffffff; background-image: none; }');
  let release, entered, held = false;
  const pending = new Promise(resolve => { release = resolve; }), painting = new Promise(resolve => { entered = resolve; });
  await page.route('**/api/ui/v1', async route => {
    const request = route.request().postDataJSON();
    if (!held && request.op === 'paint' && request.digest === value.digest) {
      held = true; entered(); await pending;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'unavailable', error: 'Paint confirmation unavailable' }) });
    } else await route.continue();
  });
  try {
    const context = await requestUi(socket, { op: 'context' }), requestId = `${context.requestEpoch}:${randomUUID()}`;
    await requestUi(socket, { op: 'apply', requestId, expectedRevision: context.revision, bundle: value });
    await painting;
    await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).hover();
    await wait(async () => await page.locator('.experience-content').getAttribute('data-experience-phase') === 'failed', 'installed appearance rejected before paint reply');
    assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), null);
    const diagnostic = await page.locator('.experience-recovery [role="status"]').textContent();
    assert.match(diagnostic, /unreadable text/);
    const failedResponse = page.waitForResponse(response => {
      if (!response.url().endsWith('/api/ui/v1') || response.status() !== 503) return false;
      const request = response.request().postDataJSON(); return request.op === 'paint' && request.digest === value.digest;
    });
    release();
    await (await failedResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.experience-recovery [role="status"]').textContent(), diagnostic);
    assert.equal(await page.locator('.experience-content').getAttribute('data-openpane-experience'), null);
    assert.equal(await page.locator('.experience-content').getAttribute('data-experience-phase'), 'failed');
    assert.equal(await editor.evaluate((node, before) => node === before, original), true);
    assert.equal(await editor.inputValue(), 'Retain text and editor through appearance recovery');
  } finally { release(); await page.unrouteAll({ behavior: 'ignoreErrors' }); }
});
