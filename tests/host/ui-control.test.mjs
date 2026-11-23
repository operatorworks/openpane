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
  const targets = await command(installed, ['ui', '--data-dir', host.directory, 'targets']);
  assert.equal(targets.code, 0, targets.stderr); assert.ok(Array.isArray(JSON.parse(targets.stdout).items));
  const source = join(directory, 'source'); await mkdir(source);
  const { writeFile } = await import('node:fs/promises');
  const { sha256 } = await import('../../apps/host/build/tsc/experience-bundle.js');
  const css = '[data-openpane-part="button"] { color: #123456; }';
  await writeFile(join(source, 'style.css'), css);
  await writeFile(join(source, 'experience.json'), JSON.stringify({ schemaVersion: 2, id: 'installed', label: 'Installed CLI', theme: { density: 'comfortable', mode: 'system', light: {}, dark: {} },
    presentation: { home: { kind: 'stack', panes: ['conversations', 'conversation'] }, transcript: 'bubbles', navigation: 'rail', chats: 'inline', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } },
    stylesheet: 'style.css', assets: [{ name: 'style.css', mimeType: 'text/css', bytes: Buffer.byteLength(css), sha256: sha256(css) }] }));
  const { randomUUID } = await import('node:crypto');
  const applied = await command(installed, ['ui', '--data-dir', host.directory, 'experience', 'apply', '--directory', source, '--request-id', `${context.requestEpoch}:${randomUUID()}`, '--expected-revision', String(context.revision)]);
  assert.equal(applied.code, 0, applied.stderr); assert.equal(JSON.parse(applied.stdout).outcome, 'selected-with-no-clients');
  const response = await fetch(`${host.origin}/api/ui/v1`, { method: 'POST', headers: { Origin: 'http://other', 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'context' }) });
  assert.equal(response.status, 400);
});

test('an unavailable UI socket leaves the conversation host and builtin recovery available', async t => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const { startBrowserHost } = await import('../../apps/host/build/tsc/server.js');
  const directory = await mkdtemp('/tmp/op-ui-optional-'); let host;
  t.after(async () => { await host?.close(); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, 'ui.sock'), 'preserve this regular file', { mode: 0o600 });
  host = await startBrowserHost({ directory, port: 0, hostArtifactDirectory: join(root, 'apps/host/dist'), hostSdkDirectory: join(root, 'apps/host/dist'), assetsDirectory: join(root, 'apps/desktop/web-dist-browser'), agentStartup: { kind: 'recorded' } });
  const api = async input => {
    const response = await fetch(`${host.origin}/api/v1`, { method: 'POST', headers: { Origin: host.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const result = await response.json(); assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  };
  const metadata = await api({ op: 'metadata' });
  const scope = { hostId: metadata.hostId, conversationId: 'ui-fallback-conversation' };
  await api({ op: 'create', scope, agentId: metadata.defaultAgentId });
  await api({ op: 'submit', command: { version: 1, scope, clientCommandId: 'ui-fallback-send', body: { kind: 'send', text: 'Conversation service remains usable.' } } });
  assert.equal(await readFile(join(directory, 'ui.sock'), 'utf8'), 'preserve this regular file');
  const response = await fetch(`${host.origin}/api/ui/v1`, { method: 'POST', headers: { Origin: host.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'context' }) });
  const result = await response.json(); assert.equal(result.ok, false); assert.match(result.error, /UI control socket unavailable/);
});


test('a UI interruption persistence fault still releases a drained host directory', {timeout:20000},async t=>{
  const {startBrowserHost}=await import('../../apps/host/build/tsc/server.js'),{DatabaseSync}=await import('node:sqlite');
  const {openUiQuerySession,requestUi}=await import('../../apps/host/build/tsc/ui-control.js');
  const {randomUUID}=await import('node:crypto');
  const directory=await mkdtemp('/tmp/op-ui-close-fault-'),options={directory,port:0,hostArtifactDirectory:join(root,'apps/host/dist'),hostSdkDirectory:join(root,'apps/host/dist'),assetsDirectory:join(root,'apps/desktop/web-dist-browser'),agentStartup:{kind:'recorded'}};
  let host=await startBrowserHost(options),fault;
  t.after(async()=>{await host?.close().catch(()=>{});fault?.close();await rm(directory,{recursive:true,force:true});});
  const api=async request=>{const response=await fetch(`${host.origin}/api/v1`,{method:'POST',headers:{Origin:host.origin,'Content-Type':'application/json'},body:JSON.stringify(request)});const body=await response.json();assert.equal(body.ok,true,JSON.stringify(body));return body.value;};
  const metadata=await api({op:'metadata'}),scope={hostId:metadata.hostId,conversationId:randomUUID()};await api({op:'create',scope,agentId:metadata.defaultAgentId});
  const socket=join(directory,'ui.sock'),context=await requestUi(socket,{op:'context'}),publicationId=`${context.requestEpoch}:${randomUUID()}`;
  const session=await openUiQuerySession(socket,{op:'display-query-reserve',scope,publicationId,input:{query:'avg:system.cpu.user{*}',title:'CPU',from:'1795374000',to:'1795377600',executable:'/fixture/pup',executableHint:'PATH:pup',version:'2.0.1',site:'us3.datadoghq.com',siteHint:'us3.datadoghq.com'}});assert.equal(session.first.granted,true);
  fault=new DatabaseSync(join(directory,'ui.sqlite'));fault.exec("CREATE TRIGGER refuse_interrupt BEFORE INSERT ON ui_display_keys WHEN NEW.state='interrupted' BEGIN SELECT RAISE(ABORT,'injected interruption failure');END");session.close();
  let observed=false;for(let n=0;n<100&&!observed;n++){try{await requestUi(socket,{op:'context'});}catch(error){observed=/Query recovery could not be saved/.test(String(error));}if(!observed)await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(observed,true);await assert.rejects(host.close(),/Host shutdown failed/);
  fault.exec('DROP TRIGGER refuse_interrupt');fault.close();fault=null;
  host=await startBrowserHost(options);assert.equal((await api({op:'metadata'})).hostId,metadata.hostId);
});

test('native relay rejects duplicate conversation or saved-view ownership',async()=>{
  const {parseUiRequest}=await import('../../apps/host/build/tsc/ui-protocol.js');
  const main={role:'main',hostId:'host',profileId:'profile',brokerInstance:'broker',label:'main',documentIncarnation:'main-doc',viewId:'catalog'};
  const children=['a','b'].map(id=>({context:{...main,role:'chat',label:id,documentIncarnation:`doc-${id}`,viewId:`view-${id}`,scope:{hostId:'host',conversationId:id}},visible:true,presenceSequence:1}));
  assert.equal(parseUiRequest({op:'relay',main,children,departed:[]}).children.length,2);
  for(const key of ['scope','viewId']){const duplicate=structuredClone(children);duplicate[1].context[key]=duplicate[0].context[key];assert.throws(()=>parseUiRequest({op:'relay',main,children:duplicate,departed:[]}),/Duplicate relay child/);}
});


test('wait deadline bounds a final stalled status socket and returns its last pending receipt', { timeout: 5000 }, async t => {
  const { createServer } = await import('node:net'), { chmod } = await import('node:fs/promises');
  const directory = await mkdtemp('/tmp/op-wait-budget-'), sockets = new Set(); let polls = 0;
  const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('data', () => { if (++polls === 1) socket.end(JSON.stringify({ ok: true, value: { outcome: 'pending', receipt: { requestId: '1:wait-fixture' } } }) + '\n'); }); });
  await new Promise(resolve => server.listen(join(directory, 'ui.sock'), resolve)); await chmod(join(directory, 'ui.sock'), 0o600);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const started = performance.now(), result = await command(cli, ['ui', '--data-dir', directory, 'wait', '--request-id', '1:wait-fixture', '--wait-ms', '500']);
  assert.equal(result.code, 0, result.stderr); assert.ok(performance.now() - started < 1500); assert.ok(polls >= 2);
  assert.deepEqual(JSON.parse(result.stdout), { outcome: 'pending', receipt: { requestId: '1:wait-fixture' }, waitEnded: true });
});

test('packaged UI argument validation reports invalid-input refusal codes', async () => {
  for (const args of [[], ['--unknown'], ['--data-dir','/unreachable-fixture','display','list','--scope-json','not-json']]) {
    const result = await command(cli, ['ui', ...args]);
    assert.equal(result.code,1);
    assert.equal(JSON.parse(result.stderr).code,'invalid-input');
  }
});
