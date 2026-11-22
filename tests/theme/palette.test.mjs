import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { parseExtensionManifest } from '@openpane/sdk';
import { canonicalPaletteText, parsePaletteDocument, starterPalette, PALETTE_ROLES_V1, palettes } from '@openpane/theme';

test('palette canonical identity ignores key order, hex case and label normalization', () => {
  const palette = starterPalette();
  const reordered = { colors: Object.fromEntries(Object.entries(palette.colors).reverse().map(([mode, colors]) => [mode, Object.fromEntries(Object.entries(colors).reverse().map(([role, value]) => [role, value.toUpperCase()]))])), label: '  Cafe\u0301  ', name: palette.name, namespace: palette.namespace, version: 1, kind: palette.kind };
  const normalized = { ...palette, label: 'Café' };
  const canonical = canonicalPaletteText(parsePaletteDocument(reordered));
  assert.equal(canonical, canonicalPaletteText(normalized));
  assert.equal(createHash('sha256').update(canonical).digest('hex'), createHash('sha256').update(canonicalPaletteText(normalized)).digest('hex'));
  assert.deepEqual(Object.keys(JSON.parse(canonical)), ['kind', 'version', 'namespace', 'name', 'label', 'colors']);
  assert.deepEqual(Object.keys(JSON.parse(canonical).colors.light), PALETTE_ROLES_V1);
  assert.deepEqual([...PALETTE_ROLES_V1].sort(), Object.keys(palettes.light).sort());
});

for (const [field, change, message] of [
  ['version', value => ({ ...value, version: 2 }), /palette.version/],
  ['unknown field', value => ({ ...value, script: 'alert(1)' }), /palette/],
  ['blank label', value => ({ ...value, label: '  ' }), /palette.label/],
  ['long label', value => ({ ...value, label: 'x'.repeat(65) }), /palette.label/],
  ['missing role', value => ({ ...value, colors: { ...value.colors, light: { ...value.colors.light, text: undefined } } }), /palette.colors.light.text/],
  ['unknown role', value => ({ ...value, colors: { ...value.colors, light: { ...value.colors.light, wallpaper: '#ffffff' } } }), /palette.colors.light/],
  ['CSS expression', value => ({ ...value, colors: { ...value.colors, dark: { ...value.colors.dark, text: 'url(https://example.com)' } } }), /palette.colors.dark.text/],
  ['short hex', value => ({ ...value, colors: { ...value.colors, dark: { ...value.colors.dark, text: '#fff' } } }), /palette.colors.dark.text/],
]) test(`palette rejects ${field}`, () => assert.throws(() => parsePaletteDocument(change(starterPalette())), message));

for (const namespace of ['a', 'example-123', 'a'.repeat(32), '', 'A', '-bad', 'bad_name', 'a'.repeat(33), 'white space', 'é', '__proto__']) {
  test(`palette and SDK agree on namespace ${JSON.stringify(namespace)}`, () => {
    const valid = parse => { try { parse(); return true; } catch { return false; } };
    const sdk = valid(() => parseExtensionManifest({ namespace, trust: 'full', sdkVersion: '0.13.0', entries: [{ kind: 'desktop', module: './index.js' }] }));
    assert.equal(valid(() => parsePaletteDocument({ ...starterPalette(), namespace })), sdk);
    assert.equal(valid(() => parsePaletteDocument({ ...starterPalette(), name: namespace })), sdk);
  });
}

test('palette JSON fields must be present rather than inherited', () => {
  assert.throws(() => parsePaletteDocument(Object.create(starterPalette())), /required field/);
});


test('V1 canonical UTF-8 bytes and digest match the independent identity vector', () => {
  const expectedText = '{"kind":"openpane-palette","version":1,"namespace":"example","name":"fixed","label":"Stable V1","colors":{"light":{"canvas":"#123456","surface":"#123456","raised":"#123456","text":"#123456","muted":"#123456","border":"#123456","controlBorder":"#123456","accent":"#123456","onAccent":"#123456","danger":"#123456","onDanger":"#123456","focus":"#123456"},"dark":{"canvas":"#abcdef","surface":"#abcdef","raised":"#abcdef","text":"#abcdef","muted":"#abcdef","border":"#abcdef","controlBorder":"#abcdef","accent":"#abcdef","onAccent":"#abcdef","danger":"#abcdef","onDanger":"#abcdef","focus":"#abcdef"}}}';
  const text = canonicalPaletteText(parsePaletteDocument(JSON.parse(expectedText)));
  assert.equal(text, expectedText);
  assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), 'f6401f8ce78bbd47f2fb3cacbed665ff9bcb94e502ac444503b604a5720a248b');
});
