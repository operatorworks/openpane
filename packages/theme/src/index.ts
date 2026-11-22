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
export interface ThemeOptions {
  readonly appearance?: Appearance | undefined;
  readonly reducedMotion?: boolean | undefined;
  readonly colors?: ThemeColorOverrides | undefined;
}
export interface Theme {
  readonly appearance: Appearance;
  readonly reducedMotion: boolean;
  readonly colors: ThemeColors;
  readonly spacing: typeof spacing;
  readonly radius: typeof radius;
  readonly typography: typeof typography;
  readonly motion: Readonly<{ quick: number; standard: number }>;
}
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
    appearance, reducedMotion,
    colors: { ...inheritedColors, ...overrides },
    spacing, radius, typography,
    motion: reducedMotion ? { quick: 0, standard: 0 } : motion,
  };
}
export const defaultTheme = createTheme();
