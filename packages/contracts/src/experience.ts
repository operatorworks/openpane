import { boundedText, count, hex, identifier, record, utf8Bytes } from './decode.js';

export const EXPERIENCE_LIMITS = { manifestBytes: 65_536, stylesheetBytes: 131_072, assets: 16, assetBytes: 2_097_152, imageDimension: 2048 } as const;
export const EXPERIENCE_COLOR_ROLES = ['canvas', 'surface', 'raised', 'text', 'muted', 'border', 'controlBorder', 'accent', 'onAccent', 'danger', 'onDanger', 'focus'] as const;
export const EXPERIENCE_SPACE_ROLES = ['xs', 'sm', 'md', 'lg', 'xl', 'xxl'] as const;
export const EXPERIENCE_RADIUS_ROLES = ['control', 'panel'] as const;
export const EXPERIENCE_TEXT_ROLES = ['body', 'muted', 'label', 'title', 'code'] as const;
export const EXPERIENCE_CHART_ROLES = ['background', 'grid', 'axis', 'trace1', 'trace2', 'trace3', 'trace4', 'trace5', 'trace6', 'trace7', 'trace8'] as const;
export interface TextMetrics { readonly size: number; readonly lineHeight: number; readonly weight: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 }
export interface ExperienceTokens {
  readonly colors?: Readonly<Partial<Record<typeof EXPERIENCE_COLOR_ROLES[number], string>>>;
  readonly spacing?: Readonly<Partial<Record<typeof EXPERIENCE_SPACE_ROLES[number], number>>>;
  readonly radius?: Readonly<Partial<Record<typeof EXPERIENCE_RADIUS_ROLES[number], number>>>;
  readonly typography?: Readonly<Partial<Record<typeof EXPERIENCE_TEXT_ROLES[number], Partial<TextMetrics>>>>;
  readonly fonts?: { readonly body?: string; readonly code?: string };
  readonly treatments?: { readonly borderWidth?: number; readonly shadow?: 'none' | 'soft' | 'bevel' };
  readonly chart?: Readonly<Partial<Record<typeof EXPERIENCE_CHART_ROLES[number], string>>>;
}
export interface ExperienceV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly label: string;
  readonly theme: { readonly mode: 'system' | 'light' | 'dark'; readonly light: ExperienceTokens; readonly dark: ExperienceTokens };
  readonly presentation: {
    readonly navigation: 'rail' | 'pages'; readonly chats: 'inline' | 'separate';
    readonly chatWindow: { readonly width: number; readonly height: number; readonly titlebar: 'native' | 'integrated'; readonly title: 'agent' | 'conversation' | 'agent-and-conversation' };
  };
  readonly stylesheet: string | null;
  readonly assets: readonly { readonly name: string; readonly mimeType: 'text/css' | 'image/png'; readonly bytes: number; readonly sha256: string }[];
}
export interface ExperienceBundle {
  readonly manifest: ExperienceV1;
  readonly stylesheet: string | null;
  readonly assets: readonly { readonly name: string; readonly base64: string }[];
  readonly digest: string;
}
function choice<const T extends string>(value: unknown, choices: readonly T[]): T {
  const found = choices.find(candidate => candidate === value);
  if (found === undefined) throw new Error('Unsupported experience policy');
  return found;
}
function partial(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const input = record(value);
  if (Object.keys(input).some(key => !keys.includes(key))) throw new Error('Unknown experience token');
  return input;
}
function bounded(value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error('Invalid experience number');
  return value;
}
function mapTokens<K extends string, V>(value: unknown, keys: readonly K[], parse: (value: unknown) => V): Partial<Record<K, V>> {
  const input = partial(value, keys);
  const result: Partial<Record<K, V>> = {};
  for (const key of keys) if (Object.hasOwn(input, key)) result[key] = parse(input[key]);
  return result;
}
function color(value: unknown): string {
  if (typeof value !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(value)) throw new Error('Expected #RRGGBB experience color');
  return value;
}
const fontFamily = String.raw`(?:-*[a-zA-Z][a-zA-Z0-9-]*(?: +-*[a-zA-Z][a-zA-Z0-9-]*)*|"[a-zA-Z0-9 '-]*[a-zA-Z][a-zA-Z0-9 '-]*"|'[a-zA-Z0-9 "-]*[a-zA-Z][a-zA-Z0-9 "-]*')`;
export const LOCAL_FONT_STACK_PATTERN = `^ *${fontFamily}(?: *, *${fontFamily})* *$`;
const localFontStack = new RegExp(LOCAL_FONT_STACK_PATTERN);
function font(value: unknown): string {
  const text = identifier(value, 256);
  if (!localFontStack.test(text)) throw new Error('Expected a local font stack');
  return text;
}
function fontWeight(value: unknown): TextMetrics['weight'] {
  const weight = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
  const found = weight.find(weight => weight === value);
  if (found === undefined) throw new Error('Expected a font weight from 100 to 900 in hundreds');
  return found;
}
export function parseExperienceTokens(value: unknown): ExperienceTokens {
  const input = partial(value, ['colors', 'spacing', 'radius', 'typography', 'fonts', 'treatments', 'chart']);
  const result: ExperienceTokens = {
    ...(Object.hasOwn(input, 'colors') ? { colors: mapTokens(input.colors, EXPERIENCE_COLOR_ROLES, color) } : {}),
    ...(Object.hasOwn(input, 'spacing') ? { spacing: mapTokens(input.spacing, EXPERIENCE_SPACE_ROLES, value => bounded(value, 0, 64)) } : {}),
    ...(Object.hasOwn(input, 'radius') ? { radius: mapTokens(input.radius, EXPERIENCE_RADIUS_ROLES, value => bounded(value, 0, 32)) } : {}),
    ...(Object.hasOwn(input, 'chart') ? { chart: mapTokens(input.chart, EXPERIENCE_CHART_ROLES, color) } : {}),
    ...(Object.hasOwn(input, 'fonts') ? { fonts: mapTokens(input.fonts, ['body', 'code'], font) } : {}),
    ...(Object.hasOwn(input, 'typography') ? { typography: mapTokens(input.typography, EXPERIENCE_TEXT_ROLES, value => {
      const metrics = partial(value, ['size', 'lineHeight', 'weight']);
      return {
        ...(Object.hasOwn(metrics, 'size') ? { size: bounded(metrics.size, 10, 48) } : {}),
        ...(Object.hasOwn(metrics, 'lineHeight') ? { lineHeight: bounded(metrics.lineHeight, 1, 2) } : {}),
        ...(Object.hasOwn(metrics, 'weight') ? { weight: fontWeight(metrics.weight) } : {}),
      };
    }) } : {}),
    ...(Object.hasOwn(input, 'treatments') ? { treatments: (() => {
      const treatments = partial(input.treatments, ['borderWidth', 'shadow']);
      return {
        ...(Object.hasOwn(treatments, 'borderWidth') ? { borderWidth: bounded(treatments.borderWidth, 0, 4) } : {}),
        ...(Object.hasOwn(treatments, 'shadow') ? { shadow: choice(treatments.shadow, ['none', 'soft', 'bevel']) } : {}),
      };
    })() } : {}),
  };
  return result;
}
export function parseExperience(value: unknown): ExperienceV1 {
  const input = record(value, ['schemaVersion', 'id', 'label', 'theme', 'presentation', 'stylesheet', 'assets']);
  if (input.schemaVersion !== 1) throw new Error('Unsupported experience schema version');
  const id = identifier(input.id, 64);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Invalid experience id');
  const theme = record(input.theme, ['mode', 'light', 'dark']);
  const presentation = record(input.presentation, ['navigation', 'chats', 'chatWindow']);
  const window = record(presentation.chatWindow, ['width', 'height', 'titlebar', 'title']);
  if (!Array.isArray(input.assets) || input.assets.length > EXPERIENCE_LIMITS.assets + 1) throw new Error('Invalid experience asset inventory');
  const names = new Set<string>();
  let imageBytes = 0, images = 0;
  const assets = input.assets.map((value: unknown) => {
    const asset = record(value, ['name', 'mimeType', 'bytes', 'sha256']);
    const name = identifier(asset.name, 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || names.has(name)) throw new Error('Invalid or duplicate experience asset name');
    names.add(name);
    const mimeType = choice(asset.mimeType, ['text/css', 'image/png']);
    const bytes = count(asset.bytes);
    if (mimeType === 'image/png') { images++; imageBytes += bytes; }
    else if (bytes > EXPERIENCE_LIMITS.stylesheetBytes) throw new Error('Stylesheet exceeds byte limit');
    return { name, mimeType, bytes, sha256: hex(asset.sha256, 64) };
  });
  if (images > EXPERIENCE_LIMITS.assets || imageBytes > EXPERIENCE_LIMITS.assetBytes) throw new Error('Artwork exceeds limits');
  const stylesheet = input.stylesheet === null ? null : identifier(input.stylesheet, 128);
  const stylesheets = assets.filter(asset => asset.mimeType === 'text/css');
  if (stylesheets.length !== (stylesheet === null ? 0 : 1) || (stylesheet !== null && stylesheets[0]?.name !== stylesheet)) throw new Error('Stylesheet must match its sole declared CSS asset');
  const experience: ExperienceV1 = {
    schemaVersion: 1, id, label: boundedText(input.label, 200),
    theme: { mode: choice(theme.mode, ['system', 'light', 'dark']), light: parseExperienceTokens(theme.light), dark: parseExperienceTokens(theme.dark) },
    presentation: {
      navigation: choice(presentation.navigation, ['rail', 'pages']), chats: choice(presentation.chats, ['inline', 'separate']),
      chatWindow: { width: bounded(window.width, 360, 1600, true), height: bounded(window.height, 480, 1200, true),
        titlebar: choice(window.titlebar, ['native', 'integrated']), title: choice(window.title, ['agent', 'conversation', 'agent-and-conversation']) },
    }, stylesheet, assets,
  };
  if (utf8Bytes(JSON.stringify(experience)) > EXPERIENCE_LIMITS.manifestBytes) throw new Error('Manifest exceeds byte limit');
  return experience;
}
