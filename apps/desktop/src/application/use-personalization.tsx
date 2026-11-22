import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { PersonalizationStorage, type PersonalizationSnapshot, type PersonalizationOutcome } from './personalization-storage.js';
import { safeDesktopPreferences, type DesktopPreferencesV1, type PaletteDigest, type PreferencePatch } from './personalization.js';

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
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;
  private operation = 0;
  private appearanceRecovery = 0;
  private viewRecovery = 0;
  constructor(readonly storage = new PersonalizationStorage()) {
    this.unsubscribe = storage.subscribe(saved => this.receive(saved));
  }
  getSnapshot = (): PersonalizationSessionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(snapshot: PersonalizationSessionSnapshot): void {
    if (this.closed) return;
    this.snapshot = snapshot;
    this.storage.setBlocked(snapshot.readiness === 'blocked');
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
    this.update(this.effective({ ...this.snapshot, readiness, saved, diagnostic: valid ? this.snapshot.diagnostic : saved.preferences.diagnostic }));
  }
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      if (this.snapshot.readiness !== 'loading') return;
      this.storage.invalidateReads();
      this.update(this.effective({ ...this.snapshot, readiness: 'blocked', diagnostic: 'Saved personalization did not load in time. Builtin appearance and views are active. Retry to resume saved settings.' }));
    }, 2000);
    void this.storage.readSnapshot();
  }
  private authorize(saved: PersonalizationSnapshot, resume: 'matching' | 'view' | 'all' = 'matching'): boolean {
    const current = this.snapshot.saved?.preferences;
    if (this.closed || saved.preferences.kind !== 'valid' || current?.kind !== 'valid' || current.epoch !== saved.preferences.epoch || current.revision < saved.preferences.revision) return false;
    const recovery = resume === 'all' ? { appearance: 'none', view: 'none' } as const : {
      appearance: this.snapshot.recovery.appearance === 'session' && current.document.appearance === 'system' && current.document.palette.kind === 'builtin' ? 'saved' as const : this.snapshot.recovery.appearance,
      view: resume === 'view' ? 'none' as const : this.snapshot.recovery.view === 'session' && !current.document.ui.enabled ? 'saved' as const : this.snapshot.recovery.view,
    };
    this.update(this.effective({ ...this.snapshot, readiness: 'ready', diagnostic: null, recovery }));
    return true;
  }
  async retry(): Promise<PersonalizationSnapshot> {
    this.start();
    const operation = ++this.operation;
    const saved = await this.storage.readSnapshot();
    if (operation === this.operation) this.authorize(saved, 'all');
    return saved;
  }
  private async run(action: () => Promise<PersonalizationOutcome>, authorization: 'none' | 'matching' | 'view' = 'none'): Promise<PersonalizationOutcome> {
    this.start();
    const operation = ++this.operation;
    const outcome = await action();
    if (this.closed) return outcome;
    if (operation !== this.operation) return outcome;
    if (outcome.kind !== 'committed') this.update({ ...this.snapshot, diagnostic: outcome.diagnostic });
    else {
      if (authorization !== 'none') this.authorize(outcome.snapshot, authorization);
      const recovery = this.snapshot.recovery;
      const active = recovery.appearance === 'session' || recovery.view === 'session';
      const diagnostic = active ? 'Change saved. Session recovery remains active. Retry saved preferences to resume saved choices.'
        : this.snapshot.readiness === 'blocked' ? this.snapshot.diagnostic : null;
      this.update({ ...this.snapshot, diagnostic });
      if (diagnostic) return { ...outcome, diagnostic };
    }
    return outcome;
  }
  patchPreferences(patch: PreferencePatch): Promise<PersonalizationOutcome> {
    return this.run(() => this.storage.patchPreferences(patch), patch.kind === 'ui-enabled' && patch.enabled ? 'view' : 'none');
  }
  replacePreferences(input: { readonly expectedEpoch: number; readonly expectedRevision: number; readonly document: DesktopPreferencesV1 }): Promise<PersonalizationOutcome> {
    return this.run(() => this.storage.replacePreferences(input), 'matching');
  }
  importPalette(text: string): Promise<PersonalizationOutcome> { return this.run(() => this.storage.importPalette(text)); }
  selectPalette(digest: PaletteDigest | null): Promise<PersonalizationOutcome> { return this.run(() => this.storage.selectPalette(digest)); }
  removePalette(key: IDBValidKey): Promise<PersonalizationOutcome> { return this.run(() => this.storage.removePalette(key)); }
  private confirmedRecovery(outcome: PersonalizationOutcome, scope: 'appearance' | 'view'): boolean {
    const current = this.snapshot.saved?.preferences;
    if (outcome.kind !== 'committed' || outcome.revision === null || current?.kind !== 'valid' || current.epoch !== outcome.epoch || current.revision < outcome.revision) return false;
    return scope === 'appearance' ? current.document.appearance === 'system' && current.document.palette.kind === 'builtin' : !current.document.ui.enabled;
  }
  async resetAppearance(): Promise<PersonalizationOutcome> {
    const recovery = ++this.appearanceRecovery;
    this.update(this.effective({ ...this.snapshot, recovery: { ...this.snapshot.recovery, appearance: 'session' }, diagnostic: 'Default appearance is active for this session. Saving…' }));
    const pending = this.run(() => this.storage.resetAppearance());
    const operation = this.operation;
    const outcome = await pending;
    if (recovery === this.appearanceRecovery && this.confirmedRecovery(outcome, 'appearance')) {
      this.update(this.effective({ ...this.snapshot, recovery: { ...this.snapshot.recovery, appearance: 'saved' }, diagnostic: 'Default appearance saved.' }));
    } else if (recovery === this.appearanceRecovery && operation === this.operation && !this.closed) this.update({ ...this.snapshot, diagnostic: 'Default appearance is active for this session. Could not save this change.' });
    return outcome.kind === 'committed' && this.snapshot.diagnostic ? { ...outcome, diagnostic: this.snapshot.diagnostic } : outcome;
  }
  async restoreDefaultView(): Promise<PersonalizationOutcome> {
    const recovery = ++this.viewRecovery;
    this.update(this.effective({ ...this.snapshot, recovery: { ...this.snapshot.recovery, view: 'session' }, diagnostic: 'Default view is active for this session. Saving…' }));
    const pending = this.run(() => this.storage.restoreDefaultView());
    const operation = this.operation;
    const outcome = await pending;
    if (recovery === this.viewRecovery && this.confirmedRecovery(outcome, 'view')) {
      this.update(this.effective({ ...this.snapshot, recovery: { ...this.snapshot.recovery, view: 'saved' }, diagnostic: 'Default view saved.' }));
    } else if (recovery === this.viewRecovery && operation === this.operation && !this.closed) this.update({ ...this.snapshot, diagnostic: 'Default view is active for this session. Could not save this change.' });
    return outcome.kind === 'committed' && this.snapshot.diagnostic ? { ...outcome, diagnostic: this.snapshot.diagnostic } : outcome;
  }
  resetPersonalization(): Promise<PersonalizationOutcome> { return this.run(() => this.storage.resetPersonalization(), 'matching'); }
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
