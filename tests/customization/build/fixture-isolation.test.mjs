import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('build repository fixtures preserve an inherited caller index', t => {
  const directory = mkdtempSync(join(tmpdir(), 'custom-fixture-index-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['init', '--template=', '--quiet', directory], { env });
  writeFileSync(join(directory, 'sentinel'), 'Caller-owned staged content');
  execFileSync('git', ['-C', directory, 'add', 'sentinel'], { env });
  const index = join(directory, '.git/index'), before = readFileSync(index);
  const source = `import { repository } from ${JSON.stringify(new URL('./support.mjs', import.meta.url).href)};
const fixture = repository(); console.log(JSON.stringify({ directory: fixture.directory })); console.log(fixture.commit());`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...env, GIT_INDEX_FILE: index }, encoding: 'utf8', timeout: 30000 });
  const first = result.stdout.split('\n')[0];
  if (first) { const fixture = JSON.parse(first); t.after(() => rmSync(fixture.directory, { recursive: true, force: true })); }
  assert.deepEqual(readFileSync(index), before, 'fixture Git commands cannot mutate the caller index');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.split('\n')[1], /^[a-f0-9]{40}$/);
});
