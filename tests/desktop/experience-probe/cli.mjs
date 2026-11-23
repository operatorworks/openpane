import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const executable = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Pass the installed pinned Codex executable as argv[2]');
const directory = await mkdtemp('/tmp/op-ui-');
await chmod(directory, 0o700);
const workspace = join(directory, 'workspace'); await mkdir(workspace);
const socketPath = join(directory, 'ui.sock'), received = [];
const receiver = createServer(socket => {
  socket.setTimeout(5000, () => socket.destroy());
  let input = '';
  socket.on('data', chunk => {
    input += chunk;
    if (Buffer.byteLength(input) > 4096) { socket.destroy(); return; }
    if (input.includes('\n')) {
      const request = JSON.parse(input.trim()); received.push(request);
      socket.end(JSON.stringify({ ok: true, received: request.scope }) + '\n');
    }
  });
});
receiver.listen(socketPath); await once(receiver, 'listening'); await chmod(socketPath, 0o600);
const entry = join(directory, 'main.mjs');
await writeFile(entry, `import {createConnection} from 'node:net';\nconst [mode,flag,path,operation,scopeFlag,scopeText]=process.argv.slice(2);\nif(mode!=='ui'||flag!=='--data-dir'||operation!=='probe'||scopeFlag!=='--scope-json')throw new Error('Invalid probe argv');\nconst socket=createConnection(path+'/ui.sock');socket.on('connect',()=>socket.write(JSON.stringify({kind:'probe',scope:JSON.parse(scopeText),argv:process.argv.slice(2)})+'\\n'));socket.on('data',chunk=>process.stdout.write(chunk));socket.on('error',()=>{process.exitCode=1});socket.setTimeout(5000,()=>socket.destroy());\n`);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AZURE_OPENAI_API_KEY'].includes(key)));
const child = spawn(process.execPath, [join(root, 'apps/host/dist/main.js'), 'codex', '--data-dir', join(directory, 'profile'), '--workspace', workspace, '--executable', executable, '--port', '0'], { cwd: root, env, stdio: 'pipe' });
let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
let browser;
let result;
try {
  browser = await chromium.launch({ headless: false });
  const info = await new Promise((resolveInfo, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Packaged host did not start')), 20000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Packaged host exited')); });
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) { clearTimeout(timer); resolveInfo(JSON.parse(output.split('\n')[0])); } });
  });
  const page = await browser.newPage(); page.setDefaultTimeout(20000);
  await page.goto(`${info.origin}/browser.html`);
  const newChat = page.getByRole('button', { name: 'New conversation', exact: true });
  await newChat.click();
  const editor = page.getByRole('textbox', { name: 'Message', exact: true }); await editor.waitFor();
  const conversationId = (await page.locator('.scope-label').textContent()).trim();
  const scope = { hostId: info.hostId, conversationId };
  const prefix = [process.execPath, entry, 'ui', '--data-dir', directory];
  const pup = process.argv[3] ? resolve(process.argv[3]) : null;
  const toSeconds = Math.floor(Date.now() / 1000), range = { fromSeconds: toSeconds - 3600, toSeconds };
  const prompt = `Qualify OpenPane UI CLI access in this disposable workspace. Create probe.txt containing exactly "approved UI probe". Then run this exact argv as a command, requesting ordinary approval if necessary: ${JSON.stringify([...prefix, 'probe', '--scope-json', JSON.stringify(scope)])}. Do not change configuration or use another runtime. ${pup ? `Also execute ${JSON.stringify(pup)} --no-agent --output=json metrics query --query 'avg:system.cpu.user{*}' --from=${range.fromSeconds} --to=${range.toSeconds}, with DD_SITE=us3.datadoghq.com and no --org; save stdout to pup-raw.json in this workspace. Do not print credentials. If it fails, stop and report that failure.` : ''} Report completion.`;
  await writeFile(join(directory, 'intent.json'), JSON.stringify({ scope, prefix, prompt, codexVersion: execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), node: process.version }, null, 2));
  await editor.fill(prompt); await page.getByRole('button', { name: 'Send', exact: true }).click();
  const approvals = [], deadline = Date.now() + 180000;
  for (;;) {
    const cards = page.getByRole('region', { name: 'Approval required', exact: true });
    for (const card of await cards.all()) {
      const text = await card.textContent();
      if (!approvals.includes(text)) {
        approvals.push(text);
        console.log('Review and answer the ordinary approval in the visible OpenPane window. The probe does not approve requests.');
      }
    }
    let edited = false, queried = !pup;
    try { edited = (await readFile(join(workspace, 'probe.txt'), 'utf8')).trim() === 'approved UI probe'; } catch {}
    try {
      if (pup) {
        const { normalizePup } = await import('../../../apps/host/build/tsc/ui-pup.js');
        normalizePup(JSON.parse(await readFile(join(workspace, 'pup-raw.json'), 'utf8')), 'avg:system.cpu.user{*}', 'CPU query qualification', range, Date.now()); queried = true;
      }
    } catch {}
    if (edited && received.length && queried) break;
    if (Date.now() > deadline) throw new Error('Approved CLI probe did not complete before deadline');
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.deepEqual(received[0].scope, scope);
  await page.screenshot({ path: join(directory, 'host-agent.png'), fullPage: true });
  await writeFile(join(directory, 'approvals.json'), JSON.stringify(approvals, null, 2));
  result = { status: 'passed', scope, received, approvals: approvals.length, pupQualified: pup !== null, evidence: directory };
} catch (error) { result = { status: 'failed', reason: error.message, received, evidence: directory }; }
finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    const bounded = async milliseconds => {
      let timer;
      try { return await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
      finally { clearTimeout(timer); }
    };
    child.kill('SIGTERM');
    if (!await bounded(10000)) {
      child.kill('SIGKILL');
      const stopped = await bounded(3000);
      result = { status: 'failed', reason: stopped ? 'Probe host required forced shutdown' : 'Probe host shutdown could not be confirmed', received, evidence: directory };
    }
  }
  receiver.closeAllConnections?.(); await new Promise(resolve => receiver.close(resolve));
  await writeFile(join(directory, 'host-stderr.log'), stderr);
}
await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.status === 'passed' ? 0 : 1;
