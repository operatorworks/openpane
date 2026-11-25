import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { root } from './browser-support.mjs';

for (const strict of [false, true]) test(`an unmounted appearance releases only its stylesheet (StrictMode ${strict})`, async t => {
  const stylesheet = '[data-openpane-part="header"] { background-color:#abcdef; }';
  const asset = { name: 'style.css', mimeType: 'text/css', bytes: Buffer.byteLength(stylesheet), sha256: createHash('sha256').update(stylesheet).digest('hex') };
  const bundle = await build({ stdin: { resolveDir:root,loader:'tsx',contents: `
    import { parseExperience } from '@openpane/contracts';
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { ExperienceScope } from './apps/desktop/src/application/ExperienceScope.tsx';
    const digest = 'a'.repeat(64), manifest = parseExperience({ schemaVersion:2,id:'lifetime',label:'Lifetime',theme:{mode:'light',density:'comfortable',light:{},dark:{}},
      presentation:{home:{kind:'stack',panes:['conversation']},transcript:'lines',navigation:'rail',chats:'inline',chatWindow:{width:640,height:720,titlebar:'native',title:'conversation'}},stylesheet:'style.css',assets:[${JSON.stringify(asset)}] });
    const state = { version:1,change:1,selection:{revision:1,deliveryGeneration:1,selected:{kind:'experience',digest},previousHealthy:{kind:'builtin'}},bundle:{digest,manifest},envelope:null,transitions:[],fault:null,display:null };
    const snapshot = {deliveryContext:null,state,diagnostic:null,localBuiltin:false,confirmedGeneration:null,cards:{kind:'none'}};
    globalThis.paints = 0; globalThis.closes = 0;
    const connection = {getSnapshot:()=>snapshot,subscribe:()=>()=>{},start(){},close(){globalThis.closes++;},selectScope(){},refreshCards(){},async restore(){},async rendered(){globalThis.paints++;},async failed(_state,reason){throw new Error(reason);}};
    const owner = createRoot(document.getElementById('root'));
    const view = <ExperienceScope connection={connection}><button data-openpane-essential="new-chat">New chat</button></ExperienceScope>;
    owner.render(${strict} ? <React.StrictMode>{view}</React.StrictMode> : view);
    globalThis.unmount = () => owner.unmount();
  ` },bundle:true,write:false,outfile:'lifetime.js',jsx:'automatic' });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text, css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
  await page.route('http://localhost/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html',body:
      path.startsWith('/ui-assets/') ? stylesheet : path === '/lifetime.js' ? js : path === '/lifetime.css' ? css : '<!doctype html><link rel="stylesheet" href="/lifetime.css"><div id="root"></div><script src="/lifetime.js"></script>' });
  });
  await page.goto('http://localhost/'); await page.waitForFunction(() => globalThis.paints > 0);
  assert.equal(await page.locator('link[href^="/ui-assets/"][media="all"]').count(),1);
  assert.equal(await page.evaluate(() => globalThis.closes),0);
  await page.evaluate(() => globalThis.unmount());
  assert.equal(await page.locator('link[href^="/ui-assets/"]').count(),0);
  assert.equal(await page.locator('link[href="/lifetime.css"]').count(),1,'the fixture stylesheet belongs to a different owner');
  assert.equal(await page.evaluate(() => globalThis.closes),1);
});

test('Restore failures stay visible through rendering and only the latest attempt can update them', async t => {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { ExperienceScope } from './apps/desktop/src/application/ExperienceScope.tsx';
    import { useUiActions } from './apps/desktop/src/application/experience-state.ts';
    let snapshot = {deliveryContext:null,state:null,diagnostic:null,localBuiltin:true,confirmedGeneration:null,cards:{kind:'none'}};
    const listeners = new Set(); globalThis.calls = 0;
    const connection = {getSnapshot:()=>snapshot,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},start(){},close(){},selectScope(){},refreshCards(){},async restore(){const call=++globalThis.calls;if(call===4) await new Promise((_resolve,reject)=>{globalThis.release=()=>reject(new Error('Late attempt 4'));});if(call<=2)throw new Error('Restore failed attempt '+call);},async rendered(){},async failed(){}};
    globalThis.publish = () => {snapshot = {...snapshot,state:{version:1,change:1,selection:{revision:1,deliveryGeneration:1,selected:{kind:'builtin'},previousHealthy:{kind:'builtin'}},bundle:null,envelope:null,transitions:[],fault:null,display:null}};for(const fn of listeners)fn();};
    function Actions(){const actions=useUiActions();return <button onClick={()=>void actions.restore()}>Restore through context</button>;}
    createRoot(document.getElementById('root')).render(<ExperienceScope connection={connection}><button data-openpane-essential="new-chat">New chat</button><Actions/></ExperienceScope>);
  ` }, bundle: true, write: false, outfile: 'restore-failure.js', jsx: 'automatic' });
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text, css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
  await page.route('http://localhost/**', route => { const path = new URL(route.request().url()).pathname; return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html',body:path==='/restore-failure.js'?js:path==='/restore-failure.css'?css:'<!doctype html><link rel="stylesheet" href="/restore-failure.css"><div id="root"></div><script src="/restore-failure.js"></script>'}); });
  await page.goto('http://localhost/'); const control=page.getByRole('button', { name: 'Restore OpenPane appearance', exact: true }); await control.click();
  await page.getByRole('status').filter({hasText:'Restore failed attempt 1'}).waitFor(); assert.equal(await page.evaluate(() => globalThis.calls),1);
  await page.keyboard.press('Control+Shift+Backspace'); await page.getByRole('status').filter({hasText:'Restore failed attempt 2'}).waitFor();
  await page.evaluate(() => globalThis.publish()); await page.locator('[data-experience-phase="committed"]').waitFor(); assert.equal(await page.getByRole('status').innerText(),'Restore failed attempt 2');
  await control.click(); await page.waitForFunction(() => globalThis.calls===3); await page.getByRole('status').waitFor({state:'hidden'});
  await page.getByRole('button', {name:'Restore through context',exact:true}).click(); await page.waitForFunction(() => globalThis.calls===4);
  await page.keyboard.press('Control+Shift+Backspace'); await page.waitForFunction(() => globalThis.calls===5); await page.evaluate(() => globalThis.release());
  await page.evaluate(() => new Promise(resolve => {const channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};channel.port2.postMessage(null);}));
  assert.equal(await page.getByRole('status').count(),0); assert.deepEqual(errors,[]);
});
