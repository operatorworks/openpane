import type { ConversationOpenResult } from '@openpane/contracts';
import { PlacementSuperseded, placementReason, type PlacementPort, type PlacementIntentRef, type PlacementPurpose } from './placement-port.js';
import { checkCompatibility, createConversationStore } from '@openpane/client';
import type { CompatibilityIssue, ConversationStore } from '@openpane/client';
import { ServiceConnectionLost } from '@openpane/client/service';
import type { ServiceConnectionOptions } from '@openpane/client/service';
import { ServiceError, SERVICE_CATALOG_PAGE } from '@openpane/contracts/service';
import { canRetryObservation, sameScope } from '@openpane/contracts';
import { SOLO_CLIENT_COMPATIBILITY } from '@openpane/contracts/compatibility';
import type { ConversationScope, SubmitResult, ProviderObservationStatus, ConversationPermissions, ContinuationCarried, ConversationClosure } from '@openpane/contracts';
import type { ImageId } from '@openpane/contracts/image';
import { conversationPreview, transcriptProjection } from '@openpane/contracts/conversation';
import type { Transcript } from '@openpane/contracts/conversation';
import type { AgentDescriptor, ContinuationView, ConversationCatalogEntry, ConversationSearchPage, ExtensionCallRequest, ExtensionCallValue, ServiceConnection, ServiceMetadata } from '@openpane/contracts/service';
import type { ConversationCommands, ConversationModuleProps } from '@openpane/sdk/react';
import { IndependentDraftsError } from './view-state.js';
import type { OwnedViewStorage, SavedDraftRecovery, SavedView, ViewStorageFactory } from './view-state.js';
import { agentPresentation } from './agent-presentation.js';
import { createFrontendSends, createGenerationSource } from './frontend-sends.js';
import type { CapturedSend, FrontendSends, GenerationSink } from './frontend-sends.js';
import { createFrontendRecovery } from './frontend-recovery.js';
import { createViewLeasePool } from './view-leases.js';
import type { StoreBorrow, ViewBorrow } from './view-leases.js';
import { conversationResponding } from './responding.js';
import { createContinuationSession } from './continuation-session.js';
export { EARLIER_SEGMENT_LIMIT } from './continuation-session.js';

export interface Page<T> { readonly items: readonly T[]; readonly after: string | null }
type HostState =
  | { readonly kind: 'loading' | 'unavailable' }
  | { readonly kind: 'ready'; readonly metadata: ServiceMetadata }
  | { readonly kind: 'incompatible'; readonly metadata: ServiceMetadata; readonly issues: readonly CompatibilityIssue[] };
export interface OpenConversation {
  readonly agent: AgentDescriptor;
  readonly viewId: string;
  readonly scope: ConversationScope;
  readonly store: ConversationStore<Transcript>;
}
export interface ConversationObservation {
  readonly status: ProviderObservationStatus | { readonly kind: 'unknown' };
  readonly retrying: boolean;
}
type AvailablePermissions = Extract<ConversationPermissions, { kind: 'available' }>;
export type PermissionState =
  | { readonly kind: 'fresh'; readonly listing: AvailablePermissions }
  | { readonly kind: 'loading' | 'stale'; readonly listing: AvailablePermissions | null; readonly reason: string }
  | { readonly kind: 'unsupported'; readonly reason: string };
/** What the boundary above one segment of a continued chat reports. */
export interface ContinuationBoundary {
  /** How the earlier segment ended; `unknown` or `null` when that could not be read. */
  readonly closure: ConversationClosure | 'unknown' | null;
  readonly carried: ContinuationCarried | null;
}
export interface EarlierSegment {
  readonly scope: ConversationScope;
  readonly messages: Transcript['messages'];
  /** The boundary above this segment when it continues an even earlier one. */
  readonly boundary: ContinuationBoundary | null;
}
export interface ConversationContinuation {
  readonly placement: ConversationOpenResult | null;
  /** `null` until the host answers the first read. */
  readonly view: ContinuationView | null;
  readonly action: 'start' | 'check' | 'move' | 'earlier' | null;
  readonly error: string;
  /** Background reads or moves reached their bound; only a click tries again. */
  readonly stalled: boolean;
  /** Set when a Continue or Start a new chat click opened this chat, so its composer takes focus. */
  readonly arrived: 'continue' | 'new-chat' | null;
  /** The boundary above the open segment's own messages, when it continues an earlier one. */
  readonly boundary: ContinuationBoundary | null;
  /** Earlier segments loaded on request, oldest first. */
  readonly earlier: readonly EarlierSegment[];
  readonly earlierError: string;
  readonly more: boolean;
}
/** One extension namespace's conversations, read with a namespace catalog filter in catalog order. */
export interface WorkspaceConversations {
  readonly entries: readonly ConversationCatalogEntry[];
  readonly after: string | null;
  readonly hasMore: boolean;
  readonly loading: boolean;
}
export interface ApplicationSnapshot {
  readonly host: HostState;
  readonly catalog: Page<ConversationCatalogEntry>;
  readonly workspaces: Readonly<Record<string, WorkspaceConversations>>;
  readonly saved: SavedView;
  readonly savedViews: Page<string>;
  readonly savedViewNotice: string;
  readonly savedDraftRecovery: SavedDraftRecovery | null;
  readonly active: OpenConversation | null;
  readonly observation: ConversationObservation | null;
  readonly continuation: ConversationContinuation | null;
  readonly permissionState: PermissionState;
  readonly error: string;
  readonly storageFailure: string;
  readonly busy: boolean;
  readonly lastPlacement: ConversationOpenResult | null;
  readonly capturedSends: readonly CapturedSend[];
}
export interface ConversationActions {
  readonly commands: ConversationCommands;
  readonly permissions: ConversationModuleProps['permissions'];
  submit(operation: () => Promise<SubmitResult>): Promise<void>;
  reconcile(id: string): Promise<void>;
  /** Stops waiting on an unconfirmed send so the conversation can take new work. Says nothing about whether it ran. */
  abandon(id: string): Promise<void>;
  retryObservation(): Promise<void>;
  /** Continue and Try again: the host starts this closed conversation's successor, or answers with the one it has. */
  continueConversation(): Promise<void>;
  /** Check again: looks up unsettled attempts and never starts another. */
  checkContinuation(): Promise<void>;
  /** Starts an unrelated new chat with the same agent through the ordinary create flow; only the unsent draft moves. */
  startNewChat(): Promise<void>;
  loadEarlierSegment(): Promise<void>;
  /** Reads an image of this conversation for preview; failures never mark the application failed. */
  readImage(imageId: ImageId): Promise<Uint8Array>;
}
export interface ApplicationController {
  readonly frontendGenerations: GenerationSink;
  releaseCapturedSend(key: string): Promise<void>;
  getSnapshot(): ApplicationSnapshot;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  dispose(): Promise<void>;
  prepareClose(): Promise<void>;
  canAutomaticallySend(scope: ConversationScope): boolean;
  reconnect(): Promise<void>;
  reopenView(viewId: string): Promise<boolean>;
  inspectSavedDraft(viewId: string, scope: ConversationScope): Promise<void>;
  openRemainingSavedWork(expected: SavedDraftRecovery): Promise<ConversationOpenResult | undefined>;
  dismissSavedDraftRecovery(expected: SavedDraftRecovery): void;
  moreConversations(): Promise<void>;
  refreshCatalog(): Promise<void>;
  search(query: string, after: string | null, signal: AbortSignal): Promise<ConversationSearchPage>;
  moreSavedViews(): Promise<void>;
  create(agentId?: string, initialDraft?: string): Promise<ConversationOpenResult>;
  /** Native allocation has already persisted this scope and agent. */
  createReserved(scope: ConversationScope, agentId: string, intentRef?: PlacementIntentRef): Promise<ConversationOpenResult>;
  openReserved(scope: ConversationScope, intentRef?: PlacementIntentRef, purpose?: PlacementPurpose): Promise<ConversationOpenResult>;
  pendingPlacements(): readonly Extract<ConversationOpenResult, { readonly kind: 'pending' }>[];
  settlePlacement(expected: Extract<ConversationOpenResult, { readonly kind: 'pending' }>, result: Exclude<ConversationOpenResult, { readonly kind: 'pending' }>): boolean;
  settleCarriedDraft(carry: { readonly source: ConversationScope; readonly sourceViewId: string; readonly requestId: string; readonly expected: { readonly text: string; readonly revision: number } }): Promise<void>;
  capturePlacementDraft(scope: ConversationScope): Promise<{ readonly viewId: string; readonly text: string; readonly revision: number; recover(): void } | null>;
  inspectConversation(scope: ConversationScope): Promise<{ readonly agent: AgentDescriptor | null; readonly continuation: ContinuationView }>;
  recoverCreation(agentId?: string, intentRef?: PlacementIntentRef): Promise<ConversationOpenResult | undefined>;
  open(scope: ConversationScope): Promise<ConversationOpenResult>;
  conversationActions(target: OpenConversation): ConversationActions;
  /** Reads the first page of one namespace's conversations. */
  loadWorkspace(namespace: string): Promise<void>;
  /** Reads the next page of one namespace's conversations. */
  moreWorkspace(namespace: string): Promise<void>;
  /** Re-reads host metadata and replaces it when the host is ready. */
  refreshMetadata(): Promise<void>;
  /** Forwards one extension operation call. No retry. */
  extensionCall(request: ExtensionCallRequest): Promise<ExtensionCallValue>;
}
interface LoadedView { readonly borrow: ViewBorrow; readonly saved: SavedView; readonly hostId: string }
type OwnedView = { readonly borrow: ViewBorrow; readonly saved: null } | LoadedView;
interface ImageTransfers {
  upload: ServiceConnection['uploadImage'];
  read(scope: ConversationScope, imageId: ImageId): Promise<Uint8Array>;
}
interface ActiveStoreOwner { readonly borrow: StoreBorrow; readonly target: OpenConversation }
interface CreationConfirmation { readonly scope: ConversationScope; readonly viewId: string; readonly agentId: string; readonly principalId: string }
interface NavigationConfirmation { readonly storage: OwnedViewStorage; readonly scope: ConversationScope }
interface Session { readonly recovery: ReturnType<typeof createFrontendRecovery>; navigation: NavigationConfirmation | null; hostId: string | null; principalId: string | null; readonly continuationCarries: Set<string>; readonly pendingContinuationCarries: Map<Extract<ConversationOpenResult, { readonly kind: 'pending' }>, string>; quiescingViewId: string | null; catalog: ViewBorrow | null; readonly pool: ReturnType<typeof createViewLeasePool>; activeOwner: ActiveStoreOwner | null; view: OwnedView | null; readonly connection: ServiceConnection; readonly frontend: FrontendSends; readonly images: ImageTransfers }
const EMPTY_SAVED_VIEW: SavedView = { version: 2, route: null, pendingCreation: null };
const DETACHED_VIEW = {
  observation: null, continuation: null, permissionState: { kind: 'stale', listing: null, reason: 'Open a conversation to read permissions.' }, catalog: { items: [], after: null }, workspaces: {}, savedViews: { items: [], after: null }, savedViewNotice: '', savedDraftRecovery: null,
} satisfies Pick<ApplicationSnapshot, 'observation' | 'continuation' | 'permissionState' | 'catalog' | 'workspaces' | 'savedViews' | 'savedViewNotice' | 'savedDraftRecovery'>;
function compatibleAgent(agent: AgentDescriptor): AgentDescriptor {
  if ('kind' in agent) return agent;
  return SOLO_CLIENT_COMPATIBILITY.supportedNativeRuntimes.some(runtime => runtime.engine === agent.runtime.engine &&
    runtime.version === agent.runtime.version && runtime.format === agent.runtime.format) ? agent
    : { ...agent, availability: { kind: 'unavailable', reason: 'This agent runtime is unsupported by this app.' } };
}
const IMAGE_TRANSFER_ATTEMPTS = 3;
// The host admits one image transfer per access and refuses overlaps as unavailable, so transfers run one at a time.
function imageTransfers(connection: ServiceConnection): ImageTransfers {
  let tail: Promise<unknown> = Promise.resolve();
  const reads = new Map<string, Promise<Uint8Array>>();
  function queued<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      for (let attempt = 1; ; attempt++) {
        try { return await operation(); }
        catch (cause) {
          if (!(cause instanceof ServiceError && cause.kind === 'unavailable') || cause instanceof ServiceConnectionLost || attempt === IMAGE_TRANSFER_ATTEMPTS) throw cause;
          await new Promise(resolve => setTimeout(resolve, 200 * attempt));
        }
      }
    });
    tail = result.catch(() => undefined);
    return result;
  }
  return {
    upload: input => queued(() => connection.uploadImage(input)),
    read(scope, imageId) {
      const key = JSON.stringify([scope.hostId, scope.conversationId, imageId]);
      const pending = reads.get(key);
      if (pending) return pending;
      const read = queued(async () => (await connection.readImage(scope, imageId)).bytes).finally(() => reads.delete(key));
      reads.set(key, read);
      return read;
    },
  };
}
type EntriesUpdate = (entries: readonly ConversationCatalogEntry[]) => readonly ConversationCatalogEntry[] | null;
/** Sets the preview of the entry for `scope`; no change when it is absent or already current. */
const withPreview = (scope: ConversationScope, preview: string | null): EntriesUpdate => entries => {
  const existing = entries.find(entry => sameScope(entry.scope, scope));
  return existing && existing.preview !== preview ? entries.map(entry => entry === existing ? { ...entry, preview } : entry) : null;
};
/** Puts `entry` first, replacing any entry for the same scope. */
const prepended = (entry: ConversationCatalogEntry): EntriesUpdate => entries => [entry, ...entries.filter(item => !sameScope(item.scope, entry.scope))];
function entryKey(entry: ConversationCatalogEntry): string {
  return JSON.stringify([entry.scope.hostId, entry.scope.conversationId]);
}
/** A catalog page merged into what is loaded: the first page replaces it, a later page adds or replaces by scope. */
function mergePage(loaded: readonly ConversationCatalogEntry[], items: readonly ConversationCatalogEntry[], first: boolean): ConversationCatalogEntry[] {
  const merged = new Map((first ? [] : loaded).map(entry => [entryKey(entry), entry]));
  for (const entry of items) merged.set(entryKey(entry), entry);
  return [...merged.values()];
}
function initialSnapshot(): ApplicationSnapshot {
  return { ...DETACHED_VIEW, active: null, host: { kind: 'loading' }, saved: EMPTY_SAVED_VIEW, error: '', storageFailure: '', busy: false, lastPlacement: null, capturedSends: [] };
}
function message(error: unknown): string { return error instanceof Error ? error.message : 'The operation failed.'; }
export function applicationEnabled(state: ApplicationSnapshot): boolean {
  return state.host.kind === 'ready' && !state.storageFailure && !state.busy;
}
const SEND_AWAITING_CONFIRMATION = 'An earlier message has not been confirmed yet, so this one was not sent. Your draft is kept. '
  + 'Use Reconcile command under Command recovery, or Check pending command under Pending commands, to check it. '
  + 'If it stays unconfirmed, use Stop waiting beside that button to send new messages here; '
  + 'the earlier message may or may not have run.';
export const NOTHING_TO_STOP_WAITING = 'Nothing to stop waiting on: this command is not holding up new messages.';
export function refusalMessage(reason: string): string {
  if (reason === 'conversation-closed') return 'This conversation ended. Start a new chat to keep going.';
  if (reason === 'send-awaiting-confirmation') return SEND_AWAITING_CONFIRMATION;
  return reason;
}

export function createApplicationController(deps: {
  readonly createConnection: (options: ServiceConnectionOptions) => ServiceConnection;
  readonly ownedViewStorage: ViewStorageFactory;
  readonly createId: () => string;
  readonly placement?: PlacementPort;
  readonly fixedScope?: ConversationScope;
}): ApplicationController {
  let state = initialSnapshot();
  let session: Session | null = null;
  let disposal: { readonly promise: Promise<void>; settled: boolean } | null = null;
  let lifecycle = 0;
  const listeners = new Set<() => void>();
  const pendingCreations = new Map<Extract<ConversationOpenResult, { readonly kind: 'pending' }>, CreationConfirmation>();
  const confirmedCreations = new Set<CreationConfirmation>();
  let creationConfirmationVersion = 0;
  let observationPoll: { stop(): void; retry(): Promise<void> } | null = null;
  const concludedScopes = new Map<string, Extract<ProviderObservationStatus, { readonly kind: 'concluded' }>>();
  const continuations = createContinuationSession<Session>({
    owner: () => session,
    active: () => state.active,
    busy: () => state.busy,
    publish, current, install: (owner, scope, arrived, purpose, carryEmptyOnly) => install(owner, scope, arrived, null, undefined, purpose, carryEmptyOnly), save, recoverDraft, requireSaved, requireTarget, message, patchEntries, run,
    loadedLists: () => [state.catalog.items, ...Object.values(state.workspaces).map(workspace => workspace.entries)],
  });
  let unsubscribeActive: (() => void) | null = null;
  function publish(update: Partial<Omit<ApplicationSnapshot, 'saved' | 'active'>>): void {
    state = Object.freeze({ ...state, ...update, saved: session?.view?.saved ?? EMPTY_SAVED_VIEW,
      active: session?.activeOwner?.target ?? null });
    syncRecovery();
    for (const listener of listeners) listener();
  }
  function setActive(owner: Session, next: ActiveStoreOwner | null): void {
    const previous = owner.activeOwner;
    owner.activeOwner = next;
    if (previous?.borrow !== next?.borrow) previous?.borrow.release();
  }
  const generations = createGenerationSource();
  function syncRecovery(): void {
    const owner = session, view = owner?.view, host = state.host;
    owner?.recovery.retarget(owner && view && view.saved !== null && host.kind === 'ready'
      && !state.storageFailure && owner.quiescingViewId !== view.borrow.storage.viewId && view.hostId === host.metadata.hostId
      ? { pool: owner.pool, frontend: owner.frontend, lease: view.borrow, metadata: host.metadata,
        ...(deps.ownedViewStorage.recoverClosedView ? {
          openOtherView: async (viewId: string) => {
            if (session !== owner || viewId === deps.ownedViewStorage.catalogViewId) return null;
            return owner.pool.open(viewId, async () => {
              let storage: OwnedViewStorage | null = null;
              storage = await deps.ownedViewStorage.recoverClosedView?.(viewId, error => { if (storage) owner.pool.failed(storage, error); }) ?? null;
              return storage;
            }, { interested: false, kind: 'recovery' });
          },
          otherViewFailed: () => { if (session === owner) publish({ savedViewNotice: 'Some saved tool captures could not be inspected. Reopen their saved view to recover them; their records are preserved.' }); },
        } : {}),
      } : null);
  }
  let permissionRead = 0;
  function stalePermissions(reason: string): void {
    permissionRead++;
    const previous = state.permissionState;
    // Support belongs to the conversation, not the connection: a disconnect does not make it report permissions.
    if (previous.kind === 'unsupported') return;
    publish({ permissionState: { kind: 'stale', listing: 'listing' in previous ? previous.listing : null, reason } });
  }
  async function readPermissions(owner: Session, target: OpenConversation): Promise<ConversationPermissions> {
    requireTarget(owner, target);
    const version = ++permissionRead, previous = state.permissionState;
    if (previous.kind !== 'unsupported') publish({ permissionState: { kind: 'loading', listing: 'listing' in previous ? previous.listing : null, reason: 'Refreshing permissions…' } });
    try {
      const result = await current(owner, owner.connection.conversationPermissions(target.scope));
      requireTarget(owner, target);
      if (version === permissionRead) publish({ permissionState: result.kind === 'available'
        ? { kind: 'fresh', listing: result } : result.kind === 'unsupported' ? { kind: 'unsupported', reason: result.reason }
          : { kind: 'stale', listing: 'listing' in previous ? previous.listing : null, reason: result.reason } });
      return result;
    } catch (cause) {
      if (session === owner && state.active === target && version === permissionRead) stalePermissions(message(cause));
      throw cause;
    }
  }
  function refreshPermissions(owner: Session, target: OpenConversation): void {
    if (session === owner && state.active === target && state.host.kind === 'ready') void readPermissions(owner, target).catch(() => {});
  }
  function stopObservation(): void { observationPoll?.stop(); observationPoll = null; }
  function disconnectActive(): void {
    const target = state.active;
    stalePermissions('Reconnect to refresh permissions.');
    stopObservation();
    continuations.stop();
    unsubscribeActive?.();
    unsubscribeActive = null;
    target?.store.disconnect();
  }
  function fail(owner: Session, cause: unknown, phase: 'handshake' | 'operation' = 'operation'): void {
    if (session !== owner || state.host.kind === 'unavailable' && state.error) return;
    publish(phase === 'handshake' ? { host: { kind: 'unavailable' }, error: message(cause) } : { error: message(cause) });
  }
  function lose(owner: Session, cause: ServiceConnectionLost): void {
    if (session !== owner) return;
    if (state.host.kind !== 'unavailable') publish({ host: { kind: 'unavailable' }, error: message(cause) });
    disconnectActive();
    owner.frontend.pause();
  }
  async function current<T>(owner: Session, operation: Promise<T>): Promise<T> {
    const result = await operation;
    if (session !== owner) throw new Error('This application has closed.');
    return result;
  }
  function failStorage(owner: Session, storage: OwnedViewStorage | null, cause: unknown): void {
    if (session !== owner || (storage !== null && !owner.pool.owns(storage))) return;
    publish({ storageFailure: message(cause) });
    if (storage) owner.frontend.storageFailed(storage.viewId);
    disconnectActive();
  }
  function local(owner: Session): OwnedViewStorage {
    if (session !== owner || !owner.view || state.storageFailure) throw new Error(state.storageFailure || 'Local storage is not ready.');
    return owner.view.borrow.storage;
  }
  function requireHost(owner: Session): ServiceMetadata {
    local(owner);
    if (state.host.kind !== 'ready') throw new Error('A compatible connected host is required.');
    return state.host.metadata;
  }
  function requireSaved(owner: Session): LoadedView {
    const host = requireHost(owner);
    const view = owner.view;
    if (!view || view.saved === null || view.hostId !== host.hostId) throw new Error('This view is still loading.');
    return view;
  }
  async function acquire(owner: Session, viewId: string | null, purpose: PlacementPurpose = 'explicit', prepare?: (storage: OwnedViewStorage) => Promise<void>): Promise<OwnedViewStorage> {
    const ownedId = viewId ?? deps.ownedViewStorage.catalogViewId;
    let borrow: ViewBorrow | null;
    if (viewId === null) {
      borrow = ownedId === undefined ? null : owner.pool.reserve(ownedId);
      if (!borrow) {
        if (ownedId !== undefined) await owner.pool.closed(ownedId);
        let storage: OwnedViewStorage | null = null;
        storage = await deps.ownedViewStorage.open(cause => storage ? owner.pool.failed(storage, cause) : failStorage(owner, null, cause));
        borrow = owner.pool.adopt(storage);
      }
    } else {
      borrow = await owner.pool.open(viewId, async () => {
        let storage: OwnedViewStorage | null = null;
        const failed = (cause: unknown) => storage ? owner.pool.failed(storage, cause) : failStorage(owner, null, cause);
        storage = await deps.ownedViewStorage.reopen(viewId, failed, purpose === 'passive' ? { purpose } : undefined); return storage;
      }, { required: true });
    }
    if (!borrow) throw new Error('This application has closed.');
    try {
      if (session !== owner) throw new Error('This application has closed.');
      if (prepare) await current(owner, prepare(borrow.storage));
      if (viewId !== null) borrow.storage.select();
      if (session !== owner) throw new Error('This application has closed.');
      if (!owner.catalog && borrow.storage.viewId === deps.ownedViewStorage.catalogViewId) owner.catalog = owner.pool.reserve(borrow.storage.viewId);
      const previous = owner.view;
      owner.view = { borrow, saved: null };
      syncRecovery();
      previous?.borrow.release();
      return borrow.storage;
    } catch (cause) { borrow.release(); throw cause; }
  }
  async function place(owner: Session, scope: ConversationScope, agent: AgentDescriptor, creation: boolean, carryFrom: ConversationScope | null = null, initialDraft: string | null = null, intentRef?: PlacementIntentRef, purpose: PlacementPurpose = 'explicit', carryEmptyOnly?: boolean): Promise<ConversationOpenResult> {
    requireHost(owner);
    if (!deps.placement) return { kind: 'inline', scope };
    owner.recovery.suspend(true);
    try {
      await current(owner, owner.pool.drainRecovery());
      const source = local(owner), host = requireHost(owner);
      let released = false, quiesceTask: Promise<void> | null = null;
      let releasedCatalog: string | null = null;
      const priorActive = owner.activeOwner?.target;
      const quiesce = () => quiesceTask ??= (async () => {
        await current(owner, owner.pool.flushDrafts()); local(owner);
        owner.quiescingViewId = source.viewId;
        owner.recovery.retarget(null); disconnectActive(); setActive(owner, null);
        owner.frontend.quiesceView(source.viewId);
        await current(owner, owner.recovery.drained());
        await current(owner, owner.pool.drainStores(source.viewId));
      })();
      const retainCatalog = async () => {
        if (!releasedCatalog || owner.catalog) return;
        const viewId = releasedCatalog;
        const borrow = await current(owner, owner.pool.open(viewId, async () => {
          let storage: OwnedViewStorage | null = null;
          storage = await deps.ownedViewStorage.open(cause => storage ? owner.pool.failed(storage, cause) : failStorage(owner, null, cause));
          return storage;
        }, { required: true }));
        if (!borrow) throw new Error('The original catalog is unavailable.');
        owner.catalog = borrow;
        releasedCatalog = null;
      };
      const restoreSource = async (placedElsewhere = false) => {
        if (session !== owner) return;
        try {
          await retainCatalog();
          owner.quiescingViewId = null;
          if (released) {
            const catalog = owner.catalog?.storage;
            const load = async (storage: OwnedViewStorage) => {
              const saved = await current(owner, storage.readView(host.hostId)), borrow = owner.view?.borrow;
              if (!borrow) throw new Error('The original editor is unavailable.');
              owner.view = { borrow, saved, hostId: host.hostId };
            };
            if (placedElsewhere && catalog && catalog.viewId !== source.viewId && (!priorActive || sameScope(priorActive.scope, scope))) {
              await load(await acquire(owner, catalog.viewId));
              publish({});
            } else {
              let storage: OwnedViewStorage | null = null;
              try {
                storage = await acquire(owner, source.viewId);
                await load(storage);
              } catch (cause) {
                if (!catalog || catalog.viewId === source.viewId) throw cause;
                try { await load(await acquire(owner, catalog.viewId)); }
                catch (fallback) { throw new Error(`${message(cause)} Catalog restoration failed: ${message(fallback)}`); }
                publish({});
                if (storage) throw cause;
                return;
              }
              if (priorActive && state.host.kind === 'ready') await activate(owner, priorActive.scope, priorActive.agent);
              else publish({});
            }
          }
          else if (quiesceTask && owner.pool.holds(source.viewId) && !state.storageFailure) {
            if (state.host.kind !== 'ready') { publish({}); return; }
            owner.frontend.resumeView(source.viewId);
            if (priorActive) await activate(owner, priorActive.scope, priorActive.agent);
            else publish({});
          }
        } catch (cause) {
          if (!owner.view || owner.view.saved === null) failStorage(owner, owner.view?.borrow.storage ?? owner.catalog?.storage ?? null, cause);
          throw cause;
        }
      };
      const restoreAfterPlacement = async (context: string) => {
        try { await restoreSource(); }
        catch (cause) {
          const placement = context.slice(0, 480).replace(/[\uD800-\uDBFF]$/u, '');
          const restoration = message(cause).slice(0, 480).replace(/[\uD800-\uDBFF]$/u, '');
          throw new Error(`${placement} Source restoration failed: ${restoration}`);
        }
      };
      const release = async () => {
        if (released) return;
        await quiesce();
        await current(owner, owner.frontend.releaseView(source.viewId));
        released = true;
        const closed = owner.pool.closed(source.viewId), previous = owner.view;
        if (owner.catalog?.storage === source) {
          const catalog = owner.catalog; owner.catalog = null; releasedCatalog = catalog.storage.viewId; catalog.release();
        }
        owner.view = null; previous?.borrow.release(); publish({});
        await current(owner, closed);
      };
      const releaseHeld = async (viewId: string) => {
        if (viewId === source.viewId) { await release(); return; }
        const catalog = owner.catalog;
        if (!catalog || catalog.storage.viewId !== viewId) throw new Error('The saved source is still owned by another operation.');
        owner.frontend.quiesceView(viewId);
        await current(owner, owner.frontend.releaseView(viewId));
        await current(owner, owner.pool.drainStores(viewId));
        const closed = owner.pool.closed(viewId);
        owner.catalog = null; releasedCatalog = viewId; catalog.release();
        await current(owner, closed);
      };
      let result: Awaited<ReturnType<NonNullable<typeof deps.placement>['acquire']>>;
      try {
        result = await deps.placement.acquire({ scope, agentId: agent.id, agentLabel: agent.label, creation, carryFrom, initialDraft, ...(intentRef ? { intentRef } : {}), ...(purpose === 'passive' ? { purpose } : {}), ...(carryEmptyOnly === undefined ? {} : { carryEmptyOnly }) }, { storage: source, holds: owner.pool.holds, quiesce, release, releaseHeld });
        if (session !== owner) {
          if (result.kind === 'inline' && result.view.kind === 'acquired') await result.view.storage.close();
          throw new Error('This application has closed.');
        }
      }
      catch (error) {
        await restoreAfterPlacement(message(error));
        throw error;
      }
      if (result.kind !== 'inline') {
        try {
          if (result.kind === 'refused') await restoreAfterPlacement(result.reason);
          else await restoreSource(true);
        }
        catch (cause) {
          if (result.kind === 'refused') throw cause;
          fail(owner, cause);
        }
        return result;
      }
      let candidate: ViewBorrow | null = null;
      try {
        const view = result.view;
        if (view.kind === 'acquired') candidate = owner.pool.adopt(view.storage);
        await retainCatalog();
        if (view.kind === 'owned') candidate = owner.pool.reserve(view.viewId);
        if (!candidate) throw new Error('The previous editor is finishing its writes. Retry opening it.');
        const saved = await current(owner, candidate.storage.readView(host.hostId));
        // Keep the working source until the destination record has been validated.
        if (owner.view?.borrow.storage !== candidate.storage) {
          disconnectActive(); setActive(owner, null);
        }
        const previous = owner.view;
        if (previous?.borrow.storage === candidate.storage) {
          candidate.release(); candidate = null;
          owner.view = { borrow: previous.borrow, saved, hostId: host.hostId };
        } else {
          owner.view = { borrow: candidate, saved, hostId: host.hostId };
          candidate = null;
          previous?.borrow.release();
        }
        owner.quiescingViewId = null;
        owner.frontend.resumeView(local(owner).viewId);
        publish({});
      } catch (error) {
        candidate?.release();
        await restoreAfterPlacement(message(error));
        throw error;
      }
      return { kind: 'inline', scope };
    } finally { owner.recovery.suspend(false); }
  }

  function reportPlacement(owner: Session, outcome: ConversationOpenResult): void {
    if (session !== owner) return;
    publish({ lastPlacement: outcome, ...(state.host.kind === 'ready' && outcome.kind === 'refused' ? { error: outcome.reason } : {}) });
  }
  async function opening(operation: (owner: Session) => Promise<ConversationOpenResult>): Promise<ConversationOpenResult> {
    if (!session) return { kind: 'refused', reason: 'This application has closed.' };
    if (state.busy) return { kind: 'refused', reason: 'Another operation is in progress. Try again when it finishes.' };
    if (state.host.kind !== 'ready') return { kind: 'refused', reason: 'A compatible connected host is required.' };
    if (state.storageFailure) return { kind: 'refused', reason: state.storageFailure.slice(0, 1000).replace(/[\uD800-\uDBFF]$/u, '') || 'The conversation could not be opened.' };
    const owner = session;
    let outcome: ConversationOpenResult = { kind: 'refused', reason: 'The conversation could not be opened.' };
    let superseded = false;
    await run(async owner => {
      try { outcome = await operation(owner); }
      catch (error) {
        outcome = { kind: 'refused', reason: message(error).slice(0, 1000).replace(/[\uD800-\uDBFF]$/u, '') || 'The conversation could not be opened.' };
        if (error instanceof PlacementSuperseded) { superseded = true; return; }
        throw error;
      }
    });
    if (!superseded) reportPlacement(owner, outcome);
    return outcome;
  }
  async function recoverDraft(owner: Session, scope: ConversationScope): Promise<StoreBorrow | null> {
    const currentView = owner.view?.borrow;
    if (!currentView) return null;
    if (!deps.ownedViewStorage.locate) return owner.pool.recovery(currentView, scope);
    let viewId: string | null;
    try { viewId = await current(owner, deps.ownedViewStorage.locate(scope)); }
    catch (error) {
      if (!(error instanceof IndependentDraftsError)) throw error;
      const first = error.viewIds[0], saved = first ? await current(owner, deps.ownedViewStorage.readLegacyDraft?.(first, scope.hostId, scope) ?? Promise.resolve(null)) : null;
      publish({ savedViewNotice: error.message, ...(saved ? { savedDraftRecovery: { ...saved, kind: 'continued' } as const } : {}) });
      return null;
    }
    if (!viewId) return null;
    const borrowed = await owner.pool.open(viewId, async () => {
      let storage: OwnedViewStorage | null = null;
      const failure = (error: unknown) => { if (storage) owner.pool.failed(storage, error); };
      storage = deps.ownedViewStorage.recoverClosedView ? await deps.ownedViewStorage.recoverClosedView(viewId, failure) : await deps.ownedViewStorage.reopen(viewId, failure);
      return storage;
    }, { kind: 'recovery' });
    if (!borrowed) return null;
    try {
      const held = await owner.pool.recovery(borrowed, scope);
      if (session !== owner) { held.release(); throw new Error('This application has closed.'); }
      return held;
    }
    finally { borrowed.release(); }
  }
  async function save(owner: Session, next: SavedView): Promise<void> {
    const view = requireSaved(owner);
    try {
      await current(owner, view.borrow.storage.saveView(view.hostId, next));
      if (owner.view?.borrow.storage !== view.borrow.storage) throw new Error('The saved view changed.');
      owner.view = { ...view, saved: next };
      if (owner.catalog?.storage === view.borrow.storage) owner.navigation = next.route ? { storage: view.borrow.storage, scope: next.route } : null;
      publish({});
    } catch (cause) { failStorage(owner, view.borrow.storage, cause); throw cause; }
    if (next.route) await saveNavigation(owner, next.route);
  }
  async function saveNavigation(owner: Session, scope: ConversationScope): Promise<void> {
    const catalog = owner.catalog?.storage;
    if (!catalog?.saveNavigation || owner.navigation?.storage === catalog && sameScope(owner.navigation.scope, scope)) return;
    try {
      await current(owner, catalog.saveNavigation(scope.hostId, scope));
      owner.navigation = { storage: catalog, scope };
    }
    catch (cause) { failStorage(owner, catalog, cause); throw cause; }
  }
  function observeActive(owner: Session, target: OpenConversation): void {
    stopObservation();
    let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
    let pending: Promise<void> | null = null, retrying = false;
    const current = () => !stopped && session === owner && state.active?.store === target.store && state.host.kind === 'ready';
    const key = JSON.stringify([target.scope.hostId, target.scope.conversationId]), concluded = concludedScopes.get(key);
    publish({ observation: concluded ? { status: concluded, retrying: false } : null });
    function schedule(): void {
      const kind = state.observation?.status.kind;
      if (current() && !retrying && kind !== 'not-applicable' && kind !== 'concluded') timer = setTimeout(() => { void read('read'); }, 2_000);
    }
    function observed(status: ConversationObservation['status']): void {
      if (status.kind === 'concluded') concludedScopes.set(key, status);
      // The host never clears a closure, so a later failed read or a stopped status during an extension change is transient.
      // Only those are masked: any live status the host reports wins.
      const sticky = status.kind === 'unknown' || status.kind === 'stopped' ? concludedScopes.get(key) : undefined;
      publish({ observation: { status: sticky ?? status, retrying } });
    }
    function read(action: 'read' | 'retry'): Promise<void> {
      const task = (async () => {
        try {
          const status = await owner.connection.providerObservation({ scope: target.scope, action });
          if (current()) observed(status);
        } catch {
          if (current()) observed({ kind: 'unknown' });
        }
      })();
      pending = task;
      return task.finally(() => { if (pending === task) pending = null; schedule(); });
    }
    observationPoll = {
      stop() { stopped = true; clearTimeout(timer); },
      async retry() {
        if (!current() || retrying || !state.observation || state.observation.status.kind === 'unknown' || !canRetryObservation(state.observation.status)) return;
        retrying = true;
        publish({ observation: { ...state.observation, retrying: true } });
        clearTimeout(timer);
        await pending;
        if (!current()) return;
        await read('retry');
        retrying = false;
        if (current() && state.observation) publish({ observation: { ...state.observation, retrying: false } });
        schedule();
      },
    };
    void read('read');
  }
  /** Reopens a saved route at the newest segment, then saves that route only after its draft has moved. */
  async function reopenNewest(owner: Session, route: ConversationScope, report: (outcome: ConversationOpenResult) => void, purpose: PlacementPurpose): Promise<void> {
    const retained = owner.activeOwner?.target, permission = continuations.carry(owner, route);
    const reactivatePredecessor = async () => {
      const active = owner.activeOwner?.target;
      if (session === owner && state.host.kind === 'ready' && retained && active?.store === retained.store && sameScope(retained.scope, route)) {
        await activate(owner, active.scope, active.agent, { followContinuation: false });
      }
    };
    let opened: ConversationOpenResult, newest: ConversationScope;
    try {
      newest = await continuations.newestSegment(owner, route);
      opened = await install(owner, newest, null, sameScope(newest, route) ? null : route, undefined, purpose, !permission.explicit);
    }
    catch (cause) {
      try { await reactivatePredecessor(); }
      catch (restoration) { throw new Error(`${message(cause)} Source restoration failed: ${message(restoration)}`); }
      throw cause;
    }
    if (!sameScope(newest, route)) permission.placed(opened);
    report(opened);
    if (opened.kind !== 'inline') {
      await reactivatePredecessor(); return;
    }
    await continuations.moveDraft(owner, route, !permission.explicit);
    if (!sameScope(newest, route)) { permission.moved(); await save(owner, { ...requireSaved(owner).saved, route: newest }); }
  }
  async function createConversation(owner: Session, agentId?: string, carried?: ConversationScope, arrived: ConversationContinuation['arrived'] = null, reserved?: ConversationScope, initialDraft: string | null = null, intentRef?: PlacementIntentRef): Promise<ConversationOpenResult> {
    const host = requireHost(owner);
    const { saved } = requireSaved(owner);
    if (saved.pendingCreation) throw new Error('Recover the pending creation before creating another conversation.');
    const selected = agentId ?? host.defaultAgentId;
    if (selected === null) throw new Error('No agent is available to start a conversation.');
    const agent = host.agents.find(agent => agent.id === selected);
    if (!agent || agent.availability.kind !== 'ready') throw new Error('Choose an available agent.');
    const delegated = reserved ? null : await deps.placement?.delegateCreate?.(selected, carried !== undefined, initialDraft);
    if (delegated) return delegated;
    const scope = reserved ?? { hostId: host.hostId, conversationId: deps.createId() };
    if (scope.hostId !== host.hostId) throw new Error('Reserved conversation belongs to another host.');
    const placement = await place(owner, scope, agent, true, carried ?? null, initialDraft, intentRef);
    if (placement.kind !== 'inline') return placement;
    if (initialDraft !== null) {
      const storage = local(owner);
      if (!storage.saveInitialDraft) throw new Error('This editor cannot prepare an initial draft');
      await current(owner, storage.saveInitialDraft(scope, selected, initialDraft));
    }
    try {
      await save(owner, { ...requireSaved(owner).saved, pendingCreation: { scope, agentId: selected, ...(carried ? { carryFrom: carried } : {}) } });
      await saveNavigation(owner, scope);
      requireHost(owner);
      return await completeCreation(owner, scope, selected, carried, arrived, intentRef);
    }
    catch (error) {
      if (owner.view?.saved?.pendingCreation && sameScope(owner.view.saved.pendingCreation.scope, scope)) {
        fail(owner, error); return { kind: 'pending', scope, reason: 'Creation needs confirmation in its saved editor.' };
      }
      throw error;
    }
  }
  async function exposeUnsentDraft(owner: Session, scope: ConversationScope): Promise<boolean> {
    let held: StoreBorrow | null;
    try { held = await recoverDraft(owner, scope); } catch { if (session === owner) publish({ savedViewNotice: 'The original draft could not be read. Its saved records are preserved.' }); return false; }
    if (!held) return false;
    try {
      const captured = await current(owner, held.store.captureDraft());
      if (!captured.text) return false;
      publish({ savedDraftRecovery: { kind: 'bound', viewId: held.storage.viewId, scope, text: captured.text } });
      return true;
    } finally { held.release(); }
  }
  async function install(owner: Session, scope: ConversationScope, arrived: ConversationContinuation['arrived'] = null, predecessor: ConversationScope | null = null, intentRef?: PlacementIntentRef, purpose: PlacementPurpose = 'explicit', carryEmptyOnly?: boolean): Promise<ConversationOpenResult> {
    const found = await current(owner, owner.connection.conversationAgent(scope));
    if (!found) { const recovered = await exposeUnsentDraft(owner, scope); throw new Error(`Conversation does not exist.${recovered ? ' Saved unsent text is available to copy.' : ''}`); }
    const agent = compatibleAgent(found);
    const carryFrom = predecessor ?? (arrived === 'continue' ? state.active?.scope ?? null : null);
    const placement = await place(owner, scope, agent, false, carryFrom, null, intentRef, purpose, carryEmptyOnly);
    if (placement.kind !== 'inline') return placement;
    return activate(owner, scope, agent, { arrived, persistNavigation: carryFrom === null || sameScope(carryFrom, scope) });
  }
  async function activate(owner: Session, scope: ConversationScope, agent: AgentDescriptor, { arrived = null, followContinuation = true, persistNavigation = true }: {
    readonly arrived?: ConversationContinuation['arrived']; readonly followContinuation?: boolean; readonly persistNavigation?: boolean;
  } = {}): Promise<ConversationOpenResult> {
    const storage = local(owner);
    const lease = owner.view?.borrow;
    if (!lease) throw new Error('The original view lease is unavailable.');
    const borrow = await owner.pool.active(lease, scope, agent.id);
    try {
      requireHost(owner);
      const store = borrow.store;
      if (persistNavigation) await saveNavigation(owner, scope);
      const previous = owner.activeOwner;
      if (previous?.target.store === store) {
        const active: OpenConversation = { ...previous.target, agent };
        setActive(owner, { borrow: previous.borrow, target: active });
        publish({});
        requireHost(owner);
        observeActive(owner, active);
        continuations.watch(owner, active, arrived, followContinuation);
        subscribeActive(owner, active);
        await current(owner, store.connect());
        refreshPermissions(owner, active); return { kind: 'inline', scope };
      }
      disconnectActive();
      requireHost(owner);
      const active: OpenConversation = { scope, agent, viewId: storage.viewId, store };
      setActive(owner, { borrow, target: active });
      publish({ permissionState: { kind: 'loading', listing: null, reason: 'Reading permissions…' } });
      requireHost(owner);
      observeActive(owner, active);
      continuations.watch(owner, active, arrived, followContinuation);
      subscribeActive(owner, active);
      await current(owner, store.connect());
      refreshPermissions(owner, active);
    } finally { if (owner.activeOwner?.borrow !== borrow) borrow.release(); }
    return { kind: 'inline', scope };
  }
  function subscribeActive(owner: Session, active: OpenConversation): void {
    if (unsubscribeActive) return;
    const { store, scope, agent } = active;
    let connected = false;
    unsubscribeActive = store.subscribe(() => {
      if (session !== owner || state.active?.store !== store) return;
      const snapshot = store.getSnapshot();
      if (snapshot.connection.kind !== 'connected') {
        if (connected) stalePermissions('Reconnect to refresh permissions.');
        connected = false;
        return;
      }
      if (!connected && state.active) refreshPermissions(owner, state.active);
      connected = true;
      const patch = patchEntries('kind' in agent ? agent.namespace : null, withPreview(scope, conversationPreview(snapshot.document.domain)));
      if (patch.catalog || patch.workspaces) publish(patch);
    });
  }
  function workspaceFor(namespace: string): ApplicationSnapshot['workspaces'][string] | undefined {
    return Object.hasOwn(state.workspaces, namespace) ? state.workspaces[namespace] : undefined;
  }
  async function readCatalog(owner: Session, hostId: string, after: string | null = null): Promise<void> {
    const items = await current(owner, owner.connection.catalog(after, SERVICE_CATALOG_PAGE));
    if (items.some(entry => entry.scope.hostId !== hostId)) throw new Error('Catalog belongs to another host.');
    const next = items.length === SERVICE_CATALOG_PAGE ? items.at(-1)?.scope.conversationId ?? null : null;
    if (next !== null && next === after) throw new Error('Catalog did not advance.');
    publish({ catalog: { items: mergePage(state.catalog.items, items, after === null), after: next } });
    for (const namespace of new Set(items.flatMap(entry => entry.provider ? [entry.provider.namespace] : []))) {
      const workspace = workspaceFor(namespace);
      if (workspace) {
        const page = new Map(items.filter(entry => entry.provider?.namespace === namespace).map(entry => [entryKey(entry), entry]));
        const entries = workspace.entries.map(entry => page.get(entryKey(entry)) ?? entry);
        publish({ workspaces: { ...state.workspaces, [namespace]: { ...workspace, entries } } });
      }
    }
  }
  /**
   * Applies `update` to the catalog and, when that namespace's workspace is loaded, to its entries. Returns one partial
   * snapshot holding each list that changed, so a caller publishes them together. `update` returns null for no change.
   */
  function patchEntries(namespace: string | null, update: EntriesUpdate): Partial<Pick<ApplicationSnapshot, 'catalog' | 'workspaces'>> {
    const items = update(state.catalog.items), workspace = namespace === null ? undefined : workspaceFor(namespace);
    const entries = workspace ? update(workspace.entries) : null;
    return { ...(items ? { catalog: { ...state.catalog, items } } : {}),
      ...(namespace !== null && workspace && entries ? { workspaces: { ...state.workspaces, [namespace]: { ...workspace, entries } } } : {}) };
  }
  /** The latest load per namespace. A first-page load supersedes any load in flight; a superseded load publishes nothing. */
  const workspaceLoads = new Map<string, number>();
  /** A cleared workspace must not accept a page that started on the previous host or view. */
  function invalidateWorkspaceLoads(): void {
    for (const namespace of workspaceLoads.keys()) workspaceLoads.set(namespace, (workspaceLoads.get(namespace) ?? 0) + 1);
  }
  async function readWorkspace(owner: Session, namespace: string, more: boolean): Promise<void> {
    const { hostId } = requireHost(owner);
    const previous = workspaceFor(namespace);
    if (more && (!previous || previous.loading || !previous.hasMore)) return;
    const load = (workspaceLoads.get(namespace) ?? 0) + 1;
    workspaceLoads.set(namespace, load);
    const latest = () => workspaceLoads.get(namespace) === load;
    const after = more ? previous?.after ?? null : null;
    const baseline = new Set((previous?.entries ?? []).map(entryKey));
    publish({ workspaces: { ...state.workspaces, [namespace]: { entries: previous?.entries ?? [], after: previous?.after ?? null, hasMore: previous?.hasMore ?? false, loading: true } } });
    try {
      const items = await current(owner, owner.connection.catalog(after, SERVICE_CATALOG_PAGE, { kind: 'namespace', namespace }));
      if (!latest()) return;
      if (items.some(entry => entry.scope.hostId !== hostId || entry.provider?.namespace !== namespace)) throw new Error('Workspace catalog belongs to another namespace or host.');
      const next = items.length === SERVICE_CATALOG_PAGE ? items.at(-1)?.scope.conversationId ?? null : null;
      if (next !== null && next === after) throw new Error('Workspace catalog did not advance.');
      const page = mergePage(workspaceFor(namespace)?.entries ?? [], items, !more);
      const arrived = new Set(page.map(entryKey));
      // A first page replaces what was loaded, but keeps a conversation added after this request started.
      const kept = !more ? (workspaceFor(namespace)?.entries ?? []).filter(entry => {
        const key = entryKey(entry);
        return !baseline.has(key) && !arrived.has(key);
      }) : [];
      publish({ workspaces: { ...state.workspaces, [namespace]: {
        entries: [...kept, ...page], after: next,
        hasMore: items.length === SERVICE_CATALOG_PAGE, loading: false,
      } } });
    } catch (cause) {
      if (!latest()) return;
      const current = workspaceFor(namespace);
      if (session === owner) publish({ workspaces: { ...state.workspaces, [namespace]: {
        entries: current?.entries ?? [], after: current?.after ?? null, hasMore: current?.hasMore ?? false, loading: false,
      } } });
      throw cause;
    }
  }
  /** A workspace action: the first page, or the next one when `more`, for the current session. */
  const workspaceRead = (more: boolean) => async (namespace: string): Promise<void> => {
    const owner = session;
    if (!owner) return;
    try { await readWorkspace(owner, namespace, more); } catch (cause) { fail(owner, cause); }
  };
  async function readSavedViews(owner: Session, hostId: string, after: string | null = null): Promise<void> {
    try {
      const page = await current(owner, local(owner).savedViews(hostId, after));
      publish({ savedViews: { items: after === null ? page.ids : [...state.savedViews.items, ...page.ids], after: page.after },
        savedViewNotice: page.unreadable ? `${page.unreadable} saved views on this page could not be opened. Their records were left untouched.` : '' });
    } catch {
      if (session === owner) publish({ savedViewNotice: 'Saved views could not be listed. This view and its records remain available.' });
    }
  }
  /** Bumped by every metadata read, so a `refreshMetadata` reply that a later read superseded publishes nothing. */
  let metadataReads = 0;
  async function refresh(owner: Session, purpose: PlacementPurpose = 'passive'): Promise<void> {
    metadataReads++;
    let storage = local(owner);
    publish({ host: { kind: 'loading' }, error: '' });
    stopObservation();
    stalePermissions('Reconnecting to refresh permissions.');
    let held: StoreBorrow | undefined;
    try {
      const received = await current(owner, owner.connection.metadata());
      const metadata = { ...received, agents: received.agents.map(compatibleAgent) };
      const compatibility = checkCompatibility(SOLO_CLIENT_COMPATIBILITY, metadata.compatibility);
      const issues = compatibility.kind === 'incompatible' ? compatibility.issues.filter(issue => issue.dimension !== 'native-runtime') : [];
      await current(owner, owner.frontend.session(issues.length ? null : metadata, owner.connection));
      if (state.host.kind === 'unavailable') { owner.frontend.pause(); return; }
      if (owner.hostId !== null && (owner.hostId !== metadata.hostId || owner.principalId !== metadata.principalId)) { owner.continuationCarries.clear(); owner.pendingContinuationCarries.clear(); }
      if (owner.principalId !== null && owner.principalId !== metadata.principalId) {
        disconnectActive();
        local(owner);
        held = owner.activeOwner?.borrow;
        owner.activeOwner = null;
        publish({});
        local(owner);
      }
      owner.principalId = metadata.principalId;
      const previous = owner.view;
      if (owner.hostId !== null && owner.hostId !== metadata.hostId) {
        disconnectActive();
        setActive(owner, null);
        if (previous) owner.view = { borrow: previous.borrow, saved: null };
        invalidateWorkspaceLoads();
        publish({ ...DETACHED_VIEW, lastPlacement: null });
        if (!deps.fixedScope && owner.catalog && owner.catalog.storage !== storage) storage = await acquire(owner, owner.catalog.storage.viewId, purpose);
      }
      owner.hostId = metadata.hostId;
      if (issues.length) {
        state.active?.store.disconnect();
        publish({ host: { kind: 'incompatible', metadata, issues }, error: '' });
        return;
      }
      const saved = await current(owner, storage.readView(metadata.hostId)).catch(cause => {
        failStorage(owner, storage, cause);
        throw cause;
      });
      const borrow = owner.view?.borrow;
      if (!borrow) throw new Error('The original view lease is unavailable.');
      owner.view = { borrow, saved, hostId: metadata.hostId };
      if (controller.getSnapshot().host.kind === 'unavailable') { owner.frontend.pause(); return; }
      const pending = saved.pendingCreation;
      const placement = pending && [...pendingCreations].find(([, creation]) => creation.viewId === storage.viewId && creation.principalId === metadata.principalId
        && creation.scope.hostId === metadata.hostId && creation.agentId === pending.agentId && sameScope(creation.scope, pending.scope));
      publish({ host: { kind: 'ready', metadata }, error: '', ...(placement && state.lastPlacement === null ? { lastPlacement: placement[0] } : {}) });
      const retained = saved.pendingCreation ? owner.activeOwner?.target : undefined;
      await clearConfirmedCreations(owner);
      const restoredSaved = requireSaved(owner).saved;
      const { hostId } = metadata;
      let restoreFailed = false, restoreRoute = true;
      if (saved.route && storage.viewId === deps.ownedViewStorage.catalogViewId) {
        try {
          restoreRoute = await current(owner, deps.placement?.restoresInline?.(saved.route, purpose) ?? Promise.resolve(true));
          if (restoreRoute) {
            const editor = await current(owner, deps.ownedViewStorage.locate?.(saved.route) ?? Promise.resolve(null));
            if (editor && editor !== storage.viewId) { await acquire(owner, editor, purpose); await refresh(owner, purpose); return; }
          }
        } catch (cause) { restoreFailed = true; fail(owner, cause); }
      }
      let reported = false;
      const reportRestored = (outcome: ConversationOpenResult) => { reported = true; reportPlacement(owner, outcome); };
      let restoring: Promise<unknown> = Promise.resolve();
      if (!restoreFailed && restoreRoute && restoredSaved.route) {
        if (retained && sameScope(retained.scope, restoredSaved.route)) restoring = activate(owner, retained.scope, retained.agent);
        else if (!deps.placement || !restoredSaved.pendingCreation) {
          if (!deps.fixedScope) restoring = reopenNewest(owner, restoredSaved.route, reportRestored, purpose);
          else if (sameScope(restoredSaved.route, deps.fixedScope)) restoring = install(owner, deps.fixedScope).then(reportRestored);
          else restoring = Promise.reject(new Error('This window cannot replace its assigned conversation.'));
        }
      }
      const results = await Promise.allSettled([readCatalog(owner, hostId), readSavedViews(owner, hostId), restoring.catch(cause => {
        if (cause instanceof PlacementSuperseded) return;
        if (!reported) reportRestored({ kind: 'refused', reason: message(cause).slice(0, 1000).replace(/[\uD800-\uDBFF]$/u, '') || 'The conversation could not be opened.' });
        throw cause;
      })]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') fail(owner, failed.reason);
    } catch (cause) { fail(owner, cause, 'handshake'); }
    finally { held?.release(); }
  }
  async function releaseBusy(owner: Session): Promise<void> {
    if (session !== owner) return;
    let version: number;
    do {
      version = creationConfirmationVersion;
      await clearConfirmedCreations(owner);
    } while (session === owner && version !== creationConfirmationVersion);
    if (session === owner) publish({ busy: false });
  }
  async function run<T>(operation: (owner: Session) => Promise<T>): Promise<T | undefined> {
    const owner = session;
    if (!owner || state.busy) return;
    owner.navigation = null;
    publish({ busy: true, ...(state.host.kind === 'ready' ? { error: '' } : {}) });
    try { return await operation(owner); }
    catch (cause) { fail(owner, cause); } finally { await releaseBusy(owner); }
  }
  async function submitCommand(owner: Session | null, target: OpenConversation, operation: () => Promise<SubmitResult>): Promise<SubmitResult> {
    if (!owner || session !== owner) throw new Error('This application has closed.');
    if (state.busy) throw new Error('Another operation is in progress.');
    requireTarget(owner, target);
    stalePermissions('A command is in progress. Permissions will refresh afterward.');
    publish({ busy: true, error: '' });
    try {
      if (target.agent.availability.kind !== 'ready') throw new Error(target.agent.availability.reason);
      const result = await current(owner, operation());
      if (result.kind === 'rejected') publish({ error: refusalMessage(result.reason) });
      else if (result.receipt.state.kind === 'rejected') publish({ error: result.receipt.state.reason });
      return result;
    } catch (cause) {
      fail(owner, cause);
      throw cause;
    } finally { await releaseBusy(owner); if (session === owner) refreshPermissions(owner, target); }
  }
  async function completeCreation(owner: Session, scope: ConversationScope, agentId: string, carried?: ConversationScope, arrived: ConversationContinuation['arrived'] = null, intentRef?: PlacementIntentRef): Promise<ConversationOpenResult> {
    const view = requireSaved(owner), host = requireHost(owner);
    carried ??= view.saved.pendingCreation?.carryFrom;
    const matches = () => session === owner && state.host.kind === 'ready' && state.host.metadata.principalId === host.principalId && state.host.metadata.hostId === host.hostId && owner.view?.borrow.storage === view.borrow.storage && owner.view.saved !== null && owner.view.hostId === scope.hostId &&
      owner.view.saved?.pendingCreation?.agentId === agentId && sameScope(owner.view.saved.pendingCreation.scope, scope);
    try { await current(owner, owner.connection.create(scope, agentId)); }
    catch (error) {
      if (error instanceof ServiceError && error.kind === 'create-rejected' && matches()) {
        await exposeUnsentDraft(owner, scope);
        const saved = requireSaved(owner).saved;
        await save(owner, { version: 2, route: saved.route, pendingCreation: null });
        return { kind: 'refused', reason: placementReason(error) };
      }
      throw error;
    }
    if (!matches()) throw new Error('The creation view changed. Recover it in its original view.');
    const created = host.agents.find(agent => agent.id === agentId);
    const provider = created && 'kind' in created && created.providerAgentId !== null
      ? { namespace: created.namespace, installationId: created.installationId, providerAgentId: created.providerAgentId } : null;
    publish(patchEntries(provider?.namespace ?? null, prepended({ scope, preview: null, provider })));
    const placed = await install(owner, scope, arrived, carried ?? null, intentRef);
    if (placed.kind !== 'inline') {
      const confirmation = { scope, viewId: view.borrow.storage.viewId, agentId, principalId: host.principalId };
      confirmCreationPlacement(placed, confirmation);
      return placed;
    }
    if (carried && !deps.fixedScope) await continuations.moveDraft(owner, carried);
    await save(owner, { version: 2, route: scope, pendingCreation: null });
    return placed;
  }

  async function clearConfirmedCreations(owner: Session): Promise<void> {
    if (session !== owner || state.host.kind !== 'ready' || state.storageFailure) return;
    const view = owner.view;
    if (!view || view.saved === null || view.hostId !== state.host.metadata.hostId) return;
    for (const creation of confirmedCreations) {
      if (creation.viewId !== view.borrow.storage.viewId || creation.scope.hostId !== view.hostId || creation.principalId !== state.host.metadata.principalId) continue;
      const pending = view.saved.pendingCreation;
      if (!pending || pending.agentId !== creation.agentId || !sameScope(pending.scope, creation.scope)) {
        confirmedCreations.delete(creation);
        continue;
      }
      try {
        await save(owner, { ...view.saved, pendingCreation: null });
        confirmedCreations.delete(creation);
      } catch (cause) { fail(owner, cause); }
      return;
    }
  }
  function finishCreationPlacement(creation: CreationConfirmation): void {
    confirmedCreations.add(creation);
    creationConfirmationVersion++;
    const owner = session;
    if (!owner || state.busy || state.host.kind !== 'ready' || state.storageFailure) return;
    publish({ busy: true });
    void releaseBusy(owner);
  }
  function confirmCreationPlacement(placed: ConversationOpenResult, confirmation: CreationConfirmation): void {
    if (placed.kind === 'pending') pendingCreations.set(placed, confirmation);
    if (placed.kind === 'detached') finishCreationPlacement(confirmation);
  }

  function requireTarget(owner: Session, target: OpenConversation): void {
    requireHost(owner);
    if (state.active !== target) throw new Error('Open the command’s conversation before continuing.');
  }
  const controller: ApplicationController = {
    frontendGenerations: generations,
    async releaseCapturedSend(key) {
      const owner = session;
      if (!owner) return;
      try { await owner.frontend.release(key); }
      catch (cause) { if (session === owner) publish({ error: message(cause) }); }
    },
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (session) return Promise.resolve();
      if (disposal?.settled) disposal = null;
      const closing = disposal?.promise;
      const connection = deps.createConnection({ onConnectionLost: cause => lose(next, cause) });
      const next: Session = {
        recovery: createFrontendRecovery(), navigation: null, hostId: null, principalId: null, continuationCarries: new Set(), pendingContinuationCarries: new Map(), quiescingViewId: null, catalog: null, activeOwner: null, view: null, images: imageTransfers(connection),
        pool: createViewLeasePool({
          createStore: (storage, scope, agentId, capture) => {
            const frontend = next.frontend.forStore({ viewId: storage.viewId, scope, capture, recoveryNeeded: () => next.recovery.wake({ pool: next.pool, storage }), eligibility: () => {
              if (state.host.kind !== 'ready') return 'unsupported';
              const active = next.activeOwner?.target;
              return active?.viewId === storage.viewId && sameScope(active.scope, scope)
                ? active.agent.frontendOffers : state.host.metadata.agents.find(item => item.id === agentId())?.frontendOffers ?? 'unsupported';
            } });
            const store = createConversationStore({ scope,
            port: next.connection.conversation(scope), projection: transcriptProjection,
            drafts: storage.drafts(error => next.pool.failed(storage, error)), createCommandId: deps.createId,
            images: { upload: input => next.images.upload(input) },
            frontend });
            return { ...store, async dispose() { try { await store.dispose(); } finally { frontend.dispose(); } } };
          },
          failed: (storage, error) => failStorage(next, storage, error),
        }),
        connection,
        frontend: createFrontendSends({
          generations,
          rowsChanged() {
            if (session !== next) return;
            const capturedSends = next.frontend.snapshot();
            if (capturedSends !== state.capturedSends) publish({ capturedSends });
          },
        }),
      };
      session = next;
      publish(initialSnapshot());
      return run(async owner => {
        try {
          if (closing) await current(owner, closing);
          await current(owner, acquire(owner, null));
        }
        catch (cause) { failStorage(owner, null, cause); if (session === owner) publish({ host: { kind: 'unavailable' } }); return; }
        await refresh(owner);
      });
    },
    canAutomaticallySend(scope) { return Boolean(state.active && sameScope(state.active.scope, scope) && (deps.placement?.canAutomaticallySend?.() ?? true)); },
    async prepareClose() {
      const owner = session;
      if (!owner) return;
      if (!owner.view && !owner.activeOwner) return;
      local(owner);
      await current(owner, owner.pool.flushDrafts());
      local(owner);
    },
    dispose() {
      lifecycle++;
      if (!session && disposal) return disposal.promise;
      const owner = session, drains: unknown[] = [disposal && !disposal.settled ? disposal.promise : undefined];
      owner?.continuationCarries.clear(); owner?.pendingContinuationCarries.clear();
      const closing = Promise.resolve().then(async () => {
        const results = await Promise.allSettled(drains);
        const failures = results.filter(result => result.status === 'rejected');
        if (failures.length === 1 && failures[0]) throw failures[0].reason;
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Application disposal failed');
      });
      const pending = { promise: closing, settled: false };
      disposal = pending;
      const settled = () => { pending.settled = true; };
      void closing.then(settled, settled);
      const observation = observationPoll, unsubscribe = unsubscribeActive;
      observationPoll = null;
      unsubscribeActive = null;
      session = null;
      for (const close of [() => owner?.frontend.dispose(), () => owner?.pool.dispose(),
        () => { owner?.recovery.retarget(null); owner?.recovery.suspend(false); }, () => observation?.stop(), () => continuations.stop(), () => unsubscribe?.(),
        () => { if (owner) setActive(owner, null); },
        () => { if (session === null && disposal === pending) stalePermissions('Reconnect to refresh permissions.'); }]) {
        try { drains.push(close()); } catch (error) { drains.push(Promise.reject(error)); }
      }
      return closing;
    },
    reconnect: () => !session && state.storageFailure ? controller.start() : run(async owner => {
      if (state.storageFailure) {
        const restart = lifecycle + 1;
        try { await controller.dispose(); if (lifecycle === restart && !session) await controller.start(); }
        catch (cause) { if (lifecycle === restart && !session) publish({ busy: false, storageFailure: message(cause), error: message(cause) }); }
        return;
      }
      await refresh(owner);
    }),
    dismissSavedDraftRecovery(expected) { if (state.savedDraftRecovery === expected) publish({ savedDraftRecovery: null }); },
    openRemainingSavedWork: expected => run(async owner => {
      if (state.savedDraftRecovery !== expected || expected.kind !== 'independent') return;
      const host = requireHost(owner);
      await current(owner, acquire(owner, expected.viewId, 'explicit', storage => storage.openRemainingWork?.(host.hostId) ?? Promise.resolve()));
      disconnectActive(); setActive(owner, null); invalidateWorkspaceLoads();
      publish({ ...DETACHED_VIEW, host: { kind: 'loading' }, savedDraftRecovery: expected, lastPlacement: null });
      await refresh(owner, 'explicit');
      return state.lastPlacement ?? undefined;
    }),
    inspectSavedDraft: (viewId, scope) => run(async owner => {
      const host = requireHost(owner), saved = await current(owner, deps.ownedViewStorage.readLegacyDraft?.(viewId, host.hostId, scope) ?? Promise.resolve(null));
      if (saved) publish({ savedDraftRecovery: saved });
    }),
    async reopenView(viewId) {
      if (!session || state.busy) return false;
      let opened = false;
      await run(async owner => {
        const previousActive = owner.activeOwner?.target;
        const didOpen = () => {
          const target = owner.activeOwner?.target;
          return session === owner && state.host.kind === 'ready' && !state.storageFailure && !state.error && target !== undefined && target !== previousActive
            && (target.viewId === viewId || state.lastPlacement?.kind === 'inline' && sameScope(target.scope, state.lastPlacement.scope));
        };
        const host = requireHost(owner);
        const recovery = owner.pool.holds(viewId) ? null : await current(owner, deps.ownedViewStorage.readLegacyDraft?.(viewId, host.hostId, state.active?.scope) ?? Promise.resolve(null));
        if (recovery) {
          if (recovery.kind === 'independent' || !recovery.pendingCreation && await current(owner, owner.connection.conversationAgent(recovery.scope)) === null) { publish({ savedDraftRecovery: recovery }); return; }
          const continuation = recovery.pendingCreation ? null : await current(owner, owner.connection.continuation({ scope: recovery.scope, action: 'read' }));
          if (continuation?.successor?.kind === 'confirmed') { publish({ savedDraftRecovery: { ...recovery, kind: 'continued' } }); return; }
        }
        const previous = owner.view;
        const next = await current(owner, acquire(owner, viewId));
        if (previous?.borrow.storage === next) { await refresh(owner, 'explicit'); opened = didOpen(); return; }
        disconnectActive();
        setActive(owner, null);
        invalidateWorkspaceLoads();
        publish({ ...DETACHED_VIEW, host: { kind: 'loading' } });
        await refresh(owner, 'explicit');
        opened = didOpen();
      });
      return opened;
    },
    refreshCatalog: () => run(async owner => { const host = requireHost(owner); await readCatalog(owner, host.hostId); }),
    moreConversations: () => run(async owner => {
      const host = requireHost(owner);
      if (state.catalog.after !== null) await readCatalog(owner, host.hostId, state.catalog.after);
    }),
    async search(query, after, signal) {
      const owner = session;
      if (!owner) throw new Error('This application has closed.');
      const { hostId, principalId } = requireHost(owner);
      const page = await current(owner, owner.connection.search(query, after));
      const host = requireHost(owner);
      if (signal.aborted || host.hostId !== hostId || host.principalId !== principalId) throw new Error('Search connection changed.');
      if (page.items.some(entry => entry.scope.hostId !== hostId)) throw new Error('Search belongs to another host.');
      if (page.after !== null && page.after === after) throw new Error('Search did not advance.');
      return page;
    },
    moreSavedViews: () => run(async owner => {
      const host = requireHost(owner);
      if (state.savedViews.after !== null) await readSavedViews(owner, host.hostId, state.savedViews.after);
    }),
    create: (agentId, initialDraft) => opening(owner => createConversation(owner, agentId, undefined, null, undefined, initialDraft ?? null)),
    createReserved: (scope, agentId, intentRef) => opening(owner => createConversation(owner, agentId, undefined, null, scope, null, intentRef)),
    openReserved: (scope, intentRef, purpose) => opening(async owner => {
      if (requireHost(owner).hostId !== scope.hostId) throw new Error('Conversation belongs to another host.');
      const result = await install(owner, scope, null, null, intentRef, purpose);
      if (result.kind === 'inline') await save(owner, { ...requireSaved(owner).saved, route: scope });
      return result;
    }),
    pendingPlacements() {
      const pending = [...pendingCreations.keys(), ...(session?.pendingContinuationCarries.keys() ?? [])];
      const continuing = continuations.pendingPlacement(), latest = state.lastPlacement;
      if (continuing && !pending.includes(continuing)) pending.push(continuing);
      if (latest?.kind === 'pending' && !pending.includes(latest)) pending.push(latest);
      return pending;
    },
    settlePlacement(expected, result) {
      const creation = pendingCreations.get(expected);
      if (!session && !creation) return false;
      const settled = session ? continuations.settlePlacement(session, expected, result) : false;
      const created = creation !== undefined;
      if (creation) {
        pendingCreations.delete(expected);
        if (result.kind !== 'refused') finishCreationPlacement(creation);
      }
      if (!session || state.lastPlacement !== expected) return settled || created;
      publish({ lastPlacement: result, ...(result.kind === 'refused' && state.host.kind === 'ready' && !state.busy ? { error: result.reason } : {}) }); return true;
    },
    async settleCarriedDraft(carry) {
      const owner = session; if (!owner) return;
      const held = await recoverDraft(owner, carry.source); if (!held) return;
      try {
        await current(owner, held.store.transferDraft(carry.expected, '', { kind: 'release', source: carry.source, requestId: carry.requestId }));
      } finally { held.release(); }
    },
    async capturePlacementDraft(scope) {
      const owner = session; if (!owner) throw new Error('This application has closed.');
      const held = await recoverDraft(owner, scope); if (!held) return null;
      try {
        const captured = await current(owner, held.store.captureDraft());
        return { viewId: held.storage.viewId, ...captured, recover() { if (session === owner && captured.text) publish({ savedDraftRecovery: { kind: 'bound', scope, viewId: held.storage.viewId, text: captured.text } }); } };
      }
      finally { held.release(); }
    },
    async inspectConversation(scope) {
      const owner = session;
      if (!owner || requireHost(owner).hostId !== scope.hostId) throw new Error('Conversation belongs to another host.');
      const agent = await current(owner, owner.connection.conversationAgent(scope));
      const continuation = agent ? await current(owner, owner.connection.continuation({ scope, action: 'read' })) : { predecessor: null, carried: null, closure: null, successor: null };
      return { agent, continuation };
    },
    recoverCreation: (selected, intentRef) => !session?.view?.saved?.pendingCreation ? Promise.resolve(undefined) : opening(async owner => {
      const view = requireSaved(owner), { saved } = view;
      const pending = saved.pendingCreation;
      if (!pending) throw new PlacementSuperseded();
      const existing = await current(owner, owner.connection.conversationAgent(pending.scope));
      if (requireSaved(owner) !== view) throw new Error('The creation view changed.');
      if (pending.agentId !== null && existing && existing.id !== pending.agentId) {
        throw new Error('This conversation belongs to a different agent. The saved creation still needs confirmation.');
      }
      if (pending.agentId !== null && selected !== undefined && selected !== pending.agentId) {
        throw new Error('Recovery must use the saved agent. The original creation still needs confirmation.');
      }
      const agentId = pending.agentId ?? existing?.id ?? selected ?? null;
      if (agentId === null) throw new Error('This older pending creation has no saved agent. Choose an agent explicitly to continue.');
      if (pending.agentId === null && !existing && selected !== undefined) {
        const host = await current(owner, owner.connection.metadata());
        if (requireSaved(owner) !== view) throw new Error('The creation view changed.');
        const agent = host.agents.find(agent => agent.id === selected);
        if (!agent || agent.availability.kind !== 'ready') throw new Error('Choose an available agent.');
      }
      if (agentId !== pending.agentId) {
        await save(owner, { ...saved, pendingCreation: { ...pending, agentId } });
      }
      const agent = existing ?? requireHost(owner).agents.find(agent => agent.id === agentId);
      const complete = async () => {
        try { return await completeCreation(owner, pending.scope, agentId, undefined, null, intentRef); }
        catch (cause) {
          if (cause instanceof PlacementSuperseded || session !== owner || !owner.view?.saved?.pendingCreation || !sameScope(owner.view.saved.pendingCreation.scope, pending.scope)) throw cause;
          fail(owner, cause);
          return { kind: 'pending', scope: pending.scope, reason: 'Creation needs confirmation in its saved editor.' } satisfies ConversationOpenResult;
        }
      };
      if (!agent) return complete();
      const confirmation = { scope: pending.scope, viewId: view.borrow.storage.viewId, agentId, principalId: requireHost(owner).principalId };
      const placement = await place(owner, pending.scope, agent, true, pending.carryFrom ?? null, null, intentRef);
      if (placement.kind !== 'inline') {
        if (existing) confirmCreationPlacement(placement, confirmation);
        return placement;
      }
      return complete();
    }),
    open: scope => opening(async owner => {
      const host = requireHost(owner);
      if (scope.hostId !== host.hostId) throw new Error('Conversation belongs to another host.');
      requireSaved(owner);
      const newest = await continuations.newestSegment(owner, scope);
      const permission = continuations.carry(owner, scope);
      const opened = await install(owner, newest, null, sameScope(newest, scope) ? null : scope, undefined, 'explicit', !permission.explicit);
      if (!sameScope(newest, scope)) permission.placed(opened);
      if (opened.kind !== 'inline') return opened;
      await continuations.moveDraft(owner, scope, !permission.explicit);
      if (!sameScope(newest, scope)) permission.moved();
      await save(owner, { ...requireSaved(owner).saved, route: newest });
      return opened;
    }),
    loadWorkspace: workspaceRead(false),
    moreWorkspace: workspaceRead(true),
    async refreshMetadata() {
      const owner = session;
      if (!owner || state.host.kind !== 'ready') return;
      const read = ++metadataReads;
      try {
        const received = await current(owner, owner.connection.metadata());
        // A reconnect or a later refresh started since: its result stands, and this reply is stale.
        if (read !== metadataReads) return;
        const previous = requireHost(owner);
        const compatibility = checkCompatibility(SOLO_CLIENT_COMPATIBILITY, received.compatibility);
        const incompatible = compatibility.kind === 'incompatible' && compatibility.issues.some(issue => issue.dimension !== 'native-runtime');
        // A changed host, principal or compatibility needs the full handshake, which also blocks commands when incompatible.
        if (incompatible || received.hostId !== previous.hostId || received.principalId !== previous.principalId) {
          if (state.busy) {
            const retry = () => {
              if (session !== owner) { listeners.delete(retry); return; }
              if (!state.busy) { listeners.delete(retry); void run(refresh); }
            };
            listeners.add(retry); publish({ host: { kind: 'loading' } });
          } else await run(refresh);
          return;
        }
        publish({ host: { kind: 'ready', metadata: { ...received, agents: received.agents.map(compatibleAgent) } } });
      } catch (cause) { if (read === metadataReads) fail(owner, cause); }
    },
    async extensionCall(request) {
      const owner = session;
      if (!owner) return { kind: 'failed', cause: 'unavailable' };
      return owner.connection.extensionCall(request);
    },
    conversationActions(target) {
      const owner = session;
      const invoke = (kind: 'send' | 'approve' | 'cancel', operation: () => Promise<SubmitResult>) => submitCommand(owner, target, () => {
        const view = target.store.getSnapshot();
        if (view.connection.kind !== 'connected') throw new Error('Connect the conversation before continuing.');
        if (!target.agent.commands.includes(kind)) throw new Error('This agent does not support that command.');
        if (kind === 'send' && conversationResponding(agentPresentation('runtime' in target.agent ? target.agent.runtime : target.agent).agent, view.document.domain)) {
          throw new Error('Wait for the current response before sending.');
        }
        return operation();
      });
      return {
        async readImage(imageId) {
          if (!owner || session !== owner) throw new Error('This application has closed.');
          requireTarget(owner, target);
          return owner.images.read(target.scope, imageId);
        },
        async retryObservation() {
          if (owner && session === owner && state.active === target) await observationPoll?.retry();
        },
        continueConversation: () => run(async active => { if (active === owner) await continuations.act(active, target, 'start'); }),
        checkContinuation: () => run(async active => { if (active === owner) await continuations.act(active, target, 'check'); }),
        startNewChat: async () => {
          if (session !== owner) return;
          await opening(async active => {
            requireTarget(active, target);
            return createConversation(active, target.agent.id, target.scope, 'new-chat');
          });
        },
        async loadEarlierSegment() {
          if (owner && session === owner) await continuations.readEarlier(owner, target);
        },
        permissions: { async read() {
          if (!owner) throw new Error('Connect the conversation before continuing.');
          return readPermissions(owner, target);
        } },
        commands: {
          revokePermission: (permissionId, scope) => {
            if (!owner) return Promise.reject(new Error('Connect the conversation before continuing.'));
            try { requireTarget(owner, target); } catch (cause) { return Promise.reject(cause); }
            const current = state.permissionState;
            if (state.active !== target || current.kind !== 'fresh' ||
              !current.listing.permissions.some(row => row.permissionId === permissionId && row.scope === scope)) {
              return Promise.reject(new Error('Refresh permissions before revoking this permission.'));
            }
            return submitCommand(owner, target, () => target.store.revokePermission(permissionId, scope));
          },
          send: text => invoke('send', () => {
            if (typeof text !== 'string') throw new Error('An explicit message is required.');
            return target.store.send(text);
          }),
          approve: (pendingId, choiceId) => invoke('approve', () => target.store.approve(pendingId, choiceId)),
          cancel: runId => invoke('cancel', () => target.store.cancel(runId)),
        },
        async submit(operation) {
          try { await submitCommand(owner, target, operation); } catch {}
        },
        reconcile: id => run(async owner => {
          requireTarget(owner, target);
          await current(owner, owner.connection.reconcile(target.scope, id));
          await current(owner, target.store.refreshReceipt(id));
        }),
        abandon: id => run(async owner => {
          requireTarget(owner, target);
          const receipt = await current(owner, owner.connection.abandon(target.scope, id));
          await current(owner, target.store.refreshReceipt(id));
          if (receipt?.state.kind !== 'abandoned' && session === owner) publish({ error: NOTHING_TO_STOP_WAITING });
        }),
      };
    },
  };
  return controller;
}
