import type { ReactNode } from 'react';
import { BrowserApplication } from '../shell/BrowserApplication.js';
import type { ApplicationController } from './application-controller.js';

export function ChatWindowApplication({ controller, notice, recovery, suspended }: { readonly suspended: boolean; readonly controller: ApplicationController; readonly notice: string | null; readonly recovery: ReactNode }) {
  return <BrowserApplication suspended={suspended} controller={controller} managedLifecycle fixedChat windowRecovery={recovery} placementNotice={notice} />;
}
