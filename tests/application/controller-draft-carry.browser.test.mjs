import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t, { sharedViewState = false, captureRuntimeFactory = false } = {}) {
  const bundle = await build({ stdin: { contents: `import { WindowCoordinator } from './apps/desktop/src/application/window-coordinator.ts';
    import { WindowRuntime } from './apps/desktop/src/application/window-runtime.ts';
    import { fixture as controllerFixture } from './tests/application/controller-fixture.mjs';
    import { BrowserViewStorage } from './apps/desktop/src/application/browser-storage.ts';
    import { createConversationStore } from './packages/client/src/index.ts';
    import { transcriptProjection } from '@openpane/contracts/conversation';
    import { recordNativeEditorOrigin, nativeEditorOrigin } from './apps/desktop/src/application/native-editor-origin.ts';
    import * as carries from './apps/desktop/src/application/draft-carry.ts';
    Object.assign(globalThis, { recordNativeEditorOrigin, nativeEditorOrigin, controllerFixture, WindowCoordinator, WindowRuntime, BrowserViewStorage, carries, createConversationStore, transcriptProjection });`, resolveDir: root }, bundle: true, write: false, format: 'iife', plugins: [
    ...(sharedViewState ? [{ name: 'shared-controller-view-state', setup(builder) { builder.onResolve({ filter: /^\.\/view-state\.js$/ }, () => ({ path: `${root}apps/desktop/dist/application/view-state.js` })); } }] : []),
    ...(captureRuntimeFactory ? [{ name: 'actual-runtime-factory', setup(builder) {
      builder.onResolve({ filter: /^\.\/application-controller\.js$/ }, args => args.importer.endsWith('/window-runtime.ts') ? { path: 'captured-controller', namespace: 'runtime-factory' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'runtime-factory' }, () => ({ contents: `import { createApplicationController as create } from ${JSON.stringify(`${root}apps/desktop/dist/application/application-controller.js`)}; export function createApplicationController(deps) { globalThis.runtimeFactory = deps.ownedViewStorage; return create(deps); }`, resolveDir: root }));
      builder.onLoad({ filter: /\/window-runtime\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replaceAll('window.location.reload()', 'globalThis.recordReload()'), loader: 'ts', resolveDir: `${root}apps/desktop/src/application` }));
    } }] : []),
  ] });
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage();
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Inline draft recovery</title>' }));
  await page.goto('http://localhost/recovery'); await page.addScriptTag({ content: bundle.outputFiles[0].text }); return page;
}

for (const entry of ['catalog', 'saved-inline', 'new-chat']) for (const successor of entry === 'new-chat' ? ['unrelated'] : ['kept', 'different']) test(`inline ${entry} respects Keep for its actual ${successor} destination`, async t => {
  const page = await fixture(t), result = await page.evaluate(async ({ entry, successor }) => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, source = { hostId: 'host', conversationId: 'kept-source' }, kept = { hostId: 'host', conversationId: 'kept-successor' }, different = { hostId: 'host', conversationId: 'different-successor' };
    const wait = async predicate => { for (let n = 0; n < 400; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Controller recovery did not settle'); };
    const records = async () => { const db = await new Promise((resolve,reject) => { const open = indexedDB.open('openpane-browser-views', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); }); try { const rows = await new Promise((resolve,reject) => { const tx = db.transaction('records'), request = tx.objectStore('records').getAll(); tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error); }); return rows; } finally { db.close(); } };
    const make = (owner,scope) => globalThis.createConversationStore({ scope, port: { scope, async submit() { throw new Error('No sends'); }, async receipt() { return null; }, watch() { return { close() {} }; } }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}), createCommandId: () => crypto.randomUUID() });
    const seed = await S.claimEditor({ scope: source, viewId: 'kept-source-view', label: 'source-child', transitionId: null, creation: { agentId: 'default' } }, () => {}), seedStore = make(seed,source); await seedStore.ready; await seedStore.setDraft('Keep these exact inline source bytes'); await seed.saveView('host', { version: 2, route: source, pendingCreation: null });
    const binding = seed.editorBinding(), captured = await seedStore.captureDraft(); await c.offerDraftCarry({ source, sourceViewId: seed.viewId, requestId: '1:prior-keep', writerGeneration: binding.writerGeneration, expected: captured }); await c.bindDraftCarry(source, '1:prior-keep', kept); await c.cancelDraftCarry((await c.sourceCarries(source))[0]); await seedStore.dispose(); await seed.close();
    const coordinator = new globalThis.WindowCoordinator(null), f = globalThis.controllerFixture({ placement: coordinator });
    Object.defineProperty(f.storage,'catalogViewId',{get:()=>sessionStorage.getItem('openpane.catalogViewId')??undefined});
    f.storage.open = failure => S.open(failure, 'openpane.catalogViewId'); f.storage.reopen = (viewId,failure) => S.reopenForRecovery(viewId,failure); f.storage.recoverClosedView = f.storage.reopen;
    f.storage.locate = async scope => { const found = await S.locateEditor(scope); return found.binding?.viewId ?? found.legacyViewIds[0] ?? null; };
    const none = { predecessor: null, carried: null, closure: null, successor: null }, destination = successor === 'kept' ? kept : different;
    f.behavior.continuation = async input => entry !== 'new-chat' && input.scope.conversationId === source.conversationId ? { ...none, closure: 'cancelled', successor: { kind: 'confirmed', scope: destination } } : none;
    try {
      await f.app.start();
      if (entry === 'catalog') await f.app.open(source);
      else { await f.app.openReserved(source); if (entry === 'new-chat') await f.app.conversationActions(f.app.getSnapshot().active).startNewChat(); }
      await wait(() => !f.app.getSnapshot().busy && f.app.getSnapshot().active?.scope.conversationId !== source.conversationId);
      const rows = await records(), text = scope => rows.find(row => row?.version === 3 && row.scope?.conversationId === scope.conversationId)?.draft ?? '';
      return { source: text(source), destination: text(f.app.getSnapshot().active.scope), keep: await c.keptDraft(source,kept), active: f.app.getSnapshot().active.scope, sent: f.submitted.length, error: f.app.getSnapshot().error };
    } finally { await f.app.dispose(); }
  }, { entry, successor });
  assert.equal(result.keep, true); assert.equal(result.sent, 0); assert.equal(result.error, '');
  if (successor === 'kept') { assert.equal(result.source, 'Keep these exact inline source bytes'); assert.equal(result.destination, ''); }
  else { assert.equal(result.source, ''); assert.equal(result.destination, 'Keep these exact inline source bytes'); }
});

for (const boundary of ['receive-copy', 'release-copy']) test(`Keep fences an inline draft ${boundary} transaction`, async t => {
  const page = await fixture(t), result = await page.evaluate(async boundary => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, source = { hostId: 'host', conversationId: 'copy-race-source' }, target = { hostId: 'host', conversationId: 'copy-race-target' }, owners = [];
    const make = (owner,scope) => globalThis.createConversationStore({ scope, port: { scope, async submit() { throw new Error('No sends'); }, async receipt() { return null; }, watch() { return { close() {} }; } }, projection: globalThis.transcriptProjection, drafts: owner.drafts(() => {}), createCommandId: () => crypto.randomUUID() });
    const from = await S.claimEditor({ scope: source, viewId: 'race-source-view', label: 'source', transitionId: null, creation: { agentId: 'default' } }, () => {}), to = await S.claimEditor({ scope: target, viewId: 'race-target-view', label: 'target', transitionId: null, creation: { agentId: 'default' } }, () => {}); owners.push(from,to);
    const fromStore = make(from,source), toStore = make(to,target); await Promise.all([fromStore.ready,toStore.ready]); await fromStore.setDraft('Exact inline race bytes');
    const expected = await fromStore.captureDraft(); await c.offerDraftCarry({ source, sourceViewId: from.viewId, writerGeneration: from.editorBinding().writerGeneration, requestId: '1:inline-race', expected }); await c.bindDraftCarry(source,'1:inline-race',target);
    try {
      const destination = await toStore.captureDraft();
      if (boundary === 'receive-copy') await c.cancelDraftCarry((await c.sourceCarries(source))[0]);
      const received = await toStore.transferDraft(destination,expected.text,{kind:'receive-copy',source});
      if (boundary === 'release-copy') await c.cancelDraftCarry((await c.sourceCarries(source))[0]);
      const released = received === 'committed' ? await fromStore.transferDraft(expected,'',{kind:'release-copy',target,targetViewId:to.viewId}) : null;
      return { received,released,source:(await fromStore.captureDraft()).text,target:(await toStore.captureDraft()).text,keep:await c.keptDraft(source,target) };
    } finally { await Promise.all([fromStore.dispose(),toStore.dispose()]); await Promise.all(owners.map(owner=>owner.close())); }
  }, boundary);
  assert.equal(result.keep,true); assert.equal(result.source,'Exact inline race bytes');
  if (boundary === 'receive-copy') { assert.equal(result.received,'cancelled'); assert.equal(result.target,''); }
  else { assert.equal(result.received,'committed'); assert.equal(result.released,'cancelled'); assert.equal(result.target,'Exact inline race bytes'); }
});

test('recovering Start a new chat under separate placement carries its saved predecessor text', async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, source = { hostId: 'host', conversationId: 'creation-predecessor' }, context = { role:'main',version:1,label:'main',brokerInstance:'broker',documentIncarnation:'main',viewId:'catalog',reservation:null,liveRelay:true };
    let reservation = null, childOwner = null, childStore = null; const calls = [];
    const port = { context, async request(command) {
      calls.push(command.kind);
      if (command.kind === 'lookup') return reservation && reservation.scope.conversationId === command.scope.conversationId ? { kind:childOwner?'ready':'opening',reservation } : { kind:'absent' };
      if (command.kind === 'intent-context') return { epoch:1,pendingCarryRequests:[] };
      if (command.kind === 'reserve') return reservation = { scope:command.scope,viewId:command.viewId,label:'recovered-child',transitionId:'recovery-attempt',creationAgentId:command.creationAgentId,phase:'requested',bindingRevision:null,writerGeneration:null };
      if (command.kind === 'phase') { reservation = {...reservation,phase:command.phase}; return {ok:true}; }
      if (command.kind === 'launch') {
        childOwner = await S.claimEditor({scope:reservation.scope,viewId:reservation.viewId,label:reservation.label,transitionId:reservation.transitionId,creation:{agentId:'default'}},()=>{});
        childStore = globalThis.createConversationStore({scope:reservation.scope,port:{scope:reservation.scope,async submit(){throw new Error('No sends');},async receipt(){return null;},watch(){return{close(){}};}},projection:globalThis.transcriptProjection,drafts:childOwner.drafts(()=>{}),createCommandId:()=>crypto.randomUUID()}); await childStore.ready;
        reservation={...reservation,phase:'target-ready',bindingRevision:childOwner.editorBinding().revision,writerGeneration:childOwner.editorBinding().writerGeneration}; return{kind:'detached',scope:reservation.scope,label:reservation.label};
      }
      if(command.kind === 'carry-applied')return{ok:true};
      throw new Error(command.kind);
    }};
    const coordinator=new globalThis.WindowCoordinator(port),f=globalThis.controllerFixture({placement:coordinator});
    Object.defineProperty(f.storage,'catalogViewId',{get:()=>sessionStorage.getItem('openpane.catalogViewId')??undefined});
    f.storage.open=failure=>S.open(failure,'openpane.catalogViewId');f.storage.reopen=(viewId,failure)=>S.reopenForRecovery(viewId,failure);f.storage.recoverClosedView=f.storage.reopen;f.storage.locate=async scope=>{const found=await S.locateEditor(scope);return found.binding?.viewId??found.legacyViewIds[0]??null;};
    const runtime=Object.assign(Object.create(globalThis.WindowRuntime.prototype),{context,controller:f.app,coordinator,port,ui:null,placingPolicy:null,pendingIntents:new Map(),pendingIntent:null,snapshot:{placementNotice:null},listeners:new Set()});runtime.configurePlacementTracking();
    try {
      await f.app.start();await f.app.openReserved(source);await f.app.getSnapshot().active.store.setDraft('Exact pending-creation predecessor bytes');
      f.behavior.create=async()=>{throw new Error('Recorded create reply lost');};await f.app.conversationActions(f.app.getSnapshot().active).startNewChat();
      const pending=f.app.getSnapshot().saved.pendingCreation;if(!pending?.carryFrom)throw new Error('Producer did not save pending carryFrom');
      f.behavior.create=async()=>{};coordinator.setPresentation({chats:'separate',chatWindow:{width:640,height:720,titlebar:'native',title:'conversation'}});const recovered=await f.app.recoverCreation();
      const receiver=Object.assign(Object.create(globalThis.WindowRuntime.prototype),{context:{role:'chat'},controller:{getSnapshot:()=>({host:{kind:'unavailable'},active:{scope:reservation.scope,viewId:childOwner.viewId,store:childStore}})},port});await receiver.syncDraftCarries();await runtime.syncDraftCarries();await receiver.syncDraftCarries();
      if(!childStore)throw new Error('No native child: '+JSON.stringify({recovered,state:f.app.getSnapshot(),calls}));const carries=await c.sourceCarries(source);return{pending,recovered,sourceText:(await f.app.capturePlacementDraft(source))?.text,childText:(await childStore.captureDraft()).text,carries,sent:f.submitted.length,created:f.created.length};
    }finally{await f.app.dispose();if(childStore)await childStore.dispose();if(childOwner)await childOwner.close();}
  });
  assert.equal(result.recovered.kind,'detached');assert.equal(result.sourceText,'');assert.equal(result.childText,'Exact pending-creation predecessor bytes');assert.equal(result.carries.length,1);assert.equal(result.carries[0].kind,'settled');assert.equal(result.sent,0);assert.equal(result.created,1);
});

for (const scenario of ['inline-closed', 'separate-closed', 'separate-new', 'inline-agent-close', 'separate-agent-close', 'inline-retired', 'separate-retired', 'inline-agent-failure', 'inline-chain-failure']) test(`passive predecessor refresh honors its successor history (${scenario})`, async t => {
  const page = await fixture(t), result = await page.evaluate(async scenario => {
    const policy=scenario.startsWith('inline')?'inline':'separate',knownClosed=scenario!=='separate-new',closeDuringAgent=scenario.endsWith('agent-close'),historyRetired=scenario.endsWith('retired'),failedLookup=scenario.endsWith('agent-failure'),failedChain=scenario.endsWith('chain-failure');
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, source = { hostId:'host',conversationId:'passive-predecessor' }, target = { hostId:'host',conversationId:'closed-successor' };
    const context = {role:'main',version:1,label:'main',brokerInstance:'broker',documentIncarnation:'main',viewId:'catalog',reservation:null,liveRelay:true};
    let reservation=null,childOwner=null,childStore=null,closed=false,retired=false,started=false,chainFailed=false,continuationReads=0,permissionReads=0,observationReads=0;const launches=[];
    const port={context,async request(command){
      if(command.kind==='lookup')return !retired&&reservation&&command.scope.conversationId===target.conversationId?{kind:closed?'closed':'ready',reservation}:{kind:'absent'};
      if(command.kind==='intent-context')return{epoch:1,pendingCarryRequests:[]};
      if(command.kind==='reserve'){if(reservation&&command.newTransition===false)return reservation;return reservation={scope:command.scope,viewId:command.viewId,label:'successor-child',transitionId:'successor-attempt-'+launches.length,creationAgentId:command.creationAgentId,phase:'requested',bindingRevision:null,writerGeneration:null};}
      if(command.kind==='phase'){reservation={...reservation,phase:command.phase};return{ok:true};}
      if(command.kind==='launch'){
        if(command.existingOnly)return childOwner&&!closed?{kind:'detached',scope:target,label:reservation.label}:null;
        launches.push(command);childOwner=await S.claimEditor({scope:target,viewId:reservation.viewId,label:reservation.label,transitionId:reservation.transitionId,creation:null},()=>{});
        childStore=globalThis.createConversationStore({scope:target,port:{scope:target},projection:globalThis.transcriptProjection,drafts:childOwner.drafts(()=>{})});await childStore.ready;await childOwner.saveView('host',{version:2,route:target,pendingCreation:null});
        await globalThis.recordNativeEditorOrigin(childOwner.editorBinding(),reservation.label);reservation={...reservation,phase:'target-ready',bindingRevision:childOwner.editorBinding().revision,writerGeneration:childOwner.editorBinding().writerGeneration};closed=false;return{kind:'detached',scope:target,label:reservation.label};
      }
      throw new Error(command.kind);
    }};
    const coordinator=new globalThis.WindowCoordinator(port),f=globalThis.controllerFixture({placement:coordinator});
    Object.defineProperty(f.storage,'catalogViewId',{get:()=>sessionStorage.getItem('openpane.catalogViewId')??undefined});
    f.storage.open=failure=>S.open(failure,'openpane.catalogViewId');f.storage.reopen=(viewId,failure)=>S.reopenForRecovery(viewId,failure);f.storage.recoverClosedView=f.storage.reopen;f.storage.locate=async scope=>{const found=await S.locateEditor(scope);return found.binding?.viewId??found.legacyViewIds[0]??null;};
    const runtime=Object.assign(Object.create(globalThis.WindowRuntime.prototype),{context,controller:f.app,coordinator,port,ui:null,placingPolicy:null,pendingIntents:new Map(),pendingIntent:null,snapshot:{placementNotice:null},listeners:new Set()});runtime.configurePlacementTracking();
    f.behavior.permissions=async()=>{permissionReads++;return{kind:'available',observedAt:new Date().toISOString(),permissions:[]};};f.behavior.observation=async()=>{observationReads++;return{kind:'not-applicable'};};
    const none={predecessor:null,carried:null,closure:null,successor:null};f.behavior.continuation=async input=>{continuationReads++;if(input.action==='start')started=true;if(chainFailed&&input.scope.conversationId===target.conversationId)return{...none,closure:'cancelled',successor:{kind:'confirmed',scope:source}};return input.scope.conversationId===source.conversationId&&started?{...none,closure:'cancelled',successor:{kind:'confirmed',scope:target}}:none;};
    const readSource=async()=>{const db=await new Promise(resolve=>{const open=indexedDB.open('openpane-browser-views',1);open.onsuccess=()=>resolve(open.result);});try{return await new Promise((resolve,reject)=>{const tx=db.transaction('records'),read=tx.objectStore('records').getAll();tx.oncomplete=()=>resolve(read.result.find(row=>row?.version===3&&row.scope?.conversationId===source.conversationId)?.draft??'');tx.onabort=()=>reject(tx.error);});}finally{db.close();}};
    try{
      await f.app.start();await f.app.openReserved(source);await f.app.getSnapshot().active.store.setDraft('Original predecessor text stays here');
      const separate={chats:'separate',chatWindow:{width:640,height:720,titlebar:'native',title:'conversation'}};coordinator.setPresentation(separate);
      if(knownClosed){await f.app.conversationActions(f.app.getSnapshot().active).continueConversation();
        const carry=(await c.sourceCarries(source))[0];if(!carry)throw new Error('The real continuation did not offer its source draft');await c.cancelDraftCarry(carry);
        if(!closeDuringAgent){await childStore.dispose();childStore=null;await childOwner.close();childOwner=null;closed=true;}
      }else started=true;
      retired=historyRetired;
      const before=launches.length,readsBefore=continuationReads,feedsBefore=f.feeds.length,permissionsBefore=permissionReads,observationsBefore=observationReads;
      let releaseAgent,enteredAgent;const agentEntered=new Promise(resolve=>{enteredAgent=resolve;}),agentReply=new Promise(resolve=>{releaseAgent=resolve;});
      if(closeDuringAgent)f.behavior.agentLookup=async selected=>{if(selected.conversationId===target.conversationId){enteredAgent();await agentReply;}return f.descriptor();};
      if(failedChain)chainFailed=true;
      if(failedLookup)f.behavior.agentLookup=async selected=>{if(selected.conversationId===target.conversationId)throw new Error('Recorded successor lookup failed');return f.descriptor();};
      coordinator.setPresentation(policy==='inline'?null:separate);f.connectionLost(new Error('Recorded reconnect'));const reconnecting=f.app.reconnect();
      if(closeDuringAgent){await agentEntered;await childStore.dispose();childStore=null;await childOwner.close();childOwner=null;closed=true;releaseAgent();}
      await reconnecting;
      await f.app.getSnapshot().active?.store.captureDraft();await new Promise(resolve=>setTimeout(resolve,0));
      const after={active:f.app.getSnapshot().active?.scope??null,launches:launches.length,continuationReads:continuationReads-readsBefore,text:await readSource(),route:f.app.getSnapshot().saved.route,error:f.app.getSnapshot().error};
      if(!knownClosed)return{newSuccessor:true,before,after,sent:f.submitted.length};
      const active=f.app.getSnapshot().active,feed=f.feeds.at(-1);
      if(feed&&feed.scope.conversationId===source.conversationId&&f.feeds.length>feedsBefore)await feed.receive({kind:'snapshot',snapshot:{scope:source,projectionVersion:4,cursor:(active.store.getSnapshot().cursor??-1)+1,document:{domain:{messages:[],currentRun:null},decisions:{},receipts:{}}}});
      await new Promise(resolve=>setTimeout(resolve,0));
      const health={connection:active?.store.getSnapshot().connection.kind,newFeeds:f.feeds.length-feedsBefore,permissions:f.app.getSnapshot().permissionState.kind,permissionReads:permissionReads-permissionsBefore,observationReads:observationReads-observationsBefore};
      f.behavior.submit=async()=>({kind:'rejected',reason:'conversation-closed'});let command;
      try{command=active?.scope.conversationId===source.conversationId?await f.app.conversationActions(active).commands.send('Recorded synthetic reconnect check'):{kind:'unexpected-visible-target'};}catch(error){command={kind:'error',message:error.message};}
      if(failedLookup||failedChain)return{historyRetired,failedLookup,failedChain,before,after,health,command,sourceText:await readSource(),sent:f.submitted.length};
      const explicit=policy==='inline'?await f.app.open(target):await coordinator.placeExplicitly(target,'inline',()=>f.app.openReserved(target));
      return{historyRetired,failedLookup,failedChain,before,after,health,command,explicit,originAfter:await globalThis.nativeEditorOrigin((await S.locateEditor(target)).binding),explicitScope:f.app.getSnapshot().active?.scope,sourceText:await readSource(),sent:f.submitted.length};
    }finally{await f.app.dispose();if(childStore)await childStore.dispose();if(childOwner)await childOwner.close();}
  }, scenario);
  if(result.newSuccessor){assert.equal(result.before,0);assert.equal(result.after.launches,1,'a new separate successor remains eligible for passive restoration');assert.equal(result.after.text,'Original predecessor text stays here');assert.equal(result.after.error,'');assert.equal(result.sent,0);return;}
  assert.deepEqual(result.after.active,{hostId:'host',conversationId:'passive-predecessor'});assert.equal(result.after.launches,result.before);assert.equal(result.after.text,'Original predecessor text stays here');if(result.historyRetired)assert.match(result.after.error,/explicit reopen/);else if(result.failedLookup)assert.match(result.after.error,/Recorded successor lookup failed/);else if(result.failedChain)assert.match(result.after.error,/continuations of this chat form a loop/);else assert.equal(result.after.error,'');
  assert.equal(result.health.connection,'connected',JSON.stringify(result.health));assert.equal(result.health.newFeeds,1);assert.equal(result.health.permissions,'fresh');assert.ok(result.health.permissionReads>0);assert.ok(result.health.observationReads>0);assert.deepEqual(result.command,{kind:'rejected',reason:'conversation-closed'});
  if(result.failedLookup||result.failedChain){assert.equal(result.sourceText,'Original predecessor text stays here');assert.equal(result.sent,1);return;}
  assert.equal(result.explicit.kind,'inline',JSON.stringify(result));assert.equal(result.originAfter,null,'explicit inline reclaim invalidates the old native origin tuple');assert.deepEqual(result.explicitScope,{hostId:'host',conversationId:'closed-successor'});assert.equal(result.sourceText,'Original predecessor text stays here');assert.equal(result.sent,1,'only the explicitly simulated command reaches the fixture');
});

test('a real legacy catalog migrates its saved editor without holding its own physical close', async t => {
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const S=globalThis.BrowserViewStorage,scope={hostId:'host',conversationId:'legacy-catalog-chat'},seed=await S.open(()=>{},'openpane.catalogViewId'),catalogId=seed.viewId;
    await seed.drafts(()=>{}).save({version:3,scope,draft:'Original legacy catalog draft',draftRevision:1,outbox:[],frontendSends:[],image:null});
    const db=await new Promise(resolve=>{const open=indexedDB.open('openpane-browser-views',1);open.onsuccess=()=>resolve(open.result);});await new Promise((resolve,reject)=>{const tx=db.transaction('records','readwrite');tx.objectStore('records').put({version:2,route:scope,pendingCreation:null},['view',catalogId,'host']);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();await seed.close();
    const coordinator=new globalThis.WindowCoordinator(null),f=globalThis.controllerFixture({placement:coordinator});Object.defineProperty(f.storage,'catalogViewId',{get:()=>sessionStorage.getItem('openpane.catalogViewId')??undefined});
    f.storage.open=failure=>S.open(failure,'openpane.catalogViewId');f.storage.reopen=(viewId,failure)=>viewId===catalogId?S.reopen(viewId,failure,{catalog:true}):S.reopenForRecovery(viewId,failure);f.storage.recoverClosedView=f.storage.reopen;f.storage.locate=async selected=>{const found=await S.locateEditor(selected);return found.binding?.viewId??found.legacyViewIds[0]??null;};
    await f.app.start();const starting=f.app.open(scope);let timeout;try{
      const completed=await Promise.race([starting.then(()=>true),new Promise(resolve=>{timeout=setTimeout(()=>resolve(false),2000);})]);if(!completed){await f.app.dispose();await starting;return{completed};}
      const active=f.app.getSnapshot().active,first={scope:active?.scope,text:active?.store.getSnapshot().draft,viewId:active?.viewId,error:f.app.getSnapshot().error};
      const created=await f.app.create();
      for(let n=0;n<400;n++){const drained=await S.reopenForRecovery(first.viewId,()=>{});if(drained){await drained.close();break;}await new Promise(resolve=>setTimeout(resolve,5));}
      await f.app.openReserved(scope);return{completed,first,created,reopened:f.app.getSnapshot().active?.store.getSnapshot().draft,catalogId,error:f.app.getSnapshot().error,sent:f.submitted.length};
    }finally{clearTimeout(timeout);await f.app.dispose();}
  });
  assert.equal(result.completed,true,'opening must finish its migration while the catalog anchor is retained');assert.equal(result.first.text,'Original legacy catalog draft');assert.notEqual(result.first.viewId,result.catalogId);assert.equal(result.first.error,'');assert.equal(result.created.kind,'inline');assert.equal(result.reopened,'Original legacy catalog draft',JSON.stringify(result));assert.equal(result.error,'');assert.equal(result.sent,0);
});

for (const fault of ['catalog-reopen', 'second-legacy', 'second-legacy-abort']) test(`legacy migration releases only the actual source and retains recoverable writers (${fault})`, async t => {
  const page=await fixture(t),result=await page.evaluate(async fault=>{
    const S=globalThis.BrowserViewStorage,a={hostId:'host',conversationId:'legacy-held-a'},b={hostId:'host',conversationId:'legacy-held-b'},seed=await S.open(()=>{},'openpane.catalogViewId'),catalogId=seed.viewId;
    for(const [scope,draft]of[[a,'Exact first legacy text'],[b,'Exact second legacy text']])await seed.drafts(()=>{}).save({version:3,scope,draft,draftRevision:1,outbox:[],frontendSends:[],image:null});await seed.close();
    const coordinator=new globalThis.WindowCoordinator(null),f=globalThis.controllerFixture({placement:coordinator});let opens=0;
    Object.defineProperty(f.storage,'catalogViewId',{get:()=>sessionStorage.getItem('openpane.catalogViewId')??undefined});
    f.storage.open=async failure=>{if(++opens===2&&fault==='catalog-reopen')throw new Error('Recorded catalog reopen failure');return S.open(failure,'openpane.catalogViewId');};
    f.storage.reopen=(viewId,failure)=>viewId===catalogId?S.reopen(viewId,failure,{catalog:true}):S.reopenForRecovery(viewId,failure);f.storage.recoverClosedView=f.storage.reopen;f.storage.locate=async scope=>{const found=await S.locateEditor(scope);return found.binding?.viewId??found.legacyViewIds[0]??null;};
    const originalPut=IDBObjectStore.prototype.put;let abortSecond=fault==='second-legacy-abort';
    IDBObjectStore.prototype.put=function(value,key){if(abortSecond&&Array.isArray(key)&&key[0]==='draft'&&key[1]!==catalogId&&key[3]===b.conversationId){abortSecond=false;this.transaction.abort();throw new DOMException('Recorded second legacy transaction abort','AbortError');}return originalPut.call(this,value,key);};
    try{
      await f.app.start();const first=await f.app.openReserved(a),binding=(await S.locateEditor(a)).binding;
      if(fault==='catalog-reopen'){
        await new Promise(resolve=>setTimeout(resolve,0));const locks=await navigator.locks.query(),leaked=locks.held.filter(lock=>lock.name===`openpane-view:${binding.viewId}`||lock.name.startsWith('openpane-conversation:')&&lock.name.includes(a.conversationId)).map(lock=>lock.name);
        const retried=await f.app.openReserved(a);return{first,leaked,retried,text:f.app.getSnapshot().active?.store.getSnapshot().draft,sent:f.submitted.length};
      }
      const original=f.app.getSnapshot().active,second=await f.app.openReserved(b),after={scope:f.app.getSnapshot().active?.scope,text:f.app.getSnapshot().active?.store.getSnapshot().draft,sameStore:f.app.getSnapshot().active?.store===original.store};
      const retried=fault==='second-legacy-abort'?await f.app.openReserved(b):second;return{first,second,after,retried,text:f.app.getSnapshot().active?.store.getSnapshot().draft,sent:f.submitted.length};
    }finally{IDBObjectStore.prototype.put=originalPut;await f.app.dispose();}
  },fault);
  assert.equal(result.sent,0);
  if(fault==='catalog-reopen'){assert.equal(result.first.kind,'refused');assert.deepEqual(result.leaked,[],'the acquired destination must release its writer locks after catalog restoration fails');assert.equal(result.retried.kind,'inline');assert.equal(result.text,'Exact first legacy text');}
  else{assert.equal(result.first.kind,'inline');if(fault==='second-legacy-abort'){assert.equal(result.second.kind,'refused');assert.equal(result.after.sameStore,true);assert.equal(result.after.text,'Exact first legacy text');}else assert.equal(result.second.kind,'inline');assert.equal(result.retried.kind,'inline');assert.equal(result.text,'Exact second legacy text');}
});

test('the actual handoff transaction fences a native-origin write that lands after passive admission',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const S=globalThis.BrowserViewStorage,scope={hostId:'host',conversationId:'origin-transaction-race'},owner=await S.claimEditor({scope,viewId:'origin-race-view',label:'child-origin-race',transitionId:null,creation:{agentId:'default'}},()=>{});
    const drafts=owner.drafts(()=>{});await drafts.load(scope);await drafts.save({version:3,scope,draft:'Exact origin-fenced text',draftRevision:1,image:null,outbox:[],frontendSends:[]});const binding=owner.editorBinding();await owner.close();
    const plan={scope,sourceViewId:binding.viewId,targetViewId:binding.viewId,transitionId:'passive-reclaim',targetLabel:'main',expectedBinding:binding,purpose:'passive'};
    await globalThis.recordNativeEditorOrigin(binding,'child-origin-race');let error;try{await S.transferClosed(plan);}catch(cause){error=cause.message;}
    const after=(await S.locateEditor(scope)).binding;await S.transferClosed({...plan,purpose:undefined,transitionId:'explicit-reclaim'});const inline=await S.claimEditor({scope,viewId:binding.viewId,label:'main',transitionId:'explicit-reclaim',creation:null},()=>{});
    const reclaimed=inline.editorBinding(),originAfter=await globalThis.nativeEditorOrigin(reclaimed),text=(await inline.drafts(()=>{}).load(scope)).draft;await inline.close();
    await S.transferClosed({...plan,expectedBinding:reclaimed,transitionId:'passive-after-explicit'});const again=await S.claimEditor({scope,viewId:binding.viewId,label:'main',transitionId:'passive-after-explicit',creation:null},()=>{});await again.close();return{error,binding,after,originAfter,text};
  });
  assert.match(result.error,/explicit reopen/);assert.deepEqual(result.after,result.binding);assert.equal(result.originAfter,null);assert.equal(result.text,'Exact origin-fenced text');
});

for(const successor of ['retired-native','unseen'])test(`a child continuation carries passive purpose through admission (${successor})`,async t=>{
  const page=await fixture(t),result=await page.evaluate(async successor=>{
    const S=globalThis.BrowserViewStorage,source={hostId:'host',conversationId:'purpose-child-source'},target={hostId:'host',conversationId:successor==='unseen'?'purpose-unseen':'purpose-retired'},requests=[];
    const seed=await S.claimEditor({scope:source,viewId:'purpose-source-view',label:'purpose-source-child',transitionId:null,creation:{agentId:'default'}},()=>{});const drafts=seed.drafts(()=>{});await drafts.load(source);await drafts.save({version:3,scope:source,draft:'Exact purpose source text',draftRevision:1,image:null,outbox:[],frontendSends:[]});await seed.saveView('host',{version:2,route:source,pendingCreation:null});await seed.close();
    if(successor==='retired-native'){const old=await S.claimEditor({scope:target,viewId:'purpose-retired-view',label:'old-target-child',transitionId:null,creation:{agentId:'default'}},()=>{});await globalThis.recordNativeEditorOrigin(old.editorBinding(),'old-target-child');await old.close();}
    const context={role:'chat',version:1,label:'purpose-source-child',brokerInstance:'broker',documentIncarnation:'source-document',viewId:'purpose-source-view',liveRelay:true,reservation:{scope:source,viewId:'purpose-source-view',label:'purpose-source-child',transitionId:'source-attempt',creationAgentId:null,phase:'target-ready',bindingRevision:1,writerGeneration:1}};
    const port={context,async request(command){if(command.kind==='intent-context')return{epoch:1,pendingCarryRequests:[]};if(command.kind==='placement-intent'){requests.push(command);return{sourceScope:source,requestId:command.requestId,action:command.action,target:null,result:null};}throw new Error(command.kind);}};
    const coordinator=new globalThis.WindowCoordinator(port),f=globalThis.controllerFixture({placement:coordinator,fixedScope:source});let sourceOwner;
    f.storage.open=async failure=>sourceOwner=await S.claimEditor({scope:source,viewId:context.viewId,label:context.label,transitionId:null,creation:null},failure);
    f.storage.reopen=async()=>{throw new Error('The child keeps its assigned editor');};const none={predecessor:null,carried:null,closure:null,successor:null};f.behavior.continuation=async input=>input.scope.conversationId===source.conversationId?{...none,closure:'cancelled',successor:{kind:'confirmed',scope:target}}:none;
    const runtime=Object.assign(Object.create(globalThis.WindowRuntime.prototype),{context,controller:f.app,coordinator,port,childOwner:null,ui:null,placingPolicy:null,pendingIntents:new Map(),pendingIntent:null,snapshot:{placementNotice:null},listeners:new Set()});
    const wait=async predicate=>{for(let n=0;n<600;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Child continuation did not settle');};
    try{await f.app.start();runtime.childOwner=sourceOwner;runtime.configurePlacementTracking();await wait(()=>!f.app.getSnapshot().busy&&(successor==='unseen'?requests.length>0:f.app.getSnapshot().continuation?.stalled));
      const automatic=requests.map(item=>item.action);if(successor==='retired-native')await f.app.conversationActions(f.app.getSnapshot().active).continueConversation();
      return{automatic,requests:requests.map(item=>item.action),text:f.app.getSnapshot().active.store.getSnapshot().draft,active:f.app.getSnapshot().active.scope,sent:f.submitted.length};
    }finally{await f.app.dispose();}
  },successor);
  assert.equal(result.text,'Exact purpose source text');assert.equal(result.sent,0);assert.deepEqual(result.active,{hostId:'host',conversationId:'purpose-child-source'});assert.equal(result.requests.length,1);
  if(successor==='retired-native'){assert.deepEqual(result.automatic,[]);assert.equal(result.requests[0].passive,undefined,'explicit Continue remains eligible');}else assert.equal(result.requests[0].passive,true,'the new automatic intent retains its passive purpose');
});

test('a real window-load-failed shape leaves its same-view handoff recoverable and main usable',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const S=globalThis.BrowserViewStorage,scope={hostId:'host',conversationId:'failed-load-same-view'},context={role:'main',version:1,label:'main',brokerInstance:'broker',documentIncarnation:'main',viewId:'catalog',reservation:null,liveRelay:true};let reservation=null;
    const port={context,async request(command){if(command.kind==='lookup')return reservation&&command.scope.conversationId===scope.conversationId?{kind:'closed',reservation}:{kind:'absent'};if(command.kind==='reserve')return reservation={scope:command.scope,viewId:command.viewId,label:'failed-load-child',transitionId:'failed-load-attempt',creationAgentId:command.creationAgentId,phase:'requested',bindingRevision:null,writerGeneration:null};if(command.kind==='phase'){reservation={...reservation,phase:command.phase};return{ok:true};}if(command.kind==='launch'){reservation={...reservation,phase:'failed'};throw new Error('window-load-failed');}throw new Error(command.kind);}};
    const coordinator=new globalThis.WindowCoordinator(port),f=globalThis.controllerFixture({placement:coordinator});Object.defineProperty(f.storage,'catalogViewId',{get:()=>sessionStorage.getItem('openpane.catalogViewId')??undefined});
    f.storage.open=failure=>S.open(failure,'openpane.catalogViewId');f.storage.reopen=async(viewId,failure)=>{const binding=await S.bindingForView(viewId);if(!binding)return S.reopen(viewId,failure,{catalog:viewId===f.storage.catalogViewId});if(binding.kind==='handoff-reserved'&&binding.targetLabel!=='main')throw new Error('This saved view is reserved for its recorded chat window.');return S.claimEditor({scope:binding.scope,viewId,label:'main',transitionId:binding.kind==='handoff-reserved'?binding.transitionId:null,creation:null},failure);};f.storage.recoverClosedView=(viewId,failure)=>S.reopenForRecovery(viewId,failure);f.storage.locate=async selected=>{const found=await S.locateEditor(selected);return found.binding?.viewId??found.legacyViewIds[0]??null;};
    try{await f.app.start();await f.app.openReserved(scope);const sourceView=f.app.getSnapshot().active.viewId;await f.app.getSnapshot().active.store.setDraft('Exact text in failed native handoff');coordinator.setPresentation({chats:'separate',chatWindow:{width:640,height:720,titlebar:'native',title:'conversation'}});const failed=await f.app.openReserved(scope),failure=f.app.getSnapshot().storageFailure,binding=(await S.locateEditor(scope)).binding;
      const db=await new Promise(resolve=>{const open=indexedDB.open('openpane-browser-views',1);open.onsuccess=()=>resolve(open.result);});const text=await new Promise((resolve,reject)=>{const tx=db.transaction('records'),read=tx.objectStore('records').get(['draft',binding.viewId,'host',scope.conversationId]);tx.oncomplete=()=>resolve(read.result?.draft);tx.onabort=()=>reject(tx.error);});db.close();
      coordinator.setPresentation(null);const next=await f.app.openReserved({hostId:'host',conversationId:'still-usable-inline'});return{failed,failure,binding,sourceView,nativeView:reservation.viewId,text,next,afterFailure:f.app.getSnapshot().storageFailure,sent:f.submitted.length};
    }finally{await f.app.dispose();}
  });
  assert.equal(result.failed.kind,'refused');assert.match(result.failed.reason,/window-load-failed/);assert.equal(result.failure,'');assert.equal(result.binding.kind,'handoff-reserved');assert.equal(result.sourceView,result.nativeView);assert.equal(result.text,'Exact text in failed native handoff');assert.equal(result.next.kind,'inline');assert.equal(result.afterFailure,'');assert.equal(result.sent,0);
});

for (const reply of ['starting', 'dropped']) test(`explicit Continue retains placement and carry choices after its ${reply} reply`, { timeout: 10000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async reply => {
    const S = globalThis.BrowserViewStorage, source = { hostId: 'host', conversationId: 'poll-source' }, target = { hostId: 'host', conversationId: 'poll-target' };
    const seed = await S.claimEditor({ scope: target, viewId: 'poll-target-view', label: 'prior-native', transitionId: null, creation: { agentId: 'default' } }, () => {});
    await seed.saveView('host', { version: 2, route: target, pendingCreation: null });
    const draft = seed.drafts(() => {}); await draft.load(target); await draft.save({ version: 3, scope: target, draft: 'Existing destination', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    await globalThis.recordNativeEditorOrigin(seed.editorBinding(), 'prior-native'); await seed.close();
    const coordinator = new globalThis.WindowCoordinator(null), f = globalThis.controllerFixture({ placement: coordinator }), purposes = [];
    const original = coordinator.acquire.bind(coordinator); coordinator.acquire = (request, owner) => { if (request.scope.conversationId === target.conversationId) purposes.push(request.purpose ?? 'explicit'); return original(request, owner); };
    Object.defineProperty(f.storage, 'catalogViewId', { get: () => sessionStorage.getItem('openpane.catalogViewId') ?? undefined });
    f.storage.open = failure => S.open(failure, 'openpane.catalogViewId'); f.storage.reopen = (viewId, failure) => S.reopenForRecovery(viewId, failure); f.storage.recoverClosedView = f.storage.reopen;
    f.storage.locate = async scope => { const found = await S.locateEditor(scope); return found.binding?.viewId ?? found.legacyViewIds[0] ?? null; };
    const none = { predecessor: null, carried: null, closure: null, successor: null }; let started = false, reads = 0;
    f.behavior.continuation = async input => {
      if (input.scope.conversationId !== source.conversationId) return none;
      if (input.action === 'start') { started = true; if (reply === 'dropped') throw new Error('Recorded Continue reply dropped'); return { ...none, closure: 'cancelled', successor: { kind: 'starting' } }; }
      if (!started) return none;
      if (reply === 'dropped' && reads++ === 0) return { ...none, closure: 'cancelled', successor: { kind: 'starting' } };
      return { ...none, closure: 'cancelled', successor: { kind: 'confirmed', scope: target } };
    };
    try {
      await f.app.start(); await f.app.openReserved(source); await f.app.getSnapshot().active.store.setDraft('Explicit source bytes');
      await f.app.conversationActions(f.app.getSnapshot().active).continueConversation();
      for (let n = 0; n < 400 && (!purposes.length || f.app.getSnapshot().busy); n++) await new Promise(resolve => setTimeout(resolve, 5));
      const active = f.app.getSnapshot().active; return { purposes, active: active?.scope, text: active?.store.getSnapshot().draft, sent: f.submitted.length, error: f.app.getSnapshot().error };
    } finally { await f.app.dispose(); }
  }, reply);
  assert.deepEqual(result.purposes, ['explicit']); assert.deepEqual(result.active, { hostId: 'host', conversationId: 'poll-target' });
  assert.equal(result.text, 'Explicit source bytes\n\nExisting destination'); assert.equal(result.sent, 0); assert.equal(result.error, '');
});

for (const scenario of ['automatic', 'explicit-catalog', 'claim-race', 'held', 'continued-shortcircuit', 'explicit-source']) test(`catalog restoration preserves native origin admission (${scenario})`, { timeout: 10000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async scenario => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'saved-native' }, next = { hostId: 'host', conversationId: 'saved-next' }, earlier = { hostId: 'host', conversationId: 'empty-predecessor' };
    const catalog = await S.open(() => {}, 'openpane.catalogViewId'), catalogId = catalog.viewId;
    if (scenario !== 'explicit-source') await catalog.saveNavigation('host', scope); await catalog.close();
    const seed = await S.claimEditor({ scope, viewId: 'saved-native-view', label: 'native-child', transitionId: null, creation: { agentId: 'default' } }, () => {});
    await seed.saveView('host', { version: 2, route: scope, pendingCreation: null });
    const drafts = seed.drafts(() => {}); await drafts.load(scope); await drafts.save({ version: 3, scope, draft: 'Exact saved native bytes', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    if (scenario !== 'claim-race') await globalThis.recordNativeEditorOrigin(seed.editorBinding(), 'native-child');
    const before = seed.editorBinding(); await seed.close();
    if (scenario === 'explicit-source') {
      const predecessor = await S.claimEditor({ scope: earlier, viewId: 'empty-predecessor-view', label: 'main', transitionId: null, creation: { agentId: 'default' } }, () => {});
      await predecessor.saveView('host', { version: 2, route: earlier, pendingCreation: null }); await predecessor.close();
    }
    const context = { role: 'main', liveRelay: true, label: 'main' }, coordinator = new globalThis.WindowCoordinator({ context, async request(command) { if (command.kind === 'lookup') return { kind: 'absent' }; throw new Error(command.kind); } });
    const f = globalThis.controllerFixture({ placement: coordinator }); let claims = 0;
    Object.defineProperty(f.storage, 'catalogViewId', { get: () => catalogId });
    f.storage.open = failure => S.reopen(catalogId, failure, { catalog: true });
    f.storage.reopen = async (viewId, failure, options) => {
      if (viewId === catalogId) return S.reopen(catalogId, failure, { catalog: true });
      claims++;
      if (scenario === 'claim-race') await globalThis.recordNativeEditorOrigin(before, 'native-child');
      const binding = await S.bindingForView(viewId);
      return S.claimEditor({ scope: binding.scope, viewId, label: 'main', transitionId: binding.kind === 'handoff-reserved' ? binding.transitionId : null, creation: null, ...(options?.purpose ? { purpose: options.purpose } : {}) }, failure);
    };
    f.storage.locate = async selected => { const found = await S.locateEditor(selected); return found.binding?.viewId ?? found.legacyViewIds[0] ?? null; };
    f.storage.recoverClosedView = async () => null;
    const none = { predecessor: null, carried: null, closure: null, successor: null }; let continuing = false;
    f.behavior.continuation = async input => scenario === 'explicit-source' && input.scope.conversationId === earlier.conversationId ? { ...none, closure: 'cancelled', successor: { kind: 'confirmed', scope } } : continuing && input.scope.conversationId === scope.conversationId ? { ...none, closure: 'cancelled', successor: { kind: 'confirmed', scope: next } } : none;
    try {
      await f.app.start();
      const startup = { active: f.app.getSnapshot().active?.scope ?? null, claims, host: f.app.getSnapshot().host.kind, error: f.app.getSnapshot().error };
      let opened = null, recovery = null, held = null;
      if (scenario === 'explicit-catalog') opened = await f.app.reopenView(catalogId);
      if (scenario === 'explicit-source') { f.storage.readLegacyDraft = S.readLegacyDraft; opened = await f.app.reopenView('empty-predecessor-view'); }
      if (scenario === 'held' || scenario === 'continued-shortcircuit') {
        await f.app.openReserved(scope);
        if (scenario === 'held') { f.connectionLost(new Error('Recorded reconnect')); await f.app.reconnect(); held = f.app.getSnapshot().active?.scope; }
        else {
          const savedId = f.app.getSnapshot().active.viewId; await f.app.create();
          f.storage.readLegacyDraft = S.readLegacyDraft; continuing = true;
          opened = await f.app.reopenView(savedId); recovery = f.app.getSnapshot().savedDraftRecovery?.kind;
        }
      }
      const binding = (await S.locateEditor(scope)).binding;
      return { startup, opened, recovery, held, claims, active: f.app.getSnapshot().active?.scope ?? null, before, binding, origin: await globalThis.nativeEditorOrigin(binding), draft: f.app.getSnapshot().active?.store.getSnapshot().draft, error: f.app.getSnapshot().error, sent: f.submitted.length };
    } finally { await f.app.dispose(); }
  }, scenario);
  assert.equal(result.startup.active, null, JSON.stringify(result));
  assert.equal(result.startup.host, 'ready'); assert.equal(result.sent, 0);
  if (scenario === 'automatic' || scenario === 'claim-race') {
    assert.deepEqual(result.binding, result.before, JSON.stringify(result)); assert.ok(result.origin);
    if (scenario === 'automatic') assert.equal(result.claims, 0); else { assert.equal(result.claims, 1); assert.match(result.startup.error, /explicit reopen/); }
  } else if (scenario === 'explicit-catalog' || scenario === 'explicit-source') {
    assert.equal(result.opened, true, JSON.stringify(result)); assert.deepEqual(result.active, { hostId: 'host', conversationId: 'saved-native' });
    assert.equal(result.draft, 'Exact saved native bytes'); assert.equal(result.origin, null); assert.equal(result.error, '');
  } else if (scenario === 'held') { assert.deepEqual(result.held, { hostId: 'host', conversationId: 'saved-native' }); assert.equal(result.error, ''); }
  else { assert.equal(result.opened, false); assert.equal(result.recovery, 'continued'); assert.notEqual(result.active?.conversationId, 'saved-native'); }
});

for (const scenario of ['same-child', 'explicit-main', 'stale-origin']) test(`native origin follows only a matching child claim (${scenario})`, { timeout: 10000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async scenario => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'origin-reload' }, claim = { scope, viewId: 'origin-reload-view', label: 'native-child', transitionId: null, creation: { agentId: 'default' } };
    const original = await S.claimEditor(claim, () => {}); await original.saveView('host', { version: 2, route: scope, pendingCreation: null });
    await globalThis.recordNativeEditorOrigin(original.editorBinding(), claim.label); const before = original.editorBinding(); await original.close();
    if (scenario === 'stale-origin') {
      const main = await S.claimEditor({ ...claim, label: 'main', creation: null }, () => {}); await main.close();
    }
    const reopened = await S.claimEditor({ ...claim, label: scenario === 'explicit-main' ? 'main' : claim.label, creation: null }, () => {}), after = reopened.editorBinding();
    const origin = await globalThis.nativeEditorOrigin(after); await reopened.close();
    let passive, passiveOwner;
    try { passiveOwner = await S.claimEditor({ ...claim, label: 'main', creation: null, purpose: 'passive' }, () => {}); passive = 'admitted'; }
    catch (error) { passive = error.message; }
    finally { await passiveOwner?.close(); }
    return { before, after, origin, passive };
  }, scenario);
  assert.ok(result.after.writerGeneration > result.before.writerGeneration);
  if (scenario === 'same-child') { assert.equal(result.origin?.writerGeneration, result.after.writerGeneration, JSON.stringify(result)); assert.match(result.passive, /explicit reopen/); }
  else { assert.equal(result.origin, null); assert.equal(result.passive, 'admitted'); }
});

for (const point of ['held', 'pending']) test(`an explicit reopen claims a view after actual frontend recovery ${point} ownership drains`, { timeout: 12000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async point => {
    const S = globalThis.BrowserViewStorage, a = { hostId: 'host', conversationId: 'recovery-owner-a' }, b = { hostId: 'host', conversationId: 'recovery-owner-b' };
    const make = async (scope, viewId, label, text) => { const owner = await S.claimEditor({ scope, viewId, label, transitionId: null, creation: { agentId: 'default' } }, () => {}); await owner.saveView('host', { version: 2, route: scope, pendingCreation: null }); const drafts = owner.drafts(() => {}); await drafts.load(scope); await drafts.save({ version: 3, scope, draft: text, draftRevision: 1, outbox: [], frontendSends: [], image: null }); return owner; };
    const first = await make(a, 'recovery-owner-a-view', 'main', 'Original A bytes'); await first.close();
    const native = await make(b, 'recovery-owner-b-view', 'native-b', 'Exact native B bytes'), before = native.editorBinding(); await globalThis.recordNativeEditorOrigin(before, 'native-b'); await native.close();
    const catalog = await S.open(() => {}, 'openpane.catalogViewId'), catalogId = catalog.viewId; await catalog.saveNavigation('host', a); await catalog.close();
    const reservation = { scope: b, viewId: before.viewId, label: 'native-b', transitionId: 'completed-native-b', creationAgentId: null, phase: 'target-ready', bindingRevision: before.revision, writerGeneration: before.writerGeneration };
    const coordinator = new globalThis.WindowCoordinator({ context: { role: 'main', label: 'main', liveRelay: true }, async request(command) { if (command.kind === 'lookup') return command.scope.conversationId === b.conversationId ? { kind: 'closed', reservation } : { kind: 'absent' }; throw new Error(command.kind); } });
    const f = globalThis.controllerFixture({ placement: coordinator }); let release, entered, blocked = false, editorLoads = 0;
    const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { entered = resolve; });
    Object.defineProperty(f.storage, 'catalogViewId', { get: () => catalogId }); f.storage.open = failure => S.reopen(catalogId, failure, { catalog: true });
    f.storage.reopen = async (viewId, failure, options) => { const binding = await S.bindingForView(viewId); if (!binding) return S.reopen(viewId, failure, { catalog: viewId === catalogId }); if (viewId === before.viewId) editorLoads++; return S.claimEditor({ scope: binding.scope, viewId, label: 'main', transitionId: binding.kind === 'handoff-reserved' ? binding.transitionId : null, creation: null, ...(options?.purpose ? { purpose: options.purpose } : {}) }, failure); };
    f.storage.readLegacyDraft = S.readLegacyDraft; f.storage.locate = async selected => (await S.locateEditor(selected)).binding?.viewId ?? null;
    f.storage.recoverClosedView = async (viewId, failure) => {
      const owner = await S.reopenForRecovery(viewId, failure);
      if (owner && viewId === before.viewId && !blocked) {
        blocked = true;
        if (point === 'pending') { entered(); await gate; }
        else { const scopes = owner.draftScopes.bind(owner); owner.draftScopes = async (...args) => { entered(); await gate; return scopes(...args); }; }
      }
      return owner;
    };
    const bounded = (promise, message) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 2500); })]).finally(() => clearTimeout(timer)); };
    try {
      await f.app.start(); await bounded(began, 'Frontend recovery did not acquire B'); const original = f.app.getSnapshot().active; await original.store.setDraft('Updated A while B recovery drains');
      let settled = false; const opening = f.app.reopenView(before.viewId).then(value => { settled = true; return value; });
      await new Promise(resolve => setTimeout(resolve, 25)); const during = { settled, active: f.app.getSnapshot().active?.scope, editorLoads, generation: (await S.locateEditor(b)).binding.writerGeneration };
      release(); const opened = await bounded(opening, 'Explicit reopen did not drain recovery');
      const binding = (await S.locateEditor(b)).binding, origin = await globalThis.nativeEditorOrigin(binding), active = f.app.getSnapshot().active;
      const after = { opened, active: active?.scope, text: active?.store.getSnapshot().draft, editorLoads, generation: binding.writerGeneration, origin };
      await f.app.dispose(); await f.app.start();
      const source = await S.readLegacyDraft('recovery-owner-a-view', 'host', a);
      return { before, during, after, restarted: f.app.getSnapshot().active?.scope ?? null, sourceText: source?.text, error: f.app.getSnapshot().error, sent: f.submitted.length };
    } finally { release(); await f.app.dispose(); }
  }, point);
  assert.equal(result.during.settled, false, JSON.stringify(result)); assert.equal(result.during.editorLoads, 0); assert.equal(result.during.generation, result.before.writerGeneration);
  assert.deepEqual(result.during.active, { hostId: 'host', conversationId: 'recovery-owner-a' });
  assert.equal(result.after.opened, true, JSON.stringify(result)); assert.equal(result.after.editorLoads, 1); assert.ok(result.after.generation > result.before.writerGeneration); assert.equal(result.after.origin, null);
  assert.deepEqual(result.after.active, { hostId: 'host', conversationId: 'recovery-owner-b' }); assert.equal(result.after.text, 'Exact native B bytes'); assert.deepEqual(result.restarted, result.after.active);
  assert.equal(result.sourceText, 'Updated A while B recovery drains'); assert.equal(result.error, ''); assert.equal(result.sent, 0);
});

test('Open remaining saved work explicitly opens its actual predecessor successor', { timeout: 10000 }, async t => {
  const page = await fixture(t, { sharedViewState: true }), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, copy = { hostId: 'host', conversationId: 'independent-copy' }, earlier = { hostId: 'host', conversationId: 'remaining-earlier' }, target = { hostId: 'host', conversationId: 'remaining-native' };
    const legacy = await S.reopen('remaining-legacy', () => {}); await legacy.saveView('host', { version: 2, route: earlier, pendingCreation: null });
    for (const [scope, text] of [[copy, 'Independent copied bytes'], [earlier, 'Remaining predecessor bytes']]) await legacy.drafts(() => {}).save({ version: 3, scope, draft: text, draftRevision: 1, outbox: [], frontendSends: [], image: null }); await legacy.close();
    const real = await S.claimEditor({ scope: copy, viewId: 'authoritative-copy', label: 'main', transitionId: null, creation: { agentId: 'default' } }, () => {}); await real.close();

    const native = await S.claimEditor({ scope: target, viewId: 'remaining-native-view', label: 'native-child', transitionId: null, creation: { agentId: 'default' } }, () => {}); await native.saveView('host', { version: 2, route: target, pendingCreation: null }); const drafts = native.drafts(() => {}); await drafts.load(target); await drafts.save({ version: 3, scope: target, draft: 'Native destination bytes', draftRevision: 1, outbox: [], frontendSends: [], image: null }); await globalThis.recordNativeEditorOrigin(native.editorBinding(), 'native-child'); await native.close();
    const coordinator = new globalThis.WindowCoordinator(null), f = globalThis.controllerFixture({ placement: coordinator });
    Object.defineProperty(f.storage, 'catalogViewId', { get: () => sessionStorage.getItem('openpane.catalogViewId') ?? undefined }); f.storage.open = failure => S.open(failure, 'openpane.catalogViewId');
    f.storage.reopen = async (viewId, failure, options) => { const binding = await S.bindingForView(viewId); return binding ? S.claimEditor({ scope: binding.scope, viewId, label: 'main', transitionId: binding.kind === 'handoff-reserved' ? binding.transitionId : null, creation: null, ...(options?.purpose ? { purpose: options.purpose } : {}) }, failure) : S.reopen(viewId, failure); };
    f.storage.readLegacyDraft = S.readLegacyDraft; f.storage.locate = async scope => { const found = await S.locateEditor(scope); return found.binding?.viewId ?? found.legacyViewIds[0] ?? null; };
    const none = { predecessor: null, carried: null, closure: null, successor: null }; f.behavior.continuation = async input => input.scope.conversationId === earlier.conversationId ? { ...none, closure: 'cancelled', successor: { kind: 'confirmed', scope: target } } : none;
    try {
      await f.app.start(); await f.app.inspectSavedDraft('remaining-legacy', copy); const expected = f.app.getSnapshot().savedDraftRecovery;
      if (expected?.kind !== 'independent') throw new Error('Actual independent recovery was not produced');
      const opened = await f.app.openRemainingSavedWork(expected), active = f.app.getSnapshot().active;
      const source = await S.readLegacyDraft('remaining-legacy', 'host', earlier), retained = await S.readLegacyDraft('remaining-legacy', 'host', copy);
      return { opened, active: active?.scope, text: active?.store.getSnapshot().draft, source: source?.text, independent: retained?.text, error: f.app.getSnapshot().error, sent: f.submitted.length };
    } finally { await f.app.dispose(); }
  });
  assert.equal(result.opened?.kind, 'inline', JSON.stringify(result)); assert.deepEqual(result.active, { hostId: 'host', conversationId: 'remaining-native' });
  assert.equal(result.text, 'Native destination bytes'); assert.equal(result.source, 'Remaining predecessor bytes'); assert.equal(result.independent, 'Independent copied bytes'); assert.equal(result.error, ''); assert.equal(result.sent, 0);
});

test('a real legacy successor migration preserves the retained predecessor store on reconnect refusal', { timeout: 10000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, a = { hostId: 'host', conversationId: 'legacy-predecessor-a' }, b = { hostId: 'host', conversationId: 'legacy-successor-b' };
    const seed = await S.open(() => {}, 'openpane.catalogViewId'), catalogId = seed.viewId;
    for (const [scope, text] of [[a, 'Legacy predecessor bytes'], [b, 'Legacy successor bytes']]) await seed.drafts(() => {}).save({ version: 3, scope, draft: text, draftRevision: 1, outbox: [], frontendSends: [], image: null }); await seed.close();
    const coordinator = new globalThis.WindowCoordinator(null), f = globalThis.controllerFixture({ placement: coordinator }); let continuing = false, aborts = 0;
    Object.defineProperty(f.storage, 'catalogViewId', { get: () => catalogId }); f.storage.open = failure => S.open(failure, 'openpane.catalogViewId'); f.storage.reopen = (viewId, failure) => viewId === catalogId ? S.reopen(viewId, failure, { catalog: true }) : S.reopenForRecovery(viewId, failure); f.storage.locate = async scope => { const found = await S.locateEditor(scope); return found.binding?.viewId ?? found.legacyViewIds[0] ?? null; };
    const none = { predecessor: null, carried: null, closure: null, successor: null }; f.behavior.continuation = async input => continuing && input.scope.conversationId === a.conversationId ? { ...none, closure: 'cancelled', successor: { kind: 'confirmed', scope: b } } : none;
    const put = IDBObjectStore.prototype.put;
    try {
      await f.app.start(); await f.app.openReserved(a); const before = f.app.getSnapshot().active, feeds = f.feeds.length;
      IDBObjectStore.prototype.put = function(value, key) { if (Array.isArray(key) && key[0] === 'draft' && key[1] !== catalogId && key[3] === b.conversationId) { aborts++; this.transaction.abort(); throw new DOMException('Recorded legacy successor abort', 'AbortError'); } return put.call(this, value, key); };
      continuing = true; f.connectionLost(new Error('Recorded legacy reconnect')); await f.app.reconnect();
      const active = f.app.getSnapshot().active, feed = f.feeds.at(-1); if (feed && f.feeds.length > feeds) await feed.receive({ kind: 'snapshot', snapshot: { scope: a, projectionVersion: 4, cursor: (active.store.getSnapshot().cursor ?? -1) + 1, document: { domain: { messages: [], currentRun: null }, decisions: {}, receipts: {} } } });
      const beforeWait = aborts; await new Promise(resolve => setTimeout(resolve, 650));
      return { sameStore: active?.store === before.store, priorViewId: before.viewId, catalogId, scope: active?.scope, text: active?.store.getSnapshot().draft, connection: active?.store.getSnapshot().connection.kind, beforeWait, aborts, error: f.app.getSnapshot().error, sent: f.submitted.length };
    } finally { IDBObjectStore.prototype.put = put; await f.app.dispose(); }
  });
  assert.equal(result.sameStore, true, JSON.stringify(result)); assert.notEqual(result.priorViewId, result.catalogId); assert.deepEqual(result.scope, { hostId: 'host', conversationId: 'legacy-predecessor-a' }); assert.equal(result.text, 'Legacy predecessor bytes'); assert.equal(result.connection, 'connected'); assert.equal(result.aborts, 1); assert.equal(result.beforeWait, result.aborts); assert.match(result.error, /Recorded legacy successor abort/); assert.equal(result.sent, 0);
});

for (const action of ['reopen', 'remaining', 'prepare-abort', 'other-document']) test(`independent work remains recoverable during ${action} inspection and journal repair`, { timeout: 12000 }, async t => {
  const page = await fixture(t, { sharedViewState: true }), result = await page.evaluate(async action => {
    const S = globalThis.BrowserViewStorage, a = { hostId: 'host', conversationId: 'inspect-active' }, x = { hostId: 'host', conversationId: 'inspect-copy' }, p = { hostId: 'host', conversationId: 'inspect-pending' }, b = { hostId: 'host', conversationId: 'inspect-native' };
    const seed = async (scope, viewId, label, text) => { const owner = await S.claimEditor({ scope, viewId, label, transitionId: null, creation: { agentId: 'default' } }, () => {}); await owner.saveView('host', { version: 2, route: scope, pendingCreation: null }); const drafts = owner.drafts(() => {}); await drafts.load(scope); await drafts.save({ version: 3, scope, draft: text, draftRevision: 1, outbox: [], frontendSends: [], image: null }); return owner; };
    const activeSeed = await seed(a, 'inspect-active-view', 'main', 'Exact current A'); await activeSeed.close();
    const legacy = await S.reopen('inspect-independent-view', () => {}); await legacy.saveView('host', { version: 2, route: x, pendingCreation: null });
    const reference = { ownerId: 'principal', state: 'retained', command: { version: 2, scope: p, clientCommandId: 'old-inspection', body: { kind: 'send', text: 'Original recorded send', frontend: { platform: 'desktop', tools: [{ activationId: 'old', definition: { name: 'fixture__echo', description: 'Original' } }] } } } };
    for (const [scope, text] of [[x, 'Exact independent X'], [p, 'Exact pending P']]) await legacy.drafts(() => {}).save({ version: 3, scope, draft: text, draftRevision: 1, outbox: [], frontendSends: scope === p && action !== 'other-document' ? [reference] : [], image: null }); await legacy.close();
    const real = await seed(x, 'inspect-authoritative-x', 'main', 'Exact canonical X'); await real.close();
    const native = await seed(b, 'inspect-native-view', 'native-b', 'Exact native B'); await globalThis.recordNativeEditorOrigin(native.editorBinding(), 'native-b'); await native.close();
    const catalog = await S.open(() => {}, 'openpane.catalogViewId'), catalogId = catalog.viewId; await catalog.saveNavigation('host', a); await catalog.close();
    const f = globalThis.controllerFixture({ placement: new globalThis.WindowCoordinator(null) }); let enabled = false, release, entered, blocked = false, holder = null;
    const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { entered = resolve; });
    Object.defineProperty(f.storage, 'catalogViewId', { get: () => catalogId }); f.storage.open = failure => S.reopen(catalogId, failure, { catalog: true });
    f.storage.reopen = async (viewId, failure, options) => { const binding = await S.bindingForView(viewId); return binding ? S.claimEditor({ scope: binding.scope, viewId, label: 'main', transitionId: binding.kind === 'handoff-reserved' ? binding.transitionId : null, creation: null, ...(options?.purpose ? { purpose: options.purpose } : {}) }, failure) : S.reopen(viewId, failure, { catalog: viewId === catalogId }); };
    f.storage.readLegacyDraft = S.readLegacyDraft; f.storage.locate = async scope => { const found = await S.locateEditor(scope); return found.binding?.viewId ?? found.legacyViewIds[0] ?? null; };
    f.storage.recoverClosedView = async (viewId, failure) => {
      if (viewId !== 'inspect-independent-view' || !enabled) return null;
      const owner = await S.reopenForRecovery(viewId, failure); if (!owner) return null;
      const drafts = owner.drafts.bind(owner); owner.drafts = failed => { const port = drafts(failed), save = port.save.bind(port); port.save = async (records, image) => { if (!blocked && records.scope.conversationId === p.conversationId && records.frontendSends.some(row => row.state === 'unavailable-pending')) { blocked = true; entered(); await gate; } return save(records, image); }; return port; }; return owner;
    };
    f.behavior.binding = async request => ({ kind: 'unavailable', id: request.id, reason: 'closures-unavailable' });
    const bounded = promise => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Inspection did not settle')), 2500); })]).finally(() => clearTimeout(timer)); };
    const raw = async () => { const db = await new Promise(resolve => { const open = indexedDB.open('openpane-browser-views', 1); open.onsuccess = () => resolve(open.result); }); try { return await new Promise(resolve => { const tx = db.transaction('records'), store = tx.objectStore('records'), rows = store.getAll(), keys = store.getAllKeys(); tx.oncomplete = () => resolve(rows.result.map((value, index) => ({ key: keys.result[index], value }))); }); } finally { db.close(); } };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) { if (action === 'prepare-abort' && Array.isArray(key) && key[0] === 'view' && key[1] === 'inspect-independent-view' && value.route === null) { throw new DOMException('Recorded remaining preparation abort', 'AbortError'); } return put.call(this, value, key); };
    try {
      await f.app.start(); await f.app.inspectSavedDraft('inspect-independent-view', x); const expected = f.app.getSnapshot().savedDraftRecovery; if (expected?.kind !== 'independent') throw new Error('Independent producer missing');
      if (action === 'other-document') holder = await S.reopen('inspect-independent-view', () => {});
      else { enabled = true; await f.app.refreshMetadata(); await bounded(began); }
      let settled = false; const opening = (action === 'reopen' ? f.app.reopenView('inspect-independent-view') : f.app.openRemainingSavedWork(expected)).then(value => { settled = true; return value; });
      await new Promise(resolve => setTimeout(resolve, 25)); const during = { settled, selected: sessionStorage.getItem('openpane.viewId'), active: f.app.getSnapshot().active?.scope, recovery: f.app.getSnapshot().savedDraftRecovery?.kind, error: f.app.getSnapshot().error };
      release(); const opened = await bounded(opening);
      if (action === 'remaining') await bounded(f.app.openRemainingSavedWork(f.app.getSnapshot().savedDraftRecovery));
      const state = f.app.getSnapshot(), rows = await raw();
      const text = scope => rows.find(row => Array.isArray(row.key) && row.key[0] === 'draft' && row.key[1] === (scope === x || scope === p ? 'inspect-independent-view' : scope === a ? 'inspect-active-view' : 'inspect-native-view') && row.value?.scope?.conversationId === scope.conversationId)?.value.draft;
      return { during, opened, selected: sessionStorage.getItem('openpane.viewId'), active: state.active?.scope ?? null, recovery: state.savedDraftRecovery?.kind, error: state.error, storageFailure: state.storageFailure, legacyRoute: rows.find(row => Array.isArray(row.key) && row.key[0] === 'view' && row.key[1] === 'inspect-independent-view')?.value.route, texts: [text(a), text(x), text(p), text(b)], sent: f.submitted.length };
    } finally { release(); IDBObjectStore.prototype.put = put; await holder?.close(); await f.app.dispose(); }
  }, action);
  assert.equal(result.storageFailure, ''); assert.deepEqual(result.texts, ['Exact current A', 'Exact independent X', 'Exact pending P', 'Exact native B']); assert.equal(result.sent, 0);
  if (action === 'reopen') { assert.equal(result.opened, false); assert.equal(result.recovery, 'independent'); assert.deepEqual(result.active, { hostId: 'host', conversationId: 'inspect-active' }); assert.equal(result.error, ''); }
  else if (action === 'remaining') { assert.equal(result.during.settled, false, JSON.stringify(result)); assert.equal(result.selected, 'inspect-independent-view'); assert.equal(result.error, ''); }
  else if (action === 'prepare-abort') { assert.match(result.error, /Recorded remaining preparation abort/); assert.deepEqual(result.active, { hostId: 'host', conversationId: 'inspect-active' }); assert.deepEqual(result.legacyRoute, { hostId: 'host', conversationId: 'inspect-copy' }); }
  else { assert.match(result.error, /already open/); assert.deepEqual(result.active, { hostId: 'host', conversationId: 'inspect-active' }); }
});

test('read-only saved-draft inspection cannot refuse an assigned native child claim', { timeout: 10000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, scope = { hostId: 'host', conversationId: 'assigned-inspection' }, viewId = 'assigned-inspection-view';
    const seed = await S.claimEditor({ scope, viewId, label: 'main', transitionId: null, creation: { agentId: 'default' } }, () => {}); await seed.saveView('host', { version: 2, route: scope, pendingCreation: null }); const drafts = seed.drafts(() => {}); await drafts.load(scope); await drafts.save({ version: 3, scope, draft: 'Exact assigned bytes', draftRevision: 1, outbox: [], frontendSends: [], image: null });
    await seed.reserveHandoff({ scope, sourceViewId: viewId, targetViewId: viewId, expectedBinding: seed.editorBinding(), transitionId: 'assigned-move', targetLabel: 'assigned-child' }); await seed.close();
    const get = IDBObjectStore.prototype.get; let released = false, entered, held = false, child = null, settled = false;
    const began = new Promise(resolve => { entered = resolve; });
    IDBObjectStore.prototype.get = function(key) { const request = get.call(this, key); if (!held && Array.isArray(key) && key[0] === 'editor-view-binding' && key[1] === viewId) { held = true; const store = this; request.addEventListener('success', () => { entered(); const pump = () => { if (released) return; get.call(store, ['inspection-keepalive']).onsuccess = pump; }; pump(); }, { once: true }); } return request; };
    try {
      const inspection = S.readLegacyDraft(viewId, 'host', scope); await began;
      const claiming = S.claimEditor({ scope, viewId, label: 'assigned-child', transitionId: 'assigned-move', creation: null }, () => {}).then(owner => { child = owner; settled = true; return null; }, error => { settled = true; return error.message; });
      await new Promise(resolve => setTimeout(resolve, 25)); const during = settled; released = true; const error = await claiming, saved = await inspection;
      const text = child ? (await child.drafts(() => {}).load(scope))?.draft : null; return { during, error, saved: saved?.text, text, binding: child?.editorBinding().kind };
    } finally { released = true; IDBObjectStore.prototype.get = get; await child?.close(); }
  });
  assert.equal(result.during, false, JSON.stringify(result)); assert.equal(result.error, null); assert.equal(result.saved, 'Exact assigned bytes'); assert.equal(result.text, 'Exact assigned bytes'); assert.equal(result.binding, 'editing');
});

test('a native child can reclaim its editor after close completion fails while main reopens its saved view', { timeout: 12000 }, async t => {
  const page = await fixture(t, { sharedViewState: true, captureRuntimeFactory: true }), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, a = { hostId: 'host', conversationId: 'main-before-child-reload' }, b = { hostId: 'host', conversationId: 'native-child-reload' }, catalogId = 'native-reopen-catalog'; let reloads = 0, focused = 0, resumed = null;
    globalThis.recordReload = () => { reloads++; };
    const seed = async (scope, viewId, label, text) => { const owner = await S.claimEditor({ scope, viewId, label, transitionId: null, creation: { agentId: 'default' } }, () => {}); await owner.saveView('host', { version: 2, route: scope, pendingCreation: null }); const drafts = owner.drafts(() => {}); await drafts.load(scope); await drafts.save({ version: 3, scope, draft: text, draftRevision: 1, outbox: [], frontendSends: [], image: null }); return owner; };
    const mainSeed = await seed(a, 'main-before-child-view', 'main', 'Exact main before reload'); await mainSeed.close();
    const childSeed = await seed(b, 'native-child-reload-view', 'native-child', 'Exact child before reload'); await globalThis.recordNativeEditorOrigin(childSeed.editorBinding(), 'native-child'); const initial = childSeed.editorBinding(); await childSeed.close();
    const catalog = await S.reopen(catalogId, () => {}, { catalog: true }); await catalog.saveNavigation('host', a); await catalog.close();
    const reserved = { scope: b, viewId: initial.viewId, label: 'native-child', transitionId: 'native-child-move', creationAgentId: null, phase: 'target-ready', bindingRevision: initial.revision, writerGeneration: initial.writerGeneration };
    const childRuntime = new globalThis.WindowRuntime({ role: 'chat', version: 1, label: 'native-child', brokerInstance: 'broker', documentIncarnation: 'child-old', viewId: initial.viewId, reservation: reserved, liveRelay: true });
    const child = globalThis.controllerFixture({ fixedScope: b, placement: childRuntime.coordinator }); Object.defineProperties(child.storage, Object.getOwnPropertyDescriptors(globalThis.runtimeFactory)); childRuntime.controller = child.app;
    const closeCommands = []; childRuntime.port.request = async command => { closeCommands.push({ kind: command.kind, attemptId: command.attemptId }); if (command.attemptId !== 'fixture-child-close') throw new Error('Wrong native close attempt identity'); if (command.kind === 'close-ready') throw new Error('Recorded close completion failure'); if (command.kind === 'close-cancelled') return { ok: true }; throw new Error(command.kind); };
    let mainRuntime, main;
    try {
      await child.app.start(); await child.app.getSnapshot().active.store.setDraft('Exact child after saved close'); const ready = { ...reserved, bindingRevision: (await S.locateEditor(b)).binding.revision, writerGeneration: (await S.locateEditor(b)).binding.writerGeneration };
      await childRuntime.closeWindow('fixture-child-close');
      mainRuntime = new globalThis.WindowRuntime({ role: 'main', version: 1, label: 'main', brokerInstance: 'broker', documentIncarnation: 'main', viewId: catalogId, reservation: null, liveRelay: true });
      const launches = []; mainRuntime.port.request = async command => { if (command.kind === 'lookup') return command.scope.conversationId === b.conversationId ? { kind: 'ready', reservation: ready } : { kind: 'absent' }; if (command.kind === 'launch') { launches.push(command); if (command.existingOnly) { focused++; return { kind: 'detached', scope: b, label: 'native-child' }; } throw new Error('Unexpected native creation'); } throw new Error(command.kind); };
      main = globalThis.controllerFixture({ placement: mainRuntime.coordinator }); Object.defineProperties(main.storage, Object.getOwnPropertyDescriptors(globalThis.runtimeFactory)); await main.app.start();
      const before = main.app.getSnapshot().active, opened = await main.app.reopenView(initial.viewId), after = main.app.getSnapshot(); let resumeError = null;
      try { resumed = await S.claimEditor({ scope: b, viewId: initial.viewId, label: 'native-child', transitionId: 'native-child-move', creation: null }, () => {}); } catch (error) { resumeError = error.message; }
      const childText = resumed ? (await resumed.drafts(() => {}).load(b))?.draft : null;
      return { reloads, closeCommands, opened, focused, existingOnly: launches.every(command => command.existingOnly === true), host: after.host.kind, storageFailure: after.storageFailure, error: after.error, sameMain: after.active?.store === before.store, mainScope: after.active?.scope, mainText: before.store.getSnapshot().draft, route: after.saved.route, resumeError, childText, sent: child.submitted.length + main.submitted.length };
    } finally { await resumed?.close(); await main?.app.dispose(); await child.app.dispose(); mainRuntime?.close(); childRuntime.close(); }
  });
  assert.equal(result.reloads, 1); assert.deepEqual(result.closeCommands, [{ kind: 'close-ready', attemptId: 'fixture-child-close' }, { kind: 'close-cancelled', attemptId: 'fixture-child-close' }]); assert.equal(result.focused, 1); assert.equal(result.existingOnly, true);
  assert.equal(result.host, 'ready'); assert.equal(result.storageFailure, ''); assert.equal(result.opened, false); assert.equal(result.error, 'This saved chat is already open in its native window. Continue editing there.'); assert.equal(result.sameMain, true, JSON.stringify(result)); assert.deepEqual(result.mainScope, { hostId: 'host', conversationId: 'main-before-child-reload' }); assert.deepEqual(result.route, result.mainScope); assert.equal(result.mainText, 'Exact main before reload');
  assert.equal(result.resumeError, null, JSON.stringify(result)); assert.equal(result.childText, 'Exact child after saved close'); assert.equal(result.sent, 0);
});

test('a main reconnect reads the new host route from its retained catalog instead of the previous dedicated editor', { timeout: 10000 }, async t => {
  const page = await fixture(t), result = await page.evaluate(async () => {
    const S = globalThis.BrowserViewStorage, a = { hostId: 'host', conversationId: 'catalog-switch-a' }, b = { hostId: 'other-host', conversationId: 'catalog-switch-b' };
    const catalog = await S.open(() => {}, 'openpane.catalogViewId'), catalogId = catalog.viewId;
    await catalog.saveNavigation(a.hostId, a); await catalog.saveNavigation(b.hostId, b); await catalog.close();
    for (const [scope, viewId, text] of [[a, 'catalog-switch-editor-a', 'Exact host A draft'], [b, 'catalog-switch-editor-b', 'Exact host B draft']]) {
      const seed = await S.claimEditor({ scope, viewId, label: 'main', transitionId: null, creation: { agentId: 'default' } }, () => {});
      await seed.saveView(scope.hostId, { version: 2, route: scope, pendingCreation: null });
      const drafts = seed.drafts(() => {}); await drafts.load(scope); await drafts.save({ version: 3, scope, draft: text, draftRevision: 1, outbox: [], frontendSends: [], image: null }); await seed.close();
    }
    const f = globalThis.controllerFixture({ placement: new globalThis.WindowCoordinator(null) });
    Object.defineProperty(f.storage, 'catalogViewId', { get: () => catalogId });
    f.storage.open = failure => S.reopen(catalogId, failure, { catalog: true });
    f.storage.reopen = async (viewId, failure, options) => {
      if (viewId === catalogId) return S.reopen(catalogId, failure, { catalog: true });
      const binding = await S.bindingForView(viewId);
      return S.claimEditor({ scope: binding.scope, viewId, label: 'main', transitionId: null, creation: null, ...(options?.purpose ? { purpose: options.purpose } : {}) }, failure);
    };
    f.storage.locate = async scope => { const found = await S.locateEditor(scope); return found.binding?.viewId ?? null; };
    try {
      await f.app.start(); const first = f.app.getSnapshot().active;
      const before = { scope: first?.scope, viewId: first?.viewId, draft: first?.store.getSnapshot().draft, error: f.app.getSnapshot().error };
      f.host(b.hostId); f.connectionLost(new Error('Recorded host switch')); await f.app.reconnect();
      const snapshot = f.app.getSnapshot(), active = snapshot.active;
      let drained = null;
      for (let n = 0; n < 400 && !drained; n++) { drained = await S.reopenForRecovery('catalog-switch-editor-a', () => {}); if (!drained) await new Promise(resolve => setTimeout(resolve, 5)); }
      let savedA = null; if (drained) { savedA = (await drained.drafts(() => {}).load(a))?.draft; await drained.close(); }
      const heldCatalog = await S.reopenForRecovery(catalogId, () => {}); if (heldCatalog) await heldCatalog.close();
      return { before, active: active?.scope ?? null, viewId: active?.viewId, draft: active?.store.getSnapshot().draft, host: snapshot.host.kind, error: snapshot.error, storageFailure: snapshot.storageFailure, catalogRetained: heldCatalog === null, savedA, sent: f.submitted.length };
    } finally { await f.app.dispose(); }
  });
  assert.deepEqual(result.before, { scope: { hostId: 'host', conversationId: 'catalog-switch-a' }, viewId: 'catalog-switch-editor-a', draft: 'Exact host A draft', error: '' });
  assert.deepEqual(result.active, { hostId: 'other-host', conversationId: 'catalog-switch-b' }, JSON.stringify(result));
  assert.equal(result.viewId, 'catalog-switch-editor-b'); assert.equal(result.draft, 'Exact host B draft'); assert.equal(result.savedA, 'Exact host A draft');
  assert.equal(result.catalogRetained, true); assert.equal(result.host, 'ready'); assert.equal(result.error, ''); assert.equal(result.storageFailure, ''); assert.equal(result.sent, 0);
});
