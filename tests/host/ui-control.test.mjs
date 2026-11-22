import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, root } from '../application/browser-support.mjs';
const cli = join(root, 'apps/host/dist/main.js');
async function command(entry, args) {
  const child = spawn(process.execPath, [entry, ...args], { stdio: 'pipe' }); let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit'); return { code, stdout, stderr };
}
test('bundled UI dispatch touches no data directory when no owner socket exists', async t => {
  const directory = await mkdtemp('/tmp/op-cli-'); t.after(() => rm(directory, { recursive: true, force: true }));
  const missing = join(directory, 'missing');
  const failed = await command(cli, ['ui', '--data-dir', missing, 'context']);
  assert.equal(failed.code, 1); assert.match(failed.stderr, /Host unavailable/);
  assert.deepEqual(await readdir(directory), []);
  const empty = join(directory, 'empty'); await mkdir(empty, { mode: 0o700 });
  assert.equal((await command(cli, ['ui', '--data-dir', empty, 'context'])).code, 1);
  assert.deepEqual(await readdir(empty), []);
});
test('installed UI chunks include runtime CSS validation without importing host startup', async t => {
  const host = await fixture(t);
  const directory = await mkdtemp('/tmp/op-installed-'); t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(root, 'apps/host/dist'), join(directory, 'host'), { recursive: true });
  const installed = join(directory, 'host/main.js');
  const result = await command(installed, ['ui', '--data-dir', host.directory, 'context']);
  assert.equal(result.code, 0, result.stderr); const context = JSON.parse(result.stdout);
  assert.equal(context.hostId, host.hostId);
  const schema = await command(installed, ['ui', '--data-dir', host.directory, 'experience', 'schema']);
  assert.equal(schema.code, 0, schema.stderr); assert.equal(JSON.parse(schema.stdout).manifest.type, 'object');
  const source = join(directory, 'source'); await mkdir(source);
  const { writeFile } = await import('node:fs/promises');
  const { sha256 } = await import('../../apps/host/build/tsc/experience-bundle.js');
  const css = '[data-openpane-part="button"] { color: #123456; }';
  await writeFile(join(source, 'style.css'), css);
  await writeFile(join(source, 'experience.json'), JSON.stringify({ schemaVersion: 1, id: 'installed', label: 'Installed CLI', theme: { mode: 'system', light: {}, dark: {} },
    presentation: { navigation: 'rail', chats: 'inline', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } },
    stylesheet: 'style.css', assets: [{ name: 'style.css', mimeType: 'text/css', bytes: Buffer.byteLength(css), sha256: sha256(css) }] }));
  const { randomUUID } = await import('node:crypto');
  const applied = await command(installed, ['ui', '--data-dir', host.directory, 'experience', 'apply', '--directory', source, '--request-id', `${context.requestEpoch}:${randomUUID()}`, '--expected-revision', String(context.revision)]);
  assert.equal(applied.code, 0, applied.stderr); assert.equal(JSON.parse(applied.stdout).outcome, 'selected-with-no-clients');
  const response = await fetch(`${host.origin}/api/ui/v1`, { method: 'POST', headers: { Origin: 'http://other', 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'context' }) });
  assert.equal(response.status, 400);
});
