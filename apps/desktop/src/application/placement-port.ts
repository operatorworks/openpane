import type { ConversationOpenResult, ConversationScope } from '@openpane/contracts';
import type { OwnedViewStorage } from './view-state.js';
export class PlacementSuperseded extends Error {
  constructor() { super('A newer appearance superseded this chat placement. Its saved work remains recoverable.'); }
}

export type PlacementPurpose = 'explicit' | 'passive';

export interface PlacementIntentRef { readonly sourceScope: ConversationScope; readonly requestId: string }

export type PlacementAcquisition =
  | { readonly kind: 'inline'; readonly view: { readonly kind: 'owned'; readonly viewId: string } | { readonly kind: 'acquired'; readonly storage: OwnedViewStorage } }
  | Exclude<ConversationOpenResult, { readonly kind: 'inline' }>;
export interface PlacementPort {
  canAutomaticallySend?(): boolean;
  restoresInline?(scope: ConversationScope, purpose?: PlacementPurpose): Promise<boolean>;
  delegateCreate?(agentId: string, carry: boolean, initialDraft: string | null): Promise<ConversationOpenResult | null>;
  acquire(request: { readonly scope: ConversationScope; readonly agentId: string; readonly agentLabel: string; readonly carryFrom: ConversationScope | null; readonly initialDraft: string | null; readonly creation: boolean; readonly intentRef?: PlacementIntentRef; readonly purpose?: 'passive'; readonly carryEmptyOnly?: boolean },
    owner: { readonly storage: OwnedViewStorage; readonly quiesce: () => Promise<void>; readonly release: () => Promise<void>; readonly releaseHeld?: (viewId: string) => Promise<void>; readonly holds: (viewId: string) => boolean }): Promise<PlacementAcquisition>;
}

export function placementReason(error: unknown): string {
  const reason = (error instanceof Error ? error.message : String(error)).replace(/[\uD800-\uDFFF]/gu, '\uFFFD').slice(0, 1000).replace(/[\uD800-\uDBFF]$/u, '');
  return reason || 'The conversation could not be opened.';
}
