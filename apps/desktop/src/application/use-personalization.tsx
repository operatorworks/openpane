import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { PersonalizationStorage, type PersonalizationSnapshot, type PersonalizationOutcome } from './personalization-storage.js';
import { safeDesktopPreferences, type DesktopPreferencesV1, type PaletteDigest, type PreferencePatch } from './personalization.js';

type RecoveryScope = 'appearance' | 'view';
interface RecoveryCommit { readonly intent: number; readonly operation: number; readonly epoch: number; readonly revision: number }
const ACTIVE_RECOVERY_DIAGNOSTIC = 'Change saved. Session recovery remains active. Retry saved preferences to resume saved choices.';

export interface PersonalizationSessionSnapshot {
  readonly readiness: 'loading' | 'ready' | 'blocked';
  readonly document: DesktopPreferencesV1;
  readonly saved: PersonalizationSnapshot | null;
  readonly diagnostic: string | null;
  readonly recovery: { readonly appearance: 'none' | 'session' | 'saved'; readonly view: 'none' | 'session' | 'saved' };
}
export class PersonalizationSession {
  private snapshot: PersonalizationSessionSnapshot = { readiness: 'loading', document: safeDesktopPreferences, saved: null, diagnostic: null, recovery: { appearance: 'none', view: 'none' } };
  private readonly listeners = new Set<() => void>();
  private started = false;
  private closed = false;
  private startupSuperseded = false;
  private enableCommit: RecoveryCommit | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;
  private operation = 0;
  private readonly recoveryIntents = { appearance: 0, view: 0 };
  private readonly recoveryCommits: Partial<Record<RecoveryScope, RecoveryCommit>> = {};
  constructor(readonly storage = new PersonalizationStorage()) {
    this.unsubscribe = storage.subscribe(saved => this.receive(saved));
  }
  getSnapshot = (): PersonalizationSessionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(snapshot: PersonalizationSessionSnapshot): void {
    if (this.closed) return;
    this.snapshot = this.effective(this.settleRecoveries(snapshot));
    if (this.snapshot.readiness === 'ready' && this.snapshot.recovery.appearance !== 'session' && this.snapshot.recovery.view !== 'session' && this.snapshot.diagnostic === ACTIVE_RECOVERY_DIAGNOSTIC) {
      this.snapshot = { ...this.snapshot, diagnostic: null };
    }
    this.storage.setBlocked(this.snapshot.readiness === 'blocked');
    for (const listener of this.listeners) listener();
  }
  private effective(snapshot: PersonalizationSessionSnapshot): PersonalizationSessionSnapshot {
    const valid = snapshot.saved?.preferences.kind === 'valid' ? snapshot.saved.preferences.document : safeDesktopPreferences;
    let document = snapshot.readiness === 'ready' ? valid : safeDesktopPreferences;
    if (snapshot.recovery.appearance === 'session') document = { ...document, appearance: 'system', palette: { kind: 'builtin' } };
    if (snapshot.recovery.view === 'session') document = { ...document, ui: { ...document.ui, enabled: false } };
    return { ...snapshot, document };
  }
  private receive(saved: PersonalizationSnapshot): void {
    if (this.closed) return;
    const valid = saved.preferences.kind === 'valid';
    const readiness = this.snapshot.readiness === 'blocked' ? 'blocked' : valid ? 'ready' : 'blocked';
    if (this.startupTimer !== undefined) { clearTimeout(this.startupTimer); this.startupTimer = undefined; }
    this.update({ ...this.snapshot, readiness, saved, diagnostic: valid ? this.snapshot.diagnostic : saved.preferences.diagnostic });
  }
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      if (this.snapshot.readiness !== 'loading') return;
      if (!this.startupSuperseded) this.storage.invalidateReads();
      this.update({ ...this.snapshot, readiness: 'blocked', diagnostic: 'Saved personalization did not load in time. Builtin appearance and views are active. Retry to resume saved settings.' });
    }, 2000);
    void this.storage.readSnapshot();
  }
  private authorize(saved: PersonalizationSnapshot, resume: 'matching' | 'view' | 'all' = 'matching'): boolean {
    const current = this.snapshot.saved?.preferences;
    if (this.closed || saved.preferences.kind !== 'valid' || current?.kind !== 'valid' || current.epoch !== saved.preferences.epoch || current.revision < saved.preferences.revision) return false;
    const recovery = resume === 'all' ? { appearance: 'none', view: 'none' } as const : {
      appearance: resume === 'view' ? this.snapshot.recovery.appearance : this.snapshot.recovery.appearance === 'session' && current.document.appearance === 'system' && current.document.palette.kind === 'builtin' ? 'saved' as const : this.snapshot.recovery.appearance,
      view: resume === 'view' ? 'none' as const : this.snapshot.recovery.view === 'session' && !current.document.ui.enabled ? 'saved' as const : this.snapshot.recovery.view,
    };
    this.update({ ...this.snapshot, readiness: 'ready', recovery });
    return true;
  }
  async retry(): Promise<PersonalizationSnapshot> {
    this.start();
    const operation = ++this.operation;
    this.startupSuperseded = true;
    const saved = await this.storage.readSnapshot();
    if (operation === this.operation && this.authorize(saved, 'all')) this.update({ ...this.snapshot, diagnostic: null });
    return saved;
  }
  private async run(action: () => Promise<PersonalizationOutcome>, authorization: 'none' | 'matching' | 'view' = 'none'): Promise<PersonalizationOutcome> {
    this.start();
    const operation = ++this.operation;
    const viewRecovery = this.recoveryIntents.view;
    const outcome = await action();
    if (this.closed) return outcome;
    if (outcome.kind === 'committed' && authorization === 'view' && viewRecovery === this.recoveryIntents.view && outcome.epoch !== null && outcome.revision !== null) {
      this.enableCommit = { intent: viewRecovery, operation, epoch: outcome.epoch, revision: outcome.revision };
      this.update(this.snapshot);
    }
    if (operation !== this.operation) return outcome;
    if (outcome.kind !== 'committed') this.update({ ...this.snapshot, diagnostic: outcome.diagnostic });
    else {
      if (authorization === 'matching') this.authorize(outcome.snapshot, 'matching');
      const recovery = this.snapshot.recovery;
      const active = recovery.appearance === 'session' || recovery.view === 'session';
      const diagnostic = active ? ACTIVE_RECOVERY_DIAGNOSTIC
        : this.snapshot.readiness === 'blocked' ? this.snapshot.diagnostic : null;
      this.update({ ...this.snapshot, diagnostic });
      if (diagnostic) return { ...outcome, diagnostic };
    }
    return outcome;
  }
  patchPreferences(patch: PreferencePatch): Promise<PersonalizationOutcome> {
    if (patch.kind === 'ui-enabled') { this.recoveryIntents.view++; this.enableCommit = undefined; }
    return this.run(() => this.storage.patchPreferences(patch), patch.kind === 'ui-enabled' && patch.enabled ? 'view' : 'none');
  }
  replacePreferences(input: { readonly expectedEpoch: number; readonly expectedRevision: number; readonly document: DesktopPreferencesV1 }): Promise<PersonalizationOutcome> {
    return this.run(() => this.storage.replacePreferences(input), 'matching');
  }
  importPalette(text: string): Promise<PersonalizationOutcome> { return this.run(() => this.storage.importPalette(text)); }
  selectPalette(digest: PaletteDigest | null): Promise<PersonalizationOutcome> { return this.run(() => this.storage.selectPalette(digest)); }
  removePalette(key: IDBValidKey): Promise<PersonalizationOutcome> { return this.run(() => this.storage.removePalette(key)); }
  private settleRecoveries(snapshot: PersonalizationSessionSnapshot): PersonalizationSessionSnapshot {
    const current = snapshot.saved?.preferences;
    let recovery = snapshot.recovery, diagnostic = snapshot.diagnostic, readiness = snapshot.readiness;
    const enabling = this.enableCommit;
    if (enabling) {
      if (enabling.intent !== this.recoveryIntents.view) this.enableCommit = undefined;
      else if (current?.kind === 'valid' && current.epoch === enabling.epoch && current.revision >= enabling.revision && current.document.ui.enabled) {
        recovery = { ...recovery, view: 'none' };
        readiness = 'ready';
        this.enableCommit = undefined;
      }
    }
    for (const scope of ['appearance', 'view'] as const) {
      const commit = this.recoveryCommits[scope];
      if (!commit) continue;
      if (commit.intent !== this.recoveryIntents[scope] || recovery[scope] !== 'session') { delete this.recoveryCommits[scope]; continue; }
      if (current?.kind !== 'valid' || current.epoch !== commit.epoch || current.revision < commit.revision) continue;
      const confirmed = scope === 'appearance' ? current.document.appearance === 'system' && current.document.palette.kind === 'builtin' : !current.document.ui.enabled;
      if (!confirmed) continue;
      recovery = { ...recovery, [scope]: 'saved' };
      if (commit.operation === this.operation) diagnostic = `Default ${scope} saved.`;
      delete this.recoveryCommits[scope];
    }
    return { ...snapshot, readiness, recovery, diagnostic };
  }
  private async recover(scope: RecoveryScope, write: () => Promise<PersonalizationOutcome>): Promise<PersonalizationOutcome> {
    const recovery = ++this.recoveryIntents[scope];
    delete this.recoveryCommits[scope];
    this.update({ ...this.snapshot, recovery: { ...this.snapshot.recovery, [scope]: 'session' }, diagnostic: `Default ${scope} is active for this session. Saving…` });
    const pending = this.run(write);
    const operation = this.operation;
    const outcome = await pending;
    if (recovery === this.recoveryIntents[scope] && outcome.kind === 'committed' && outcome.epoch !== null && outcome.revision !== null) {
      this.recoveryCommits[scope] = { intent: recovery, operation, epoch: outcome.epoch, revision: outcome.revision };
      this.update({ ...this.snapshot, diagnostic: operation === this.operation ? `Default ${scope} is active for this session. Saved change is being verified.` : this.snapshot.diagnostic });
    } else if (recovery === this.recoveryIntents[scope] && operation === this.operation && !this.closed) {
      this.update({ ...this.snapshot, diagnostic: `Default ${scope} is active for this session. Could not save this change.` });
    }
    return outcome.kind === 'committed' && this.snapshot.diagnostic ? { ...outcome, diagnostic: this.snapshot.diagnostic } : outcome;
  }
  resetAppearance(): Promise<PersonalizationOutcome> { return this.recover('appearance', () => this.storage.resetAppearance()); }
  restoreDefaultView(): Promise<PersonalizationOutcome> {
    return this.recover('view', () => this.storage.restoreDefaultView());
  }
  resetPersonalization(): Promise<PersonalizationOutcome> {
    return this.run(() => this.storage.resetPersonalization(), 'matching');
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.operation++;
    clearTimeout(this.startupTimer); this.unsubscribe(); this.storage.close(); this.listeners.clear();
  }
}
export function createPersonalizationSession(): PersonalizationSession { return new PersonalizationSession(); }
const PersonalizationContext = createContext<PersonalizationSession | null>(null);
function useSessionLifetime(session: PersonalizationSession | null): void {
  useEffect(() => {
    if (!session) return;
    sessionSubscribers.set(session, (sessionSubscribers.get(session) ?? 0) + 1);
    session.start();
    const close = (event: PageTransitionEvent) => { if (!event.persisted) session.close(); };
    globalThis.addEventListener('pagehide', close);
    return () => {
      globalThis.removeEventListener('pagehide', close);
      const remaining = (sessionSubscribers.get(session) ?? 1) - 1;
      if (remaining === 0) sessionSubscribers.delete(session); else sessionSubscribers.set(session, remaining);
      // Effect replay reattaches synchronously; a real unmount releases the owner after that turn.
      queueMicrotask(() => { if (!sessionSubscribers.has(session)) session.close(); });
    };
  }, [session]);
}
const sessionSubscribers = new WeakMap<PersonalizationSession, number>();
export function PersonalizationProvider({ children, session: supplied }: { readonly children: ReactNode; readonly session?: PersonalizationSession }) {
  const [session] = useState(() => supplied ?? createPersonalizationSession());
  useSessionLifetime(session);
  return <PersonalizationContext.Provider value={session}>{children}</PersonalizationContext.Provider>;
}
export function usePersonalization(): PersonalizationSessionSnapshot & { readonly session: PersonalizationSession } {
  const provided = useContext(PersonalizationContext);
  const [fallback] = useState(() => provided ? null : createPersonalizationSession());
  useSessionLifetime(fallback);
  const session = provided ?? fallback;
  if (!session) throw new Error('Personalization session is missing.');
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return { ...snapshot, session };
}
