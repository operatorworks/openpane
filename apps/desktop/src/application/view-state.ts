import type { DraftStoragePort } from '@openpane/client';
import type { ConversationScope } from '@openpane/contracts';
import { parseScope } from '@openpane/contracts';
import { identifier, record } from '@openpane/contracts/decode';

export interface SavedView {
  readonly version: 2;
  readonly route: ConversationScope | null;
  readonly pendingCreation: { readonly scope: ConversationScope; readonly agentId: string | null } | null;
}
export interface OwnedViewStorage {
  readonly viewId: string;
  select(): void;
  readView(hostId: string): Promise<SavedView>;
  saveView(hostId: string, state: SavedView): Promise<void>;
  saveNavigation?(hostId: string, scope: ConversationScope): Promise<void>;
  savedViews(hostId: string, after: string | null): Promise<{
    readonly ids: readonly string[]; readonly unreadable: number; readonly after: string | null;
  }>;
  draftScopes(hostId: string, after: string | null): Promise<{ readonly scopes: readonly ConversationScope[]; readonly after: string | null }>;
  drafts(onFailure: (error: unknown) => void): DraftStoragePort;
  close(): void | Promise<void>;
}
export interface ViewStorageFactory {
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
    ? { scope: input.pendingCreation, agentId: null } : record(input.pendingCreation, ['scope', 'agentId']);
  const pendingCreation = pending === null ? null : { scope: parseScope(pending.scope),
    agentId: pending.agentId === null ? null : identifier(pending.agentId) };
  if ([route, pendingCreation?.scope].some(scope => scope && scope.hostId !== hostId)) throw new Error('Saved view belongs to another host.');
  return { version: 2, route, pendingCreation };
}
