import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { root, wait } from './browser-support.mjs';

test('builtin paint waits for the application frame after local preferences finish loading', async t => {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { ExperienceScope } from './apps/desktop/src/application/ExperienceScope.tsx';
    const state = { version:1, change:1, selection:{revision:1,deliveryGeneration:1,selected:{kind:'builtin'},previousHealthy:{kind:'builtin'}},bundle:null,envelope:null,transitions:[],fault:null,display:null };
    const snapshot = {deliveryContext:null,state,diagnostic:null,localBuiltin:false,confirmedGeneration:null,cards:{kind:'none'}};
    window.paints=[];window.failures=[];
    const connection = {getSnapshot:()=>snapshot,subscribe:()=>()=>{},start(){},close(){},selectScope(){},refreshCards(){},async restore(){},async rendered(state){window.paints.push(state.selection.deliveryGeneration);},async failed(_state,reason){window.failures.push(reason);}};
    function Probe(){const[ready,setReady]=React.useState(false);React.useEffect(()=>{window.finishPreferences=()=>setReady(true);},[]);return <ExperienceScope connection={connection}>{ready?<button data-openpane-essential="new-chat">New chat</button>:<p role="status">Loading local preferences…</p>}</ExperienceScope>;}
    createRoot(document.getElementById('root')).render(<Probe/>);
  ` }, bundle: true, write: false, outfile: 'readiness.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage();
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text, css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
  await page.route('http://localhost/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html', body: path === '/readiness.js' ? js : path === '/readiness.css' ? css : '<!doctype html><link rel="stylesheet" href="/readiness.css"><div id="root"></div><script src="/readiness.js"></script>' });
  });
  await page.goto('http://localhost/'); await page.getByText('Loading local preferences…', { exact: true }).waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await page.evaluate(() => window.paints), []);
  await page.evaluate(() => window.finishPreferences()); await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
  await wait(() => page.evaluate(() => window.paints.length === 1), 'restored application frame paint');
  assert.deepEqual(await page.evaluate(() => window.paints), [1]); assert.deepEqual(await page.evaluate(() => window.failures), []);
});
