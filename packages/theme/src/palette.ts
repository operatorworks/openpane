import { palettes, type ThemeColors } from './color-tokens.js';

export const PALETTE_ROLES_V1 = ['canvas', 'surface', 'raised', 'text', 'muted', 'border', 'controlBorder', 'accent', 'onAccent', 'danger', 'onDanger', 'focus'] as const satisfies readonly (keyof ThemeColors)[];
type MissingRole = Exclude<keyof ThemeColors, typeof PALETTE_ROLES_V1[number]>;
const completeRoles: Record<MissingRole, never> = {};
void completeRoles;
export type PaletteColorsV1 = Readonly<Record<typeof PALETTE_ROLES_V1[number], string>>;
export type PaletteLogicalName = string & { readonly __brand: 'PaletteLogicalName' };
export interface PaletteDocumentV1 {
  readonly kind: 'openpane-palette'; readonly version: 1;
  readonly namespace: PaletteLogicalName; readonly name: PaletteLogicalName; readonly label: string;
  readonly colors: { readonly light: PaletteColorsV1; readonly dark: PaletteColorsV1 };
}
function record(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path}: expected an object.`);
  if (Object.keys(value).some(key => !keys.includes(key))) throw new TypeError(`${path}: unknown field.`);
  return value as Record<string, unknown>;
}
export function isPaletteLogicalName(value: unknown): value is PaletteLogicalName {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value);
}
function logicalName(value: unknown, path: string): PaletteLogicalName {
  if (!isPaletteLogicalName(value)) throw new TypeError(`${path}: expected a lowercase name of 1–32 letters, digits or hyphens, beginning with a letter.`);
  return value;
}
function colors(value: unknown, path: string): PaletteColorsV1 {
  const input = record(value, PALETTE_ROLES_V1, path);
  const color = (role: typeof PALETTE_ROLES_V1[number]) => {
    const value = input[role];
    if (typeof value !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(value)) throw new TypeError(`${path}.${role}: expected #RRGGBB.`);
    return value.toLowerCase();
  };
  return { canvas: color('canvas'), surface: color('surface'), raised: color('raised'), text: color('text'), muted: color('muted'), border: color('border'), controlBorder: color('controlBorder'), accent: color('accent'), onAccent: color('onAccent'), danger: color('danger'), onDanger: color('onDanger'), focus: color('focus') };
}
export function parsePaletteDocument(value: unknown): PaletteDocumentV1 {
  const input = record(value, ['kind', 'version', 'namespace', 'name', 'label', 'colors'], 'palette');
  if (input.kind !== 'openpane-palette') throw new TypeError('palette.kind: expected openpane-palette.');
  if (input.version !== 1) throw new TypeError('palette.version: unsupported version.');
  if (typeof input.label !== 'string') throw new TypeError('palette.label: expected text.');
  const label = input.label.normalize('NFC').trim();
  if (!label || [...label].length > 64) throw new TypeError('palette.label: expected 1–64 characters.');
  const maps = record(input.colors, ['light', 'dark'], 'palette.colors');
  return { kind: 'openpane-palette', version: 1, namespace: logicalName(input.namespace, 'palette.namespace'), name: logicalName(input.name, 'palette.name'), label,
    colors: { light: colors(maps.light, 'palette.colors.light'), dark: colors(maps.dark, 'palette.colors.dark') } };
}
export function canonicalPaletteText(document: PaletteDocumentV1): string {
  return JSON.stringify(parsePaletteDocument(document));
}
export function starterPalette(): PaletteDocumentV1 {
  return parsePaletteDocument({ kind: 'openpane-palette', version: 1, namespace: 'my-palette', name: 'starter', label: 'My palette', colors: palettes });
}
