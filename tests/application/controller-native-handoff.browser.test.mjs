import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t) {
  const bundle = await build({ stdin: { resolveDir: root, contents: `
    import {createApplicationController} from './apps/desktop/src/application/application-controller.ts';
    import {BrowserViewStorage} from './apps/desktop/src/application/browser-storage.ts';
    import {WindowCoordinator} from './apps/desktop/src/application/window-coordinator.ts';
    import * as carries from './apps/desktop/src/application/draft-carry.ts';
    import {createConversationStore} from '@openpane/client';import {transcriptProjection} from '@openpane/contracts/conversation';
    import {RECORDED_RUNTIME,SERVICE_WIRE_VERSION,EXTENSION_SDK_VERSION} from '@openpane/contracts/compatibility';
    Object.assign(globalThis,{createApplicationController,BrowserViewStorage,WindowCoordinator,RECORDED_RUNTIME,SERVICE_WIRE_VERSION,EXTENSION_SDK_VERSION,carries,createConversationStore,transcriptProjection});
  ` }, bundle: true, write: false, format: 'iife' });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Main handoff ownership</title>' }));
  await page.goto('http://localhost/handoff'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return page;
}

for (const outcome of ['detached', 'pending', 'refused after commit', 'refused before commit']) test(`main remains usable after its source chat is ${outcome}`, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async outcome => {
    const S = globalThis.BrowserViewStorage, first = { hostId: 'host', conversationId: 'first' }, second = { ...first, conversationId: 'second' };
    const text = 'Native draft one — keep this exact text', childOwners = new Map(), reservations = new Map(), launches = [], reopenAttempts = [];
    let transition = 0;
    const claimChild = async scope => {
      if (childOwners.has(scope.conversationId)) return childOwners.get(scope.conversationId);
      const saved = reservations.get(scope.conversationId);
      const owner = await S.claimEditor({ scope, viewId: saved.viewId, label: saved.label, transitionId: saved.transitionId, creation: null }, () => {});
      childOwners.set(scope.conversationId, owner); return owner;
    };
    const port = { context: { role: 'main', liveRelay: true, label: 'main' }, async request(command) {
      const id = command.scope?.conversationId;
      if (command.kind === 'lookup') return reservations.has(id) ? { kind: childOwners.has(id) ? 'ready' : 'opening', reservation: reservations.get(id) } : { kind: 'absent' };
      if (command.kind === 'reserve') {
        const reservation = { scope: command.scope, viewId: command.viewId, label: `child-${id}`, transitionId: `transition-${++transition}`, creationAgentId: command.creationAgentId, phase: 'requested', bindingRevision: null, writerGeneration: null };
        reservations.set(id, reservation); return reservation;
      }
      if (command.kind === 'phase') { reservations.set(id, { ...reservations.get(id), phase: command.phase }); return; }
      if (command.kind === 'cancel-reservation') { reservations.delete(id); return; }
      if (command.kind === 'launch') {
        if (command.existingOnly) return childOwners.has(id) ? { kind: 'detached', scope: command.scope, label: reservations.get(id).label } : null;
        launches.push(id);
        if (id === 'first' && outcome === 'pending') return { kind: 'pending', scope: command.scope, reason: 'Child is starting' };
        if (id === 'first' && outcome === 'refused after commit') return { kind: 'refused', reason: 'Child failed after committed handoff' };
        await claimChild(command.scope); return { kind: 'detached', scope: command.scope, label: reservations.get(id).label };
      }
      throw new Error(`Unexpected native fixture operation ${command.kind}`);
    } };
    const coordinator = new globalThis.WindowCoordinator(port);
    const factory = { catalogViewId: 'main-catalog', open: failure => S.reopen('main-catalog', failure, { catalog: true }),
      async reopen(viewId, failure) {
        reopenAttempts.push(viewId);
        const binding = await S.bindingForView(viewId);
        if (!binding) return S.reopen(viewId, failure);
        if (binding.kind === 'handoff-reserved' && binding.targetLabel !== 'main') throw new Error('This saved view is reserved for its recorded chat window. Open that chat from the catalog.');
        return S.claimEditor({ scope: binding.scope, viewId, label: 'main', transitionId: binding.kind === 'handoff-reserved' ? binding.transitionId : null, creation: null }, failure);
      },
      async locate(scope) { return (await S.locateEditor(scope)).binding?.viewId ?? null; },
    };
    const agent = { id: 'recorded', label: 'Recorded', runtime: globalThis.RECORDED_RUNTIME, imageInput: { kind: 'unsupported', reason: 'No images' }, frontendOffers: 'unsupported', commands: ['send','cancel','approve'], availability: { kind: 'ready' } };
    const none = { predecessor: null, carried: null, closure: null, successor: null };
    const connection = {
      async metadata() { return { hostId:'host', principalId:'principal', agents:[agent], extensions:[], defaultAgentId:agent.id, compatibility:{wireVersion:globalThis.SERVICE_WIRE_VERSION,extensionSdkVersion:globalThis.EXTENSION_SDK_VERSION,nativeRuntime:globalThis.RECORDED_RUNTIME,desiredGitRevision:'revision',appliedArtifact:{gitRevision:'revision',artifactId:'artifact'}} }; },
      async catalog() { return [first,second].map(scope=>({scope,preview:null,provider:null})); },
      async conversationAgent() { return agent; }, async continuation() { return none; }, async providerObservation() { return {kind:'not-applicable'}; }, async conversationPermissions() { return {kind:'unsupported',reason:'No permissions'}; },
      conversation(scope) { return {scope,async receipt(){return null;},async submit(){throw new Error('No send requested');},watch(){return{close(){},ended:new Promise(()=>{})};}}; },
    };
    const app = globalThis.createApplicationController({createConnection:()=>connection,ownedViewStorage:factory,createId:()=>crypto.randomUUID(),placement:coordinator});
    let sourceStore;
    const original = S.prototype.reserveHandoff;
    try {
      await app.start(); const initial = await app.open(first);
      if (initial.kind !== 'inline') throw new Error(`Initial chat did not open: ${JSON.stringify(initial)}`);
      sourceStore = app.getSnapshot().active.store; const sourceViewId = app.getSnapshot().active.viewId;
      await sourceStore.setDraft(text);
      if (outcome === 'refused before commit') S.prototype.reserveHandoff = function(plan) { if (plan.scope.conversationId === 'first') throw new Error('Refused before handoff commit'); return original.call(this,plan); };
      coordinator.setPresentation({ chats:'separate', chatWindow:{width:640,height:720,titlebar:'native',title:'conversation'} });
      const handed = await app.open(first), after = app.getSnapshot();
      const summary = { handed, mainError:after.error, storageFailure:after.storageFailure, activeScope:after.active?.scope ?? null, saved:after.saved, sourceViewId, reopenAttempts:[...reopenAttempts], launches:[...launches] };
      if (outcome === 'refused before commit') {
        summary.sourceText = after.active ? (await after.active.store.captureDraft()).text : null;
        if (after.active) await after.active.store.setDraft('Still writable before commit');
      } else {
        const child = await claimChild(first); summary.sourceText = (await child.drafts(()=>{}).load(first)).draft;
        summary.duplicateWriter = await factory.reopen(sourceViewId,()=>{}).then(async owner=>{await owner.close();return true;},()=>false);
      }
      const next = await app.open(second); summary.next = next; summary.finalError=app.getSnapshot().error; summary.finalStorageFailure=app.getSnapshot().storageFailure;
      summary.launches = [...launches]; summary.childCount = childOwners.size;
      return summary;
    } finally { S.prototype.reserveHandoff=original; await app.dispose(); for(const owner of childOwners.values())await owner.close(); }
  }, outcome);
  assert.equal(result.handed.kind, outcome.startsWith('refused') ? 'refused' : outcome);
  assert.equal(result.storageFailure, '');
  assert.equal(result.sourceText, 'Native draft one — keep this exact text');
  if (outcome === 'refused before commit') {
    assert.deepEqual(result.activeScope, {hostId:'host',conversationId:'first'});
    assert.match(result.mainError,/Refused before handoff commit/);
  } else {
    assert.equal(result.activeScope,null,'main returns to its retained catalog after relinquishing this editor');
    assert.equal(result.duplicateWriter,false,'main cannot reacquire the child writer');
    if (outcome === 'refused after commit') assert.equal(result.mainError,'Child failed after committed handoff');
    else { assert.equal(result.mainError,''); assert.deepEqual(result.reopenAttempts,[],'successful handoff never tries to reclaim the source'); }
  }
  assert.equal(result.next.kind,'detached','another directly openable catalog chat still opens its native child');
  assert.equal(result.finalError,''); assert.equal(result.finalStorageFailure,'');
});

for (const condition of ['unchanged source', 'newer source edit', 'destination copy removed']) test(`main recovers a nonactive historical applied carry while source remains in B with ${condition}`, async t => {
  const page = await fixture(t), result = await page.evaluate(async condition => {
    const S = globalThis.BrowserViewStorage, c = globalThis.carries, sourceScope = { hostId:'host',conversationId:'closed-source-B' }, targetScope={...sourceScope,conversationId:'closed-target'};
    const claim=(scope,viewId,label,transitionId=null,creation={agentId:'recorded'})=>({scope,viewId,label,transitionId,creation});
    let source=await S.claimEditor(claim(sourceScope,'closed-A','main'),()=>{}), target=await S.claimEditor(claim(targetScope,'closed-target','target'),()=>{});
    const make=(owner,scope)=>globalThis.createConversationStore({scope,drafts:owner.drafts(()=>{}),projection:globalThis.transcriptProjection,port:{scope,async receipt(){return null;},async submit(){throw Error('No send requested');},watch(){return{close(){},ended:new Promise(()=>{})};}}});
    let sourceStore=make(source,sourceScope);const targetStore=make(target,targetScope);await Promise.all([sourceStore.ready,targetStore.ready]);
    await sourceStore.setDraft('Original nonactive draft');const expected=await sourceStore.captureDraft(),requestId='1:closed-B';
    await c.offerDraftCarry({source:sourceScope,sourceViewId:source.viewId,requestId,writerGeneration:source.editorBinding().writerGeneration,expected});
    await c.bindDraftCarry(sourceScope,requestId,targetScope);
    await targetStore.transferDraft(await targetStore.captureDraft(),expected.text,{kind:'receive',source:sourceScope,requestId});
    await sourceStore.dispose();await source.reserveHandoff({scope:sourceScope,sourceViewId:source.viewId,targetViewId:'closed-B',transitionId:'closed-A-B',targetLabel:'child-B',expectedBinding:source.editorBinding()});await source.close();
    source=await S.claimEditor(claim(sourceScope,'closed-B','child-B','closed-A-B',null),()=>{});sourceStore=make(source,sourceScope);await sourceStore.ready;
    if(condition==='newer source edit')await sourceStore.setDraft('New nonactive source edit');
    if(condition==='destination copy removed')await targetStore.setDraft('Destination replacement retained');
    await sourceStore.dispose();await source.close();
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('openpane-browser-views',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const [current]=await c.sourceCarries(sourceScope);
    await new Promise((resolve,reject)=>{const tx=db.transaction('records','readwrite');tx.objectStore('records').put({...current,sourceViewId:'closed-A'},['draft-carry',sourceScope.hostId,sourceScope.conversationId,requestId]);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
    const agent={id:'recorded',label:'Recorded',runtime:globalThis.RECORDED_RUNTIME,imageInput:{kind:'unsupported',reason:'No images'},frontendOffers:'unsupported',commands:['send'],availability:{kind:'ready'}};
    const connection={async metadata(){return{hostId:'host',principalId:'principal',agents:[agent],extensions:[],defaultAgentId:agent.id,compatibility:{wireVersion:globalThis.SERVICE_WIRE_VERSION,extensionSdkVersion:globalThis.EXTENSION_SDK_VERSION,nativeRuntime:globalThis.RECORDED_RUNTIME,desiredGitRevision:'revision',appliedArtifact:{gitRevision:'revision',artifactId:'artifact'}}};},async catalog(){return[];},conversation(scope){return{scope,watch(){return{close(){},ended:new Promise(()=>{})};}};}};
    const factory={catalogViewId:'recovery-catalog',open:failure=>S.reopen('recovery-catalog',failure,{catalog:true}),reopen:(id,failure)=>S.reopen(id,failure),recoverClosedView:(id,failure)=>S.reopenForRecovery(id,failure),async locate(scope){return(await S.locateEditor(scope)).binding?.viewId??null;}};
    const app=globalThis.createApplicationController({createConnection:()=>connection,ownedViewStorage:factory,createId:()=>crypto.randomUUID()});
    await app.start();const inactive=app.getSnapshot().active===null;
    await app.settleCarriedDraft((await c.sourceCarries(sourceScope))[0]);await app.dispose();
    const [settled]=await c.sourceCarries(sourceScope),owner=await S.reopenForRecovery('closed-B',()=>{}),stored=await owner.drafts(()=>{}).load(sourceScope);
    const targetText=(await targetStore.captureDraft()).text;let freshOffer=false;
    if(settled.kind==='settled'){
      const reopened=make(owner,sourceScope);await reopened.ready;await reopened.setDraft('Fresh offer after main recovery');
      await c.offerDraftCarry({source:sourceScope,sourceViewId:owner.viewId,requestId:'1:fresh-closed-B',writerGeneration:owner.editorBinding().writerGeneration,expected:await reopened.captureDraft()});
      freshOffer=(await c.sourceCarries(sourceScope)).some(row=>row.kind==='offered'&&row.requestId==='1:fresh-closed-B');await reopened.dispose();
    }
    await owner.close();await targetStore.dispose();await target.close();
    return{inactive,kind:settled.kind,sourceViewId:settled.sourceViewId,outcome:settled.outcome,retainedText:settled.retainedText,sourceText:stored.draft,targetText,freshOffer};
  }, condition);
  assert.equal(result.inactive,true);assert.equal(result.kind,'settled');assert.equal(result.sourceViewId,'closed-B');
  assert.equal(result.sourceText,condition==='unchanged source'?'':condition==='newer source edit'?'New nonactive source edit':'Original nonactive draft');
  assert.equal(result.targetText,condition==='destination copy removed'?'Destination replacement retained':'Original nonactive draft');
  assert.equal(result.outcome,condition==='unchanged source'?'cleared':'changed');if(condition!=='unchanged source')assert.equal(result.retainedText,'Original nonactive draft');assert.equal(result.freshOffer,true);
});
