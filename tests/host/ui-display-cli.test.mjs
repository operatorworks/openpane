import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startBrowserHost } from './extensions/fixtures.mjs';
import { requestUi } from '../../apps/host/build/tsc/ui-control.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), entry = join(root, 'apps/host/dist/main.js');
const source = JSON.parse(await readFile(new URL('./fixtures/metrics/pup-v1.json', import.meta.url), 'utf8'));
async function wait(check) { const until = Date.now() + 10000; while (!await check()) { if (Date.now() > until) throw new Error('CLI query did not reach its fixture'); await new Promise(resolve => setTimeout(resolve, 20)); } }
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'openpane-display-cli-')), profile = join(directory, 'profile'), pup = join(directory, 'pup'), log = join(directory, 'argv.jsonl'), mode = join(directory, 'mode.json'), ready = join(directory, 'query-ready');
  await writeFile(mode, JSON.stringify({ kind: 'success' }));
  await writeFile(pup, `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args,site:process.env.DD_SITE})+'\\n');
if (args.includes('--version')) { console.log('pup 2.0.1'); process.exit(0); }
if (args.includes('auth')) { console.log(JSON.stringify({site:'us3.datadoghq.com'})); process.exit(0); }
const mode = JSON.parse(fs.readFileSync(${JSON.stringify(mode)}, 'utf8'));
if (mode.kind==='hang') { fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(()=>{},1000); }
else if (mode.kind==='invalid') process.stdout.write('{invalid');
else { process.stdout.write(${JSON.stringify(JSON.stringify(source))}); if(mode.kind==='fail') {process.stderr.write('PRIVATE_AUTHENTICATION_MARKER');setTimeout(()=>process.exit(7),20);} }
`, { mode: 0o700 });
  const options = { directory: profile, port: 0, assetsDirectory: join(root, 'apps/desktop/web-dist-browser'), agentStartup: { kind: 'recorded' } };
  let host = await startBrowserHost(options);
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });
  const api = async request => {
    const response = await fetch(`${host.origin}/api/v1`, { method: 'POST', headers: { Origin: host.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    const body = await response.json(); assert.equal(body.ok, true, JSON.stringify(body)); return body.value;
  };
  const metadata = await api({ op: 'metadata' }), scope = { hostId: host.hostId, conversationId: randomUUID() }; await api({ op: 'create', scope, agentId: metadata.defaultAgentId });
  const id = async () => `${(await requestUi(join(profile, 'ui.sock'), { op: 'context' })).requestEpoch}:${randomUUID()}`;
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const cli = (args, stdin = '') => {
    const child = spawn(process.execPath, [entry, 'ui', '--data-dir', profile, ...args], { env: { ...process.env, DD_SITE: 'us3.datadoghq.com', DD_TOKEN_STORAGE: 'file' }, stdio: 'pipe' });
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; }); child.stdin.end(stdin);
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); });
    return { child, done };
  };
  const query = (publicationId, target = scope, extra = []) => ['display', 'datadog', '--scope-json', JSON.stringify(target), '--publication-id', publicationId, '--query', source.query, '--title', 'CPU', '--from', '1795374001', '--to', '1795374061', '--pup', pup, ...extra];
  const status = async publicationId => { const result = await cli(['display', 'status', '--scope-json', JSON.stringify(scope), '--publication-id', publicationId]).done; assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout); };
  const page = async (target = scope) => {
    const response = await fetch(`${host.origin}/api/ui/v1`, { method: 'POST', headers: { Origin: host.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'display-list', subscription: { scope: target, subscriptionId: randomUUID(), cursor: null } }) });
    return { status: response.status, body: await response.json() };
  };
  return { profile, pup, mode, ready, scope, id, calls, cli, query, status, page, get host() { return host; },
    async restart() { await host.close(); host = await startBrowserHost(options); } };
}

test('packaged display CLI publishes one actual executable response and replays it after the binary disappears', { timeout: 30000 }, async t => {
  const f = await fixture(t), publicationId = await f.id(), first = await f.cli(f.query(publicationId)).done;
  assert.equal(first.code, 0, first.stderr); const result = JSON.parse(first.stdout); assert.equal(result.reservation.kind, 'published');
  const queries = (await f.calls()).filter(call => call.args.includes('metrics')); assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].args, ['--no-agent', '--output=json', 'metrics', 'query', `--query=${source.query}`, '--from=1795374001', '--to=1795374061']);
  assert.equal(queries[0].site, 'us3.datadoghq.com'); assert.ok(!queries[0].args.some(arg => arg.startsWith('--org')));
  const page = await f.page(); assert.equal(page.status, 200); assert.equal(page.body.value.publications.length, 1);
  const publication = page.body.value.publications[0]; assert.equal(publication.digest, result.reservation.digest);
  assert.deepEqual(publication.event.value.series[0].points, source.series[0].pointlist); assert.equal(publication.event.value.series[0].unit, '%'); assert.equal(publication.event.value.fromMs, 1795374001000);
  await rm(f.pup);
  const replay = await f.cli(f.query(publicationId)).done; assert.equal(replay.code, 0, replay.stderr); assert.equal(JSON.parse(replay.stdout).replayed, true);
  assert.equal((await f.calls()).filter(call => call.args.includes('metrics')).length, 1);
  const changed = f.query(publicationId); changed[changed.indexOf('--query') + 1] = 'different';
  assert.equal((await f.cli(changed).done).code, 1);
  await f.restart(); assert.equal((await f.status(publicationId)).reservation.sequence, result.reservation.sequence);
  assert.equal((await f.page()).body.value.publications[0].digest, publication.digest);
});

test('valid stdout followed by failed close produces no card, keeps query mode and retries only explicitly', { timeout: 30000 }, async t => {
  const f = await fixture(t), publicationId = await f.id(); await writeFile(f.mode, JSON.stringify({ kind: 'fail' }));
  const failed = await f.cli(f.query(publicationId)).done; assert.equal(failed.code, 1); assert.doesNotMatch(failed.stdout + failed.stderr, /PRIVATE_AUTHENTICATION_MARKER/);
  assert.equal((await f.status(publicationId)).reservation.kind, 'failed'); assert.deepEqual((await f.page()).body.value.publications, []);
  const event = { type: 'CUSTOM', name: 'openpane.datadog.metrics.v1', value: { schemaVersion: 1, query: source.query, title: 'CPU', fromMs: 1795374001000, toMs: 1795374061000, fetchedAtMs: Date.now(), series: [] } };
  const raw = await f.cli(['display', 'publish', '--scope-json', JSON.stringify(f.scope), '--publication-id', publicationId, '--stdin'], JSON.stringify(event)).done;
  assert.equal(raw.code, 1); assert.match(raw.stderr, /different mode/);
  const duplicate = await f.cli(f.query(publicationId)).done; assert.equal(JSON.parse(duplicate.stdout).reservation.kind, 'failed');
  assert.equal((await f.calls()).filter(call => call.args.includes('metrics')).length, 1);
  await writeFile(f.mode, JSON.stringify({ kind: 'success' }));
  const retried = await f.cli(['display', 'retry', '--scope-json', JSON.stringify(f.scope), '--publication-id', publicationId, '--expected-attempt', '1']).done;
  assert.equal(retried.code, 0, retried.stderr); assert.equal(JSON.parse(retried.stdout).reservation.attempt, 2);
  assert.equal((await f.calls()).filter(call => call.args.includes('metrics')).length, 2); assert.equal((await f.page()).body.value.publications.length, 1);
});

test('foreign or absent scopes and expired unknown IDs refuse before starting any pup process', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  for (const scope of [{ ...f.scope, hostId: 'foreign' }, { ...f.scope, conversationId: 'absent' }]) {
    const result = await f.cli(f.query(await f.id(), scope)).done; assert.equal(result.code, 1); assert.match(result.stderr, /another host|unavailable/);
  }
  const expired = await f.cli(f.query(`0:${randomUUID()}`)).done; assert.equal(expired.code, 1); assert.match(expired.stderr, /current ui context/);
  assert.deepEqual(await f.calls(), []);
  const response = await fetch(`${f.host.origin}/api/ui/v1`, { method: 'POST', headers: { Origin: f.host.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'display-query-reserve', scope: f.scope, publicationId: await f.id(), input: {} }) });
  assert.equal(response.status, 400); assert.deepEqual((await f.page()).body.value.publications, []);
});

test('CLI shutdown and host owner loss drain the running child without publishing a partial card', { timeout: 30000 }, async t => {
  const f = await fixture(t); await writeFile(f.mode, JSON.stringify({ kind: 'hang' }));
  const publicationId = await f.id(), query = f.cli(f.query(publicationId));
  await wait(() => access(f.ready).then(() => true, () => false)); const pid = Number(await readFile(f.ready, 'utf8'));
  query.child.kill('SIGTERM'); assert.equal((await query.done).code, 1); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal((await f.status(publicationId)).reservation.kind, 'failed'); assert.deepEqual((await f.page()).body.value.publications, []);
  await rm(f.ready); const lostId = await f.id(), lost = f.cli(f.query(lostId));
  await wait(() => access(f.ready).then(() => true, () => false)); const lostPid = Number(await readFile(f.ready, 'utf8'));
  await f.restart(); assert.equal((await lost.done).code, 1); assert.throws(() => process.kill(lostPid, 0), { code: 'ESRCH' });
  assert.equal((await f.status(lostId)).reservation.kind, 'interrupted'); assert.deepEqual((await f.page()).body.value.publications, []);
});

test('the packaged CLI enforces the real 30-second child deadline before publication', { timeout: 45000 }, async t => {
  const f = await fixture(t), publicationId = await f.id(); await writeFile(f.mode, JSON.stringify({ kind: 'hang' }));
  const result = await f.cli(f.query(publicationId)).done;
  assert.equal(result.code, 1); assert.equal((await f.status(publicationId)).reservation.reason, 'pup-timeout');
  assert.deepEqual((await f.page()).body.value.publications, []);
  const pid = Number(await readFile(f.ready, 'utf8')); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
