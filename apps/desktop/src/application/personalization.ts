import { EXTENSION_NAMESPACE_PATTERN } from '@openpane/contracts/service';

export type Namespace = string & { readonly __brand: 'Namespace' };
export type PaletteDigest = string & { readonly __brand: 'PaletteDigest' };
export type PaletteSelection = { readonly kind: 'builtin' } | { readonly kind: 'imported'; readonly digest: PaletteDigest };
export type SlotPreference = { readonly kind: 'automatic' } | { readonly kind: 'builtin' } | { readonly kind: 'extension'; readonly namespace: Namespace };
export type GlobalSlot = 'transcript' | 'activity' | 'contentLayout';
export interface DesktopPreferencesV1 {
  readonly version: 1; readonly appearance: 'system' | 'light' | 'dark'; readonly palette: PaletteSelection;
  readonly ui: { readonly enabled: boolean; readonly disabledNamespaces: readonly Namespace[]; readonly slots: Readonly<Record<GlobalSlot, SlotPreference>> };
}
export const defaultDesktopPreferences: DesktopPreferencesV1 = {
  version: 1, appearance: 'system', palette: { kind: 'builtin' },
  ui: { enabled: true, disabledNamespaces: [], slots: { transcript: { kind: 'automatic' }, activity: { kind: 'automatic' }, contentLayout: { kind: 'automatic' } } },
};
export const safeDesktopPreferences: DesktopPreferencesV1 = { ...defaultDesktopPreferences, ui: { ...defaultDesktopPreferences.ui, enabled: false } };
function record(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path}: expected an object.`);
  if (Object.keys(value).some(key => !keys.includes(key))) throw new TypeError(`${path}: unknown field.`);
  return value as Record<string, unknown>;
}
export function isNamespace(value: unknown): value is Namespace { return typeof value === 'string' && EXTENSION_NAMESPACE_PATTERN.test(value); }
export function parseNamespace(value: unknown): Namespace {
  if (!isNamespace(value)) throw new TypeError('preferences.ui: invalid namespace.');
  return value;
}
export function isPaletteDigest(value: unknown): value is PaletteDigest { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
export function parsePaletteDigest(value: unknown): PaletteDigest {
  if (!isPaletteDigest(value)) throw new TypeError('preferences.palette.digest: expected lowercase SHA-256.');
  return value;
}
function parseSlot(value: unknown, path: string): SlotPreference {
  const input = record(value, ['kind', 'namespace'], path);
  if ((input.kind === 'automatic' || input.kind === 'builtin') && Object.keys(input).length === 1) return { kind: input.kind };
  if (input.kind === 'extension' && Object.keys(input).length === 2) return { kind: 'extension', namespace: parseNamespace(input.namespace) };
  throw new TypeError(`${path}: expected automatic, builtin or extension selection.`);
}
export function parseDesktopPreferences(value: unknown): DesktopPreferencesV1 {
  const input = record(value, ['version', 'appearance', 'palette', 'ui'], 'preferences');
  if (input.version !== 1) throw new TypeError('preferences.version: unsupported version.');
  if (input.appearance !== 'system' && input.appearance !== 'light' && input.appearance !== 'dark') throw new TypeError('preferences.appearance: expected system, light or dark.');
  const selection = record(input.palette, ['kind', 'digest'], 'preferences.palette');
  let palette: PaletteSelection;
  if (selection.kind === 'builtin' && Object.keys(selection).length === 1) palette = { kind: 'builtin' };
  else if (selection.kind === 'imported' && Object.keys(selection).length === 2) palette = { kind: 'imported', digest: parsePaletteDigest(selection.digest) };
  else throw new TypeError('preferences.palette: invalid selection.');
  const ui = record(input.ui, ['enabled', 'disabledNamespaces', 'slots'], 'preferences.ui');
  if (typeof ui.enabled !== 'boolean') throw new TypeError('preferences.ui.enabled: expected a boolean.');
  if (!Array.isArray(ui.disabledNamespaces)) throw new TypeError('preferences.ui.disabledNamespaces: expected a list.');
  const disabledNamespaces = Array.from(ui.disabledNamespaces, parseNamespace);
  if (new Set(disabledNamespaces).size !== disabledNamespaces.length) throw new TypeError('preferences.ui.disabledNamespaces: duplicate namespace.');
  const slots = record(ui.slots, ['transcript', 'activity', 'contentLayout'], 'preferences.ui.slots');
  return { version: 1, appearance: input.appearance, palette, ui: { enabled: ui.enabled, disabledNamespaces,
    slots: { transcript: parseSlot(slots.transcript, 'preferences.ui.slots.transcript'), activity: parseSlot(slots.activity, 'preferences.ui.slots.activity'), contentLayout: parseSlot(slots.contentLayout, 'preferences.ui.slots.contentLayout') } } };
}
export type PreferencePatch =
  | { readonly kind: 'appearance'; readonly appearance: DesktopPreferencesV1['appearance'] }
  | { readonly kind: 'ui-enabled'; readonly enabled: boolean }
  | { readonly kind: 'namespace-enabled'; readonly namespace: string; readonly enabled: boolean }
  | { readonly kind: 'slot'; readonly slot: GlobalSlot; readonly selection: SlotPreference };
export function patchDesktopPreferences(document: DesktopPreferencesV1, patch: PreferencePatch): DesktopPreferencesV1 {
  switch (patch.kind) {
    case 'appearance': return { ...document, appearance: patch.appearance };
    case 'ui-enabled': return { ...document, ui: { ...document.ui, enabled: patch.enabled } };
    case 'namespace-enabled': {
      const namespace = parseNamespace(patch.namespace);
      return { ...document, ui: { ...document.ui, disabledNamespaces: patch.enabled ? document.ui.disabledNamespaces.filter(value => value !== namespace) : [...new Set([...document.ui.disabledNamespaces, namespace])] } };
    }
    case 'slot': return { ...document, ui: { ...document.ui, slots: { ...document.ui.slots, [patch.slot]: patch.selection } } };
  }
}
