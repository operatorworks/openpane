import type { ExperienceTokens, ExperienceDensity, TextMetrics } from '@openpane/contracts';
import { palettes, type Appearance, type ThemeColors } from './color-tokens.js';
export { palettes, type Appearance, type ThemeColors } from './color-tokens.js';
export * from './palette.js';
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { control: 8, panel: 12 } as const;
export const typography = {
  body: { size: 16, lineHeight: 1.6, weight: 400 },
  muted: { size: 14, lineHeight: 1.6, weight: 400 },
  label: { size: 14, lineHeight: 1.5, weight: 600 },
  title: { size: 24, lineHeight: 1.3, weight: 600 },
  code: { size: 14, lineHeight: 1.6, weight: 400 },
} as const;
export type TextVariant = keyof typeof typography;
export const buttonTones = {
  primary: { background: 'accent', foreground: 'onAccent', border: 'accent' },
  secondary: { background: 'raised', foreground: 'text', border: 'controlBorder' },
  danger: { background: 'danger', foreground: 'onDanger', border: 'danger' },
} as const satisfies Record<string, Record<'background' | 'foreground' | 'border', keyof ThemeColors>>;
export type ButtonTone = keyof typeof buttonTones;
export const textVariantColor = {
  body: 'text', muted: 'muted', label: 'text', title: 'text', code: 'text',
} as const satisfies Record<TextVariant, keyof ThemeColors>;
export const control = { minTarget: 44, disabledOpacity: 0.6 } as const;
export const motion = { quick: 120, standard: 180 } as const;
export type ThemeColorOverrides = Readonly<Partial<Record<keyof ThemeColors, string | undefined>>>;
type OptionalExperienceTokens = { readonly [K in keyof ExperienceTokens]?: ExperienceTokens[K] | undefined };
export interface ThemeOptions extends Omit<OptionalExperienceTokens, 'colors'> {
  readonly density?: ExperienceDensity | undefined;
  readonly appearance?: Appearance | undefined;
  readonly reducedMotion?: boolean | undefined;
  readonly colors?: ThemeColorOverrides | undefined;
}
export interface Theme {
  readonly density: ExperienceDensity;
  readonly appearance: Appearance;
  readonly reducedMotion: boolean;
  readonly colors: ThemeColors;
  readonly spacing: Readonly<Record<keyof typeof spacing, number>>;
  readonly radius: Readonly<Record<keyof typeof radius, number>>;
  readonly typography: Readonly<Record<TextVariant, TextMetrics>>;
  readonly fonts: Readonly<{ body: string; code: string }>;
  readonly treatments: Readonly<{ borderWidth: number; shadow: 'none' | 'soft' | 'bevel' }>;
  readonly chart: Readonly<Record<'background' | 'grid' | 'axis' | 'trace1' | 'trace2' | 'trace3' | 'trace4' | 'trace5' | 'trace6' | 'trace7' | 'trace8', string>>;
  readonly motion: Readonly<{ quick: number; standard: number }>;
}
const chartTraces = {
  light: { trace1: '#3158b5', trace2: '#a5324e', trace3: '#16816b', trace4: '#8458a8', trace5: '#a85d15', trace6: '#59751d', trace7: '#8d4c79', trace8: '#347e9b' },
  dark: { trace1: '#94b6ff', trace2: '#ff9fae', trace3: '#83d5b3', trace4: '#d7b2ff', trace5: '#ffc17d', trace6: '#c4d98a', trace7: '#edaddc', trace8: '#8dd8ef' },
} as const;
export function createTheme(options: ThemeOptions = {}, parent?: Theme): Theme {
  const appearance = options.appearance ?? parent?.appearance ?? 'light';
  if (appearance !== 'light' && appearance !== 'dark') {
    throw new TypeError(`Unknown appearance ${String(appearance)}; omit it to inherit the parent or system.`);
  }
  const reducedMotion = (parent?.reducedMotion ?? false) || (options.reducedMotion ?? false);
  const inheritedColors = parent?.appearance === appearance ? parent.colors : palettes[appearance];
  const overrides = Object.fromEntries<string>(Object.entries(options.colors ?? {}).filter(
    (entry): entry is [string, string] => Object.hasOwn(inheritedColors, entry[0]) && typeof entry[1] === 'string' && entry[1].trim() !== '',
  ));
  return {
    appearance, reducedMotion, density: options.density ?? parent?.density ?? 'comfortable',
    colors: { ...inheritedColors, ...overrides },
    spacing: { ...(parent?.spacing ?? spacing), ...options.spacing }, radius: { ...(parent?.radius ?? radius), ...options.radius },
    typography: {
      body: { ...(parent?.typography.body ?? typography.body), ...options.typography?.body },
      muted: { ...(parent?.typography.muted ?? typography.muted), ...options.typography?.muted },
      label: { ...(parent?.typography.label ?? typography.label), ...options.typography?.label },
      title: { ...(parent?.typography.title ?? typography.title), ...options.typography?.title },
      code: { ...(parent?.typography.code ?? typography.code), ...options.typography?.code },
    },
    fonts: { ...(parent?.fonts ?? { body: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', code: 'ui-monospace, "SF Mono", Consolas, monospace' }), ...options.fonts },
    treatments: { ...(parent?.treatments ?? { borderWidth: 1, shadow: 'none' }), ...options.treatments },
    chart: { ...(parent?.appearance === appearance ? parent.chart : {
      background: palettes[appearance].surface, grid: palettes[appearance].border, axis: palettes[appearance].muted,
      ...chartTraces[appearance],
    }), ...options.chart },
    motion: reducedMotion ? { quick: 0, standard: 0 } : motion,
  };
}
export const defaultTheme = createTheme();
