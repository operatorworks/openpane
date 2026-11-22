import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { chromium } from 'playwright';
import { repository, buildCustom } from '../customization/build/support.mjs';
import { bundledPlan } from '../../scripts/bundled-extensions.mjs';
import { startCustomizationPreview } from '../../scripts/customization-dev.mjs';
import { connected, draft, extensionFixture, fixture, root, tools, wait } from './browser-support.mjs';
import { ledgerExtension, ledgerService } from '../extensions/providers/conformance/ledger.mjs';
import { png } from '../host/image-fixtures.mjs';

async function unusedPort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function source(t) {
  const directory = await mkdtemp(join(tmpdir(), 'openpane-working-preview-'));
  await cp(join(root, 'templates/customization'), directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function preview(t, sourceRoot, host, { useDefaultPort = false } = {}) {
  const result = await startCustomizationPreview({ source: sourceRoot, hostUrl: host.origin, ...(useDefaultPort ? {} : { port: await unusedPort() }) });
  t.after(() => result.server.close()); return result;
}
async function sourceDiagnostic(running) {
  const response = await fetch(running.url);
  assert.equal(response.status, 500);
  assert.match(await response.text(), /source diagnostic.*correct the entry.*reload/u);
}
async function previewPage(host, running) {
  const page = await host.browser.newPage(); page.setDefaultTimeout(20_000);
  await page.goto(running.url);
  await page.getByRole('note').filter({ hasText: 'Unqualified local preview' }).waitFor();
  await wait(() => page.getByRole('button', { name: 'New recorded conversation' }).isEnabled(), 'connected preview host');
  return page;
}

test('working preview connects to a real recorded host, keeps manual reload and blocks unlabeled entry routes', { timeout: 90_000 }, async t => {
  const host = await fixture(t), directory = await source(t);
  const entry = join(directory, 'desktop/index.tsx'), css = join(directory, 'desktop/review.css');
  const running = await preview(t, directory, host, { useDefaultPort: true });
  const page = await previewPage(host, running), operations = [], navigations = [];
  assert.deepEqual(await page.locator('.desktop-shell').evaluate(node => ({
    color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor,
  })), { color: 'rgb(32, 36, 44)', background: 'rgb(248, 249, 251)' }, 'preview loads the same painted builtin shell styles as the ordinary browser bootstrap');
  page.on('request', request => { if (request.method() === 'POST') operations.push(request.postDataJSON()?.op); });
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  for (const path of ['/', '/index.html', '/browser.html', '/provider-setup.html', '/anything.html']) {
    assert.equal((await fetch(running.origin + path)).status, 404, `${path} must not start an unlabeled preview`);
  }
  const headers = { Origin: running.origin, 'Content-Type': 'application/json' };
  for (const [path, init, status] of [
    ['/api/v1', { method: 'POST', headers: { ...headers, Origin: 'https://elsewhere.test' }, body: '{}' }, 403],
    ['/api/v1', { headers }, 405],
    ['/api/v1', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' }, 415],
    ['/api/v1/extra', { method: 'POST', headers, body: '{}' }, 404],
    ['/api/v1?other=1', { method: 'POST', headers, body: '{}' }, 404],
  ]) assert.equal((await fetch(running.origin + path, init)).status, status);
  await page.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(page);
  const toolPanel = await tools(page);
  await toolPanel.getByRole('button', { name: 'Review the plan' }).click();
  await wait(async () => (await host.entries()).length === 1, 'real host command through preview');
  await wait(() => operations.includes('pull'), 'real feed through preview');
  await toolPanel.getByRole('heading', { name: 'Plan review', exact: true }).waitFor();
  const oldHeading = await toolPanel.getByRole('heading', { name: 'Plan review', exact: true }).elementHandle();
  const border = () => page.locator('.review-plan').evaluate(node => getComputedStyle(node).borderInlineStartWidth);
  assert.equal(await border(), '2px');
  await writeFile(entry, (await readFile(entry, 'utf8')).replace("'Plan review'", "'Uncommitted review edit'"));
  await writeFile(css, (await readFile(css, 'utf8')).replace('border-inline-start: 2px', 'border-inline-start: 4px'));
  // Let Vite's watcher process both edits: neither JS nor CSS may update the running page.
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(navigations.length, 0);
  assert.equal(await border(), '2px');
  assert.equal(await toolPanel.getByRole('heading', { name: 'Plan review', exact: true }).evaluate((node, before) => node === before, oldHeading), true);
  await page.reload(); await connected(page); await tools(page);
  await page.getByRole('heading', { name: 'Uncommitted review edit', exact: true }).waitFor();
  assert.equal(navigations.length, 1);
  assert.equal(await border(), '4px');
  assert.equal(await page.getByRole('note').filter({ hasText: 'Unqualified local preview' }).count(), 1);
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance mode', { exact: true }).selectOption('dark');
  await wait(() => page.locator('.desktop-shell').getAttribute('data-appearance').then(value => value === 'dark'), 'saved dark appearance');
  const palette = JSON.parse(await readFile(join(directory, 'review-palette.json'), 'utf8'));
  await page.getByLabel('Palette JSON', { exact: true }).fill(JSON.stringify(palette));
  await page.getByRole('button', { name: 'Preview palette', exact: true }).click();
  await page.getByRole('button', { name: 'Import palette', exact: true }).click();
  await page.getByRole('button', { name: /^Select Quiet review / }).click();
  const accent = () => page.locator('.conversation-content').evaluate(node => getComputedStyle(node).getPropertyValue('--aui-color-accent').trim());
  await wait(async () => await accent() === palette.colors.dark.accent, 'saved preview palette');
  await running.server.close();
  const restarted = await startCustomizationPreview({ source: directory, hostUrl: host.origin });
  t.after(() => restarted.server.close());
  assert.equal(restarted.url, running.url);
  await page.reload(); await connected(page);
  await wait(() => page.locator('.desktop-shell').getAttribute('data-appearance').then(value => value === 'dark'), 'dark appearance across consecutive previews');
  await wait(async () => await accent() === palette.colors.dark.accent, 'palette choice across consecutive previews');
});

test('the template workspace uses a namespaced conformance provider and leaves host composer, decisions and draft intact', { timeout: 90_000 }, async t => {
  const service = await ledgerService(t), ledger = ledgerExtension({ service: service.origin, key: service.key,
    supports: { cancel: true, decide: true }, namespace: 'personal' });
  const host = await extensionFixture(t, { extensions: [ledger.value] }), directory = await source(t), running = await preview(t, directory, host);
  const page = await previewPage(host, running);
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Open Plan review workspace' }).click();
  const workspace = page.getByRole('region', { name: 'Plan review workspace', exact: true });
  await workspace.getByRole('button', { name: 'Start review with Ledger desk' }).click(); await connected(page);
  assert.equal(await page.locator('#message').count(), 1);
  await workspace.getByRole('region', { name: 'Review transcript' }).getByText('This review has no messages yet.').waitFor();
  await draft(page, 'Keep this draft');
  // The template action is host-rendered inside its namespace conversation.
  await page.getByRole('button', { name: 'All extensions', exact: true }).click();
  await page.getByRole('region', { name: 'Conversation tools', exact: true }).getByRole('button', { name: 'Review the plan' }).click();
  await page.getByRole('button', { name: 'Open Plan review workspace' }).click();
  await wait(() => service.effects.sends === 1, 'namespaced host action');
  assert.equal(await page.locator('#message').inputValue(), 'Keep this draft');
  await workspace.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  service.card('Review approval');
  await workspace.getByText('Review approval', { exact: true }).waitFor();
  await workspace.getByRole('button', { name: 'Approve', exact: true }).click();
  await wait(() => service.answers()[0] === 'approve', 'ordinary host approval');
  service.reply('Unresolved decision: should we ship?');
  await workspace.getByRole('heading', { name: 'Unresolved decisions' }).waitFor();
  await workspace.getByRole('listitem').filter({ hasText: 'Unresolved decision: should we ship?' }).waitFor();
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).click();
  assert.equal(await page.locator('#message').count(), 1);
  assert.equal(await page.locator('#message').inputValue(), 'Keep this draft');
  assert.equal(await page.getByRole('region', { name: 'Review transcript' }).count(), 0);
});

test('preview carries exact image upload/read JSON through the real host without changing host admission', { timeout: 90_000 }, async t => {
  const directory = await source(t), log = join(directory, 'codex.jsonl'), implementation = join(directory, 'fixture.mjs'), executable = join(directory, 'codex');
  const code = (await readFile(join(root, 'tests/host/fixtures/codex-agent.mjs'), 'utf8'))
    .replace("displayName: 'GPT-9.2-Sol', hidden: false, isDefault: false", "displayName: 'GPT-9.2-Sol', hidden: false, isDefault: true")
    .replace("displayName: 'GPT-9.1-Astra', hidden: false, isDefault: true", "displayName: 'GPT-9.1-Astra', hidden: false, isDefault: false");
  await writeFile(implementation, code);
  await writeFile(executable, `#!${process.execPath}\nif (process.argv[2] === '--version') console.log('codex-cli 0.167.2'); else { process.argv = [process.execPath, 'fixture', ${JSON.stringify(log)}, 'images']; await import(${JSON.stringify(new URL(`file://${implementation}`).href)}); }\n`, { mode: 0o700 });
  const host = await extensionFixture(t, { agentStartup: { kind: 'provider', provider: { kind: 'codex', cwd: directory, executable } } });
  const running = await preview(t, directory, host), page = await host.browser.newPage(); page.setDefaultTimeout(20_000);
  await page.goto(running.url);
  await wait(() => page.getByRole('button', { name: 'New conversation', exact: true }).isEnabled(), 'image-capable preview host');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click(); await connected(page);
  const bytes = png(), requests = [];
  page.on('request', request => { if (request.url().endsWith('/api/v1/images')) requests.push(request.postDataJSON()); });
  await page.getByLabel('Image file', { exact: true }).setInputFiles({ name: 'preview.png', mimeType: 'image/png', buffer: bytes });
  await page.getByLabel('Attached image').getByRole('status').filter({ hasText: 'Ready' }).waitFor();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const image = page.getByRole('img', { name: 'preview.png', exact: true });
  await wait(() => image.evaluate(node => node.complete && node.naturalWidth === 2), 'authorized image read through preview');
  assert.deepEqual(requests.find(body => body.op === 'image-upload').base64, bytes.toString('base64'));
  assert.ok(requests.some(body => body.op === 'image-read'));
});

test('preview routing validates origin before forwarding to the unchanged recorded endpoint', { timeout: 60_000 }, async t => {
  const host = await fixture(t), directory = await source(t), running = await preview(t, directory, host);
  const headers = { Origin: running.origin, 'Content-Type': 'application/json' };
  const call = async (path, body, extra = {}) => {
    const response = await fetch(running.origin + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  };
  const metadata = await call('/api/v1', { op: 'metadata' });
  assert.equal(metadata.status, 200);
  assert.equal(JSON.parse(metadata.text).value.hostId, host.hostId);
  assert.equal((await call('/api/v1', { op: 'metadata' }, { Origin: 'https://outside.test' })).status, 403);
  assert.equal((await call('/api/v1/images', { op: 'metadata' }, { Origin: 'https://outside.test' })).status, 403);
  assert.equal((await call('/api/v1/images', { op: 'metadata' })).status, 400);
  assert.equal((await fetch(running.origin + '/browser.html')).status, 404);
  const page = await fetch(running.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /assets\/preview-[^"]+\.js/);
});

test('preview source policy rejects ambient imports and escaping links without running author scripts', { timeout: 60_000 }, async t => {
  const host = await fixture(t), directory = await source(t);
  const file = join(directory, 'package.json'), metadata = JSON.parse(await readFile(file, 'utf8'));
  metadata.scripts = { prepare: 'exit 72', build: 'exit 72' };
  await writeFile(file, JSON.stringify(metadata));
  await writeFile(join(directory, 'vite.config.mjs'), "throw new Error('AUTHOR CONFIG MUST NOT EXECUTE');");
  await mkdir(join(directory, 'node_modules/contained-dependency'), { recursive: true });
  await writeFile(join(directory, 'node_modules/contained-dependency/package.json'), JSON.stringify({ name: 'contained-dependency', version: '1.0.0', type: 'module', main: 'index.js' }));
  await writeFile(join(directory, 'node_modules/contained-dependency/index.js'), 'export const value = 7;');
  const running = await preview(t, directory, host);
  const entry = join(running.source, 'desktop/index.tsx');
  await writeFile(entry, `import { value } from 'contained-dependency';
    export default { kind: 'desktop', sdkVersion: '0.13.0', activate() {
      return { modules: [{ id: 'dependency', label: 'Contained dependency', component() { return 'Contained dependency ' + value; } }], dispose() {} };
    } };`);
  const page = await previewPage(host, running);
  await page.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(page); await tools(page);
  await page.getByText('Contained dependency 7', { exact: true }).waitFor();
  await writeFile(entry, "import 'ambient-machine-package'; export default {};\n");
  await sourceDiagnostic(running);
  const outside = await mkdtemp(join(tmpdir(), 'openpane-preview-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'escape.js'), 'export default 1;');
  await symlink(join(outside, 'escape.js'), join(running.source, 'desktop/escape.js'));
  await writeFile(entry, "import './escape.js'; export default {};\n");
  await sourceDiagnostic(running);
  await writeFile(entry, 'export default { broken source');
  await sourceDiagnostic(running);
  await writeFile(entry, "export default { kind: 'desktop', sdkVersion: '0.13.0', activate() { return { modules: [{ id: 'fixed', label: 'Fixed source', component() { return 'Corrected working source'; } }], dispose() {} }; } };");
  await page.reload(); await connected(page); await tools(page);
  await page.getByText('Corrected working source', { exact: true }).waitFor();
});


test('preview rejects choosing the upstream host port before binding a listener', async t => {
  const directory = await source(t), port = await unusedPort();
  let running;
  t.after(() => running?.server.close());
  await assert.rejects(async () => { running = await startCustomizationPreview({ source: directory, hostUrl: `http://127.0.0.1:${port}`, port }); }, /different.*port|same.*host/u);
});

test('preview JSON admission matches the host for both API endpoints', async t => {
  let calls = 0;
  const upstream = createHttpServer((req, res) => { calls++; req.resume(); res.end('{}'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const directory = await source(t), running = await preview(t, directory, { origin: `http://127.0.0.1:${upstream.address().port}` });
  for (const path of ['/api/v1', '/api/v1/images']) {
    for (const type of ['application/json; charset=utf-8', 'Application/JSON']) {
      const response = await fetch(running.origin + path, { method: 'POST', headers: { Origin: running.origin, 'Content-Type': type }, body: '{}' });
      assert.equal(response.status, 415, type);
    }
    assert.equal(calls, path === '/api/v1' ? 0 : 1);
    const response = await fetch(running.origin + path, { method: 'POST', headers: { Origin: running.origin, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{}');
  }
  assert.equal(calls, 2);
});

test('a truncated upstream response terminates promptly and the proxy serves the next request', { timeout: 15_000 }, async t => {
  let calls = 0;
  const upstream = createHttpServer((req, res) => {
    req.resume(); calls++;
    if (calls === 1) { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' }); res.write('{'); setTimeout(() => res.destroy(), 20); }
    else res.end('{"recovered":true}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const directory = await source(t), running = await preview(t, directory, { origin: `http://127.0.0.1:${upstream.address().port}` });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/proxy-check', route => route.fulfill({ contentType: 'text/html', body: '<p>Proxy response fixture</p>' }));
  await page.goto(running.origin + '/proxy-check');
  const observed = await page.evaluate(async () => {
    const abort = new AbortController();
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
    let deadline;
    const response = await fetch('/api/v1', { ...options, signal: abort.signal });
    const outcome = await Promise.race([response.text().then(() => 'completed', () => 'rejected'),
      new Promise(resolve => { deadline = setTimeout(() => resolve('hung'), 1000); })]);
    clearTimeout(deadline); abort.abort();
    const next = await (await fetch('/api/v1', options)).json();
    return { outcome, next };
  });
  assert.deepEqual(observed, { outcome: 'rejected', next: { recovered: true } });
});

test('an unopened lazy module stays with its document snapshot until explicit reload', { timeout: 90_000 }, async t => {
  const host = await fixture(t), directory = await source(t);
  const helper = join(directory, 'desktop/lazy.tsx'), css = join(directory, 'desktop/review.css');
  await writeFile(css, '#root .preview-lazy-button { border-top: 1px solid red; }');
  await writeFile(helper, "export default function Lazy() { return <p data-preview-lazy>Committed lazy label</p>; }");
  await writeFile(join(directory, 'desktop/index.tsx'), `import { lazy, Suspense, useState } from 'react';
    import { createFrontendToolGeneration, pinFrontendTools } from '@openpane/sdk/tools';
    import './review.css';
    const Lazy = lazy(() => import('./lazy.tsx'));
    function Module() { const [open, setOpen] = useState(false); return <><button className="preview-lazy-button" onClick={() => setOpen(true)}>Open lazy content</button>
      {open && <Suspense fallback={<p>Loading lazy module</p>}><Lazy /></Suspense>}</>; }
    export default { kind: 'desktop', sdkVersion: '0.13.0', async activate() {
      window.previewActivations = (window.previewActivations || 0) + 1;
      const { generation } = await createFrontendToolGeneration({ namespace: 'personal', generation: 'preview-pin', platform: 'desktop',
        activate({ frontendTools }) { frontendTools.add({ definition: { name: 'hold', description: 'Hold work during preview edits' },
          decodeInput: value => value, async execute() { await new Promise(resolve => { window.finishPreviewTool = resolve; }); return 'original generation'; } }); return { dispose() {} }; }, capture: value => value });
      window.previewPin = pinFrontendTools({ generations: [generation], platform: 'desktop', capabilities: { tools: { clientProvided: true } },
        run: { conversation: { hostId: 'host', conversationId: 'conversation' }, runId: 'run', authority: { kind: 'remote-provider', binding: { namespace: 'recorded', installationId: 'fixture', opaqueSessionId: 'session' } } } });
      const binding = window.previewPin.bindings[0];
      window.pendingPreviewTool = window.previewPin.invoke(binding.name, {}, binding.activationId);
      return { modules: [{ id: 'lazy', label: 'Lazy module', component: Module }], dispose() { window.previewDisposals = (window.previewDisposals || 0) + 1; window.previewPin.release(); return generation.retire(); } };
    } };`);
  const running = await preview(t, directory, host), page = await previewPage(host, running);
  await page.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(page);
  await wait(() => page.evaluate(() => window.previewActivations === 1 && typeof window.finishPreviewTool === 'function'), 'pending frontend pin');
  const binding = await page.evaluate(() => window.previewPin.bindings[0]);
  const border = () => page.locator('.preview-lazy-button').evaluate(node => getComputedStyle(node).borderTopWidth);
  assert.equal(await border(), '1px');
  assert.equal(await page.locator('.preview-lazy-button').evaluate(node => getComputedStyle(node).borderTopColor), 'rgb(255, 0, 0)');
  await writeFile(helper, (await readFile(helper, 'utf8')).replace('Committed lazy label', 'Dirty lazy label'));
  await writeFile(css, '#root .preview-lazy-button { border-top: 3px solid red; }');
  await new Promise(resolve => setTimeout(resolve, 350));
  // A second document advances the snapshot without changing this document's unused import graph.
  const second = await previewPage(host, running);
  await second.close();
  await tools(page);
  await page.getByRole('button', { name: 'Open lazy content' }).click();
  await page.locator('[data-preview-lazy]').waitFor();
  assert.equal(await page.locator('[data-preview-lazy]').textContent(), 'Committed lazy label');
  assert.equal(await page.getByText('Dirty lazy label', { exact: true }).count(), 0);
  assert.deepEqual(await page.evaluate(() => [window.previewActivations, window.previewDisposals || 0]), [1, 0]);
  assert.deepEqual(await page.evaluate(() => window.previewPin.bindings[0]), binding);
  assert.equal(await border(), '1px');
  await page.evaluate(() => window.finishPreviewTool());
  assert.deepEqual(await page.evaluate(() => window.pendingPreviewTool), { kind: 'completed', output: 'original generation' });
  await page.evaluate(() => window.previewPin.release());
  await page.reload(); await connected(page); await tools(page);
  await page.getByRole('button', { name: 'Open lazy content' }).click();
  await page.getByText('Dirty lazy label', { exact: true }).waitFor();
  assert.equal(await border(), '3px');
});

test('a dirty preview and a release of the same pinned source show their respective labels', { timeout: 90_000 }, async t => {
  const custom = repository(); t.after(() => rm(custom.directory, { recursive: true, force: true }));
  const commit = custom.commit();
  const entry = join(custom.repo, 'desktop/index.tsx');
  await writeFile(entry, (await readFile(entry, 'utf8')).replace("'Plan review'", "'Dirty preview label'"));
  const host = await fixture(t), running = await preview(t, custom.repo, host), page = await previewPage(host, running);
  await page.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(page); await tools(page);
  await page.getByRole('heading', { name: 'Dirty preview label', exact: true }).waitFor();
  buildCustom(custom, commit);
  const release = await fixture(t, join(custom.directory, 'browser')), released = await release.page();
  await released.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(released); await tools(released);
  await released.getByRole('heading', { name: 'Plan review', exact: true }).waitFor();
  assert.equal(await released.getByRole('heading', { name: 'Dirty preview label', exact: true }).count(), 0);
});

for (const [label, specifier] of [['script', 'package.json?raw'], ['CSS', 'src/desktop/styles.css'], ['asset', 'package.json?url']]) {
  test(`working ${label} imports cannot escape into a bundled extension root`, async t => {
    const directory = await source(t), bundled = bundledPlan(root).roots[0];
    await symlink(join(bundled, specifier.split('?')[0]), join(directory, 'desktop/escape' + (label === 'CSS' ? '.css' : '.json')));
    const entry = join(directory, 'desktop/index.tsx');
    const suffix = specifier.includes('?') ? '?' + specifier.split('?')[1] : '';
    await writeFile(entry, `import './escape${label === 'CSS' ? '.css' : '.json'}${suffix}'; export default {};`);
    const running = await preview(t, directory, { origin: `http://127.0.0.1:${await unusedPort()}` });
    await sourceDiagnostic(running);
  });
}


for (const kind of ['CSS URL', 'literal asset URL']) test(`working ${kind} cannot escape to bundled files`, async t => {
  const directory = await source(t), bundled = bundledPlan(root).roots[0];
  await symlink(join(bundled, 'package.json'), join(directory, 'desktop/escape.json'));
  const running = await preview(t, directory, { origin: `http://127.0.0.1:${await unusedPort()}` });
  const entry = join(running.source, 'desktop/index.tsx'), css = join(running.source, 'desktop/review.css');
  if (kind === 'CSS URL') await writeFile(css, '.test { background-image: url("./escape.json"); }');
  else await writeFile(entry, 'export const asset = new URL("./escape.json", import.meta.url); export default { kind: "desktop", sdkVersion: "0.13.0", activate() { return { modules: [], dispose() {} }; } };');
  await sourceDiagnostic(running);
});


test('template workspace keeps composer, Stop and approval reachable with many reviews in short viewports', { timeout: 90_000 }, async t => {
  const service = await ledgerService(t), ledger = ledgerExtension({ service: service.origin, key: service.key,
    supports: { cancel: true, decide: true }, namespace: 'personal' });
  const host = await extensionFixture(t, { extensions: [ledger.value] }), directory = await source(t), running = await preview(t, directory, host);
  const page = await previewPage(host, running);
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Open Plan review workspace' }).click();
  const workspace = page.getByRole('region', { name: 'Plan review workspace', exact: true });
  for (let index = 0; index < 16; index++) {
    await workspace.getByRole('button', { name: 'Start review with Ledger desk' }).click();
    await wait(() => service.effects.creates === index + 1, 'created review ' + index);
  }
  await connected(page);
  await wait(async () => await workspace.getByRole('navigation', { name: 'Review conversations' }).getByRole('button').count() >= 18, 'many review entries');
  await draft(page, 'Keep the short viewport draft');
  await page.getByRole('button', { name: 'All extensions', exact: true }).click();
  await page.getByRole('region', { name: 'Conversation tools', exact: true }).getByRole('button', { name: 'Review the plan' }).click();
  await wait(() => service.effects.sends === 1, 'review running before resizing');
  await page.getByRole('button', { name: 'Open Plan review workspace' }).click();
  service.card('Short viewport approval');
  await workspace.getByText('Short viewport approval', { exact: true }).waitFor();
  const composer = workspace.getByRole('textbox', { name: 'Message', exact: true }), stop = workspace.getByRole('button', { name: 'Stop', exact: true });
  async function wheelTo(target) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const scroll = await target.evaluate(node => {
        const box = node.getBoundingClientRect(); let top = 0, bottom = innerHeight, point;
        for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const overflow = getComputedStyle(ancestor).overflowY;
          if (!['auto', 'scroll', 'hidden'].includes(overflow)) continue;
          const bounds = ancestor.getBoundingClientRect(); top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
          const x = bounds.left + bounds.width / 2, y = (Math.max(0, bounds.top) + Math.min(innerHeight - 60, bounds.bottom)) / 2;
          if (!point && ['auto', 'scroll'].includes(overflow) && bounds.top < innerHeight - 60 && bounds.bottom > 0 && ancestor.contains(document.elementFromPoint(x, y))) point = { x, y };
          if (ancestor.classList.contains('review-workspace')) break;
        }
        return { visible: box.top >= top && box.bottom <= bottom && node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)),
          delta: Math.max(-80, Math.min(80, box.top < top ? box.top - top - 8 : box.bottom - bottom + 8)), point };
      });
      if (scroll.visible) return true;
      assert.ok(scroll.point, 'a workspace scroll area must be under the pointer');
      await page.mouse.move(scroll.point.x, scroll.point.y);
      await page.mouse.wheel(0, scroll.delta);
      await page.waitForTimeout(40);
    }
    return false;
  }
  const observations = [];
  for (const height of [480, 320]) {
    await page.setViewportSize({ width: 360, height });
    assert.equal(await workspace.locator('.conversation-panel').count(), 1);
    assert.equal(await page.locator('#message').count(), 1);
    const approvalReachable = await wheelTo(workspace.getByRole('button', { name: 'Approve', exact: true }));
    const composerReachable = await wheelTo(composer), stopReachable = await wheelTo(stop);
    const geometry = await workspace.evaluate(node => {
      const conversation = node.querySelector('.conversation-panel'), composer = node.querySelector('#message');
      return { workspaceHeight: node.clientHeight, workspaceScrollHeight: node.scrollHeight, workspaceScrollTop: node.scrollTop,
        workspaceOverflow: getComputedStyle(node).overflowY, conversationScrollTop: conversation.scrollTop,
        composerTop: composer.getBoundingClientRect().top, composerBottom: composer.getBoundingClientRect().bottom };
    });
    t.diagnostic(JSON.stringify({ height, approvalReachable, composerReachable, stopReachable, ...geometry }));
    observations.push({ height, approvalReachable, composerReachable, stopReachable });
    assert.equal(await composer.inputValue(), 'Keep the short viewport draft');
    assert.equal(await workspace.getByText('Short viewport approval', { exact: true }).count(), 1);
    assert.deepEqual(service.answers(), [null]);
  }
  for (const { height, approvalReachable, composerReachable, stopReachable } of observations) {
    assert.equal(approvalReachable, true, `Approve must be reachable by ordinary scrolling at 360x${height}`);
    assert.equal(composerReachable, true, `composer must be reachable by ordinary scrolling at 360x${height}`);
    assert.equal(stopReachable, true, `Stop must be reachable by ordinary scrolling at 360x${height}`);
  }
  await workspace.getByRole('button', { name: 'Approve', exact: true }).click();
  await wait(() => service.answers()[0] === 'approve', 'approval from short workspace');
  assert.equal(await composer.inputValue(), 'Keep the short viewport draft');
  await stop.click();
  await wait(() => service.effects.cancels === 1, 'Stop from short workspace');
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Keep the short viewport draft');
  assert.equal(await page.locator('#message').count(), 1);
});


test('reloading refuses a selected entry replaced with an outside symlink', { timeout: 60_000 }, async t => {
  const host = await fixture(t), directory = await source(t), running = await preview(t, directory, host);
  const entry = join(running.source, 'desktop/index.tsx'), original = await readFile(entry, 'utf8');
  const outside = await mkdtemp(join(tmpdir(), 'openpane-preview-entry-swap-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'entry.js'), `export default { kind: 'desktop', sdkVersion: '0.13.0', activate() {
    return { modules: [{ id: 'escaped', label: 'Escaped entry', component() { return 'Outside entry executed'; } }], dispose() {} };
  } };`);
  assert.equal((await fetch(running.url)).status, 200);
  await rm(entry); await symlink(join(outside, 'entry.js'), entry);
  const page = await host.browser.newPage(), response = await page.goto(running.url);
  let executed = false;
  if (response.status() === 200) {
    await page.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(page); await tools(page);
    executed = await page.getByText('Outside entry executed', { exact: true }).isVisible();
  }
  t.diagnostic(JSON.stringify({ status: response.status(), outsideEntryExecuted: executed }));
  assert.equal(response.status(), 500);
  assert.match(await page.textContent('body'), /source diagnostic.*correct the entry.*reload/u);
  await rm(entry); await writeFile(entry, original);
  await page.reload();
  await page.getByRole('note').filter({ hasText: 'Unqualified local preview' }).waitFor();
});

test('two renamed template copies keep module and workspace styles in their own namespaces', { timeout: 90_000 }, async t => {
  const first = repository(), second = repository();
  t.after(() => Promise.all([first, second].map(value => rm(value.directory, { recursive: true, force: true }))));
  const metadata = JSON.parse(await readFile(join(second.repo, 'package.json'), 'utf8'));
  metadata.openpane.extension.namespace = 'other-review'; second.write('package.json', JSON.stringify(metadata));
  second.write('desktop/index.tsx', (await readFile(join(second.repo, 'desktop/index.tsx'), 'utf8')).replaceAll('Plan review workspace', 'Other review workspace').replaceAll("'Plan review'", "'Other review'"));
  second.write('desktop/review.css', (await readFile(join(second.repo, 'desktop/review.css'), 'utf8'))
    .replaceAll('="personal"', '="other-review"').replace('border-inline-start: 2px', 'border-inline-start: 6px').replace('max-height: min(12rem, 30vh)', 'max-height: 64px'));
  const parent = JSON.parse(await readFile(join(first.repo, 'package.json'), 'utf8'));
  parent.openpane.extensions = [{ repository: second.repo, commit: second.commit() }]; first.write('package.json', JSON.stringify(parent));
  buildCustom(first, first.commit());
  const host = await fixture(t, join(first.directory, 'browser')), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(page); await tools(page);
  const widths = await Promise.all(['personal', 'other-review'].map(namespace => page.locator(`[data-customization-namespace="${namespace}"] .review-plan`)
    .evaluate(node => getComputedStyle(node).borderInlineStartWidth)));
  t.diagnostic(JSON.stringify({ moduleBorderWidths: widths }));
  assert.deepEqual(widths, ['2px', '6px']);
  for (const [label, namespace, expected] of [['Plan review workspace', 'personal', '192px'], ['Other review workspace', 'other-review', '64px'], ['Plan review workspace', 'personal', '192px']]) {
    await page.getByRole('button', { name: 'Open ' + label, exact: true }).click();
    const nav = page.locator(`[data-extension-workspace="${namespace}"] .review-workspace > nav`);
    assert.equal(await nav.evaluate(node => getComputedStyle(node).maxHeight), expected);
    await page.getByRole('button', { name: 'All extensions', exact: true }).click();
  }
});

test('contained HTML data assets load without exposing another document bootstrap', { timeout: 60_000 }, async t => {
  const host = await fixture(t), directory = await source(t);
  await writeFile(join(directory, 'desktop/help.html'), '<p>Contained HTML help marker</p>');
  await writeFile(join(directory, 'desktop/index.tsx'), `import help from './help.html?url';
    export default { kind: 'desktop', sdkVersion: '0.13.0', async activate() {
      const response = await fetch(help); const text = await response.text();
      window.previewHelp = { status: response.status, type: response.headers.get('content-type'), text };
      return { modules: [{ id: 'help', label: 'HTML help', component() { return text; } }], dispose() {} };
    } };`);
  const running = await preview(t, directory, host), page = await previewPage(host, running);
  await page.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(page); await tools(page);
  await wait(() => page.evaluate(() => Boolean(window.previewHelp)), 'HTML data fetch');
  const observed = await page.evaluate(() => window.previewHelp); t.diagnostic(JSON.stringify(observed));
  assert.deepEqual(observed, { status: 200, type: 'application/octet-stream', text: '<p>Contained HTML help marker</p>' });
  await page.getByText('<p>Contained HTML help marker</p>', { exact: true }).waitFor();
  for (const path of ['/', '/index.html', '/browser.html', '/provider-setup.html']) assert.equal((await fetch(running.origin + path)).status, 404);
});
