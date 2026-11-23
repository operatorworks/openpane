import { useEffect, useSyncExternalStore } from 'react';
import { BrowserApplication } from '../shell/BrowserApplication.js';
import { ArtifactIdentity } from './ArtifactIdentity.js';
import { ChatWindowApplication } from './ChatWindowApplication.js';
import { ExperienceScope } from './ExperienceScope.js';
import { PersonalizationProvider } from './use-personalization.js';
import { DesktopCustomizationProvider } from './DesktopCustomizations.js';
import { WindowRecoveryControls } from './WindowRecoveryControls.js';
import type { WindowRuntime } from './window-runtime.js';

export function WindowApplication({ runtime }: { readonly runtime: WindowRuntime }) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  useEffect(() => {
    runtime.start();
    const close = () => runtime.close(); window.addEventListener('pagehide', close);
    return () => window.removeEventListener('pagehide', close);
  }, [runtime]);
  const notice = state.placementNotice ?? state.capabilityNotice;
  return <ExperienceScope connection={runtime.ui}><PersonalizationProvider><DesktopCustomizationProvider>
    {runtime.context.role === 'chat' ? <ChatWindowApplication controller={runtime.controller} notice={notice} recovery={<WindowRecoveryControls runtime={runtime} recovery={state.recovery} />} />
      : <BrowserApplication artifact={<ArtifactIdentity />} controller={runtime.controller} managedLifecycle windowRecovery={<WindowRecoveryControls runtime={runtime} recovery={state.recovery} />} catalogOnly={state.catalogOnly} placementNotice={notice} />}
  </DesktopCustomizationProvider></PersonalizationProvider></ExperienceScope>;
}
