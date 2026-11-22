import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { root, wait } from './browser-support.mjs';

async function hookFixture(t) {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom';
    import { useDesktopCustomizations, CustomizationTranscript } from './apps/desktop/src/application/DesktopCustomizations.tsx';
    import { createGenerationSource, createFrontendSends } from './apps/desktop/src/application/frontend-sends.ts';
    const scope = { hostId: 'host', conversationId: 'conversation' }, source = createGenerationSource();
    window.events = { setups: 0, cleanups: 0, begins: 0, clears: 0, activations: 0, disposals: 0, globalMounts: 0, borrows: 0 };
    const sink = { begin(token) { window.events.begins++; window.firstToken ??= token; window.tokenStable = token === window.firstToken; source.begin(token); },
      publish(token, snapshot) { window.tokenStable &&= token === window.firstToken; source.publish(token, snapshot); },
      clear(token) { window.events.clears++; source.clear(token); } };
    const sends = createFrontendSends({ generations: source, rowsChanged() {} });
    window.ready = sends.session({ hostId: 'host', principalId: 'principal' }, { frontendBinding() { throw new Error('No network before captured commit'); } });
    const captureStore = { borrow() { window.events.borrows++; let released = false; return { failed(error) { throw error; },
      release() { if (!released) { released = true; window.events.borrows--; } } }; } };
    window.capture = () => {
      const captured = sends.forStore({ viewId: 'view', scope, eligibility: () => 'ag-ui-capture-and-bind', capture: captureStore, recoveryNeeded() {} }).capture();
      const names = captured?.offer.tools.map(tool => tool.definition.name) ?? []; captured?.release(); return names;
    };
    window.admission = () => source.snapshot().kind;
    const manifest = { namespace: 'alpha', sdkVersion: '0.13.0', entries: [{ kind: 'desktop', module: './desktop.js' }] };
    function GlobalTranscript() { React.useLayoutEffect(() => { window.events.globalMounts++; }, []); return <p>Withdrawn global transcript</p>; }
    const alpha = { manifest, load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.13.0', activate({ frontendTools }) {
      window.events.activations++;
      frontendTools.add({ definition: { name: 'echo', description: 'Echo' }, decodeInput: value => value, execute: async () => 'original' });
      return { modules: [], overrides: { transcript: GlobalTranscript }, dispose() { window.events.disposals++; } };
    } } }) };
    const beta = { manifest: { ...manifest, namespace: 'beta' }, load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.13.0',
      activate() { return new Promise(resolve => { window.finishBeta = () => resolve({ modules: [], dispose() {} }); }); }
    } }) };
    const initial = [alpha], withBeta = [alpha, beta];
    const slots = { transcript: { kind: 'extension', namespace: 'alpha' }, activity: { kind: 'extension', namespace: 'alpha' }, contentLayout: { kind: 'extension', namespace: 'alpha' } };
    function App() {
      const [enabled, setEnabled] = React.useState(true), [disabled, setDisabled] = React.useState([]), [workspace, setWorkspace] = React.useState(true), [entries, setEntries] = React.useState(initial);
      window.restore = namespaceOnly => flushSync(() => { if (namespaceOnly) setDisabled(['alpha']); else setEnabled(false); setWorkspace(false); });
      window.addBeta = () => flushSync(() => setEntries(withBeta));
      const custom = useDesktopCustomizations({ customizations: entries, enabled, disabledNamespaces: disabled, sink, slots });
      window.selections = [custom.transcript.kind, custom.activity.kind, custom.contentLayout.kind];
      window.states = custom.namespaces.map(owner => owner.kind);
      React.useEffect(() => { window.events.setups++; return () => { window.events.cleanups++; }; }, []);
      return <><input aria-label="Persistent draft" defaultValue="Keep draft" />{workspace ? <p>Workspace scoped transcript</p>
        : <CustomizationTranscript selection={custom.transcript} conversationKey="conversation" context={{}} appendix={null} fallback={<p>Builtin Chats transcript</p>} />}</>;
    }
    const root = createRoot(document.getElementById('root'));
    window.closeFixture = async () => { root.unmount(); await sends.dispose(); };
    root.render(<React.StrictMode><App /></React.StrictMode>);
  ` }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('http://localhost/fixture', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://localhost/fixture'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => window.ready);
  await wait(() => page.evaluate(() => window.states?.includes('ready') && window.events.setups === 2), 'ready generation after actual StrictMode replay');
  return { page, errors };
}

test('actual StrictMode replay retains sink token and ready capture eligibility while another namespace loads', async t => {
  const { page, errors } = await hookFixture(t);
  assert.deepEqual(await page.evaluate(() => window.capture()), ['alpha__echo']);
  assert.equal(await page.evaluate(() => window.admission()), 'ready');
  assert.deepEqual(await page.evaluate(() => [window.events.setups, window.events.cleanups, window.events.begins, window.events.clears,
    window.events.activations, window.events.disposals, window.events.borrows, window.tokenStable]), [2, 1, 1, 0, 1, 0, 0, true]);
  await page.evaluate(() => window.addBeta());
  await wait(() => page.evaluate(() => typeof window.finishBeta === 'function'), 'selective namespace loading');
  assert.deepEqual(await page.evaluate(() => window.capture()), ['alpha__echo']);
  assert.equal(await page.evaluate(() => window.admission()), 'ready');
  await page.evaluate(() => window.finishBeta());
  await wait(() => page.evaluate(() => window.states.every(kind => kind === 'ready')), 'second generation ready');
  await page.evaluate(() => window.closeFixture()); assert.deepEqual(errors, []);
});

for (const namespaceOnly of [false, true]) test(`restoring from workspace suppresses withdrawn global transcript before layout effects (${namespaceOnly ? 'namespace' : 'global'})`, async t => {
  const { page, errors } = await hookFixture(t), draft = page.getByRole('textbox', { name: 'Persistent draft' });
  const previous = await draft.elementHandle();
  await page.evaluate(namespaceOnly => window.restore(namespaceOnly), namespaceOnly);
  await page.getByText('Builtin Chats transcript', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.events.globalMounts), 0, 'withdrawn transcript must never mount while the host changes conversation placement');
  assert.equal(await page.evaluate(() => window.admission()), 'ready');
  assert.deepEqual(await page.evaluate(() => window.selections), namespaceOnly ? ['missing', 'missing', 'missing'] : ['default', 'default', 'default']);
  assert.deepEqual(await page.evaluate(() => window.capture()), [], 'capture-eligible admission sees a ready empty generation set');
  assert.equal(await draft.evaluate((node, original) => node === original, previous), true);
  assert.equal(await draft.inputValue(), 'Keep draft');
  await page.evaluate(() => window.closeFixture()); assert.deepEqual(errors, []);
});
