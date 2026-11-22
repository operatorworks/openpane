import { useCallback, useId, useSyncExternalStore, type HTMLAttributes, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react';
import { buttonTones, textVariantColor, control, type ButtonTone, type TextVariant, type Theme, type Appearance, type ThemeColors } from '@openpane/theme';
import { ThemeProvider, useProvidedTheme, useTheme, type ThemeProviderProps } from '@openpane/theme/react';

function colorVariable(role: string): `--aui-color-${string}` {
  return `--aui-color-${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}
function buttonCssVariables(tone: ButtonTone) {
  const roles = buttonTones[tone];
  return {
    '--aui-button-bg': `var(${colorVariable(roles.background)})`,
    '--aui-button-fg': `var(${colorVariable(roles.foreground)})`,
    '--aui-button-border': `var(${colorVariable(roles.border)})`,
  };
}

export function toCssVariables(theme: Theme): Record<`--aui-${string}`, string> {
  const variables: Record<`--aui-${string}`, string> = {};
  for (const [key, value] of Object.entries(theme.colors)) variables[colorVariable(key)] = value;
  for (const [key, value] of Object.entries(theme.spacing)) variables[`--aui-space-${key}`] = `${value / 16}rem`;
  for (const [key, value] of Object.entries(theme.radius)) variables[`--aui-radius-${key}`] = `${value / 16}rem`;
  for (const [key, value] of Object.entries(theme.typography)) {
    variables[`--aui-font-size-${key}`] = `${value.size / 16}rem`;
    variables[`--aui-leading-${key}`] = String(value.lineHeight);
    variables[`--aui-weight-${key}`] = String(value.weight);
  }
  for (const [variant, role] of Object.entries(textVariantColor)) variables[`--aui-text-color-${variant}`] = theme.colors[role];
  for (const [key, value] of Object.entries(theme.motion)) variables[`--aui-motion-${key}`] = `${value}ms`;
  variables['--aui-control-min-target'] = `${control.minTarget}px`;
  variables['--aui-control-scaled-target'] = `${control.minTarget / 16}rem`;
  variables['--aui-disabled-opacity'] = String(control.disabledOpacity);
  Object.assign(variables, buttonCssVariables('primary'));
  return variables;
}
function useMediaQuery(query: string, enabled: boolean): boolean {
  const subscribe = useCallback((notify: () => void) => {
    if (!enabled) return () => {};
    const list = window.matchMedia(query);
    list.addEventListener('change', notify);
    return () => list.removeEventListener('change', notify);
  }, [query, enabled]);
  return useSyncExternalStore(subscribe, () => enabled && window.matchMedia(query).matches, () => false);
}
export type ThemeScopeProps = Omit<ThemeProviderProps, 'colors'> & Omit<HTMLAttributes<HTMLDivElement>, 'color' | 'children'> & (
  | { readonly colors?: ThemeProviderProps['colors']; readonly palette?: never }
  | { readonly colors?: never; readonly palette: Readonly<Record<Appearance, ThemeColors>> }
);
export function ThemeScope({ appearance, reducedMotion, colors, palette, children, ...props }: ThemeScopeProps) {
  const parent = useProvidedTheme();
  const isRoot = parent === undefined;
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)', isRoot);
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)', isRoot);
  const resolved = appearance ?? parent?.appearance ?? (prefersDark ? 'dark' : 'light');
  return <ThemeProvider colors={palette ? palette[resolved] : colors} appearance={resolved}
    reducedMotion={reducedMotion ?? (isRoot ? prefersReducedMotion : undefined)}>
    <ThemeSurface {...props}>{children}</ThemeSurface>
  </ThemeProvider>;
}
function ThemeSurface({ children, style, className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  const theme = useTheme();
  return <div {...props} className={`aui-theme ${className}`} data-appearance={theme.appearance}
    data-reduced-motion={theme.reducedMotion} style={{ ...toCssVariables(theme), ...style }}>{children}</div>;
}
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { readonly tone?: ButtonTone }
export function Button({ tone = 'primary', className = '', type = 'button', style, ...props }: ButtonProps) {
  return <button {...props} type={type} style={{ ...buttonCssVariables(tone), ...style }} className={`aui-button ${className}`} data-tone={tone} />;
}
export interface TextProps extends HTMLAttributes<HTMLElement> {
  readonly variant?: TextVariant;
  readonly as?: 'p' | 'span' | 'h1' | 'h2' | 'h3' | 'code';
}
export function Text({ variant = 'body', as: Tag = 'p', className = '', ...props }: TextProps) {
  return <Tag {...props} className={`aui-text ${className}`} data-variant={variant} />;
}
export type SurfaceProps = HTMLAttributes<HTMLDivElement>;
export function Surface({ className = '', ...props }: SurfaceProps) {
  return <div {...props} className={`aui-surface ${className}`} />;
}
export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> { readonly label: string }
export function TextField({ label, id, className = '', ...props }: TextFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return <label className="aui-field" htmlFor={inputId}>
    <span className="aui-text" data-variant="label">{label}</span>
    <input {...props} id={inputId} className={`aui-input ${className}`} />
  </label>;
}
