import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { join } from 'node:path';
import { readExperienceDirectory, scopeExperienceCss } from '../../apps/host/build/tsc/experience-bundle.js';
import { root } from './browser-support.mjs';

for (const viewport of [{ width: 640, height: 720 }, { width: 360, height: 480 }]) test(`native-sized ${viewport.width}×${viewport.height} approvals keep their complete prompt, actions, draft and recovery reachable`, { timeout: 30000 }, async t => {
  const experience = await readExperienceDirectory(join(root, 'examples/experiences/messenger-2002'));
  const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ThemeScope} from '@openpane/ui-primitives/desktop';
    import {ConversationView} from './apps/desktop/src/application/ConversationView.tsx';
    import {VisualContext} from './apps/desktop/src/application/experience-state.ts';
    import './apps/desktop/src/application/application.css';
    import './apps/desktop/src/application/experience.css';
    import './apps/desktop/src/shell/styles.css';
    const experience = ${JSON.stringify(experience)}, scope = {hostId:'host',conversationId:'approval'}, listeners = new Set();
    window.approved=[];
    let view={draft:'Preserved unsent draft',outbox:[],submitting:[],cursor:1,connection:{kind:'connected'},document:{receipts:{},domain:{messages:[],currentRun:{kind:'running',runId:'run'}},decisions:{pending:{pendingId:'pending',prompt:'Run the explicitly scoped UI command: '+ 'exact argument and workspace details '.repeat(200)+' END OF REQUEST',choices:['accept','decline'],reserved:false}}}};
    const store={getSnapshot:()=>view,subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
      async approve(id,choice){window.approved.push([id,choice]);view={...view,document:{...view.document,decisions:{}}};for(const listener of listeners)listener();},async setDraft(draft){view={...view,draft};for(const listener of listeners)listener();}};
    const active={scope,viewId:'view',store,agent:{label:'Codex',imageInput:{kind:'unsupported',reason:'Text-only verification'},commands:['send','approve','cancel'],availability:{kind:'ready'}}};
    const actions={async submit(operation){return operation();},commands:{}};
    createRoot(document.getElementById('root')).render(<div className="experience-frame"><div className="experience-content" data-openpane-experience={experience.digest}>
      <VisualContext value={experience}><ThemeScope appearance="dark" variants={{light:experience.manifest.theme.light,dark:experience.manifest.theme.dark}} className="application-chat-window">
        <header className="application-chat-header"><h1>Native chat</h1><button>New chat</button></header>
        <details className="window-recovery"><summary>Chat requests · 0 pending</summary></details>
        <ConversationView active={active} actions={actions} enabled storageFailure="" agent="codex" />
        <footer>Conversation connected</footer>
      </ThemeScope></VisualContext>
    </div><ThemeScope className="experience-recovery"><button>Restore OpenPane appearance</button></ThemeScope></div>);
  ` }, bundle: true, write: false, outfile: 'approval.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text + scopeExperienceCss(experience.stylesheet, experience.digest, new Set());
  await page.route('http://localhost/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html', body: path === '/approval.js' ? js : path === '/approval.css' ? css : '<!doctype html><link rel="stylesheet" href="/approval.css"><div id="root"></div><script src="/approval.js"></script>' });
  });
  await page.goto('http://localhost/');
  const approval = page.getByRole('region', { name: 'Approval required', exact: true }); await approval.waitFor();
  const details = approval.getByRole('region', { name: 'Approval request details', exact: true });
  assert.ok(await details.evaluate(node => node.scrollHeight > node.clientHeight && node.clientHeight > 0), 'a long command has its own readable scroll area');
  await details.focus(); await details.press('End');
  await page.waitForFunction(() => document.querySelector('[aria-label="Approval request details"]').scrollTop > 0);
  const allow = approval.getByRole('button', { name: 'Allow', exact: true }); await allow.focus();
  assert.ok(await allow.evaluate(node => { const r=node.getBoundingClientRect(); const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); return r.top>=0&&r.bottom<=innerHeight&&(hit===node||node.contains(hit)); }), 'Allow is visible and receives pointer input after keyboard focus');
  const editor=page.getByRole('textbox',{name:'Message',exact:true}), original=await editor.elementHandle();
  assert.ok(await editor.evaluate(node=>{const r=node.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}));
  assert.ok(await page.getByRole('button',{name:'Restore OpenPane appearance'}).evaluate(node=>node.getBoundingClientRect().bottom<=innerHeight));
  await allow.press('Enter'); await approval.waitFor({state:'detached'});
  assert.deepEqual(await page.evaluate(()=>window.approved),[['pending','accept']]);
  assert.equal(await editor.inputValue(),'Preserved unsent draft');
  assert.equal(await editor.evaluate((node,old)=>node===old,original),true);
});
