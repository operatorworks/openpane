import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UiStore } from '../../apps/host/build/tsc/ui-store.js';
import { uiEndpoint } from '../../apps/host/build/tsc/ui-endpoint.js';

test('HTTP UI input refusals stay distinct from actual SQLite execution failures', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ui-endpoint-')), store = new UiStore(join(directory, 'ui.sqlite'), 'host');
  const endpoint = uiEndpoint(store, null, { record() {} }, () => false), server = createServer((request, response) => { void endpoint(request, response); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(directory, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = input => fetch(`${origin}/api/ui/v1`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const invalid = await post({ op: 'invalid' }); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, 'invalid-input');
  const context = { role: 'main', hostId: 'host', profileId: store.context().profileId, brokerInstance: 'browser', label: 'main', documentIncarnation: randomUUID(), viewId: 'view' };
  const state = sequence => ({ op: 'state', context, visible: true, presenceSequence: sequence, after: null, waitMs: 0 });
  assert.equal((await post(state(1))).status, 200);
  store.db.exec('DROP TABLE ui_receipts');
  const failed = await post(state(2)), failure = await failed.json();
  assert.equal(failed.status, 503); assert.equal(failure.code, 'unavailable'); assert.doesNotMatch(failure.error, /ui_receipts|SQLite/);
});
