import type { DraftStoragePort } from '@openpane/client';
import type { ConversationScope } from '@openpane/contracts';
import { parseScope } from '@openpane/contracts';
import { identifier, record } from '@openpane/contracts/decode';

export class IndependentDraftsError extends Error {
  constructor(readonly viewIds: readonly string[]) { super(`Independent drafts exist in views ${viewIds.join(', ')}. Choose a saved view to inspect its text.`); this.name = 'IndependentDrafts'; }
}

export class SupersededDraftsError extends Error {
  constructor() { super('This conversation was reopened in a newer view.'); this.name = 'SupersededDrafts'; }
}

export interface SavedView {
  readonly version: 2;
  readonly route: ConversationScope | null;
  readonly pendingCreation: { readonly scope: ConversationScope; readonly agentId: string | null; readonly carryFrom?: ConversationScope } | null;
}
export interface OwnedViewStorage {
  readonly viewId: string;
  select(): void;
  readView(hostId: string): Promise<SavedView>;
  saveView(hostId: string, state: SavedView): Promise<void>;
  saveInitialDraft?(scope: ConversationScope, agentId: string, text: string): Promise<void>;
  saveNavigation?(hostId: string, scope: ConversationScope): Promise<void>;
  savedViews(hostId: string, after: string | null): Promise<{
    readonly ids: readonly string[]; readonly unreadable: number; readonly after: string | null;
  }>;
  draftScopes(hostId: string, after: string | null): Promise<{ readonly scopes: readonly ConversationScope[]; readonly after: string | null }>;
  drafts(onFailure: (error: unknown) => void): DraftStoragePort;
  close(): void | Promise<void>;
}
export interface SavedDraftRecovery { readonly pendingCreation?: NonNullable<SavedView['pendingCreation']>; readonly kind: 'independent' | 'bound' | 'continued'; readonly viewId: string; readonly scope: ConversationScope; readonly text: string; readonly scopes?: readonly ConversationScope[]; readonly queuedTexts?: readonly string[]; readonly queuedCount?: number; readonly image?: { readonly name: string; readonly bytes: Uint8Array } }
export interface ViewStorageFactory {
  readLegacyDraft?(viewId: string, hostId: string, selectedScope?: ConversationScope): Promise<SavedDraftRecovery | null>;
  openRemainingWork?(viewId: string, hostId: string): Promise<void>;
  recoverClosedView?(viewId: string, onFailure: (error: unknown) => void): Promise<OwnedViewStorage | null>;
  locate?(scope: ConversationScope): Promise<string | null>;
  readonly catalogViewId?: string | undefined;
  open(onFailure: (error: unknown) => void): Promise<OwnedViewStorage>;
  reopen(viewId: string, onFailure: (error: unknown) => void): Promise<OwnedViewStorage>;
}

export function decodeView(value: unknown, hostId: string): SavedView {
  if (value === undefined) return { version: 2, route: null, pendingCreation: null };
  let input: Record<string, unknown>;
  try {
    input = record(value, ['version', 'route', 'pendingCreation']);
    if (input.version !== 1 && input.version !== 2) throw new Error('Unsupported version');
  } catch { throw new Error('Unsupported saved view. Local records were preserved.'); }
  const route = input.route === null ? null : parseScope(input.route);
  const pending = input.pendingCreation === null ? null : input.version === 1
    ? { scope: input.pendingCreation, agentId: null } : record(input.pendingCreation);
  if (pending) record(pending, Object.hasOwn(pending, 'carryFrom') ? ['scope', 'agentId', 'carryFrom'] : ['scope', 'agentId']);
  const pendingCreation = pending === null ? null : { ...(pending.carryFrom === undefined ? {} : { carryFrom: parseScope(pending.carryFrom) }), scope: parseScope(pending.scope),
    agentId: pending.agentId === null ? null : identifier(pending.agentId) };
  if ([route, pendingCreation?.scope, pendingCreation?.carryFrom].some(scope => scope && scope.hostId !== hostId)) throw new Error('Saved view belongs to another host.');
  return { version: 2, route, pendingCreation };
}
