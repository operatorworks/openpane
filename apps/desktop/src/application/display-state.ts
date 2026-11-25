import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { sameScope } from '@openpane/contracts';
import type { ConversationScope } from '@openpane/contracts';
import type { UiTransport } from './ui-connection.js';
import { NO_DISPLAY } from './display-client.js';
import type { DisplayView } from './display-client.js';

export const DisplayTransportContext = createContext<UiTransport | null>(null);
const noSubscription = () => () => {};
export function useDisplayScope(scope: ConversationScope | null): void {
  const transport = useContext(DisplayTransportContext);
  useEffect(() => { transport?.selectScope(scope); return () => transport?.selectScope(null); }, [transport, scope?.hostId, scope?.conversationId]);
}
export function useDisplayView(scope: ConversationScope): { readonly view: DisplayView; readonly refresh: () => void } {
  const transport = useContext(DisplayTransportContext);
  const view = useSyncExternalStore(transport?.subscribe ?? noSubscription, () => transport?.getSnapshot().cards ?? NO_DISPLAY, () => NO_DISPLAY);
  return { view: view.kind !== 'none' && sameScope(view.scope, scope) ? view : NO_DISPLAY, refresh: () => transport?.refreshCards() };
}
