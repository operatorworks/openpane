import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { CSP as HOST_CSP } from '../../apps/host/build/tsc/static-assets.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const bundle = await build({ stdin: { contents: `import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { createConversationStore } from '@openpane/client';
  import { transcriptProjection } from '@openpane/contracts/conversation';
  import { ConversationView } from './apps/desktop/src/application/ConversationView.tsx';
  const scope = { hostId: 'host', conversationId: 'image' };
  const saved = new Map();
  let records = null, receive = null, count = 0;
  globalThis.submitted = [];
  globalThis.reads = [];
  globalThis.uploadAttempts = 0;
  const store = createConversationStore({ scope, projection: transcriptProjection, createCommandId: () => '00000000-0000-4000-8000-' + String(++count).padStart(12, '0'),
    drafts: { load: async () => records, async save(next, image) { records = next; for (const id of image?.remove ?? []) saved.delete(id); if (image?.put) saved.set(image.put.selectionId, image.put.bytes); },
      loadImage: async (_, id) => saved.get(id) ?? null },
    images: { async upload({ name, bytes }) { globalThis.uploadAttempts++; globalThis.uploadedBytes = bytes.byteLength; if (globalThis.holdUpload) await globalThis.holdUpload;
      if (globalThis.failUpload) throw Object.assign(new Error('Unsupported'), { kind: 'image-unsupported' });
      return { imageId: '00000000-0000-4000-8000-aaaaaaaaaaaa', name, mediaType: 'image/png', byteLength: bytes.byteLength, width: 1, height: 1 }; } },
    port: { scope, receipt: async () => null,
      async submit(command) { globalThis.submitted.push(command);
        return { kind: 'receipt', receipt: { scope, clientCommandId: command.clientCommandId, hostOperationId: 'operation', sequence: 1, state: { kind: 'accepted' } } }; },
      watch(request, callback) { receive = callback; return { ended: new Promise(() => {}), close() {} }; } } });
  globalThis.savedImages = () => saved.size;
  globalThis.deliver = item => receive(item);
  const active = { store, viewId: 'view', scope, agent: { id: 'codex', label: 'Codex', runtime: { engine: 'codex', version: '1', format: 'jsonl' },
    imageInput: { kind: 'supported', format: 'png-jpeg-v1' }, commands: ['send'], availability: { kind: 'ready' } } };
  const actions = { submit: operation => operation().then(() => undefined), async readImage(imageId) { globalThis.reads.push(imageId); return globalThis.previewBytes; } };
  void store.connect();
  const root = createRoot(document.getElementById('conversation'));
  const render = () => root.render(<ConversationView active={{ ...active }} actions={actions} enabled={true} storageFailure="" />);
  globalThis.refuseNewImages = () => {
    active.agent = { ...active.agent, model: { id: 'image-discovered', label: 'Image discovered' },
      imageInput: { kind: 'unsupported', reason: 'This model cannot read images.' } };
    render();
  };
  render();`, resolveDir: root, loader: 'jsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const css = (await readFile(new URL('apps/desktop/src/application/application.css', `file://${root}`), 'utf8'));
const TAURI_CSP = JSON.parse(await readFile(new URL('apps/desktop/src-tauri/tauri.conf.json', `file://${root}`), 'utf8')).app.security.csp;

for (const [shell, csp] of [['host browser', HOST_CSP], ['Tauri', TAURI_CSP]]) test(`a picked PNG uploads, sends without text and appears as an authorized preview under the ${shell} CSP`, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requests = [], errors = [], violations = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/Content Security Policy/.test(message.text())) violations.push(message.text()); });
  const assets = { '/': ['text/html', '<!doctype html><link rel="stylesheet" href="/app.css"><main id="conversation"></main><script src="/app.js"></script>'],
    '/app.css': ['text/css', css], '/app.js': ['text/javascript', bundle.outputFiles[0].text] };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), asset = url.origin === 'https://image.test' ? assets[url.pathname] : undefined;
    if (asset) await route.fulfill({ contentType: asset[0], body: asset[1], headers: { 'content-security-policy': csp } });
    else { requests.push(route.request().url()); await route.abort(); }
  });
  await page.goto('https://image.test/');
  await page.waitForFunction(() => typeof globalThis.deliver === 'function');
  await page.evaluate(bytes => { globalThis.previewBytes = new Uint8Array(bytes); }, [...png]);
  await page.evaluate(() => globalThis.deliver({ kind: 'snapshot', snapshot: { scope: { hostId: 'host', conversationId: 'image' }, projectionVersion: 4, cursor: 0,
    document: { domain: { messages: [], currentRun: null }, receipts: {}, decisions: {} } } }));
  const send = page.getByRole('button', { name: 'Send', exact: true });
  assert.equal(await send.isDisabled(), true);
  await page.getByLabel('Image file').setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: png });
  const card = page.getByLabel('Attached image');
  await card.getByRole('status').filter({ hasText: 'Ready' }).waitFor();
  assert.match(await card.textContent(), /chart\.png · 70 B/);
  assert.equal(await page.evaluate(() => globalThis.uploadedBytes), png.length);
  await send.click();
  await card.waitFor({ state: 'detached' });
  const submitted = await page.evaluate(() => globalThis.submitted);
  assert.deepEqual(submitted.map(command => command.body), [{ kind: 'send', text: '', imageId: '00000000-0000-4000-8000-aaaaaaaaaaaa' }]);
  assert.equal(await page.evaluate(() => globalThis.savedImages()), 0);
  await page.evaluate(() => globalThis.deliver({ kind: 'events', events: [{ scope: { hostId: 'host', conversationId: 'image' }, sequence: 1, event: { kind: 'domain', event: {
    kind: 'message-updated', messageId: 'sent', revision: 1, role: 'user', text: '', complete: true,
    image: { imageId: '00000000-0000-4000-8000-aaaaaaaaaaaa', name: 'chart.png', mediaType: 'image/png', byteLength: 70, width: 1, height: 1 } } } }] }));
  const preview = page.locator('.message-user').getByRole('img', { name: 'chart.png' });
  await preview.waitFor();
  await page.waitForFunction(() => document.querySelector('.message-user img')?.naturalWidth === 1);
  assert.match(await preview.getAttribute('src'), /^blob:/);
  assert.deepEqual(await page.evaluate(() => globalThis.reads), ['00000000-0000-4000-8000-aaaaaaaaaaaa']);
  assert.deepEqual(requests, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(violations, []);
});

test('a preview that the page cannot decode reports itself unavailable', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const assets = { '/': ['text/html', '<!doctype html><main id="conversation"></main><script src="/app.js"></script>'], '/app.js': ['text/javascript', bundle.outputFiles[0].text] };
  await page.route('**/*', async route => {
    const asset = assets[new URL(route.request().url()).pathname];
    await (asset ? route.fulfill({ contentType: asset[0], body: asset[1], headers: { 'content-security-policy': HOST_CSP } }) : route.abort());
  });
  await page.goto('https://image.test/');
  await page.waitForFunction(() => typeof globalThis.deliver === 'function');
  await page.evaluate(() => { globalThis.previewBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); });
  const scope = { hostId: 'host', conversationId: 'image' };
  await page.evaluate(scope => globalThis.deliver({ kind: 'snapshot', snapshot: { scope, projectionVersion: 4, cursor: 0, document: { domain: { messages: [{
    messageId: 'sent', revision: 1, role: 'user', text: '', complete: true,
    image: { imageId: '00000000-0000-4000-8000-aaaaaaaaaaaa', name: 'broken.png', mediaType: 'image/png', byteLength: 7, width: 1, height: 1 } }], currentRun: null }, receipts: {}, decisions: {} } } }), scope);
  await page.locator('.message-user').getByText('Preview unavailable').waitFor();
  assert.equal(await page.locator('.message-user img').count(), 0);
});

test('model-less capable picker follows operation capability and retains Retry and preview after support loss', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const assets = { '/': ['text/html', '<!doctype html><main id="conversation"></main><script src="/app.js"></script>'], '/app.js': ['text/javascript', bundle.outputFiles[0].text] };
  await page.route('**/*', async route => {
    const asset = assets[new URL(route.request().url()).pathname];
    await (asset ? route.fulfill({ contentType: asset[0], body: asset[1], headers: { 'content-security-policy': HOST_CSP } }) : route.abort());
  });
  await page.goto('https://image.test/');
  await page.waitForFunction(() => typeof globalThis.deliver === 'function');
  await page.evaluate(() => {
    globalThis.failUpload = true;
    globalThis.deliver({ kind: 'snapshot', snapshot: { scope: { hostId: 'host', conversationId: 'image' }, projectionVersion: 4, cursor: 0,
      document: { domain: { messages: [], currentRun: null }, receipts: {}, decisions: {} } } });
  });
  await page.getByRole('button', { name: 'Add image', exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep caption');
  await page.getByLabel('Image file').setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: png });
  const retry = page.getByRole('button', { name: 'Retry', exact: true });
  await retry.waitFor();
  await page.evaluate(() => { globalThis.failUpload = false; globalThis.refuseNewImages(); });
  await page.getByText('This model cannot read images. Remove the image to send.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Image file').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Replace image', exact: true }).count(), 0);
  assert.equal(await retry.isEnabled(), true);
  await retry.click();
  await page.getByLabel('Attached image').getByRole('status').filter({ hasText: 'Ready' }).waitFor();
  assert.equal(await page.evaluate(() => globalThis.uploadAttempts), 2);
  assert.equal(await page.evaluate(() => globalThis.savedImages()), 1);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Keep caption');
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
  await page.evaluate(bytes => {
    globalThis.previewBytes = new Uint8Array(bytes);
    globalThis.deliver({ kind: 'events', events: [{ scope: { hostId: 'host', conversationId: 'image' }, sequence: 1, event: { kind: 'domain', event: {
      kind: 'message-updated', messageId: 'retained', revision: 1, role: 'user', text: '', complete: true,
      image: { imageId: '00000000-0000-4000-8000-aaaaaaaaaaaa', name: 'retained.png', mediaType: 'image/png', byteLength: bytes.length, width: 1, height: 1 } } } }] });
  }, [...png]);
  await page.waitForFunction(() => document.querySelector('.message-user img')?.naturalWidth === 1);
  assert.deepEqual(await page.evaluate(() => globalThis.reads), ['00000000-0000-4000-8000-aaaaaaaaaaaa']);
});

/** The ConversationView harness with the app stylesheet, inside a panel-sized column, with an empty conversation delivered. */
async function quietConversation(t) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const assets = { '/': ['text/html', '<!doctype html><link rel="stylesheet" href="/app.css"><main id="conversation" style="height:100dvh;display:flex"></main><script src="/app.js"></script>'],
    '/app.css': ['text/css', css], '/app.js': ['text/javascript', bundle.outputFiles[0].text] };
  await page.route('**/*', async route => {
    const asset = assets[new URL(route.request().url()).pathname];
    await (asset ? route.fulfill({ contentType: asset[0], body: asset[1], headers: { 'content-security-policy': HOST_CSP } }) : route.abort());
  });
  await page.goto('https://image.test/');
  await page.waitForFunction(() => typeof globalThis.deliver === 'function');
  await page.evaluate(() => globalThis.deliver({ kind: 'snapshot', snapshot: { scope: { hostId: 'host', conversationId: 'image' }, projectionVersion: 4, cursor: 0,
    document: { domain: { messages: [], currentRun: null }, receipts: {}, decisions: {} } } }));
  return page;
}

test('a new conversation is a greeting over one quiet composer', async t => {
  const page = await quietConversation(t);
  const panel = page.locator('.conversation-panel');
  await page.getByText('A conversation that stays with you.', { exact: true }).waitFor();
  assert.equal(await panel.getAttribute('data-empty'), 'true');
  assert.equal(await page.getByText(/Send a message to begin/).count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'Your conversation', exact: true }).count(), 1);
  const header = await page.locator('.conversation-panel > header.visually-hidden').boundingBox();
  assert.ok(header.width <= 1 && header.height <= 1);
  assert.equal(await page.locator('.composer-disclosure').count(), 0);
  const composer = page.locator('.composer'), message = page.getByRole('textbox', { name: 'Message', exact: true });
  const [panelBox, composerBox] = [await panel.boundingBox(), await composer.boundingBox()];
  assert.ok(composerBox.y > panelBox.y + panelBox.height * 0.25, 'the empty composer sits away from the top');
  await message.click();
  assert.equal(await composer.evaluate(node => getComputedStyle(node).boxShadow), 'none');
  assert.deepEqual(await message.evaluate(node => [getComputedStyle(node).outlineStyle, getComputedStyle(node).resize]), ['none', 'none']);
  const single = await message.evaluate(node => node.clientHeight);
  await message.fill('one\ntwo\nthree');
  await page.waitForFunction(height => document.querySelector('#message').clientHeight > height, single);
  await message.fill(Array.from({ length: 80 }, (_, line) => `line ${line}`).join('\n'));
  const capped = await message.evaluate(node => ({ height: node.getBoundingClientRect().height, max: parseFloat(getComputedStyle(node).maxHeight), scroll: node.scrollHeight > node.clientHeight }));
  assert.ok(Math.abs(capped.height - capped.max) <= 1 && capped.scroll, JSON.stringify(capped));
  await message.fill('');
  await page.waitForFunction(height => document.querySelector('#message').clientHeight <= height, single);
  await page.evaluate(() => globalThis.deliver({ kind: 'events', events: [{ scope: { hostId: 'host', conversationId: 'image' }, sequence: 1, event: { kind: 'domain', event: {
    kind: 'message-updated', messageId: 'first', revision: 1, role: 'user', text: 'Hello', complete: true } } }] }));
  await page.locator('.message-user').waitFor();
  assert.equal(await panel.getAttribute('data-empty'), null);
  assert.equal(await page.getByText('A conversation that stays with you.', { exact: true }).count(), 0);
});

/** Dispatches a real DataTransfer drag sequence on the panel; `files` are [name, type, byteLength or byte array] triples. */
async function dragFiles(page, files, { drop = true, text = false } = {}) {
  return page.evaluate(async ({ files, drop, text }) => {
    const transfer = new DataTransfer();
    if (text) transfer.setData('text/plain', 'dragged words');
    for (const [name, type, content] of files) transfer.items.add(new File([typeof content === 'number' ? new Uint8Array(content) : new Uint8Array(content)], name, { type }));
    const panel = document.querySelector('.conversation-panel');
    const fire = type => panel.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
    fire('dragenter'); fire('dragover');
    // React commits the hover state on its own schedule; give it a short window, then read what the composer shows.
    let over = null;
    for (let frame = 0; frame < 30 && over === null; frame++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      over = document.querySelector('.composer').getAttribute('data-drop');
    }
    if (drop) fire('drop');
    return over;
  }, { files, drop, text });
}

test('dropping images on the conversation attaches one PNG or JPEG and explains every refusal', async t => {
  const page = await quietConversation(t);
  const message = page.getByRole('textbox', { name: 'Message', exact: true }), alert = page.locator('.composer [role="alert"]');
  await message.fill('Keep this caption');
  assert.equal(await dragFiles(page, [], { text: true, drop: false }), null, 'text drags are left alone');
  assert.equal(await dragFiles(page, [['anim.gif', 'image/gif', 10]]), 'reject');
  assert.equal(await alert.textContent(), 'Drop a PNG or JPEG image.');
  assert.equal(await dragFiles(page, [['a.png', 'image/png', 10], ['b.png', 'image/png', 10]]), 'reject');
  assert.equal(await alert.textContent(), 'Drop one image at a time.');
  assert.equal(await dragFiles(page, [['huge.png', 'image/png', 4 * 1024 * 1024 + 1]]), 'accept');
  assert.equal(await alert.textContent(), 'Choose an image of at most 4 MB.');
  assert.equal(await page.getByLabel('Attached image').count(), 0);
  assert.equal(await page.evaluate(() => globalThis.uploadAttempts), 0);
  await page.evaluate(() => { globalThis.holdUpload = new Promise(resolve => { globalThis.releaseUpload = resolve; }); });
  assert.equal(await dragFiles(page, [['chart.png', 'image/png', [...png]]]), 'accept');
  const card = page.getByLabel('Attached image');
  await card.getByRole('status').filter({ hasText: 'Uploading…' }).waitFor();
  assert.equal(await page.locator('.composer').getAttribute('data-drop'), null, 'the outline clears on drop');
  assert.equal(await dragFiles(page, [['second.png', 'image/png', [...png]]]), 'reject');
  assert.equal(await alert.textContent(), 'Wait for the current upload to finish.');
  await page.evaluate(() => globalThis.releaseUpload());
  await card.getByRole('status').filter({ hasText: 'Ready' }).waitFor();
  assert.match(await card.textContent(), /chart\.png · 70 B/);
  assert.equal(await page.getByRole('button', { name: 'Replace image', exact: true }).count(), 1);
  assert.equal(await message.inputValue(), 'Keep this caption');
  await page.evaluate(() => globalThis.refuseNewImages());
  assert.equal(await dragFiles(page, [['other.png', 'image/png', [...png]]]), 'reject');
  assert.equal(await alert.textContent(), 'This model cannot read images.');
  assert.match(await card.textContent(), /chart\.png/, 'a refused drop keeps the existing image');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await card.waitFor({ state: 'detached' });
});

test('removing an image mid-upload frees the composer for the next drop, and generic types are decided by name', async t => {
  const page = await quietConversation(t);
  const alert = page.locator('.composer [role="alert"]'), card = page.getByLabel('Attached image');
  assert.equal(await dragFiles(page, [['notes.pdf', 'application/pdf', 10]], { drop: false }), 'reject', 'known non-image types are refused on hover');
  await page.waitForFunction(() => document.querySelector('.composer').getAttribute('data-drop') === null, null, { timeout: 2000 });
  await page.evaluate(() => { globalThis.holdUpload = new Promise(resolve => { globalThis.releaseUpload = resolve; }); });
  await dragFiles(page, [['first.png', 'image/png', [...png]]]);
  await card.getByRole('status').filter({ hasText: 'Uploading…' }).waitFor();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  await page.evaluate(() => { globalThis.holdUpload = null; });
  const over = await dragFiles(page, [['second.png', 'application/octet-stream', [...png]]]);
  assert.equal(over, 'accept');
  await card.getByRole('status').filter({ hasText: 'Ready' }).waitFor();
  assert.match(await card.textContent(), /second\.png/);
  assert.equal(await alert.count(), 0);
  await page.evaluate(() => globalThis.releaseUpload());
  await page.waitForTimeout(100);
  assert.match(await card.textContent(), /second\.png/, 'the removed upload finishing late does not replace the new image');
});
