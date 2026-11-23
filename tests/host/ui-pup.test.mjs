import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizePup, resolvePupRange } from '../../apps/host/build/tsc/ui-pup.js';
import { pupSite, pupVersion, runPup } from '../../apps/host/build/tsc/ui-pup-process.js';

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
async function processId(path) {
  const value = Number(await readFile(path, 'utf8'));
  assert.ok(Number.isSafeInteger(value) && value > 0, 'fixture readiness contains a positive process ID');
  return value;
}
async function isRunning(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  return true;
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
  const f = await executable(t, "import('node:fs').then(fs => { process.on('SIGTERM', () => {}); fs.writeFileSync(process.argv[2]+'.tmp', String(process.pid)); fs.renameSync(process.argv[2]+'.tmp',process.argv[2]); setInterval(() => {}, 1000); });");
  const ready = join(f.directory, 'ready'), controller = new AbortController(), running = runPup(f.path, [ready], { signal: controller.signal, timeoutMs: 12000 });
  const until = Date.now() + 8000;
  while (!await access(ready).then(() => true, () => false)) { if (Date.now() > until) throw new Error('Pup fixture did not start'); await new Promise(resolve => setTimeout(resolve, 20)); }
  const pid = await processId(ready); controller.abort();
  assert.deepEqual(await running, { kind: 'failed', reason: 'cancelled' });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('pup version discovery accepts the qualified version line without exposing unexpected output', async t => {
  const f = await executable(t, "console.log('pup 2.0.1');");
  assert.equal(await pupVersion(f.path, new AbortController().signal), '2.0.1');
  const invalid = await executable(t, "console.log('PRIVATE_AUTHENTICATION_MARKER');");
  await assert.rejects(pupVersion(invalid.path, new AbortController().signal), error => !error.message.includes('PRIVATE_AUTHENTICATION_MARKER'));
});

test('qualified rate units retain the numerator and denominator without rescaling raw values', () => {
  const raw = structuredClone(source);
  raw.series[0].unit = [
    { family: 'bytes', id: 2, name: 'byte', plural: 'bytes', scale_factor: 1, short_name: 'B' },
    { family: 'time', id: 11, name: 'second', plural: 'seconds', scale_factor: 1, short_name: 's' },
  ];
  const card = normalize(raw);
  assert.equal(card.series[0].unit, 'B/s');
  assert.deepEqual(card.series[0].points, source.series[0].pointlist);
});
test('a raw response must match its fixed reservation query and range, allowing only interval-aligned boundary buckets', () => {
  for (const mutate of [raw => raw.query = 'another query', raw => raw.from_date += 1000, raw => raw.to_date -= 1000,
    raw => { raw.series[0].start -= 600000; raw.series[0].pointlist = raw.series[0].pointlist.map(([at, value]) => [at - 600000, value]); }]) {
    const raw = structuredClone(source); mutate(raw); assert.throws(() => normalize(raw));
  }
});

test('the independent pup guardian drains a SIGTERM-resistant child after its CLI owner is killed', { timeout: 15000 }, async t => {
  const f = await executable(t, "const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(process.argv[2]+'.tmp',String(process.pid));fs.renameSync(process.argv[2]+'.tmp',process.argv[2]); setInterval(()=>{},1000);");
  const ready = join(f.directory, 'guardian-ready');
  const module = process.env.OPENPANE_PUP_REPRO_MODULE ?? new URL('../../apps/host/build/tsc/ui-pup-process.js', import.meta.url).href;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', `import {runPup} from ${JSON.stringify(module)}; await runPup(${JSON.stringify(f.path)},[${JSON.stringify(ready)}],{signal:new AbortController().signal,timeoutMs:10000});`], { stdio: 'ignore' });
  let pid;
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); if (pid) try { process.kill(-pid, 'SIGKILL'); } catch {} });
  const until = Date.now() + 5000;
  while (!await access(ready).then(() => true, () => false)) { if (Date.now() > until) throw new Error('Supervised pup did not start'); await new Promise(resolve => setTimeout(resolve, 20)); }
  pid = await processId(ready);
  const exit = once(owner, 'exit'); owner.kill('SIGKILL'); await exit;
  const drained = Date.now() + 3500;
  while (Date.now() < drained) { if (!await isRunning(pid)) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Pup survived the death of its publishing CLI');
});
test('an expired execution grant cannot start a late pup process', async t => {
  const f = await executable(t, "require('node:fs').writeFileSync(process.argv[2],'started');");
  const ready = join(f.directory, 'late-start');
  assert.deepEqual(await runPup(f.path, [ready], { signal: new AbortController().signal, deadlineMs: Date.now() - 1 }), { kind: 'failed', reason: 'pup-timeout' });
  await assert.rejects(access(ready), { code: 'ENOENT' });
});


test('grouped metrics retain their distinct scopes beside the metric display name',()=>{
  const raw=structuredClone(source);raw.series=['host:a','host:b'].map(scope=>({...structuredClone(source.series[0]),display_name:'system.cpu.user',scope}));
  assert.deepEqual(normalize(raw).series.map(series=>series.label),['system.cpu.user {host:a}','system.cpu.user {host:b}']);
  assert.deepEqual(normalize(raw).series.map(series=>series.points),[source.series[0].pointlist,source.series[0].pointlist]);
});

for (const exitCode of [0, 7]) test(`ordinary pup exit ${exitCode} drains a helper with closed streams`, { timeout: 10000 }, async t => {
  const f = await executable(t, `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    fs.writeFileSync(process.argv[2],String(child.pid)); process.stdout.write('{}'); process.exit(${exitCode});`);
  const ready = join(f.directory, 'helper'); let pid;
  t.after(() => { if (pid) try { process.kill(pid, 'SIGKILL'); } catch {} });
  const result = await runPup(f.path, [ready], { signal: new AbortController().signal });
  pid = await processId(ready);
  assert.equal(result.kind, exitCode === 0 ? 'completed' : 'failed');
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (!await isRunning(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Pup helper survived a completed query attempt');
});

for (const exitCode of [0, 7]) test(`ordinary pup exit ${exitCode} drains a helper that inherited stdout`, { timeout: 5000 }, async t => {
  const f = await executable(t, `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});
    fs.writeFileSync(process.argv[2],String(child.pid)); process.stdout.write('complete result'); process.exit(${exitCode});`);
  const ready = join(f.directory, 'inherited-helper'); let pid;
  t.after(() => { if (pid) try { process.kill(pid, 'SIGKILL'); } catch {} });
  const result = await runPup(f.path, [ready], { signal: new AbortController().signal, timeoutMs: 1000 });
  pid = await processId(ready);
  assert.deepEqual(result, exitCode === 0 ? { kind: 'completed', stdout: 'complete result' } : { kind: 'failed', reason: 'pup-failed' });
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (!await isRunning(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Pup helper survived a completed query attempt');
});

test('pup qualification, site discovery and queries omit unrelated provider credentials', async t => {
  const overrides = { OPENPANE_EXTENSION_CREW_TOKEN: 'PRIVATE_PROVIDER_MARKER', ANTHROPIC_API_KEY: 'PRIVATE_PROVIDER_MARKER', DD_SITE: '', DD_API_KEY: 'DATADOG_MARKER' };
  for (const [key,value] of Object.entries(overrides)) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const f = await executable(t, `const fs=require('node:fs');
    fs.appendFileSync(${JSON.stringify('ENV_LOG_PLACEHOLDER')},JSON.stringify({args:process.argv.slice(2),crew:process.env.OPENPANE_EXTENSION_CREW_TOKEN,anthropic:process.env.ANTHROPIC_API_KEY,dd:process.env.DD_API_KEY})+'\\n');
    if(process.argv.includes('--version')) console.log('pup 2.0.1');
    else if(process.argv.includes('auth')) console.log(JSON.stringify({site:'us3.datadoghq.com'}));
    else console.log('{}');`);
  const log = join(f.directory, 'environment');
  await writeFile(f.path, (await readFile(f.path,'utf8')).replace('ENV_LOG_PLACEHOLDER',log));
  const signal = new AbortController().signal;
  assert.equal(await pupVersion(f.path, signal), '2.0.1');
  assert.equal(await pupSite(f.path, signal), 'us3.datadoghq.com');
  assert.equal((await runPup(f.path, ['metrics','query'], {signal,env:{...process.env}})).kind, 'completed');
  const entries = (await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries.length,3);
  for (const entry of entries) { assert.equal(entry.crew,undefined);assert.equal(entry.anthropic,undefined);assert.equal(entry.dd,'DATADOG_MARKER'); }
});

test('pup points follow the qualified provider interval grid', () => {
  const raw = structuredClone(source);
  raw.series[0].interval = 7; raw.series[0].end = raw.series[0].pointlist.at(-1)[0];
  assert.throws(() => normalize(raw), /timestamp/);
});

test('grouped labels beyond the contract bound refuse instead of truncating series identity', () => {
  const raw = structuredClone(source);
  raw.series[0].display_name = 'a'.repeat(150); raw.series[0].scope = 'host:' + 'b'.repeat(100);
  assert.throws(() => normalize(raw), /text|label|200/i);
  assert.deepEqual(raw.series[0].pointlist, source.series[0].pointlist);
});
