import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { developmentPlan, previewHost, previewPort } from '../../../scripts/lib/customization-development-plan.mjs';
import { mergePlans } from '../../../scripts/lib/customization-plugin.mjs';
import { desktopConfig } from '../../../apps/desktop/vite.config.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'openpane-dev-plan-'));
  const source = join(directory, 'source');
  await cp(new URL('../../../templates/customization/', import.meta.url), source, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, source };
}
test('development selects real working files without Git identity and packaging refuses its plan', async t => {
  const f = await fixture(t), plan = await developmentPlan(f.source);
  assert.equal(plan.kind, 'development');
  assert.equal(plan.identity, null);
  assert.equal(plan.workingRoot, plan.roots[0]);
  assert.equal(plan.entries[0].manifest.namespace, 'personal');
  await writeFile(plan.entries[0].source, 'export default "uncommitted edit";');
  assert.equal(await readFile((await developmentPlan(f.source)).entries[0].source, 'utf8'), 'export default "uncommitted edit";');
  const merged = mergePlans({ entries: [], roots: ['/bundled'] }, plan);
  assert.deepEqual(merged.roots, ['/bundled', plan.workingRoot]);
  assert.equal(merged.workingRoot, plan.workingRoot);
  assert.throws(() => desktopConfig('browser', merged), /cannot be packaged/);
  const previewConfig = desktopConfig('browser', merged, { development: true });
  assert.equal(previewConfig.server.port, 1420);
  assert.equal(previewConfig.build.write, false);
  assert.match(previewConfig.build.rollupOptions.input, /customization-preview-main\.tsx$/);
  assert.equal(previewPort(plan.roots[0], 'http://127.0.0.1:7140'), previewPort(plan.roots[0], 'http://127.0.0.1:7140'));
  assert.throws(() => mergePlans(plan, plan), /both bundled and external/);
});
for (const [label, mutate] of [
  ['escaping source', metadata => { metadata.openpane.sources['./dist/desktop.js'] = '../outside.js'; }],
  ['external graph', metadata => { metadata.openpane.extensions = [{ repository: '/tmp/other', commit: 'a'.repeat(40) }]; }],
  ['wrong SDK', metadata => { metadata.openpane.extension.sdkVersion = '0.1.0'; }],
  ['no desktop', metadata => { metadata.openpane.extension.entries[0].kind = 'ios'; }],
  ['unknown metadata', metadata => { metadata.openpane.unknown = true; }],
]) test(`development rejects ${label}`, async t => {
  const f = await fixture(t), file = join(f.source, 'package.json'), metadata = JSON.parse(await readFile(file, 'utf8'));
  mutate(metadata); await writeFile(file, JSON.stringify(metadata));
  await assert.rejects(developmentPlan(f.source));
});
test('development rejects a source symlink outside its explicit root', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'outside.tsx'), 'export default {};');
  await rm(join(f.source, 'desktop/index.tsx'));
  await symlink(join(f.directory, 'outside.tsx'), join(f.source, 'desktop/index.tsx'));
  await assert.rejects(developmentPlan(f.source), /outside/);
});
for (const value of ['https://127.0.0.1:7140', 'http://localhost:7140', 'http://127.0.0.1', 'http://127.0.0.1:7140/path',
  'http://user@127.0.0.1:7140', 'http://127.0.0.1:7140/?query', 'http://127.0.0.1:7140/#hash', 'http://example.com:7140', 'http://2130706433:7140', 'http://127.0.0.1:0', 'http://127.0.0.1:99999', 'http://127.0.0.1:7140/./'])
  test(`host rejects ${value}`, () => assert.throws(() => previewHost(value), /loopback|127\.0\.0\.1/));
test('host accepts only the selected loopback origin', () => assert.equal(previewHost('http://127.0.0.1:7140'), 'http://127.0.0.1:7140'));
