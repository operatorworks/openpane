import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizePup, resolvePupRange } from '../../apps/host/build/tsc/ui-pup.js';
import { pupVersion, runPup } from '../../apps/host/build/tsc/ui-pup-process.js';

const source = JSON.parse(await readFile(new URL('./fixtures/metrics/pup-v1.json', import.meta.url), 'utf8'));
const range = { fromSeconds: 1795374001, toSeconds: 1795374061 };
const normalize = raw => normalizePup(raw, 'avg:system.cpu.user{*}', 'CPU user', range, 1795374062000);

test('qualified pup v1 retains epoch-millisecond points, unit labels, null gaps and aligned boundary buckets', () => {
  const card = normalize(source);
  assert.deepEqual(card.series[0].points, [[1795374000000, 1.25], [1795374020000, null], [1795374040000, 3.25]]);
  assert.equal(card.fromMs, 1795374001000); assert.equal(card.toMs, 1795374061000);
  assert.ok(card.series[0].points[0][0] < card.fromMs, 'a valid returned bucket can precede the fixed requested range');
  assert.equal(card.series[0].unit, '%'); assert.equal(card.series[0].points[2][1], 3.25);
});
test('pup v1 keeps distinct units and empty success without scaling or inventing zeros', () => {
  const raw = structuredClone(source), second = structuredClone(raw.series[0]);
  second.display_name = 'Memory example'; second.unit[0].name = 'byte'; second.unit[0].short_name = 'B'; raw.series.push(second);
  assert.deepEqual(normalize(raw).series.map(series => series.unit), ['%', 'B']);
  assert.deepEqual(normalize({ ...source, series: [] }).series, []);
  raw.series[0].unit = [null, null]; assert.equal(normalize(raw).series[0].unit, null);
});
test('unknown pup formats and timestamps that disagree with qualified metadata are refused', () => {
  for (const mutate of [
    raw => raw.resp_version = 2, raw => raw.res_type = 'scalar', raw => raw.status = 'error',
    raw => raw.series[0].pointlist[0][0] /= 1000,
    raw => raw.series[0].pointlist[1][0] = raw.series[0].pointlist[0][0],
    raw => raw.series[0].pointlist[0][1] = Infinity,
    raw => raw.series[0].length++, raw => raw.series[0].interval = 0,
    raw => raw.series[0].unit = 'percent', raw => raw.series[0].unit[1] = { name: 'unknown' },
    raw => raw.series = Array(9).fill(raw.series[0]),
  ]) { const raw = structuredClone(source); mutate(raw); assert.throws(() => normalize(raw)); }
  assert.throws(() => normalize({ kind: 'ok', data: source }), /schema/);
});
test('relative query bounds resolve once to whole absolute seconds', () => {
  assert.deepEqual(resolvePupRange('1h', 'now', 1795377600999), { fromSeconds: 1795374000, toSeconds: 1795377600 });
  assert.deepEqual(resolvePupRange('1795374000', '1795377600', 0), { fromSeconds: 1795374000, toSeconds: 1795377600 });
  for (const [from, to] of [['0h', 'now'], ['1.5h', 'now'], ['later', 'now'], ['20', '10'], ['0', String(Number.MAX_SAFE_INTEGER)]]) assert.throws(() => resolvePupRange(from, to, 1795377600000));
});

async function executable(t, program) {
  const directory = await mkdtemp(join(tmpdir(), 'openpane-pup-executable-')), path = join(directory, 'pup');
  await writeFile(path, `#!${process.execPath}\n${program}\n`, { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true })); return { directory, path };
}
test('pup output is usable only after successful close, and failures never return authentication text', async t => {
  const good = await executable(t, `process.stdout.write(${JSON.stringify(JSON.stringify(source))});`);
  const completed = await runPup(good.path, [], { signal: new AbortController().signal });
  assert.equal(completed.kind, 'completed'); assert.deepEqual(JSON.parse(completed.stdout), source);
  const late = await executable(t, `process.stdout.write(${JSON.stringify(JSON.stringify(source))}); process.stderr.write('PRIVATE_AUTHENTICATION_MARKER'); setTimeout(() => process.exit(7), 20);`);
  const failed = await runPup(late.path, [], { signal: new AbortController().signal });
  assert.deepEqual(failed, { kind: 'failed', reason: 'pup-failed' }); assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_AUTHENTICATION_MARKER/);
});
for (const [stream, size] of [['stdout', 2 * 1024 * 1024 + 1], ['stderr', 16 * 1024 + 1]]) test(`pup ${stream} exceeding its byte limit terminates without returning partial data`, async t => {
  const f = await executable(t, `process.${stream}.write(Buffer.alloc(${size}, 120)); setInterval(() => {}, 1000);`);
  assert.deepEqual(await runPup(f.path, [], { signal: new AbortController().signal }), { kind: 'failed', reason: 'pup-output-limit' });
});
test('pup timeout, cancellation, missing executable and malformed UTF-8 stay bounded failures', async t => {
  const slow = await executable(t, 'setInterval(() => {}, 1000);');
  assert.deepEqual(await runPup(slow.path, [], { signal: new AbortController().signal, timeoutMs: 500 }), { kind: 'failed', reason: 'pup-timeout' });
  assert.deepEqual(await runPup(join(slow.directory, 'missing'), [], { signal: new AbortController().signal }), { kind: 'failed', reason: 'pup-unavailable' });
  const cancelled = new AbortController(); cancelled.abort();
  assert.deepEqual(await runPup(slow.path, [], { signal: cancelled.signal }), { kind: 'failed', reason: 'cancelled' });
  const invalid = await executable(t, 'process.stdout.write(Buffer.from([255]));');
  assert.deepEqual(await runPup(invalid.path, [], { signal: new AbortController().signal }), { kind: 'failed', reason: 'invalid-response' });
});
test('cancelling a running pup drains a child that ignores the first termination signal', { timeout: 15000 }, async t => {
  const f = await executable(t, "import('node:fs').then(fs => { process.on('SIGTERM', () => {}); fs.writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000); });");
  const ready = join(f.directory, 'ready'), controller = new AbortController(), running = runPup(f.path, [ready], { signal: controller.signal, timeoutMs: 12000 });
  const until = Date.now() + 8000;
  while (!await access(ready).then(() => true, () => false)) { if (Date.now() > until) throw new Error('Pup fixture did not start'); await new Promise(resolve => setTimeout(resolve, 20)); }
  const pid = Number(await readFile(ready, 'utf8')); controller.abort();
  assert.deepEqual(await running, { kind: 'failed', reason: 'cancelled' });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('pup version discovery accepts the qualified version line without exposing unexpected output', async t => {
  const f = await executable(t, "console.log('pup 2.0.1');");
  assert.equal(await pupVersion(f.path, new AbortController().signal), '2.0.1');
  const invalid = await executable(t, "console.log('PRIVATE_AUTHENTICATION_MARKER');");
  await assert.rejects(pupVersion(invalid.path, new AbortController().signal), error => !error.message.includes('PRIVATE_AUTHENTICATION_MARKER'));
});
