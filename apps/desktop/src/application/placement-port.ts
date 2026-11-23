import type { ConversationOpenResult, ConversationScope } from '@openpane/contracts';
import type { OwnedViewStorage } from './view-state.js';

export type PlacementAcquisition =
  | { readonly kind: 'inline'; readonly view: { readonly kind: 'owned'; readonly viewId: string } | { readonly kind: 'acquired'; readonly storage: OwnedViewStorage } }
  | Exclude<ConversationOpenResult, { readonly kind: 'inline' }>;
export interface PlacementPort {
  delegateCreate?(agentId: string, carry: boolean): Promise<ConversationOpenResult | null>;
  acquire(request: { readonly scope: ConversationScope; readonly agentId: string; readonly agentLabel: string; readonly carryFrom: ConversationScope | null; readonly creation: boolean },
    owner: { readonly storage: OwnedViewStorage; readonly quiesce: () => Promise<void>; readonly release: () => Promise<void>; readonly holds: (viewId: string) => boolean }): Promise<PlacementAcquisition>;
}
