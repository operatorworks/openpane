import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDesktopPreferences, defaultDesktopPreferences, patchDesktopPreferences } from '../../apps/desktop/dist/application/personalization.js';

test('preferences round-trip missing resource/namespace references without losing choices', () => {
  const document = { ...defaultDesktopPreferences, appearance: 'dark', palette: { kind: 'imported', digest: 'a'.repeat(64) },
    ui: { enabled: false, disabledNamespaces: ['example'], slots: { transcript: { kind: 'extension', namespace: 'missing' }, activity: { kind: 'builtin' }, contentLayout: { kind: 'automatic' } } } };
  assert.deepEqual(parseDesktopPreferences(JSON.parse(JSON.stringify(document))), document);
  const patch = patchDesktopPreferences(document, { kind: 'appearance', appearance: 'light' });
  assert.deepEqual(patch.ui, document.ui);
  assert.deepEqual(document.appearance, 'dark');
});

for (const [label, modify, match] of [
  ['unknown version', d => ({ ...d, version: 2 }), /version/],
  ['unknown property', d => ({ ...d, token: 'secret' }), /unknown field/],
  ['invalid appearance', d => ({ ...d, appearance: 'sepia' }), /appearance/],
  ['uppercase digest', d => ({ ...d, palette: { kind: 'imported', digest: 'A'.repeat(64) } }), /digest/],
  ['unknown palette field', d => ({ ...d, palette: { kind: 'builtin', digest: 'a'.repeat(64) } }), /palette/],
  ['duplicate namespace', d => ({ ...d, ui: { ...d.ui, disabledNamespaces: ['test', 'test'] } }), /duplicate/],
  ['invalid namespace', d => ({ ...d, ui: { ...d.ui, disabledNamespaces: ['Not valid'] } }), /namespace/],
  ['missing slot', d => ({ ...d, ui: { ...d.ui, slots: { transcript: { kind: 'automatic' } } } }), /slots.activity/],
  ['unknown slot', d => ({ ...d, ui: { ...d.ui, slots: { ...d.ui.slots, foo: { kind: 'automatic' } } } }), /slots/],
  ['invalid slot selection', d => ({ ...d, ui: { ...d.ui, slots: { ...d.ui.slots, transcript: { kind: 'automatic', namespace: 'test' } } } }), /slots.transcript/],
]) test(`preferences reject ${label}`, () => assert.throws(() => parseDesktopPreferences(modify(defaultDesktopPreferences)), match));

test('preferences reject sparse namespace arrays rather than serializing invalid holes', () => {
  assert.throws(() => parseDesktopPreferences({ ...defaultDesktopPreferences,
    ui: { ...defaultDesktopPreferences.ui, disabledNamespaces: Array(1) } }), /namespace/);
});
