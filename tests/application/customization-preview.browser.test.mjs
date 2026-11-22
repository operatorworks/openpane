import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
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
async function preview(t, sourceRoot, host) {
  const result = await startCustomizationPreview({ source: sourceRoot, hostUrl: host.origin, port: await unusedPort() });
  t.after(() => result.server.close()); return result;
}
async function previewPage(host, running) {
  const page = await host.browser.newPage(); page.setDefaultTimeout(20_000);
  await page.goto(running.url);
  await page.getByRole('note').filter({ hasText: 'Unqualified local preview' }).waitFor();
  await wait(() => page.getByRole('button', { name: 'New recorded conversation' }).isEnabled(), 'connected preview host');
  return page;
}

test('working preview connects to a real recorded host, keeps manual reload and blocks unlabeled entry routes', { timeout: 90_000 }, async t => {
  const host = await fixture(t), directory = await source(t), running = await preview(t, directory, host);
  const page = await previewPage(host, running), operations = [], navigations = [];
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
  const entry = join(directory, 'desktop/index.tsx'), css = join(directory, 'desktop/review.css');
  await writeFile(entry, (await readFile(entry, 'utf8')).replace("'Plan review'", "'Uncommitted review edit'"));
  await writeFile(css, (await readFile(css, 'utf8')) + '\n.review-workspace { border-width: 3px; }\n');
  // Let Vite's watcher process both edits: neither JS nor CSS may update the running page.
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(navigations.length, 0);
  assert.equal(await toolPanel.getByRole('heading', { name: 'Plan review', exact: true }).evaluate((node, before) => node === before, oldHeading), true);
  await page.reload(); await connected(page); await tools(page);
  await page.getByRole('heading', { name: 'Uncommitted review edit', exact: true }).waitFor();
  assert.equal(navigations.length, 1);
  assert.equal(await page.getByRole('note').filter({ hasText: 'Unqualified local preview' }).count(), 1);
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance mode', { exact: true }).selectOption('dark');
  await wait(() => page.locator('.desktop-shell').getAttribute('data-appearance').then(value => value === 'dark'), 'saved dark appearance');
  const port = Number(new URL(running.origin).port);
  await running.server.close();
  const restarted = await startCustomizationPreview({ source: directory, hostUrl: host.origin, port });
  t.after(() => restarted.server.close());
  assert.equal(restarted.url, running.url);
  await page.reload(); await connected(page);
  await wait(() => page.locator('.desktop-shell').getAttribute('data-appearance').then(value => value === 'dark'), 'dark appearance across consecutive previews');
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
  assert.match(await page.text(), /customization-preview-main\.tsx/);
});

test('preview source policy rejects ambient imports and escaping links without running author scripts', { timeout: 60_000 }, async t => {
  const host = await fixture(t), directory = await source(t);
  const file = join(directory, 'package.json'), metadata = JSON.parse(await readFile(file, 'utf8'));
  metadata.scripts = { prepare: 'exit 72', build: 'exit 72' };
  await writeFile(file, JSON.stringify(metadata));
  await writeFile(join(directory, 'vite.config.mjs'), "throw new Error('AUTHOR CONFIG MUST NOT EXECUTE');");
  const running = await preview(t, directory, host);
  const entry = join(running.source, 'desktop/index.tsx');
  await writeFile(entry, "import 'ambient-machine-package'; export default {};\n");
  await assert.rejects(running.server.transformRequest(`/@fs${entry}`), /Unsupported customization import|resolve import/);
  const outside = await mkdtemp(join(tmpdir(), 'openpane-preview-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'escape.js'), 'export default 1;');
  await symlink(join(outside, 'escape.js'), join(running.source, 'desktop/escape.js'));
  await writeFile(entry, "import './escape.js'; export default {};\n");
  running.server.moduleGraph.invalidateAll();
  await assert.rejects(running.server.transformRequest(`/@fs${entry}`), /contained customization source/);
  await writeFile(entry, "export default { kind: 'desktop', sdkVersion: '0.13.0', activate() { return { modules: [], dispose() {} }; } };\n");
  running.server.moduleGraph.invalidateAll();
  const fixed = await running.server.transformRequest(`/@fs${entry}`);
  assert.match(fixed.code, /0\.13\.0/);
});
