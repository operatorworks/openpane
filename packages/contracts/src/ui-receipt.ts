import { parseDelivery, parseWindowContext } from './ui-state.js';
import type { ApplyReceipt, CohortSlot, NativePlacementTarget, PlacementOutcome, PlacementTransition, VisualOutcome } from './ui-state.js';
import { count, hex, identifier, record } from './decode.js';
import { parseScope, sameScope } from './durable.js';

export const isUiRecoveryRequest = (requestId: string): boolean => /^recovery:/iu.test(requestId);
export const receiptCohortLimit = (requestId: string): number => isUiRecoveryRequest(requestId) ? 64 : 32;

export function parseNativePlacementTarget(value: unknown): NativePlacementTarget {
  const input = record(value, ['scope', 'viewId', 'label', 'nativeTransitionId', 'bindingRevision']);
  const bindingRevision = count(input.bindingRevision);
  if (bindingRevision === 0) throw new Error('Invalid placement binding revision');
  return { scope: parseScope(input.scope), viewId: identifier(input.viewId, 200), label: identifier(input.label, 200),
    nativeTransitionId: identifier(input.nativeTransitionId, 200), bindingRevision };
}
export function parseCohortSlot(value: unknown): CohortSlot {
  const input = record(value);
  if (input.kind === 'document') { record(input, ['kind', 'context']); return { kind: 'document', context: parseWindowContext(input.context) }; }
  record(input, ['kind', 'transitionId', 'source', 'target', 'resolved']);
  const source = parseWindowContext(input.source);
  if (input.kind !== 'transition' || source.role !== 'main') throw new Error('Invalid transition source');
  const target = input.target === null ? null : parseNativePlacementTarget(input.target), resolved = input.resolved === null ? null : parseWindowContext(input.resolved);
  if (target && target.scope.hostId !== source.hostId) throw new Error('Foreign placement target');
  if (resolved && (resolved.role !== 'chat' || !target || !sameScope(target.scope, resolved.scope) || target.label !== resolved.label || target.viewId !== resolved.viewId || resolved.brokerInstance !== source.brokerInstance || resolved.profileId !== source.profileId)) throw new Error('Placement target identity mismatch');
  const slot = { kind: 'transition', transitionId: identifier(input.transitionId, 200), source } as const;
  return target === null ? { ...slot, target: null, resolved: null } : { ...slot, target, resolved };
}
export function parseVisualOutcome(value: unknown): VisualOutcome {
  const input = record(value);
  if (input.kind === 'pending' || input.kind === 'failed') { record(input, ['kind', 'reason']); return { kind: input.kind, reason: identifier(input.reason, 500) }; }
  if (input.kind === 'rendered' || input.kind === 'departed' || input.kind === 'superseded') { record(input, ['kind']); return { kind: input.kind }; }
  throw new Error('Invalid visual outcome');
}
export function parsePlacementOutcome(value: unknown): PlacementOutcome {
  const input = record(value);
  if (input.kind === 'unchanged' || input.kind === 'deferred-for-existing-windows') { record(input, ['kind']); return { kind: input.kind }; }
  if (input.kind === 'ready') { record(input, ['kind', 'transitionId', 'bindingRevision']); const bindingRevision = count(input.bindingRevision); if (bindingRevision === 0) throw new Error('Invalid ready revision'); return { kind: input.kind, transitionId: identifier(input.transitionId, 200), bindingRevision }; }
  if (input.kind === 'pending' || input.kind === 'failed') { record(input, ['kind', 'transitionId', 'reason']); return { kind: input.kind, transitionId: identifier(input.transitionId, 200), reason: identifier(input.reason, 500) }; }
  throw new Error('Invalid placement outcome');
}
export function parseApplyReceipt(value: unknown): ApplyReceipt {
  const input = record(value, ['requestId', 'deliveryGeneration', 'selectionRevision', 'digest', 'requestDigest', 'participants']);
  const envelope = parseDelivery({ requestId: input.requestId, deliveryGeneration: input.deliveryGeneration, selectionRevision: input.selectionRevision, digest: input.digest });
  const cohortLimit = receiptCohortLimit(envelope.requestId);
  if (!Array.isArray(input.participants) || input.participants.length > cohortLimit) throw new Error('Invalid receipt cohort');
  const participants = Array.from(input.participants, value => {
    const input = record(value, ['slot', 'visual', 'placement']), slot = parseCohortSlot(input.slot), placement = parsePlacementOutcome(input.placement);
    if (slot.kind === 'transition' && 'transitionId' in placement && placement.transitionId !== slot.transitionId) throw new Error('Placement outcome names another transition');
    if (slot.kind === 'transition' && placement.kind === 'ready') {
      if (!slot.resolved) throw new Error('Ready placement has no resolved child document');
      if (placement.bindingRevision !== slot.target.bindingRevision) throw new Error('Ready placement does not match its reserved binding');
    }
    const visual = parseVisualOutcome(input.visual);
    if (slot.kind === 'transition' && !slot.resolved && (slot.target !== null || placement.kind !== 'unchanged') && visual.kind === 'rendered') throw new Error('Rendered transition has no painted document');
    return { slot, visual, placement };
  });
  return { ...envelope, requestDigest: hex(input.requestDigest, 64), participants };
}
export function parsePlacementTransition(value: unknown): PlacementTransition {
  const input = record(value, ['envelope', 'slot']), slot = parseCohortSlot(input.slot);
  if (slot.kind !== 'transition') throw new Error('Expected a placement transition');
  return { envelope: parseDelivery(input.envelope), slot };
}
