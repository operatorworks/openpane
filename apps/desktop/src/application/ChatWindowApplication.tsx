import type { ReactNode } from 'react';
import { BrowserApplication } from '../shell/BrowserApplication.js';
import type { ApplicationController } from './application-controller.js';

export function ChatWindowApplication({ controller, notice, recovery }: { readonly controller: ApplicationController; readonly notice: string | null; readonly recovery: ReactNode }) {
  return <BrowserApplication controller={controller} managedLifecycle fixedChat windowRecovery={recovery} placementNotice={notice} />;
}
