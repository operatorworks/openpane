import { createServer, request as forward } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { fixture } from '../../application/browser-support.mjs';
import { requestUi } from '../../../apps/host/build/tsc/ui-control.js';
import { createExperienceBundle, sha256 } from '../../../apps/host/build/tsc/experience-bundle.js';

const root = fileURLToPath(new URL('../../../', import.meta.url)), cleanups = [];
const evidence = await mkdtemp(join(tmpdir(), 'openpane-native-home-'));
let child, server, timeout;
try {
  const host = await fixture({ after(cleanup) { cleanups.push(cleanup); } });
  const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/desktop/experience-probe/home-window.jsx'], outfile: 'home.js', bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const javascript = bundle.outputFiles.find(file => file.path.endsWith('.js')).contents, css = bundle.outputFiles.find(file => file.path.endsWith('.css')).contents;
  await writeFile(join(evidence, 'home.js'), javascript); await writeFile(join(evidence, 'home.css'), css);
  let finish;
  const reported = new Promise(resolve => { finish = resolve; });
  server = createServer(async (incoming, outgoing) => {
    try {
      const path = new URL(incoming.url, 'http://localhost').pathname;
      if (path === '/browser.html') { outgoing.setHeader('Content-Type', 'text/html'); outgoing.end('<!doctype html><meta charset="utf-8"><title>Home WKWebView qualification</title><link rel="stylesheet" href="/qa/home.css"><div id="root"></div><script src="/qa/home.js"></script>'); return; }
      if (path === '/qa/home.js') { outgoing.setHeader('Content-Type', 'text/javascript'); outgoing.end(javascript); return; }
      if (path === '/qa/home.css') { outgoing.setHeader('Content-Type', 'text/css'); outgoing.end(css); return; }
      if (path.startsWith('/qa/')) {
        let body = ''; for await (const chunk of incoming) { body += chunk; if (body.length > 65536) throw new Error('Oversize fixture request'); }
        const value = JSON.parse(body), socket = join(host.directory, 'ui.sock'); let result;
        if (path === '/qa/apply') {
          const context = await requestUi(socket, { op: 'context' }); await requestUi(socket, { op: 'schema' }); await requestUi(socket, { op: 'display-schema' });
          const stylesheet = `[data-openpane-part="header"] { background-color: ${value.color}; }`;
          const experience = createExperienceBundle({ schemaVersion: 2, id: 'native-home-probe', label: 'WKWebView Home probe', theme: { mode: 'light', density: 'compact', light: {}, dark: {} },
            presentation: { home: { kind: 'stack', panes: value.panes }, transcript: 'lines', navigation: 'pages', chats: 'inline', chatWindow: { width: 640, height: 720, title: 'conversation', titlebar: 'native' } },
            stylesheet: 'style.css', assets: [{ name: 'style.css', mimeType: 'text/css', bytes: Buffer.byteLength(stylesheet), sha256: sha256(stylesheet) }] }, stylesheet, []);
          result = await requestUi(socket, { op: 'apply', expectedRevision: context.revision, requestId: `${context.requestEpoch}:${randomUUID()}`, bundle: experience });
        } else if (path === '/qa/status') result = await requestUi(socket, { op: 'status', requestId: value.requestId });
        else if (path === '/qa/context') result = await requestUi(socket, { op: 'context' });
        else if (path === '/qa/commands') result = await host.entries();
        else if (path === '/qa/report') { result = {}; finish(value); }
        else throw new Error('Unknown fixture operation');
        outgoing.setHeader('Content-Type', 'application/json'); outgoing.end(JSON.stringify(result)); return;
      }
      const headers = { ...incoming.headers, host: new URL(host.origin).host }; if (headers.origin) headers.origin = host.origin;
      const upstream = forward(new URL(incoming.url, host.origin), { method: incoming.method, headers }, response => { outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing); });
      upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }); outgoing.on('close', () => upstream.destroy()); incoming.pipe(upstream);
    } catch (error) { outgoing.writeHead(500); outgoing.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const app = join(evidence, 'OpenPane Home Probe.app'); await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
  await copyFile(join(root, 'apps/desktop/src-tauri/target/debug/experience-probe'), join(app, 'Contents/MacOS/experience-probe'));
  await writeFile(join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>experience-probe</string><key>CFBundleIdentifier</key><string>homes.birb.openpane.home-probe</string><key>CFBundleName</key><string>OpenPane Home Probe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' });
  const url = `http://127.0.0.1:${server.address().port}/browser.html`;
  child = spawn(join(app, 'Contents/MacOS/experience-probe'), [url], { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const result = await Promise.race([reported, new Promise(resolve => { timeout = setTimeout(() => resolve({ passed: false, error: 'Native Home probe timed out' }), 90000); }), once(child, 'exit').then(([code, signal]) => ({ passed: false, error: `Native probe exited before reporting: ${code}/${signal}` }))]);
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ ...result, source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), dirtySource: execFileSync('git', ['diff', '--stat'], { cwd: root, encoding: 'utf8' }), note: 'Production Home/ExperienceScope/BrowserApplication and controller in WKWebView, synthetic composition events, recorded service. This does not emulate a physical IME or replace production native-window qualification.' }, null, 2));
  await writeFile(join(evidence, 'native-stderr.log'), stderr);
  console.log(JSON.stringify({ ...result, evidence })); if (!result.passed) process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  const bounded = async (task, milliseconds) => { let timer; try { return await Promise.race([task.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); } finally { clearTimeout(timer); } };
  if (child?.exitCode === null && child.signalCode === null) {
    const ended = once(child, 'exit'); child.kill('SIGTERM');
    if (!await bounded(ended, 5000)) { child.kill('SIGKILL'); if (!await bounded(ended, 5000)) process.exitCode = 1; }
  }
  server?.closeAllConnections(); if (server?.listening && !await bounded(new Promise(resolve => server.close(resolve)), 5000)) process.exitCode = 1;
  for (const cleanup of cleanups.reverse()) { try { if (!await bounded(Promise.resolve().then(cleanup), 20000)) { console.error('Native fixture cleanup timed out'); process.exitCode = 1; } } catch (error) { console.error(error); process.exitCode = 1; } }
}
