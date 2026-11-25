import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createTheme, defaultTheme, type Theme, type ThemeOptions } from './index.js';

const ThemeContext = createContext<Theme | undefined>(undefined);
export interface ThemeProviderProps extends ThemeOptions {
  readonly children?: ReactNode;
}
export function ThemeProvider({ children, appearance, reducedMotion, density, colors, spacing, radius, typography, fonts, treatments, chart }: ThemeProviderProps) {
  const parent = useContext(ThemeContext);
  const value = useMemo(() => createTheme({ appearance, reducedMotion, density, colors, spacing, radius, typography, fonts, treatments, chart }, parent), [parent, appearance, reducedMotion, density, colors, spacing, radius, typography, fonts, treatments, chart]);
  return <ThemeContext value={value}>{children}</ThemeContext>;
}
export function useTheme(): Theme {
  return useProvidedTheme() ?? defaultTheme;
}
export function useProvidedTheme(): Theme | undefined { return useContext(ThemeContext); }
