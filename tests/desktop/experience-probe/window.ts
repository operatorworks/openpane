import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface Context { readonly role: 'main' | 'chat'; readonly label: string; readonly slot: number | null }
const command = <T>(command: object) => invoke<T>('desktop_window', { command });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report = async (kind: string, detail: unknown) => fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, detail }) });
const output = document.querySelector('pre')!;
async function run() {
  if (location.search === '?wrong-document') {
    try { await command({ kind: 'context' }); throw new Error('Wrong document admitted'); }
    catch (error) { if (!String(error).includes('forbidden-url')) throw error; await report('wrong-document-denied', true); return; }
  }
  const context = await command<Context>({ kind: 'context' });
  const title = document.querySelector('h1')!;
  title.textContent = context.role === 'main' ? 'Main relay · native qualification' : `Native chat ${context.slot}`;
  await report('context', context);
  if (context.role === 'main') {
    let release!: () => void;
    const held = navigator.locks.request('openpane-probe-conversation', async () => {
      await report('main-lock-held', true);
      await new Promise<void>(resolve => { release = resolve; });
    });
    while (!release) await sleep(10);
    const database = await openDatabase();
    await put(database, 'draft', 'saved native draft');
    const opened = [];
    for (let slot = 0; slot < 8; slot++) opened.push(await command({ kind: 'open', slot }));
    const duplicate = await command({ kind: 'open', slot: 0 });
    await report('open-results', { opened, duplicate });
    for (let slot = 0; slot < 8; slot++) {
      const focused = await command({ kind: 'open', slot });
      await report('startup-foreground', { slot, focused });
      const deadline = performance.now() + 15000;
      while (!(await (await fetch('/state')).json()).readyCounts[`probe-chat-${slot}`]) {
        if (performance.now() >= deadline) throw new Error(`Foreground child ${slot} did not become ready`);
        await sleep(100);
      }
    }
    const beforeRecovery = await (await fetch('/state')).json();
    await command({ kind: 'close', slot: 0 });
    await sleep(500);
    await command({ kind: 'open', slot: 0 });
    const recoveryDeadline = performance.now() + 15000;
    for (;;) {
      const recovered = await (await fetch('/state')).json();
      if (recovered.readyCounts['probe-chat-0'] > beforeRecovery.readyCounts['probe-chat-0'] && recovered.recoveredCounts['probe-chat-0'] > (beforeRecovery.recoveredCounts['probe-chat-0'] ?? 0)) break;
      if (performance.now() >= recoveryDeadline) throw new Error('Reopened foreground child did not recover its own saved draft');
      await sleep(100);
    }
    release(); await held;
    await command({ kind: 'minimize' });
    const minimizeDeadline = performance.now() + 3000;
    let minimized = await command<{ minimized: boolean; sampleAtMs: number }>({ kind: 'minimized' });
    while (!minimized.minimized) {
      if (performance.now() >= minimizeDeadline) throw new Error('Main window did not minimize');
      await sleep(50);
      minimized = await command<{ minimized: boolean; sampleAtMs: number }>({ kind: 'minimized' });
    }
    await report('minimized', minimized);
    const checkMinimized = async () => {
      const state = await command<{ minimized: boolean; sampleAtMs: number }>({ kind: 'minimized' });
      await report('minimized-state', state);
      if (!state.minimized) throw new Error('Main window was restored during the relay qualification');
    };
    await checkMinimized();
    const deadline = performance.now() + 310000;
    let generation = 0;
    while (performance.now() < deadline) {
      generation++;
      await checkMinimized();
      const start = performance.now();
      await (await fetch(`/snapshot?generation=${generation}`)).json();
      await command({ kind: 'publish', generation });
      await report('relay', { generation, elapsedMs: performance.now() - start });
      await checkMinimized();
      await sleep(2000);
    }
    await checkMinimized();
    await report('relay-frozen', { generation });
    for (let slot = 0; slot < 8; slot++) {
      await checkMinimized();
      const focused = await command({ kind: 'open', slot });
      await report('final-foreground', { slot, generation, focused });
      await command({ kind: 'publish', generation });
      const deadline = performance.now() + 15000;
      for (;;) {
        await checkMinimized();
        const state = await (await fetch('/state')).json();
        if (state.frozenGeneration === generation && state.finalPainted.includes(`probe-chat-${slot}`)) break;
        if (performance.now() >= deadline) throw new Error(`Foreground child ${slot} did not paint frozen generation ${generation}`);
        await sleep(100);
      }
    }
    await checkMinimized();
    await report('main-complete', true);
    output.textContent = 'Main relay completed with minimized state checked at every relay.';
    database.close();
  } else {
    const unavailable = await navigator.locks.request('openpane-probe-conversation', { ifAvailable: true }, lock => lock === null);
    if (!unavailable) throw new Error('Duplicate editor lock was admitted');
    const database = await openDatabase();
    if (await get(database, 'draft') !== 'saved native draft') throw new Error('WKWebViews do not share IndexedDB');
    const key = `view-${context.slot}`;
    await navigator.locks.request(key, async () => {
      const old = await get(database, key);
      if (old !== undefined && old !== `draft for ${context.slot}`) throw new Error('Recovered draft text changed');
      await put(database, key, old ?? `draft for ${context.slot}`);
      try { await command({ kind: 'open', slot: 0 }); throw new Error('Child created a window'); }
      catch (error) { if (String(error).includes('Child created')) throw error; }
      try { await invoke('provider_setup', { command: { kind: 'status' } }); throw new Error('Child accessed provider setup'); }
      catch (error) { if (String(error).includes('Child accessed')) throw error; }
      try { await invoke('native_access', { command: { kind: 'connect' } }); throw new Error('Child accessed native broker'); }
      catch (error) { if (String(error).includes('Child accessed')) throw error; }
      let readAttempt = 0;
      const read = async () => {
        const attempt = ++readAttempt;
        const state = await command<{ generation: number; slot: number }>({ kind: 'read' });
        if (state.slot !== context.slot) throw new Error('Foreign scoped relay');
        const draft = await get(database, key);
        if (attempt !== readAttempt) return;
        output.textContent = `View ${key}\n${draft}\nPainted generation ${state.generation}`;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        if (attempt !== readAttempt || document.visibilityState !== 'visible') return;
        await report('paint', { ...context, generation: state.generation });
      };
      await listen('probe-wakeup', () => { void read().catch(error => report('failure', String(error))); }, { target: { kind: 'WebviewWindow', label: context.label } });
      await read();
      const controls = document.querySelector('section')!;
      for (const action of ['send', 'stop', 'approve']) {
        const button = document.createElement('button'); button.textContent = action;
        button.onclick = async () => {
          try {
          const start = performance.now();
          const result = await command<{ slot: number; action: string }>({ kind: 'interaction', action });
          if (result.slot !== context.slot || result.action !== action) throw new Error('Wrong interaction scope');
          await report('interaction', { ...result, elapsedMs: performance.now() - start });
          } catch (error) { await report('failure', String(error)); }
        };
        controls.append(button);
      }
      await report('child-ready', { ...context, duplicateExcluded: unavailable, recovered: old === `draft for ${context.slot}` });
      while (!(await (await fetch('/state')).json()).started) await sleep(100);
      const deadline = performance.now() + 310000;
      for (let index = 0; performance.now() < deadline; index++) {
        void fetch('/observation').then(response => response.json()).catch(error => report('failure', String(error)));
        for (const button of controls.querySelectorAll('button')) button.click();
        await sleep(2000);
      }
      await report('child-complete', context);
    });
  }
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('openpane-native-qualification', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
function get(database: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = database.transaction('records').objectStore('records').get(key);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
function put(database: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction('records', 'readwrite'); tx.objectStore('records').put(value, key);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
}
void run().catch(error => { output.textContent = String(error); void report('failure', String(error)); });
