import { assessNativeProbe, finalNativePaints } from './result.mjs';
import { stopChild } from './process.mjs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, writeFile, appendFile, readFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'openpane-native-qualification-'));
const app = join(directory, 'OpenPane Experience Probe.app');
await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
await copyFile(join(root, 'apps/desktop/src-tauri/target/debug/experience-probe'), join(app, 'Contents/MacOS/experience-probe'));
await writeFile(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>experience-probe</string><key>CFBundleIdentifier</key><string>homes.birb.openpane.experience-probe</string><key>CFBundleName</key><string>OpenPane Experience Probe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' });
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/desktop/experience-probe/window.ts'], bundle: true, write: false, format: 'iife' });
const fixtureSourceHashes = Object.fromEntries(await Promise.all(['run.mjs', 'window.ts', 'native.rs', 'result.mjs', 'process.mjs'].map(async name => [name, createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex')])));
const probeBinarySha256 = createHash('sha256').update(await readFile(join(app, 'Contents/MacOS/experience-probe'))).digest('hex');
const reports = [], timers = new Set(), reportWrites = new Set(), handlers = new Set();
let stderrTail = Promise.resolve();
let child, timedOut = false;
const handle = async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/browser.html') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>OpenPane native qualification</title><h1>Connecting native probe</h1><section></section><pre></pre><script src="/probe.js"></script></html>');
  } else if (path === '/probe.js') {
    response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents);
  } else if (path === '/report') {
    let bytes = 0, chunks = [];
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 65536) { response.writeHead(413).end(); return; } chunks.push(chunk); }
    const report = { ...JSON.parse(Buffer.concat(chunks)), at: performance.now(), wallTime: Date.now() };
    const writing = appendFile(join(directory, 'reports.jsonl'), JSON.stringify(report) + '\n');
    reportWrites.add(writing);
    try { await writing; reports.push(report); response.end('{}'); } finally { reportWrites.delete(writing); }
  } else if (path === '/observation') {
    const timer = setTimeout(() => { timers.delete(timer); response.end('{"observed":true}'); }, 1500); timers.add(timer);
  } else if (path === '/state') {
    const readyCounts = {}, recoveredCounts = {};
    for (const report of reports.filter(report => report.kind === 'child-ready')) {
      const label = report.detail.label; readyCounts[label] = (readyCounts[label] ?? 0) + 1;
      if (report.detail.recovered) recoveredCounts[label] = (recoveredCounts[label] ?? 0) + 1;
    }
    const frozen = finalNativePaints(reports);
    const finalPainted = [...new Set(frozen.paints.map(report => report.detail.label))];
    response.end(JSON.stringify({ readyCounts, recoveredCounts, finalPainted, frozenGeneration: frozen.generation, started: reports.some(report => report.kind === 'minimized') }));
  }
  else if (path === '/snapshot') response.end('{"available":true}');
  else response.writeHead(404).end();
};
const server = createServer((request, response) => {
  const handling = handle(request, response).catch(error => { reports.push({ at: performance.now(), kind: 'failure', detail: error.message }); response.destroy(); });
  handlers.add(handling); void handling.then(() => handlers.delete(handling));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/browser.html`;
await writeFile(join(directory, 'invocation.json'), JSON.stringify({ source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), node: process.version, url, app, fixtureSourceHashes, probeBinarySha256, note: 'Disposable native transport fixture. Eight existing child windows are foregrounded sequentially for startup and final actual rAF paint; simultaneous visibility is not assumed. Does not qualify production controllers, providers or real approvals. Minimize checks carry shared native monotonic timestamps. State is sampled at every relay and final-focus wait, not proven continuously between samples.' }, null, 2));
console.log(JSON.stringify({ directory, app, url }));
child = spawn(join(app, 'Contents/MacOS/experience-probe'), [url], { stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.on('data', chunk => {
  stderrTail = stderrTail.then(() => appendFile(join(directory, 'native-stderr.log'), chunk)).catch(() => { reports.push({ at: performance.now(), kind: 'failure', detail: 'Could not persist native stderr evidence' }); });
});
const outputClosed = new Promise(resolve => child.once('close', resolve));
let deadline, done, childError = null, stopping = false;
await new Promise(resolve => {
  child.once('exit', (code, signal) => { if (!stopping) childError = `Probe exited before runner shutdown: ${code}/${signal}`; resolve(); });
  child.once('error', error => { childError = error.message; resolve(); });
  deadline = setTimeout(() => { timedOut = true; resolve(); }, 370000);
  done = setInterval(() => {
    if (reports.some(report => report.kind === 'failure') || assessNativeProbe(reports, false).passed) resolve();
  }, 500);
});
clearTimeout(deadline); clearInterval(done);
stopping = true;
const stopped = await stopChild(child);
if (childError || stopped.forced || !stopped.stopped) reports.push({ at: performance.now(), kind: 'failure', detail: childError ?? (stopped.stopped ? 'Probe required forced shutdown' : 'Probe shutdown could not be confirmed') });
for (const timer of timers) clearTimeout(timer);
server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
let evidenceDeadline;
const evidenceSaved = await Promise.race([
  outputClosed.then(() => Promise.allSettled([stderrTail, ...handlers, ...reportWrites])).then(results => results.every(result => result.status === 'fulfilled')),
  new Promise(resolve => { evidenceDeadline = setTimeout(() => resolve(false), 5000); }),
]);
clearTimeout(evidenceDeadline);
if (!evidenceSaved) reports.push({ at: performance.now(), kind: 'failure', detail: 'Native output evidence did not drain before its deadline' });
const result = { ...assessNativeProbe(reports, timedOut), evidence: directory };
await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.passed ? 0 : 1;
