import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = build({ stdin: { contents: `import {PersonalizationStorage,paletteDigest} from './apps/desktop/src/application/personalization-storage.ts';
 import {PersonalizationSession} from './apps/desktop/src/application/use-personalization.tsx';
 import {defaultDesktopPreferences} from './apps/desktop/src/application/personalization.ts';
 import {starterPalette,canonicalPaletteText} from '@openpane/theme';
 Object.assign(globalThis,{PersonalizationStorage,PersonalizationSession,defaultDesktopPreferences,starterPalette,canonicalPaletteText,paletteDigest});`, resolveDir: root }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
async function fixture(t) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route(/^http:\/\/127\.0\.0\.1(?::\d+)?\//, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Personalization storage</title>' }));
  const page = await context.newPage();
  await page.goto('http://127.0.0.1/storage');
  await page.addScriptTag({ content: (await bundle).outputFiles[0].text });
  await page.evaluate(() => {
    globalThis.writeRaw = async document => {
      const opening = indexedDB.open('openpane-personalization', 1);
      const database = await new Promise((resolve, reject) => { opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
      const tx = database.transaction('preferences', 'readwrite');
      tx.objectStore('preferences').put(document, 'current');
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
      database.close();
    };
    globalThis.until = async predicate => {
      const deadline = Date.now() + 6000;
      while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
    };
  });
  return page;
}

test('independent patches, CAS edits, immutable imports and atomic selected removal use real IndexedDB', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const one = new PersonalizationStorage(), two = new PersonalizationStorage();
    const initial = await one.readSnapshot();
    const edits = await Promise.all([one.patchPreferences({ kind: 'appearance', appearance: 'dark' }), two.patchPreferences({ kind: 'namespace-enabled', namespace: 'sample', enabled: false })]);
    const merged = await one.readSnapshot();
    const stale = await one.replacePreferences({ expectedEpoch: initial.preferences.epoch, expectedRevision: initial.preferences.revision, document: defaultDesktopPreferences });
    const imported = await one.importPalette(JSON.stringify(starterPalette()));
    const resource = imported.snapshot.palettes[0];
    const selected = await one.selectPalette(resource.digest);
    const removal = await Promise.all([one.selectPalette(resource.digest), two.removePalette(resource.digest)]);
    const final = await one.readSnapshot();
    one.close(); two.close();
    return { edits: edits.map(value => value.kind), merged, stale, selected, removal: removal.map(value => value.kind), final };
  });
  assert.deepEqual(result.edits, ['committed', 'committed']);
  assert.equal(result.merged.preferences.document.appearance, 'dark');
  assert.deepEqual(result.merged.preferences.document.ui.disabledNamespaces, ['sample']);
  assert.equal(result.stale.kind, 'refused');
  assert.equal(result.selected.snapshot.preferences.document.palette.kind, 'imported');
  assert.deepEqual(result.final.preferences.document.palette, { kind: 'builtin' });
  assert.equal(result.final.preferences.document.appearance, 'dark');
  assert.deepEqual(result.final.palettes, []);
});

test('palette capacity permits identical import, corrupt rows require explicit repair, capability failure is honest', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const owner = new PersonalizationStorage();
    const original = starterPalette();
    for (let index = 0; index < 64; index++) await owner.importPalette(JSON.stringify({ ...original, label: `Palette ${index}` }));
    const duplicate = await owner.importPalette(JSON.stringify({ ...original, label: 'Palette 0' }));
    const excess = await owner.importPalette(JSON.stringify({ ...original, label: 'Another palette' }));
    const digest = duplicate.snapshot.palettes[0].digest;
    const open = indexedDB.open('openpane-personalization', 1), db = await new Promise(resolve => { open.onsuccess = () => resolve(open.result); });
    const tx = db.transaction('palettes', 'readwrite'); tx.objectStore('palettes').put('damaged', digest);
    await new Promise(resolve => { tx.oncomplete = resolve; }); db.close();
    const corrupted = await owner.readSnapshot();
    const selection = await owner.selectPalette(digest);
    const reimport = await owner.importPalette(duplicate.snapshot.palettes.find(row => row.digest === digest).text);
    await owner.removePalette(digest);
    const repaired = await owner.importPalette(duplicate.snapshot.palettes.find(row => row.digest === digest).text);
    const subtle = crypto.subtle;
    Object.defineProperty(crypto, 'subtle', { value: undefined, configurable: true });
    const incapable = await owner.readSnapshot();
    const refused = await owner.importPalette(JSON.stringify(original));
    Object.defineProperty(crypto, 'subtle', { value: subtle, configurable: true });
    owner.close();
    return { duplicate: duplicate.kind, excess, corrupted: corrupted.palettes.find(row => row.digest === digest), selection, reimport, repaired: repaired.kind, incapable: incapable.palettes[0], refused };
  });
  assert.equal(result.duplicate, 'committed');
  assert.equal(result.excess.kind, 'refused');
  assert.equal(result.corrupted.kind, 'unavailable');
  assert.equal(result.selection.kind, 'refused');
  assert.match(result.reimport.diagnostic, /Remove/);
  assert.equal(result.repaired, 'committed');
  assert.match(result.incapable.diagnostic, /verification is unavailable/);
  assert.match(result.refused.diagnostic, /verification is unavailable/);
});

test('abort leaves committed data intact and failed session recovery survives focus and invalidation', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const session = new PersonalizationSession(); session.start();
    await until(() => session.getSnapshot().readiness === 'ready');
    await session.patchPreferences({ kind: 'appearance', appearance: 'dark' });
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function() { this.transaction.abort(); throw new DOMException('quota', 'QuotaExceededError'); };
    const failed = await session.resetAppearance();
    const failedView = await session.restoreDefaultView();
    IDBObjectStore.prototype.put = originalPut;
    const another = new PersonalizationStorage();
    await another.patchPreferences({ kind: 'appearance', appearance: 'light' });
    dispatchEvent(new Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 30));
    const recovered = session.getSnapshot();
    const saved = await another.readSnapshot();
    session.close(); another.close();
    return { failed, failedView, recovered, saved };
  });
  assert.equal(result.failed.kind, 'unavailable');
  assert.equal(result.failedView.kind, 'unavailable');
  assert.equal(result.recovered.document.appearance, 'system');
  assert.equal(result.recovered.document.ui.enabled, false);
  assert.deepEqual(result.recovered.recovery, { appearance: 'session', view: 'session' });
  assert.equal(result.saved.preferences.document.appearance, 'light');
  assert.equal(result.saved.preferences.document.ui.enabled, true);
});

test('malformed supported records repair only explicitly; future records remain byte-for-byte intact', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const owner = new PersonalizationStorage();
    const imported = await owner.importPalette(JSON.stringify(starterPalette()));
    const resource = imported.snapshot.palettes[0];
    await writeRaw({ broken: true });
    const broken = await owner.readSnapshot();
    const patch = await owner.patchPreferences({ kind: 'appearance', appearance: 'dark' });
    const remove = await owner.removePalette(resource.digest);
    const reset = await owner.resetPersonalization();
    const repaired = await owner.readSnapshot();
    const future = { storageVersion: 1, revision: 17, document: { ...defaultDesktopPreferences, version: 2 } };
    await writeRaw(future);
    const unavailable = await owner.readSnapshot();
    const futureReset = await owner.resetPersonalization();
    const dbRequest = indexedDB.open('openpane-personalization', 1), db = await new Promise(resolve => { dbRequest.onsuccess = () => resolve(dbRequest.result); });
    const request = db.transaction('preferences').objectStore('preferences').get('current');
    const retained = await new Promise(resolve => { request.onsuccess = () => resolve(request.result); }); db.close();
    owner.close();
    return { broken, patch, remove: remove.kind, reset: reset.kind, repaired, unavailable, futureReset, retained, future };
  });
  assert.equal(result.broken.preferences.kind, 'invalid');
  assert.equal(result.broken.preferences.revision, null);
  assert.equal(result.patch.kind, 'refused');
  assert.equal(result.remove, 'committed');
  assert.equal(result.reset, 'committed');
  assert.equal(result.repaired.preferences.document.ui.enabled, false);
  assert.equal(result.repaired.preferences.revision, 0);
  assert.equal(result.unavailable.preferences.kind, 'unavailable');
  assert.equal(result.futureReset.kind, 'refused');
  assert.deepEqual(result.retained, result.future);
});

test('late digest validation cannot publish over a newer committed snapshot', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const owner = new PersonalizationStorage();
    await owner.importPalette(JSON.stringify(starterPalette()));
    owner.setBlocked(true);
    const real = crypto.subtle.digest.bind(crypto.subtle);
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    let first = true;
    crypto.subtle.digest = async (...args) => { if (first) { first = false; started(); await new Promise(resolve => { release = resolve; }); } return real(...args); };
    const observed = [];
    owner.subscribe(snapshot => observed.push(snapshot.preferences.kind === 'valid' ? snapshot.preferences.document.appearance : 'invalid'));
    const old = owner.readSnapshot();
    await entered;
    await owner.patchPreferences({ kind: 'appearance', appearance: 'dark' });
    release(); await old;
    crypto.subtle.digest = real;
    owner.close();
    return observed;
  });
  assert.deepEqual(result, ['dark']);
});

test('startup timeout blocks admission and discards the initial completion until explicit retry', { timeout: 15_000 }, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const seed = new PersonalizationStorage(); await seed.importPalette(JSON.stringify(starterPalette())); seed.close();
    const real = crypto.subtle.digest.bind(crypto.subtle);
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    let first = true;
    crypto.subtle.digest = async (...args) => { if (first) { first = false; started(); await new Promise(resolve => { release = resolve; }); } return real(...args); };
    const session = new PersonalizationSession(); session.start(); await entered;
    await until(() => session.getSnapshot().readiness === 'blocked');
    const blocked = session.getSnapshot();
    await session.resetAppearance();
    const partial = session.getSnapshot();
    release(); await new Promise(resolve => setTimeout(resolve, 30));
    const late = session.getSnapshot();
    await session.retry();
    const resumed = session.getSnapshot();
    session.close(); crypto.subtle.digest = real;
    return { blocked, partial, late, resumed };
  });
  for (const key of ['blocked', 'partial', 'late']) {
    assert.equal(result[key].readiness, 'blocked');
    assert.equal(result[key].document.ui.enabled, false);
    assert.equal(result[key].document.appearance, 'system');
  }
  assert.equal(result.resumed.readiness, 'ready');
  assert.equal(result.resumed.document.ui.enabled, true);
});

test('future database version is unavailable without downgrade', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const opening = indexedDB.open('openpane-personalization', 2);
    opening.onupgradeneeded = () => { opening.result.createObjectStore('future'); };
    const db = await new Promise(resolve => { opening.onsuccess = () => resolve(opening.result); }); db.close();
    const owner = new PersonalizationStorage();
    const snapshot = await owner.readSnapshot(); const reset = await owner.resetPersonalization(); owner.close();
    const check = indexedDB.open('openpane-personalization'), current = await new Promise(resolve => { check.onsuccess = () => resolve(check.result); });
    const version = current.version; current.close();
    return { snapshot, reset, version };
  });
  assert.equal(result.snapshot.preferences.kind, 'unavailable');
  assert.match(result.snapshot.preferences.diagnostic, /newer version/);
  assert.equal(result.reset.kind, 'unavailable');
  assert.equal(result.version, 2);
});

test('two pages preserve concurrent fields; reload persists choices and another origin starts independently', async t => {
  const page = await fixture(t);
  const second = await page.context().newPage();
  await second.goto('http://127.0.0.1/another');
  await second.addScriptTag({ content: (await bundle).outputFiles[0].text });
  await page.evaluate(() => { globalThis.owner = new PersonalizationStorage(); });
  await second.evaluate(() => { globalThis.owner = new PersonalizationStorage(); });
  const writes = await Promise.all([
    page.evaluate(() => owner.patchPreferences({ kind: 'appearance', appearance: 'dark' })),
    second.evaluate(() => owner.patchPreferences({ kind: 'ui-enabled', enabled: false })),
  ]);
  assert.ok(writes.every(write => write.kind === 'committed'));
  await page.evaluate(() => owner.close());
  await page.reload();
  await page.addScriptTag({ content: (await bundle).outputFiles[0].text });
  const saved = await page.evaluate(async () => { const owner = new PersonalizationStorage(); const snapshot = await owner.readSnapshot(); owner.close(); return snapshot; });
  assert.equal(saved.preferences.document.appearance, 'dark');
  assert.equal(saved.preferences.document.ui.enabled, false);
  await second.evaluate(() => owner.close());
  await second.goto('http://127.0.0.1:9123/storage');
  await second.addScriptTag({ content: (await bundle).outputFiles[0].text });
  const independent = await second.evaluate(async () => { const owner = new PersonalizationStorage(); const snapshot = await owner.readSnapshot(); owner.close(); return snapshot; });
  assert.equal(independent.preferences.document.appearance, 'system');
  assert.equal(independent.preferences.document.ui.enabled, true);
});

test('valid envelope revision permits CAS repair while stale unreadable-envelope reset cannot overwrite a repair', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const owner = new PersonalizationStorage(); await owner.readSnapshot();
    await writeRaw({ storageVersion: 1, revision: 9, document: { version: 1 } });
    const broken = await owner.readSnapshot();
    const replaced = await owner.replacePreferences({ expectedEpoch: broken.preferences.epoch, expectedRevision: broken.preferences.revision, document: defaultDesktopPreferences });
    await writeRaw({ noVersion: true }); await owner.readSnapshot();
    await writeRaw({ storageVersion: 1, revision: 20, document: { ...defaultDesktopPreferences, appearance: 'dark' } });
    const staleReset = await owner.resetPersonalization();
    const saved = await owner.readSnapshot(); owner.close();
    return { replaced, staleReset, saved };
  });
  assert.equal(result.replaced.kind, 'committed');
  assert.equal(result.replaced.snapshot.preferences.revision, 10);
  assert.equal(result.staleReset.kind, 'refused');
  assert.equal(result.saved.preferences.revision, 20);
  assert.equal(result.saved.preferences.document.appearance, 'dark');
});

test('full reset keeps palettes and stays UI-off; oversized text is refused before parsing', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const session = new PersonalizationSession(); session.start(); await until(() => session.getSnapshot().readiness === 'ready');
    await session.importPalette(JSON.stringify(starterPalette()));
    const large = await session.importPalette(' '.repeat(65537));
    const reset = await session.resetPersonalization();
    const snapshot = session.getSnapshot(); session.close();
    return { large, reset, snapshot };
  });
  assert.equal(result.large.kind, 'refused');
  assert.match(result.large.diagnostic, /64 KiB/);
  assert.equal(result.reset.kind, 'committed');
  assert.equal(result.snapshot.readiness, 'ready');
  assert.equal(result.snapshot.document.ui.enabled, false);
  assert.equal(result.snapshot.saved.palettes.length, 1);
});

test('a pending palette selection cannot undo a later saved appearance recovery', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const session = new PersonalizationSession(); session.start(); await until(() => session.getSnapshot().readiness === 'ready');
    await session.importPalette(JSON.stringify(starterPalette()));
    const digest = session.getSnapshot().saved.palettes[0].digest;
    const real = crypto.subtle.digest.bind(crypto.subtle);
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; }); let first = true;
    crypto.subtle.digest = async (...args) => { if (first) { first = false; entered(); await new Promise(resolve => { release = resolve; }); } return real(...args); };
    const selecting = session.selectPalette(digest); await started;
    await session.resetAppearance(); const recovered = session.getSnapshot();
    release(); const selection = await selecting;
    const saved = await session.storage.readSnapshot(), effective = session.getSnapshot();
    crypto.subtle.digest = real; session.close();
    return { recovered, selection, saved, effective };
  });
  assert.equal(result.recovered.recovery.appearance, 'saved');
  assert.equal(result.saved.preferences.document.palette.kind, 'builtin');
  assert.equal(result.effective.document.palette.kind, 'builtin');
  assert.equal(result.selection.kind, 'refused');
});

for (const scope of ['appearance', 'view']) test(`${scope} recovery confirms its durable revision after a newer equivalent focus read`, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async scope => {
    const session = new PersonalizationSession(); session.start(); await until(() => session.getSnapshot().readiness === 'ready');
    await session.importPalette(JSON.stringify(starterPalette()));
    await session.patchPreferences({ kind: 'appearance', appearance: 'dark' });
    const real = crypto.subtle.digest.bind(crypto.subtle);
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; }); let first = true;
    crypto.subtle.digest = async (...args) => { if (first) { first = false; entered(); await new Promise(resolve => { release = resolve; }); } return real(...args); };
    const recovering = scope === 'appearance' ? session.resetAppearance() : session.restoreDefaultView(); await started;
    dispatchEvent(new Event('focus'));
    await until(() => session.getSnapshot().saved.preferences.document.appearance === (scope === 'appearance' ? 'system' : 'dark') && (scope === 'appearance' || !session.getSnapshot().saved.preferences.document.ui.enabled));
    release(); await recovering;
    const recovered = session.getSnapshot();
    await session.patchPreferences({ kind: 'appearance', appearance: 'light' });
    const changed = session.getSnapshot();
    crypto.subtle.digest = real; session.close();
    return { recovered, changed };
  }, scope);
  assert.equal(result.recovered.recovery[scope], 'saved');
  assert.doesNotMatch(result.recovered.diagnostic ?? '', /Could not save/);
  assert.equal(result.changed.document.appearance, 'light');
});

test('malformed palette keys are removed by exact key without harming a valid selected sibling', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const owner = new PersonalizationStorage(); const imported = await owner.importPalette(JSON.stringify(starterPalette()));
    const digest = imported.snapshot.palettes[0].digest; await owner.selectPalette(digest);
    const opening = indexedDB.open('openpane-personalization', 1), db = await new Promise(resolve => { opening.onsuccess = () => resolve(opening.result); });
    const tx = db.transaction('palettes', 'readwrite'); tx.objectStore('palettes').put('array-key corruption', [digest]); tx.objectStore('palettes').put('empty-key corruption', '');
    await new Promise(resolve => { tx.oncomplete = resolve; });
    const corrupted = await owner.readSnapshot();
    for (const row of corrupted.palettes.filter(row => row.kind === 'unavailable')) await owner.removePalette(row.key ?? row.digest);
    const saved = await owner.readSnapshot();
    const read = db.transaction('palettes').objectStore('palettes').getAllKeys(), keys = await new Promise(resolve => { read.onsuccess = () => resolve(read.result); });
    db.close(); owner.close(); return { digest, saved, keys };
  });
  assert.deepEqual(result.keys, [result.digest]);
  assert.equal(result.saved.palettes[0].kind, 'ready');
  assert.equal(result.saved.preferences.document.palette.digest, result.digest);
});

for (const corruption of ['undefined-value', 'sparse-namespaces']) test(`startup preserves ${corruption} and blocks executable admission until explicit reset`, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async corruption => {
    const seed = new PersonalizationStorage(); await seed.readSnapshot(); seed.close();
    await writeRaw(corruption === 'undefined-value' ? undefined : { storageVersion: 1, revision: 8,
      document: { ...defaultDesktopPreferences, ui: { ...defaultDesktopPreferences.ui, disabledNamespaces: Array(1) } } });
    const session = new PersonalizationSession(); session.start(); await until(() => session.getSnapshot().readiness !== 'loading');
    const initial = session.getSnapshot();
    const opening = indexedDB.open('openpane-personalization', 1), db = await new Promise(resolve => { opening.onsuccess = () => resolve(opening.result); });
    const count = db.transaction('preferences').objectStore('preferences').count('current');
    const present = await new Promise(resolve => { count.onsuccess = () => resolve(count.result); }); db.close();
    const reset = await session.resetPersonalization(), recovered = session.getSnapshot(); session.close();
    return { initial, present, reset, recovered };
  }, corruption);
  assert.equal(result.initial.readiness, 'blocked');
  assert.equal(result.initial.document.ui.enabled, false);
  assert.equal(result.initial.saved.preferences.kind, 'invalid');
  assert.equal(result.present, 1);
  assert.equal(result.reset.kind, 'committed');
  assert.equal(result.recovered.readiness, 'ready');
  assert.equal(result.recovered.document.ui.enabled, false);
});

test('latest successful preference commit clears old errors without resuming failed recovery overrides', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const session = new PersonalizationSession(); session.start(); await until(() => session.getSnapshot().readiness === 'ready');
    const realPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function() { throw new DOMException('Injected quota failure', 'QuotaExceededError'); };
    await session.patchPreferences({ kind: 'appearance', appearance: 'dark' });
    const failed = session.getSnapshot();
    IDBObjectStore.prototype.put = realPut;
    await session.patchPreferences({ kind: 'appearance', appearance: 'light' }); const succeeded = session.getSnapshot();
    IDBObjectStore.prototype.put = function() { throw new DOMException('Injected quota failure', 'QuotaExceededError'); };
    await session.resetAppearance();
    IDBObjectStore.prototype.put = realPut;
    const outcome = await session.patchPreferences({ kind: 'appearance', appearance: 'dark' });
    const guarded = session.getSnapshot(); session.close();
    return { failed, succeeded, outcome, guarded };
  });
  assert.match(result.failed.diagnostic, /Could not save/);
  assert.equal(result.succeeded.diagnostic, null);
  assert.equal(result.guarded.document.appearance, 'system');
  assert.equal(result.guarded.saved.preferences.document.appearance, 'dark');
  assert.equal(result.guarded.recovery.appearance, 'session');
  assert.match(result.guarded.diagnostic, /saved.*recovery remains active/i);
  assert.match(result.outcome.diagnostic, /saved.*recovery remains active/i);
});

test('an older recovery completion does not overwrite the latest saved-choice diagnostic', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const session = new PersonalizationSession(); session.start(); await until(() => session.getSnapshot().readiness === 'ready');
    await session.importPalette(JSON.stringify(starterPalette()));
    const real = crypto.subtle.digest.bind(crypto.subtle);
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; }); let first = true;
    crypto.subtle.digest = async (...args) => { if (first) { first = false; entered(); await new Promise(resolve => { release = resolve; }); } return real(...args); };
    const recovering = session.resetAppearance(); await started;
    await session.patchPreferences({ kind: 'appearance', appearance: 'dark' });
    release(); await recovering;
    const snapshot = session.getSnapshot(); crypto.subtle.digest = real; session.close(); return snapshot;
  });
  assert.equal(result.recovery.appearance, 'session');
  assert.equal(result.document.appearance, 'system');
  assert.equal(result.saved.preferences.document.appearance, 'dark');
  assert.match(result.diagnostic, /saved.*recovery remains active/i);
  assert.doesNotMatch(result.diagnostic, /Could not save/);
});

test('unrelated executable enable does not clear a failed appearance recovery guard', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const session = new PersonalizationSession(); session.start(); await until(() => session.getSnapshot().readiness === 'ready');
    await session.patchPreferences({ kind: 'appearance', appearance: 'dark' });
    const realPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function() { throw new DOMException('Injected quota failure', 'QuotaExceededError'); };
    await session.resetAppearance(); IDBObjectStore.prototype.put = realPut;
    await session.patchPreferences({ kind: 'ui-enabled', enabled: true });
    const guarded = session.getSnapshot();
    await session.retry(); const resumed = session.getSnapshot(); session.close(); return { guarded, resumed };
  });
  assert.equal(result.guarded.recovery.appearance, 'session');
  assert.equal(result.guarded.document.appearance, 'system');
  assert.match(result.guarded.diagnostic, /saved.*recovery remains active/i);
  assert.equal(result.resumed.document.appearance, 'dark');
  assert.equal(result.resumed.recovery.appearance, 'none');
});

test('a refused stale edit still observes the other window disabling executable UI', async t => {
  const page = await fixture(t);
  const other = await page.context().newPage(); await other.goto('http://127.0.0.1/other');
  await other.addScriptTag({ content: (await bundle).outputFiles[0].text });
  await page.evaluate(async () => {
    globalThis.session = new PersonalizationSession(); session.start(); await until(() => session.getSnapshot().readiness === 'ready');
    await session.importPalette(JSON.stringify(starterPalette()));
    globalThis.base = session.getSnapshot().saved.preferences;
    const real = crypto.subtle.digest.bind(crypto.subtle); let first = true;
    globalThis.readStarted = new Promise(resolve => { globalThis.enterRead = resolve; });
    crypto.subtle.digest = async (...args) => { if (first) { first = false; enterRead(); await new Promise(resolve => { globalThis.releaseRead = resolve; }); } return real(...args); };
  });
  await other.evaluate(async () => { const owner = new PersonalizationStorage(); await owner.patchPreferences({ kind: 'ui-enabled', enabled: false }); owner.close(); });
  await page.evaluate(() => readStarted);
  const refused = await page.evaluate(() => session.replacePreferences({ expectedEpoch: base.epoch, expectedRevision: base.revision, document: defaultDesktopPreferences }));
  const observed = await page.evaluate(async () => { releaseRead(); await new Promise(resolve => setTimeout(resolve, 40)); const snapshot = session.getSnapshot(); session.close(); return snapshot; });
  assert.equal(refused.kind, 'refused');
  assert.equal(observed.document.ui.enabled, false);
});

test('unreadable-envelope repair restarts revision zero in a new CAS epoch', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const editorOwner = new PersonalizationStorage(), repairOwner = new PersonalizationStorage();
    const base = (await editorOwner.readSnapshot()).preferences;
    await writeRaw({ broken: 'unreadable revision' }); await repairOwner.readSnapshot();
    const repaired = await repairOwner.resetPersonalization();
    const stale = await editorOwner.replacePreferences({ expectedEpoch: base.epoch, expectedRevision: base.revision, document: defaultDesktopPreferences });
    const saved = await editorOwner.readSnapshot(); editorOwner.close(); repairOwner.close();
    return { base, repaired, stale, saved };
  });
  assert.equal(result.repaired.snapshot.preferences.revision, 0);
  assert.equal(result.stale.kind, 'refused');
  assert.notEqual(result.repaired.snapshot.preferences.epoch, result.base.epoch);
  assert.equal(result.saved.preferences.document.ui.enabled, false);
});

for (const metadata of [undefined, { version: 2, value: 0 }, { version: 1, value: '0' }]) test(`unsupported epoch metadata ${JSON.stringify(metadata)} stays preserved and unavailable`, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async metadata => {
    const owner = new PersonalizationStorage(); await owner.readSnapshot();
    const opening = indexedDB.open('openpane-personalization', 1), db = await new Promise(resolve => { opening.onsuccess = () => resolve(opening.result); });
    const tx = db.transaction('preferences', 'readwrite'); tx.objectStore('preferences').put(metadata, 'epoch');
    await new Promise(resolve => { tx.oncomplete = resolve; });
    const saved = await owner.readSnapshot(), reset = await owner.resetPersonalization();
    const read = db.transaction('preferences').objectStore('preferences').get('epoch'), retained = await new Promise(resolve => { read.onsuccess = () => resolve(read.result); });
    db.close(); owner.close(); return { saved, reset, retained };
  }, metadata);
  assert.equal(result.saved.preferences.kind, 'unavailable');
  assert.match(result.saved.preferences.diagnostic, /metadata.*preserved/);
  assert.equal(result.reset.kind, 'refused');
  assert.deepEqual(result.retained, metadata);
});

test('explicit saved Enable resumes failed view recovery while retaining an unrelated appearance guard', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const session = new PersonalizationSession(); session.start(); await until(() => session.getSnapshot().readiness === 'ready');
    await session.patchPreferences({ kind: 'appearance', appearance: 'dark' });
    await session.patchPreferences({ kind: 'slot', slot: 'transcript', selection: { kind: 'extension', namespace: 'example' } });
    await session.patchPreferences({ kind: 'namespace-enabled', namespace: 'other', enabled: false });
    const realPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function() { throw new DOMException('Injected quota failure', 'QuotaExceededError'); };
    await session.restoreDefaultView(); await session.resetAppearance();
    const failedEnable = await session.patchPreferences({ kind: 'ui-enabled', enabled: true });
    const guarded = session.getSnapshot();
    IDBObjectStore.prototype.put = realPut;
    const enabled = await session.patchPreferences({ kind: 'ui-enabled', enabled: true });
    const resumed = session.getSnapshot(); session.close();
    return { failedEnable, guarded, enabled, resumed };
  });
  assert.equal(result.failedEnable.kind, 'unavailable');
  assert.equal(result.guarded.document.ui.enabled, false);
  assert.equal(result.guarded.recovery.view, 'session');
  assert.equal(result.enabled.kind, 'committed');
  assert.equal(result.resumed.document.ui.enabled, true);
  assert.equal(result.resumed.recovery.view, 'none');
  assert.equal(result.resumed.recovery.appearance, 'session');
  assert.equal(result.resumed.document.appearance, 'system');
  assert.equal(result.resumed.saved.preferences.document.appearance, 'dark');
  assert.deepEqual(result.resumed.document.ui.disabledNamespaces, ['other']);
  assert.deepEqual(result.resumed.document.ui.slots.transcript, { kind: 'extension', namespace: 'example' });
});
