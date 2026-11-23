import { createContext, useContext } from 'react';
import type { ExperienceV1 } from '@openpane/contracts';

export interface VisualSelection { readonly manifest: ExperienceV1; readonly digest: string }
export const VisualContext = createContext<VisualSelection | null>(null);
export const useExperience = (): VisualSelection | null => useContext(VisualContext);

export const UiActionsContext = createContext<{ readonly restore: () => Promise<void> } | null>(null);
export const useUiActions = () => useContext(UiActionsContext);
