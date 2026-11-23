import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, connected, draft, wait } from './browser-support.mjs';

test('production browser entry uses dedicated bindings, preserves each draft and reopens navigation after reload', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(page);
  const first = await page.locator('.scope-label').textContent(); await draft(page, 'First private draft');
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await wait(async () => await page.locator('.scope-label').textContent() !== first, 'second conversation'); await connected(page);
  const second = await page.locator('.scope-label').textContent(); assert.notEqual(first, second); await draft(page, 'Second private draft');
  await page.getByRole('button', { name: new RegExp(`Open conversation ${first}$`) }).click();
  await wait(async () => await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue() === 'First private draft', 'first dedicated draft');
  await page.reload(); await connected(page);
  assert.equal(await page.locator('.scope-label').textContent(), first);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'First private draft');
  await page.getByRole('button', { name: new RegExp(`Open conversation ${second}$`) }).click();
  await wait(async () => await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue() === 'Second private draft', 'second dedicated draft');
  const records = await page.evaluate(async () => {
    const open = indexedDB.open('openpane-browser-views', 1), db = await new Promise(resolve => { open.onsuccess = () => resolve(open.result); });
    const transaction = db.transaction('records'), store = transaction.objectStore('records'), keys = store.getAllKeys(), values = store.getAll();
    await new Promise(resolve => { transaction.oncomplete = resolve; });
    const rows = keys.result.map((key, index) => ({ key, value: values.result[index] })); db.close();
    return { bindings: rows.filter(row => row.key[0] === 'editor-binding').map(row => row.value), drafts: rows.filter(row => row.key[0] === 'draft').map(row => ({ view: row.key[1], draft: row.value.draft })), catalog: sessionStorage.getItem('openpane.catalogViewId') };
  });
  assert.equal(records.bindings.length, 2); assert.notEqual(records.bindings[0].viewId, records.bindings[1].viewId);
  assert.ok(records.bindings.every(binding => binding.viewId !== records.catalog && binding.kind === 'editing'));
  assert.deepEqual(records.drafts.map(row => row.draft).sort(), ['First private draft', 'Second private draft']); assert.deepEqual(errors, []);
});

test('reopening a second independent legacy draft exposes read-only recovery without replacing its authoritative editor', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page();
  const api = async request => {
    const response = await fetch(`${host.origin}/api/v1`, { method: 'POST', headers: { Origin: host.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    const body = await response.json(); assert.equal(body.ok, true, JSON.stringify(body)); return body.value;
  };
  const metadata = await api({ op: 'metadata' }), scope = { hostId: host.hostId, conversationId: 'legacy-independent-chat' };
  await api({ op: 'create', scope, agentId: metadata.defaultAgentId });
  const seeded = await page.evaluate(async scope => {
    const opening = indexedDB.open('openpane-browser-views', 1), db = await new Promise(resolve => { opening.onsuccess = () => resolve(opening.result); });
    const records = text => ({ version: 3, scope, draft: text, draftRevision: 1, outbox: [], frontendSends: [], image: null });
    const second = { ...records('Independent second draft'), outbox: [{ command: { version: 1, scope, clientCommandId: 'legacy-queued-send', body: { kind: 'send', text: 'Already queued in second view' } }, draftRevision: 0 }],
      image: { selectionId: 'legacy-image', uploadId: '22222222-2222-4222-8222-222222222222', name: 'image.png', byteLength: 2, attachment: null } };
    await new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records');
      for (const id of ['legacy-first', 'legacy-second']) store.put({ version: 2, route: scope, pendingCreation: null }, ['view', id, scope.hostId]);
      store.put(records('Authoritative first draft'), ['draft','legacy-first',scope.hostId,scope.conversationId]);
      store.put(second, ['draft','legacy-second',scope.hostId,scope.conversationId]);
      store.put(new Uint8Array([7,8]), ['draft-image','legacy-second',scope.hostId,scope.conversationId,'legacy-image']);
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    }); db.close();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(text) { window.recoveredClipboard = text; } } });
    return second;
  }, scope);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await wait(() => page.getByRole('button', { name: 'Reconnect', exact: true }).isEnabled(), 'refreshed saved views');
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('button', { name: 'Reopen saved view legacy-first', exact: true }).click(); await connected(page);
  const editor = page.getByRole('textbox', { name: 'Message', exact: true });
  await wait(async () => await editor.inputValue() === 'Authoritative first draft', 'first legacy migration');
  const original = await editor.elementHandle();
  await page.getByRole('button', { name: 'Reopen saved view legacy-second', exact: true }).click();
  const recovered = page.getByRole('textbox', { name: 'Recovered unsent draft', exact: true }); await recovered.waitFor();
  assert.equal(await recovered.inputValue(), 'Independent second draft'); assert.equal(await recovered.evaluate(node => node.readOnly), true);
  assert.equal(await editor.inputValue(), 'Authoritative first draft'); assert.equal(await editor.evaluate((node, prior) => node === prior, original), true);
  await page.getByRole('button', { name: 'Copy recovered draft', exact: true }).click();
  await wait(() => page.evaluate(() => window.recoveredClipboard === 'Independent second draft'), 'copied independent text');
  await page.getByRole('button', { name: 'Open chat to paste', exact: true }).click(); await connected(page);
  assert.equal(await editor.inputValue(), 'Authoritative first draft');
  const saved = await page.evaluate(async scope => {
    const opening = indexedDB.open('openpane-browser-views', 1), db = await new Promise(resolve => { opening.onsuccess = () => resolve(opening.result); });
    const tx = db.transaction('records'), store = tx.objectStore('records'), draft = store.get(['draft','legacy-second',scope.hostId,scope.conversationId]), image = store.get(['draft-image','legacy-second',scope.hostId,scope.conversationId,'legacy-image']);
    await new Promise(resolve => { tx.oncomplete = resolve; }); db.close(); return { draft: draft.result, image: [...image.result] };
  }, scope);
  assert.deepEqual(saved.draft, seeded); assert.deepEqual(saved.image, [7,8]); assert.deepEqual(await host.entries(), []);
  await page.getByRole('button', { name: 'Dismiss recovery', exact: true }).click();
  await wait(async () => await recovered.count() === 0, 'dismissed recovery');
});

test('the inline launch composer still sends its prepared text once in the new scope', { timeout: 45000 }, async t => {
  const host = await fixture(t), page = await host.page();
  const submitted = []; page.on('request', request => { const body = request.postDataJSON(); if (body?.op === 'submit') submitted.push(body.command); });
  await page.getByRole('textbox', { name: 'First message', exact: true }).fill('First scoped message');
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await connected(page);
  await wait(async () => (await host.entries()).length === 1, 'one first-message submission');
  assert.equal(submitted.length, 1); const [command] = submitted;
  assert.equal(command.body.kind, 'send'); assert.equal(command.body.text, 'First scoped message');
  assert.equal(command.scope.conversationId, await page.locator('.scope-label').textContent());
  await page.reload(); await connected(page); assert.equal((await host.entries()).length, 1);
});
