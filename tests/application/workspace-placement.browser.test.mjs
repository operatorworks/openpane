import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

async function fixture(t, kind) {
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { BrowserApplication } from './apps/desktop/src/shell/BrowserApplication.tsx';
    import { fixture as controllerFixture } from './tests/application/controller-fixture.mjs';
    import { CoworkersWorkspace } from './extensions/coworkers/src/desktop/CoworkersWorkspace.tsx';
    import { CrewWorkspace } from './extensions/crew/src/desktop/CrewWorkspace.tsx';
    let kind, props; const root = createRoot(document.getElementById('root')), pending = [];
    globalThis.calls = [];
    globalThis.mountCapturedChild = () => {
      const f = controllerFixture(), snapshot = { ...f.app.getSnapshot(), capturedSends: [{ key: 'original-capture', viewId:'child', status:'waiting',binding:null,
        command:{version:2,scope:{hostId:'host',conversationId:'chat'},clientCommandId:'original',body:{kind:'send',text:'Captured message'}} }] };
      const controller = { ...f.app, getSnapshot: () => snapshot, releaseCapturedSend: async key => { globalThis.calls.push(key); } };
      root.render(<BrowserApplication fixedChat managedLifecycle controller={controller} />);
    };

    const action = input => { globalThis.calls.push(input); return new Promise(resolve => pending.push(resolve)); };
    const render = () => root.render(kind === 'crew' ? <CrewWorkspace {...props} /> : <CoworkersWorkspace {...props} />);
    globalThis.mount = value => {
      kind = value;
      props = { namespace: kind, installations: [{ installationId: 'one', status: 'available' }], agents: ['Ada','Grace'].map((label,index) => ({
        id: 'agent-' + index, label, providerAgentId: 'member-' + index, installationId: 'one', availability: { kind: 'ready' } })),
        conversations: { entries: ['a','b'].map((id,index) => ({ scope: { hostId:'host',conversationId:id }, preview: id,
          provider: { namespace:kind,installationId:'one',providerAgentId:'member-' + index } })), hasMore:false,loading:false,more() {} },
        selected:null,conversation:<p>Inline conversation</p>,open: action,create:action,refresh:async()=>{},call:async()=>({kind:'ok',output:null}) };
      render();
    };
    globalThis.selectOther = () => { props = { ...props, selected: { hostId:'host',conversationId:'b' } }; render(); };
    globalThis.finish = result => { for (const resolve of pending.splice(0)) resolve(result); };
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' } });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
  await page.goto('http://localhost/'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  if (kind === 'captured-child') await page.evaluate(() => globalThis.mountCapturedChild());
  else await page.evaluate(kind => globalThis.mount(kind), kind); return page;
}

test('an unrelated inline selection cannot consume a pending Coworkers action result', async t => {
  const page = await fixture(t, 'coworkers'); await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.evaluate(() => globalThis.selectOther());
  await page.getByText('Inline conversation').waitFor();
  assert.equal(await page.locator('.coworkers-workspace').getAttribute('data-pane'), 'list');
  await page.evaluate(() => globalThis.finish({ kind: 'detached', scope: { hostId:'host',conversationId:'new-chat' },label:'child' }));
  await page.getByRole('alert').getByText('Chat opened in its own window.').waitFor();
});

test('changing Crew member keeps its earlier creation in flight until it settles', async t => {
  const page = await fixture(t, 'crew'); await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await page.locator('.crew-member-row').filter({ hasText: 'Grace' }).click();
  assert.equal(await page.getByRole('button', { name: 'Start conversation', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('.crew-conversation-row').isDisabled(), true);
  assert.equal(await page.evaluate(() => globalThis.calls.length), 1);
  await page.evaluate(() => globalThis.finish({ kind:'detached',scope:{hostId:'host',conversationId:'new-chat'},label:'child' }));
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.calls.length), 2, 'a fresh action is available after the original settles');
});


test('a fixed chat shows captured send status and its release control', async t => {
  const page = await fixture(t, 'captured-child'); await page.getByRole('heading', { name:'Opening chat' }).waitFor();
  assert.equal(await page.getByRole('region', { name:'Captured tools' }).count(), 1);
  await page.getByRole('status').filter({ hasText:'Waiting for confirmed run' }).waitFor();
  await page.getByRole('button', { name:'Release captured tools', exact:true }).click();
  assert.deepEqual(await page.evaluate(() => globalThis.calls), ['original-capture']);
});
