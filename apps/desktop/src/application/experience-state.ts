import { createContext, useContext } from 'react';
import type { ExperienceV2 } from '@openpane/contracts';

export interface VisualSelection { readonly manifest: ExperienceV2; readonly digest: string }
export const VisualContext = createContext<VisualSelection | null>(null);
export const useExperience = (): VisualSelection | null => useContext(VisualContext);
export type ExperienceBootstrap = { readonly kind: 'pending' } | { readonly kind: 'candidate'; readonly initial: 'experience' }
  | { readonly kind: 'settled'; readonly initial: 'builtin' | 'experience' };
export const ExperienceBootstrapContext = createContext<ExperienceBootstrap>({ kind: 'settled', initial: 'builtin' });
export const useExperienceBootstrap = () => useContext(ExperienceBootstrapContext);

export const ExperienceCommittedContext = createContext(true);
export const useExperienceCommitted = () => useContext(ExperienceCommittedContext);

export const UiActionsContext = createContext<{ readonly restore: () => Promise<void> } | null>(null);
export const useUiActions = () => useContext(UiActionsContext);
