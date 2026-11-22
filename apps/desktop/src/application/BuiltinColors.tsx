import type { ReactNode } from 'react';
import { palettes } from '@openpane/theme';
import { ThemeScope } from '@openpane/ui-primitives/desktop';

export function BuiltinColors({ children }: { readonly children: ReactNode }) {
  return <ThemeScope palette={palettes} className="content-theme">{children}</ThemeScope>;
}
