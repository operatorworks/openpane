import type { ConversationStore } from '@openpane/client';
import type { ConversationScope } from '@openpane/contracts';
import type { Transcript } from '@openpane/contracts/conversation';
import type { OwnedViewStorage } from './view-state.js';

type Store = ConversationStore<Transcript>;
export interface ViewBorrow { readonly storage: OwnedViewStorage; release(): void }
export interface CaptureBorrow { failed(error: unknown): void; release(): void }
export interface CaptureStore { borrow(): CaptureBorrow }
export interface StoreBorrow extends ViewBorrow, CaptureBorrow { readonly store: Store }
interface Slot { readonly store: Store; agentId: string | null; borrows: number; closing: Promise<void> | null }
type LeaseKind = 'editor' | 'recovery';
interface Lease { readonly kind: LeaseKind; readonly closed: Promise<void>; readonly didClose: () => void; readonly didFail: (error: unknown) => void; readonly storage: OwnedViewStorage; readonly stores: Map<string, Slot>; borrows: number; failureInterest: number; closing: Promise<void> | null }
export function createViewLeasePool(deps: {
  createStore(storage: OwnedViewStorage, scope: ConversationScope, agentId: () => string | null, capture: CaptureStore): Store;
  failed(storage: OwnedViewStorage | null, error: unknown): void;
}) {
  const leases = new Map<string, Lease>(), closes = new Set<Promise<void>>();
  let disposal: Promise<void> | null = null;
  function failed(lease: Lease, error: unknown): void {
    if (leases.get(lease.storage.viewId) === lease && lease.failureInterest > 0) deps.failed(lease.storage, error);
  }
  function track(task: Promise<void>): Promise<void> {
    closes.add(task);
    void task.then(() => closes.delete(task), () => {});
    return task;
  }
  function closeView(lease: Lease): void {
    if (lease.closing || lease.stores.size || (!disposal && lease.borrows)) return;
    lease.closing = track(Promise.resolve().then(() => lease.storage.close()).then(() => {
      if (leases.get(lease.storage.viewId) === lease) leases.delete(lease.storage.viewId);
      lease.didClose();
    }).catch(error => { lease.didFail(error); deps.failed(null, error); throw error; }));
  }
  function closeStore(lease: Lease, key: string, slot: Slot): void {
    if (slot.closing) return;
    let drain: Promise<void>;
    slot.closing = track(Promise.resolve().then(() => drain).finally(() => {
      if (lease.stores.get(key) === slot) lease.stores.delete(key);
      closeView(lease);
    }));
    try { drain = slot.store.dispose(); } catch (error) { drain = Promise.reject(error); }
  }
  function viewBorrow(lease: Lease, interested: boolean): ViewBorrow {
    if (disposal || lease.closing) throw new Error('The original view lease is unavailable.');
    lease.borrows++; lease.failureInterest += Number(interested);
    let released = false;
    return { storage: lease.storage, release() {
      if (released) return;
      released = true; lease.borrows--; lease.failureInterest -= Number(interested); closeView(lease);
    } };
  }
  function storeBorrow(lease: Lease, key: string, slot: Slot, interested: boolean): StoreBorrow {
    if (disposal || lease.closing || slot.closing) throw new Error('The original store is closing.');
    slot.borrows++; lease.failureInterest += Number(interested);
    let released = false;
    return { store: slot.store, storage: lease.storage, failed: error => failed(lease, error), release() {
      if (released) return;
      released = true; slot.borrows--; lease.failureInterest -= Number(interested);
      if (!slot.borrows) closeStore(lease, key, slot);
    } };
  }
  async function acquire(view: ViewBorrow, scope: ConversationScope, purpose: { readonly kind: 'active'; readonly agentId: string } | { readonly kind: 'recovery' }): Promise<StoreBorrow> {
    const lease = leases.get(view.storage.viewId);
    if (!lease || lease.storage !== view.storage || purpose.kind === 'active' && lease.kind !== 'editor') throw new Error('The original view lease is unavailable.');
    const interested = purpose.kind === 'active';
    const agentId = purpose.kind === 'active' ? purpose.agentId : null;
    const pending = viewBorrow(lease, interested), key = JSON.stringify([scope.hostId, scope.conversationId]);
    try {
      let slot = lease.stores.get(key);
      while (slot?.closing) { await slot.closing; slot = lease.stores.get(key); }
      if (disposal || lease.closing) throw new Error('The original view lease is unavailable.');
      if (!slot) {
        const cell: Slot = { agentId, borrows: 0, closing: null,
          store: deps.createStore(lease.storage, scope, () => cell.agentId, { borrow: () => storeBorrow(lease, key, cell, true) }) };
        slot = cell; lease.stores.set(key, slot);
      }
      if (agentId !== null) slot.agentId = agentId;
      const borrow = storeBorrow(lease, key, slot, interested);
      try { await slot.store.ready; return borrow; }
      catch (error) { if (interested) borrow.failed(error); borrow.release(); throw error; }
    } finally { pending.release(); }
  }
  function adopt(storage: OwnedViewStorage, kind: LeaseKind = 'editor'): ViewBorrow {
    let didClose = () => {}, didFail = (_error: unknown) => {};
    const closed = new Promise<void>((resolve, reject) => { didClose = resolve; didFail = reject; });
    void closed.catch(() => {});
    const lease: Lease = { kind, closed, didClose, didFail, storage, stores: new Map(), borrows: 0, failureInterest: 0, closing: null };
    leases.set(storage.viewId, lease);
    if (disposal) { closeView(lease); throw new Error('This application has closed.'); }
    return viewBorrow(lease, true);
  }
  const acquisitions = new Map<string, { users: number; readonly task: Promise<ViewBorrow | null>; readonly required: boolean; readonly kind: LeaseKind }>();
  async function open(viewId: string, load: () => Promise<OwnedViewStorage | null>, options: { readonly interested?: boolean; readonly required?: boolean; readonly kind?: LeaseKind } = {}): Promise<ViewBorrow | null> {
    const interested = options.interested !== false, kind = options.kind ?? 'editor';
    if (disposal) return null;
    const held = leases.get(viewId);
    if (held && !held.closing) {
      if (kind === 'editor' && held.kind === 'recovery') { await held.closed; return open(viewId, load, options); }
      return viewBorrow(held, interested);
    }
    let pending = acquisitions.get(viewId);
    if (pending?.kind === 'recovery' && kind === 'editor') {
      await pending.task.catch(() => null);
      return open(viewId, load, options);
    }
    if (!pending) {
      const task = Promise.resolve().then(async () => {
        await leases.get(viewId)?.closed;
        if (disposal) return null;
        const existing = leases.get(viewId);
        if (existing && !existing.closing) return viewBorrow(existing, false);
        const storage = await load();
        if (!storage) return null;
        if (storage.viewId !== viewId) { await storage.close(); throw new Error('The recovered view ID changed.'); }
        if (disposal) { await track(Promise.resolve().then(() => storage.close())); return null; }
        return adopt(storage, kind);
      });
      pending = { users: 0, task, required: options.required === true, kind }; acquisitions.set(viewId, pending);
    }
    pending.users++;
    try {
      const anchor = await pending.task;
      if (!anchor && options.required && !pending.required && !disposal) {
        if (acquisitions.get(viewId) === pending) acquisitions.delete(viewId);
        return open(viewId, load, options);
      }
      if (!anchor || disposal) return null;
      const lease = leases.get(viewId);
      if (!lease || lease.storage !== anchor.storage) throw new Error('The recovered view lease changed.');
      return viewBorrow(lease, interested);
    } finally {
      if (--pending.users === 0) {
        if (acquisitions.get(viewId) === pending) acquisitions.delete(viewId);
        void pending.task.then(anchor => anchor?.release(), () => {});
      }
    }
  }
  return {
    adopt,
    open,
    async drainRecovery(): Promise<void> {
      await Promise.allSettled([...acquisitions.values()].filter(pending => pending.kind === 'recovery').map(pending => pending.task));
      await Promise.all([...leases.values()].filter(lease => lease.kind === 'recovery').map(lease => lease.closed));
    },
    async flushDrafts(): Promise<void> {
      const stores = [...leases.values()].flatMap(lease => [...lease.stores.values()].filter(slot => !slot.closing).map(slot => slot.store));
      await Promise.all(stores.map(store => store.captureDraft()));
    },
    async drainStores(viewId: string): Promise<void> {
      const lease = leases.get(viewId);
      if (!lease) return;
      const slots = [...lease.stores.values()];
      if (slots.some(slot => !slot.closing)) throw new Error('A real frontend callback still owns this editor. Try the transfer again after it finishes.');
      await Promise.all(slots.map(slot => slot.closing));
    },
    closed: (viewId: string): Promise<void> => leases.get(viewId)?.closed ?? Promise.resolve(),
    releaseRecovery(view: ViewBorrow): Promise<void> | null {
      const lease = leases.get(view.storage.viewId);
      view.release();
      if (!lease || lease.storage !== view.storage || lease.borrows || [...lease.stores.values()].some(slot => slot.borrows)) return null;
      return track(Promise.all([...lease.stores.values()].map(slot => slot.closing)).then(() => lease.closing ?? undefined));
    },
    holds: (viewId: string) => { const lease = leases.get(viewId); return Boolean(lease?.kind === 'editor' && !lease.closing); },
    reserve(viewId: string, interested = true): ViewBorrow | null {
      const lease = leases.get(viewId);
      return lease?.kind === 'editor' && !lease.closing ? viewBorrow(lease, interested) : null;
    },
    retainRecovery: (view: ViewBorrow): ViewBorrow => {
      const lease = leases.get(view.storage.viewId);
      if (!lease || lease.storage !== view.storage) throw new Error('The original view lease is unavailable.');
      return viewBorrow(lease, false);
    },
    active: (view: ViewBorrow, scope: ConversationScope, agentId: string) => acquire(view, scope, { kind: 'active', agentId }),
    recovery: (view: ViewBorrow, scope: ConversationScope) => acquire(view, scope, { kind: 'recovery' }),
    failed(storage: OwnedViewStorage, error: unknown): void {
      const lease = leases.get(storage.viewId);
      if (lease?.storage === storage) failed(lease, error);
    },
    owns: (storage: OwnedViewStorage) => leases.get(storage.viewId)?.storage === storage,
    dispose(): Promise<void> {
      if (disposal) return disposal;
      const opening = [...acquisitions.values()].map(pending => pending.task);
      disposal = Promise.resolve().then(async () => {
        await Promise.allSettled(opening);
        let failure: PromiseRejectedResult | undefined;
        while (closes.size) {
          const tasks = [...closes];
          const results = await Promise.allSettled(tasks);
          failure ??= results.find(result => result.status === 'rejected');
          for (const task of tasks) closes.delete(task);
        }
        if (failure) throw failure.reason;
      });
      for (const lease of leases.values()) {
        for (const [key, slot] of lease.stores) closeStore(lease, key, slot);
        closeView(lease);
      }
      return disposal;
    },
  };
}
