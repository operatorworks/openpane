import { Component, Suspense, createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ExtensionManifest } from '@openpane/sdk';
import type { ConversationActivityProps, ConversationModuleProps, UiExtensionPresentation } from '@openpane/sdk/react';
import { DesktopExtensionLifecycle } from './desktop-extension-lifecycle.js';
import { BuiltinColors } from './BuiltinColors.js';
import type { GenerationSink } from './frontend-sends.js';
import type { FrontendToolGeneration } from '@openpane/sdk/tools';

export interface DesktopCustomization {
  readonly manifest: ExtensionManifest;
  load(): Promise<{ readonly default: unknown }>;
}
export type NamespaceActivation = { readonly namespace: string } & (
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly lifetime: number; readonly generation: FrontendToolGeneration; readonly presentation: UiExtensionPresentation; readonly fail: (error: unknown) => void }
);
type ReadyActivation = Extract<NamespaceActivation, { readonly kind: 'ready' }>;
type Slot = 'transcript' | 'activity' | 'contentLayout';
type SlotOwner<S extends Slot> = ReadyActivation & {
  readonly presentation: UiExtensionPresentation & { readonly [K in S]: NonNullable<UiExtensionPresentation[K]> };
};
type SlotSelection<S extends Slot> =
  | { readonly kind: 'default' }
  | { readonly kind: 'conflict'; readonly namespaces: readonly string[] }
  | { readonly kind: 'missing'; readonly namespace: string }
  | { readonly kind: 'claimed'; readonly owner: SlotOwner<S> };
export type TranscriptSelection = SlotSelection<'transcript'>;
export type ActivitySelection = SlotSelection<'activity'>;
export type ContentLayoutSelection = SlotSelection<'contentLayout'>;
const DEFAULT_SLOT: { readonly kind: 'default' } = { kind: 'default' };
type SlotPreference = import('./personalization.js').SlotPreference;
const BUILTIN_SLOTS: Readonly<Record<Slot, SlotPreference>> = {
  transcript: { kind: 'builtin' }, activity: { kind: 'builtin' }, contentLayout: { kind: 'builtin' },
};
export function selectSlot<S extends Slot>(owners: readonly NamespaceActivation[], slot: S, preference: SlotPreference = { kind: 'automatic' }): SlotSelection<S> {
  if (preference.kind === 'builtin') return DEFAULT_SLOT;
  if (preference.kind === 'extension') {
    if (owners.some(owner => owner.namespace === preference.namespace && owner.kind === 'loading')) return DEFAULT_SLOT;
    const owner = owners.find((owner): owner is SlotOwner<S> => owner.namespace === preference.namespace && owner.kind === 'ready' && owner.presentation[slot] !== undefined);
    return owner ? { kind: 'claimed', owner } : { kind: 'missing', namespace: preference.namespace };
  }
  if (owners.some(owner => owner.kind === 'loading')) return DEFAULT_SLOT;
  const claims = owners.filter((owner): owner is SlotOwner<S> => owner.kind === 'ready' && owner.presentation[slot] !== undefined);
  if (claims.length > 1) return { kind: 'conflict', namespaces: claims.map(owner => owner.namespace).sort() };
  const owner = claims[0];
  return owner ? { kind: 'claimed', owner } : DEFAULT_SLOT;
}
/** A workspace's own transcript, claimed for the conversation that workspace renders. */
export function workspaceTranscript(owner: ReadyActivation, transcript: NonNullable<UiExtensionPresentation['transcript']>): TranscriptSelection {
  return { kind: 'claimed', owner: { ...owner, presentation: { ...owner.presentation, transcript } } };
}

export class CustomizationBoundary extends Component<{
  readonly children: ReactNode; readonly fallback: ReactNode; readonly fail: (error: unknown) => void;
}, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: unknown) { this.props.fail(error); }
  override render() { return this.state.failed ? <BuiltinColors>{this.props.fallback}</BuiltinColors> : this.props.children; }
}

const EMPTY_NAMESPACES: readonly string[] = [];
const lifecycleSubscribers = new WeakMap<DesktopExtensionLifecycle, number>();
function useLifecycleLifetime(owner: DesktopExtensionLifecycle | null): void {
  useEffect(() => {
    if (!owner) return;
    lifecycleSubscribers.set(owner, (lifecycleSubscribers.get(owner) ?? 0) + 1);
    const close = (event: PageTransitionEvent) => { if (!event.persisted) void owner.close(); };
    window.addEventListener('pagehide', close);
    return () => {
      window.removeEventListener('pagehide', close);
      const remaining = (lifecycleSubscribers.get(owner) ?? 1) - 1;
      if (remaining === 0) lifecycleSubscribers.delete(owner); else lifecycleSubscribers.set(owner, remaining);
      queueMicrotask(() => { if (!lifecycleSubscribers.has(owner)) void owner.close(); });
    };
  }, [owner]);
}
const LifecycleContext = createContext<DesktopExtensionLifecycle | null>(null);
export function DesktopCustomizationProvider({ children }: { readonly children: ReactNode }) {
  const [owner] = useState(() => new DesktopExtensionLifecycle());
  useLifecycleLifetime(owner);
  return <LifecycleContext.Provider value={owner}>{children}</LifecycleContext.Provider>;
}

export function useDesktopCustomizations({ customizations, enabled, sink, disabledNamespaces = EMPTY_NAMESPACES, slots, loading = false }: {
  readonly customizations: readonly DesktopCustomization[]; readonly enabled: boolean; readonly sink?: GenerationSink;
  readonly disabledNamespaces?: readonly string[];
  readonly slots?: Readonly<Record<Slot, SlotPreference>>;
  readonly loading?: boolean;
}): { readonly namespaces: readonly NamespaceActivation[]; readonly transcript: TranscriptSelection; readonly activity: ActivitySelection; readonly contentLayout: ContentLayoutSelection; readonly generations: readonly FrontendToolGeneration[] } {
  const provided = useContext(LifecycleContext);
  const [local] = useState(() => new DesktopExtensionLifecycle());
  const owner = provided ?? local;
  useLifecycleLifetime(provided ? null : local);
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const admitted = useMemo(() => enabled ? customizations.filter(entry => !disabledNamespaces.includes(entry.manifest.namespace)) : [],
    [customizations, enabled, disabledNamespaces]);
  const namespaces = snapshot.filter(activation => activation.kind === 'failed' || !loading
    && admitted.some(entry => entry.manifest.namespace === activation.namespace));
  useLayoutEffect(() => {
    if (!loading) owner.reconcile(admitted);
    if (sink) owner.attach(sink);
  }, [owner, admitted, sink, loading]);
  const effectiveSlots = enabled ? slots : BUILTIN_SLOTS;
  return { namespaces, transcript: selectSlot(namespaces, 'transcript', effectiveSlots?.transcript), activity: selectSlot(namespaces, 'activity', effectiveSlots?.activity),
    contentLayout: selectSlot(namespaces, 'contentLayout', effectiveSlots?.contentLayout), generations: namespaces.flatMap(item => item.kind === 'ready' ? [item.generation] : []) };
}

export function CustomizationActivity({ selection, context, fallback, conversationKey }: {
  readonly selection: ActivitySelection; readonly context: ConversationActivityProps; readonly fallback: ReactNode; readonly conversationKey: string;
}) {
  if (selection.kind === 'default') return fallback;
  if (selection.kind === 'missing') return <><BuiltinColors><p role="alert">Selected {selection.namespace} view is unavailable. The default view remains active.</p></BuiltinColors>{fallback}</>;
  if (selection.kind === 'conflict') return <><BuiltinColors><p role="alert">Activity override conflict. {selection.namespaces.join(', ')} claim the activity. The default view remains active.</p></BuiltinColors>{fallback}</>;
  const View = selection.owner.presentation.activity;
  return <Suspense fallback={fallback}>
    <CustomizationBoundary key={`${selection.owner.lifetime}/${conversationKey}`} fail={selection.owner.fail} fallback={fallback}>
      <View {...context} />
    </CustomizationBoundary>
  </Suspense>;
}

export function CustomizationTranscript({ selection, context, fallback, appendix, conversationKey }: {
  readonly selection: TranscriptSelection; readonly context: ConversationModuleProps; readonly fallback: ReactNode; readonly conversationKey: string;
  readonly appendix: ReactNode;
}) {
  if (selection.kind === 'default') return fallback;
  if (selection.kind === 'missing') return <><BuiltinColors><p role="alert">Selected {selection.namespace} view is unavailable. The default view remains active.</p></BuiltinColors>{fallback}</>;
  if (selection.kind === 'conflict') return <><BuiltinColors><p role="alert">Transcript override conflict. {selection.namespaces.join(', ')} claim the transcript. The default view remains active.</p></BuiltinColors>{fallback}</>;
  const View = selection.owner.presentation.transcript;
  return <Suspense fallback={fallback}>
    <CustomizationBoundary key={`${selection.owner.lifetime}/${conversationKey}`} fail={selection.owner.fail} fallback={fallback}>
      <View {...context} />
      {appendix}
    </CustomizationBoundary>
  </Suspense>;
}
