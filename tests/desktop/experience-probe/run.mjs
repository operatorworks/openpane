import { assessNativeProbe } from './result.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, writeFile, appendFile } from 'node:fs/promises';
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
const reports = [], timers = new Set();
let child, timedOut = false;
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/browser.html') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>OpenPane native qualification</title><h1>Connecting native probe</h1><section></section><pre></pre><script src="/probe.js"></script></html>');
  } else if (path === '/probe.js') {
    response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents);
  } else if (path === '/report') {
    let bytes = 0, chunks = [];
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 65536) { response.writeHead(413).end(); return; } chunks.push(chunk); }
    const report = { at: Date.now(), ...JSON.parse(Buffer.concat(chunks)) };
    reports.push(report); await appendFile(join(directory, 'reports.jsonl'), JSON.stringify(report) + '\n'); response.end('{}');
  } else if (path === '/observation') {
    const timer = setTimeout(() => { timers.delete(timer); response.end('{"observed":true}'); }, 1500); timers.add(timer);
  } else if (path === '/state') response.end(JSON.stringify({ childrenReady: new Set(reports.filter(report => report.kind === 'child-ready').map(report => report.detail.label)).size, recovered: reports.some(report => report.kind === 'child-ready' && report.detail.recovered) }));
  else if (path === '/snapshot') response.end('{"available":true}');
  else response.writeHead(404).end();
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/browser.html`;
await writeFile(join(directory, 'invocation.json'), JSON.stringify({ source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), node: process.version, url, app, note: 'Disposable native transport fixture. Does not qualify production controllers, providers or real approvals.' }, null, 2));
console.log(JSON.stringify({ directory, app, url }));
child = spawn(join(app, 'Contents/MacOS/experience-probe'), [url], { stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.on('data', chunk => { void appendFile(join(directory, 'native-stderr.log'), chunk); });
const deadline = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 370000);
const done = setInterval(() => {
  if (reports.some(report => report.kind === 'failure') || (reports.some(report => report.kind === 'main-complete') && new Set(reports.filter(report => report.kind === 'child-complete').map(report => report.detail.label)).size === 8)) child.kill('SIGTERM');
}, 500);
await once(child, 'exit'); clearTimeout(deadline); clearInterval(done);
for (const timer of timers) clearTimeout(timer);
server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
const result = { ...assessNativeProbe(reports, timedOut), evidence: directory };
await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.passed ? 0 : 1;
