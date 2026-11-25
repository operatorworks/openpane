import { parseExperience } from './experience.js';
import type { ConversationScope } from './index.js';
import type { MetricsCardV1, METRICS_EVENT_NAME } from './metrics-card.js';
import { boundedText, count, hex, identifier, record } from './decode.js';
import { parseScope } from './durable.js';
import { parsePlacementTransition } from './ui-receipt.js';
import { parseDisplayDelivery } from './display.js';
import type { DisplayDelivery } from './display.js';

export type UiAppearance = { readonly kind: 'builtin' } | { readonly kind: 'experience'; readonly digest: string };
export interface UiSelection {
  readonly revision: number;
  readonly deliveryGeneration: number;
  readonly selected: UiAppearance;
  readonly previousHealthy: UiAppearance;
}
export interface DeliveryEnvelope {
  readonly requestId: string;
  readonly deliveryGeneration: number;
  readonly selectionRevision: number;
  readonly digest: string | null;
}
export type WindowContext = {
  readonly profileId: string;
  readonly hostId: string;
  readonly brokerInstance: string;
  readonly label: string;
  readonly documentIncarnation: string;
} & (
  | { readonly role: 'main'; readonly viewId: string }
  | { readonly role: 'chat'; readonly scope: ConversationScope; readonly viewId: string }
);
export interface NativePlacementTarget {
  readonly scope: ConversationScope;
  readonly viewId: string;
  readonly label: string;
  readonly nativeTransitionId: string;
  readonly bindingRevision: number;
}
export type CohortSlot =
  | { readonly kind: 'document'; readonly context: WindowContext }
  | ({ readonly kind: 'transition'; readonly transitionId: string; readonly source: Extract<WindowContext, { readonly role: 'main' }> } & (
      | { readonly target: null; readonly resolved: null }
      | { readonly target: NativePlacementTarget; readonly resolved: Extract<WindowContext, { readonly role: 'chat' }> | null }));
export type VisualOutcome =
  | { readonly kind: 'pending'; readonly reason: string }
  | { readonly kind: 'rendered' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'departed' }
  | { readonly kind: 'superseded' };
export type PlacementOutcome =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'pending'; readonly transitionId: string; readonly reason: string }
  | { readonly kind: 'ready'; readonly transitionId: string; readonly bindingRevision: number }
  | { readonly kind: 'failed'; readonly transitionId: string; readonly reason: string }
  | { readonly kind: 'deferred-for-existing-windows' };
export interface ApplyReceipt extends DeliveryEnvelope {
  readonly requestDigest: string;
  readonly participants: readonly { readonly slot: CohortSlot; readonly visual: VisualOutcome; readonly placement: PlacementOutcome }[];
}
export interface DisplayPublication {
  readonly scope: ConversationScope;
  readonly publicationId: string;
  readonly sequence: number;
  readonly publishedAtMs: number;
  readonly digest: string;
  readonly event: { readonly type: 'CUSTOM'; readonly name: typeof METRICS_EVENT_NAME; readonly value: MetricsCardV1 };
}
export type DisplayChange =
  | { readonly kind: 'published'; readonly publication: DisplayPublication }
  | { readonly kind: 'removed'; readonly publicationId: string; readonly sequence: number };
export type QueryReservation = {
  readonly scope: ConversationScope;
  readonly publicationId: string;
  readonly attempt: number;
  readonly query: string;
  readonly fromSeconds: number;
  readonly toSeconds: number;
  readonly executable: string;
  readonly version: string;
  readonly site: string;
} & (
  | { readonly kind: 'reserved' | 'running' | 'abandoned' }
  | { readonly kind: 'interrupted' | 'failed'; readonly reason: string }
  | { readonly kind: 'published' | 'removed'; readonly sequence: number; readonly digest: string }
);
export function parseUiAppearance(value: unknown): UiAppearance {
  const input = record(value);
  if (input.kind === 'builtin') { record(input, ['kind']); return { kind: 'builtin' }; }
  record(input, ['kind', 'digest']);
  if (input.kind !== 'experience') throw new Error('Invalid UI appearance');
  return { kind: 'experience', digest: hex(input.digest, 64) };
}
export function parseUiSelection(value: unknown): UiSelection {
  const input = record(value, ['revision', 'deliveryGeneration', 'selected', 'previousHealthy']);
  return { revision: count(input.revision), deliveryGeneration: count(input.deliveryGeneration),
    selected: parseUiAppearance(input.selected), previousHealthy: parseUiAppearance(input.previousHealthy) };
}
export function parseWindowContext(value: unknown): WindowContext {
  const input = record(value);
  const keys = ['profileId', 'hostId', 'brokerInstance', 'label', 'documentIncarnation', 'role', 'viewId'];
  if (input.role === 'main') record(input, keys);
  else record(input, [...keys, 'scope']);
  const context = { profileId: identifier(input.profileId, 200), hostId: identifier(input.hostId, 1024), brokerInstance: identifier(input.brokerInstance, 200),
    label: identifier(input.label, 200), documentIncarnation: identifier(input.documentIncarnation, 200), viewId: identifier(input.viewId, 200) };
  if (input.role === 'main') return { ...context, role: 'main' };
  if (input.role !== 'chat') throw new Error('Invalid window role');
  const scope = parseScope(input.scope);
  if (scope.hostId !== context.hostId) throw new Error('Window scope host mismatch');
  return { ...context, role: 'chat', scope };
}

export interface UiContextV1 {
  readonly version: 1;
  readonly hostId: string;
  readonly profileId: string;
  readonly requestEpoch: number;
  readonly recoveryGeneration: number;
  readonly revision: number;
  readonly selection: UiSelection;
  readonly capabilities: readonly string[];
  readonly fault: string | null;
}
export interface PlacementTransition {
  readonly envelope: DeliveryEnvelope;
  readonly slot: Extract<CohortSlot, { readonly kind: 'transition' }>;
}
export interface UiClientSnapshot {
  readonly version: 1;
  readonly change: number;
  readonly selection: UiSelection;
  readonly bundle: { readonly manifest: import('./experience.js').ExperienceV2; readonly digest: string } | null;
  readonly envelope: DeliveryEnvelope | null;
  readonly fault: string | null;
  readonly transitions: readonly PlacementTransition[];
  readonly display: DisplayDelivery | null;
}
export function parseDelivery(value: unknown): DeliveryEnvelope {
  const input = record(value, ['requestId', 'deliveryGeneration', 'selectionRevision', 'digest']);
  return { requestId: identifier(input.requestId, 128), deliveryGeneration: count(input.deliveryGeneration), selectionRevision: count(input.selectionRevision), digest: input.digest === null ? null : hex(input.digest, 64) };
}
export function parseUiContext(value: unknown): UiContextV1 {
  const input = record(value, ['version', 'hostId', 'profileId', 'requestEpoch', 'recoveryGeneration', 'revision', 'selection', 'capabilities', 'fault']);
  if (input.version !== 1 || !Array.isArray(input.capabilities) || input.capabilities.length > 32) throw new Error('Unsupported UI context');
  if (input.fault !== null && typeof input.fault !== 'string') throw new Error('Invalid UI fault');
  return { version: 1, hostId: identifier(input.hostId), profileId: identifier(input.profileId, 200), requestEpoch: count(input.requestEpoch), recoveryGeneration: count(input.recoveryGeneration),
    revision: count(input.revision), selection: parseUiSelection(input.selection), capabilities: input.capabilities.map(value => identifier(value, 100)), fault: input.fault === null ? null : boundedText(input.fault, 500) };
}

export function parseUiClientSnapshot(value: unknown): UiClientSnapshot {
  const input = record(value, ['version', 'change', 'selection', 'bundle', 'envelope', 'fault', 'transitions', 'display']);
  if (input.version !== 1 || (input.fault !== null && typeof input.fault !== 'string')) throw new Error('Unsupported UI snapshot');
  const selection = parseUiSelection(input.selection);
  const rawBundle = input.bundle === null ? null : record(input.bundle, ['manifest', 'digest']);
  const bundle = rawBundle === null ? null : { manifest: parseExperience(rawBundle.manifest), digest: hex(rawBundle.digest, 64) };
  if (selection.selected.kind === 'builtin' ? bundle !== null : bundle?.digest !== selection.selected.digest) throw new Error('UI bundle/selection mismatch');
  const envelope = input.envelope === null ? null : parseDelivery(input.envelope);
  if (envelope && (envelope.deliveryGeneration !== selection.deliveryGeneration || envelope.selectionRevision !== selection.revision || envelope.digest !== (bundle?.digest ?? null))) throw new Error('UI delivery/selection mismatch');
  if (!Array.isArray(input.transitions) || input.transitions.length > 32) throw new Error('Invalid placement transition list');
  const transitions = input.transitions.map(parsePlacementTransition);
  if (transitions.some(item => item.envelope.deliveryGeneration !== selection.deliveryGeneration || item.envelope.selectionRevision !== selection.revision || item.envelope.digest !== (bundle?.digest ?? null))) throw new Error('Placement transition generation mismatch');
  return { version: 1, change: count(input.change), selection, bundle, envelope, fault: input.fault === null ? null : boundedText(input.fault, 500), transitions, display: input.display === null ? null : parseDisplayDelivery(input.display) };
}
