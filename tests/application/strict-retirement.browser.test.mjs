import assert from 'node:assert/strict';
import test from 'node:test';
import { root, wait } from './browser-support.mjs';

for (const slot of ['layout', 'transcript']) test(`StrictMode ${slot} activation waits for complete retirement and keeps late cleanup failures sticky`, { timeout: 45_000 }, async t => {
  const { build } = await import('esbuild'), { chromium } = await import('playwright');
  const bundle = await build({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom';
    import { CustomizationContent } from './apps/desktop/src/application/CustomizationContent.tsx';
    import { CustomizationTranscript, useDesktopCustomizations } from './apps/desktop/src/application/DesktopCustomizations.tsx';
    window.activations = 0; window.loads = 0; window.disposals = []; window.mounts = []; window.finish = {}; window.finishCleanup = {};
    const customizations = [{ manifest: { namespace: 'strict', sdkVersion: '0.13.0', entries: [{ kind: 'desktop', module: './desktop.js' }] },
      load: async () => { window.loads++; return { default: { kind: 'desktop', sdkVersion: '0.13.0', activate() {
        const id = ++window.activations; let disposed = false;
        function Layout() { React.useLayoutEffect(() => { window.mounts.push({ id, disposed }); }, []); return <p>Owner {id}</p>; }
        return new Promise(resolve => { window.finish[id] = malformed => resolve({ modules: [],
          ${slot === 'layout' ? 'get contentLayout() { if (malformed) throw new Error("Late malformed presentation"); return Layout; }' : 'get overrides() { if (malformed) throw new Error("Late malformed presentation"); return { transcript: Layout }; }'},
          dispose() { disposed = true; window.disposals.push(id);
            if (id === 3 || id === 5) return new Promise((resolve, reject) => {
              window.finishCleanup[id] = () => id === 5 ? reject(new Error('Late cleanup rejection')) : resolve();
            });
          } }); });
      } } }; } }];
    function App() { const [enabled, setEnabled] = React.useState(true);
      window.disable = () => flushSync(() => setEnabled(false)); window.enable = () => flushSync(() => setEnabled(true));
      const custom = useDesktopCustomizations({ customizations, enabled });
      return <><input aria-label="Persistent draft" defaultValue="Strict draft" />
        {custom.namespaces.filter(owner => owner.kind === 'failed').map(owner => <p role="alert" key={owner.namespace}>{owner.message}</p>)}
        ${slot === 'layout'
          ? '<CustomizationContent selection={custom.contentLayout} conversationKey="strict" transcript={<p>Default transcript</p>} nativeTranscript={<p>Native transcript</p>} modules={null} />'
          : '<CustomizationTranscript selection={custom.transcript} context={{}} conversationKey="strict" fallback={<p>Default transcript</p>} />'}</>;
    }
    createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);`, resolveDir: root, loader: 'jsx' },
    bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://localhost/fixture', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://localhost/fixture'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await wait(() => page.evaluate(() => window.activations === 1), 'StrictMode activation');
  assert.equal(await page.evaluate(() => window.loads), 1);
  await page.evaluate(() => window.finish[1](false)); await page.getByText('Owner 1', { exact: true }).waitFor();
  const previous = await page.getByRole('textbox', { name: 'Persistent draft' }).elementHandle();
  const mounts = await page.evaluate(() => window.mounts);
  await page.evaluate(() => { window.disable(); window.enable(); });
  await wait(() => page.evaluate(() => window.activations === 2), 'same-array delayed reactivation');
  await page.getByText('Default transcript', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.mounts), mounts);
  assert.deepEqual(await page.evaluate(() => window.disposals), [1]);
  await page.evaluate(() => window.finish[2](false)); await page.getByText('Owner 2', { exact: true }).waitFor();
  await page.evaluate(() => { window.disable(); window.enable(); });
  await wait(() => page.evaluate(() => window.activations === 3), 'pending obsolete activation');
  await page.evaluate(() => { window.disable(); window.enable(); });
  await page.getByText('Default transcript', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.activations), 3, 'replacement waits for unresolved activation');
  await page.evaluate(() => window.finish[3](false));
  await wait(() => page.evaluate(() => typeof window.finishCleanup[3] === 'function'), 'late generation retirement');
  assert.equal(await page.evaluate(() => window.activations), 3, 'replacement waits for acquired generation cleanup');
  assert.equal(await page.getByText('Owner 3', { exact: true }).count(), 0);
  await page.evaluate(() => window.finishCleanup[3]());
  await wait(() => page.evaluate(() => window.activations === 4), 'replacement after complete retirement');
  await page.evaluate(() => window.finish[4](false)); await page.getByText('Owner 4', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.disposals), [1, 2, 3]);
  await page.evaluate(() => { window.disable(); window.enable(); });
  await wait(() => page.evaluate(() => window.activations === 5), 'pending malformed activation');
  await page.evaluate(() => { window.disable(); window.enable(); });
  assert.equal(await page.evaluate(() => window.activations), 5);
  await page.evaluate(() => window.finish[5](true));
  await wait(() => page.evaluate(() => typeof window.finishCleanup[5] === 'function'), 'late malformed cleanup');
  assert.equal(await page.evaluate(() => window.activations), 5, 'malformed lifetime still owns its retirement barrier');
  await page.evaluate(() => window.finishCleanup[5]());
  const cleanupFailure = page.getByRole('alert').filter({ hasText: 'Executable UI cleanup failed.' });
  await cleanupFailure.waitFor();
  await page.evaluate(() => { window.disable(); window.enable(); });
  await cleanupFailure.waitFor();
  assert.equal(await page.evaluate(() => window.activations), 5, 'cleanup failure requires restart instead of another activation');
  assert.equal(await page.evaluate(() => window.loads), 5, 'StrictMode replay and failed retry never reload a namespace');
  await page.evaluate(() => window.disable()); await page.getByText('Default transcript', { exact: true }).waitFor();
  await cleanupFailure.waitFor();
  assert.deepEqual(await page.evaluate(() => window.disposals), [1, 2, 3, 4, 5]);
  assert.equal(await page.evaluate(() => window.mounts.every(mount => !mount.disposed && ![3, 5].includes(mount.id))), true);
  assert.equal(await page.getByRole('textbox', { name: 'Persistent draft' }).evaluate((node, old) => node === old, previous), true);
  assert.equal(await page.getByRole('textbox', { name: 'Persistent draft' }).inputValue(), 'Strict draft'); assert.deepEqual(errors, []);
});
