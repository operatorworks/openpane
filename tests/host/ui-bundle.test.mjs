import { png } from './image-fixtures.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, symlink, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createExperienceBundle, parseExperienceBundle, readExperienceDirectory, scopeExperienceCss, sha256 } from '../../apps/host/build/tsc/experience-bundle.js';
const manifest = () => ({ schemaVersion: 1, id: 'test', label: 'Test experience', theme: { mode: 'system', light: {}, dark: {} }, presentation: {
  navigation: 'rail', chats: 'inline', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'conversation' } }, stylesheet: null, assets: [] });
function bundle(css = '[data-openpane-part="button"] { color: #123456; border: 1px outset #ffffff; }') {
  const value = manifest(); value.stylesheet = 'style.css'; value.assets.push({ name: 'style.css', mimeType: 'text/css', bytes: Buffer.byteLength(css), sha256: sha256(css) });
  return createExperienceBundle(value, css, []);
}
test('immutable bundles bind exact stylesheet and inventory bytes to their digest', () => {
  const value = bundle(); assert.deepEqual(parseExperienceBundle(value), value);
  assert.notEqual(bundle('[data-openpane-part="button"] { color: #654321; }').digest, value.digest);
  assert.throws(() => parseExperienceBundle({ ...value, digest: '0'.repeat(64) }), /digest/);
  assert.throws(() => parseExperienceBundle({ ...value, stylesheet: value.stylesheet + '\n' }), /bytes mismatch/);
  assert.throws(() => parseExperienceBundle({ ...value, assets: [{ name: 'undeclared.png', base64: '' }] }), /Undeclared/);
  assert.throws(() => parseExperienceBundle({ ...value, manifest: { ...value.manifest, executable: 'script.js' } }));
});
test('CSS AST scopes every selector and recursively scopes allowed at-rules', () => {
  const value = bundle('@media (prefers-color-scheme: dark) { @supports (color: #000000) { [data-openpane-part="button"]:hover, [data-openpane-part="header"] > [data-openpane-part="button"] { color: #abcdef; } } }');
  const scoped = scopeExperienceCss(value.stylesheet, value.digest, new Set());
  assert.equal((scoped.match(/data-openpane-experience/g) ?? []).length, 2);
  assert.ok(scoped.includes(value.digest));
  assert.doesNotThrow(() => bundle('[data-openpane-part="butto\\6e"] { color: #123456; }'));
  for (const css of ['body { color: #000000; }', '[data-openpane-part="button"] { position: fixed; }',
    '[data-openpane-part="button"] { display: none; }', '[data-openpane-part="button"] { opacity: 0; }',
    '[data-openpane-part="button"] { pointer-events: none; }', '[data-openpane-part="button"] { color: red !important; }',
    '[data-openpane-part="button"] { padding: 65px; }', '[data-openpane-part="button"] { font-size: 9px; }',
    '[data-openpane-part="button"] { background-image: url("https://example.com/a.png"); }',
    '@import "remote.css";', '@keyframes fade { to { color: #ffffff; } }', '@font-face { font-family: remote; src: url("font.woff"); }',
    '[data-openpane-part="header"] { & [data-openpane-part="button"] { color: #000000; } }',
    '[data-openpane-part="button"]:has(body) { color: #000000; }']) assert.throws(() => bundle(css), css);
});
test('directory ingestion copies immutable bytes and refuses escaping symlinks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'op-bundle-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source'); await mkdir(source);
  const value = bundle(); await writeFile(join(source, 'experience.json'), JSON.stringify(value.manifest));
  await writeFile(join(source, 'style.css'), value.stylesheet);
  assert.deepEqual(await readExperienceDirectory(source), value);
  await writeFile(join(source, 'style.css'), 'changed');
  assert.throws(() => parseExperienceBundle({ ...value, stylesheet: 'changed' }));
  assert.equal(value.stylesheet.includes('#123456'), true);
  await rm(join(source, 'style.css')); await writeFile(join(directory, 'outside.css'), value.stylesheet);
  await symlink(join(directory, 'outside.css'), join(source, 'style.css'));
  await assert.rejects(readExperienceDirectory(source), /escapes/);
});

test('artwork must fully decode before selection, including CRC and bounded decoded dimensions', () => {
  const artwork = bytes => {
    const value = manifest(); value.assets.push({ name: 'frame.png', mimeType: 'image/png', bytes: bytes.length, sha256: sha256(bytes) });
    return createExperienceBundle(value, null, [{ name: 'frame.png', base64: bytes.toString('base64') }]);
  };
  const valid = png(); assert.equal(artwork(valid).assets.length, 1);
  const corrupt = Buffer.from(valid); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => artwork(corrupt), /damaged|Invalid PNG/);
  assert.throws(() => artwork(valid.subarray(0, 33)), /damaged|Invalid PNG/);
  assert.throws(() => artwork(png({ width: 2049, height: 1 })), /dimensions/);
});

test('bundle identity preserves authored token bytes including hexadecimal color case', () => {
  const upper = manifest(); upper.theme.light = { colors: { accent: '#AABBCC' } };
  const lower = manifest(); lower.theme.light = { colors: { accent: '#aabbcc' } };
  const first = createExperienceBundle(upper, null, []), second = createExperienceBundle(lower, null, []);
  assert.equal(first.manifest.theme.light.colors.accent, '#AABBCC');
  assert.notEqual(first.digest, second.digest);
});
