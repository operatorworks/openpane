import type { DeliveryEnvelope, ExperienceBundle, WindowContext, NativePlacementTarget } from '@openpane/contracts';
import { parseWindowContext, parseDelivery, parseNativePlacementTarget } from '@openpane/contracts';
import { count, identifier, record } from '@openpane/contracts/decode';
import { parseExperienceBundle } from './experience-bundle.js';

export const UI_FRAME_BYTES = 4 * 1024 * 1024;
export class UiRefusal extends Error {
  constructor(readonly code: 'invalid-input' | 'conflict' | 'stale-revision' | 'expired' | 'capacity' | 'unavailable' | 'not-found', message: string) { super(message); }
}
export type UiRequest =
  | { readonly op: 'context' | 'schema' }
  | { readonly op: 'targets'; readonly after: string | null }
  | { readonly op: 'paint'; readonly session: string; readonly deliveryGeneration: number; readonly selectionRevision: number; readonly digest: string | null }
  | { readonly op: 'apply'; readonly requestId: string; readonly expectedRevision: number; readonly bundle: ExperienceBundle }
  | { readonly op: 'refresh'; readonly requestId: string; readonly expectedRevision: number }
  | { readonly op: 'restore'; readonly requestId: string; readonly expectedRevision: number; readonly expectedRecoveryGeneration: number }
  | { readonly op: 'status'; readonly requestId: string }
  | { readonly op: 'prune'; readonly requestId: string; readonly keep: number }
  | { readonly op: 'compact'; readonly expectedEpoch: number }
  | { readonly op: 'relay'; readonly main: WindowContext; readonly children: readonly { readonly context: WindowContext; readonly visible: boolean; readonly presenceSequence: number; readonly placement?: { readonly nativeTransitionId: string; readonly bindingRevision: number } | null }[]; readonly departed: readonly string[] }
  | { readonly op: 'placement-reserve'; readonly session: string; readonly envelope: DeliveryEnvelope; readonly transitionId: string; readonly target: NativePlacementTarget }
  | { readonly op: 'placement-idle'; readonly session: string; readonly envelope: DeliveryEnvelope; readonly transitionId: string }
  | { readonly op: 'placement-failed'; readonly session: string; readonly envelope: DeliveryEnvelope; readonly transitionId: string; readonly reason: string }
  | { readonly op: 'state'; readonly after: number | null; readonly waitMs: number; readonly context: WindowContext; readonly visible: boolean; readonly presenceSequence: number; readonly nativePlacement?: boolean }
  | { readonly op: 'ack'; readonly session: string; readonly envelope: DeliveryEnvelope; readonly result: { readonly kind: 'rendered' } | { readonly kind: 'failed'; readonly reason: string } };
export const parseDeliveryEnvelope = parseDelivery;
export function parseUiRequest(value: unknown): UiRequest {
  const input = record(value);
  switch (input.op) {
    case 'context': case 'schema': record(input, ['op']); return { op: input.op };
    case 'targets': record(input, ['op', 'after']); return { op: input.op, after: input.after === null ? null : identifier(input.after) };
    case 'apply': record(input, ['op', 'requestId', 'expectedRevision', 'bundle']);
      return { op: input.op, requestId: identifier(input.requestId, 128), expectedRevision: count(input.expectedRevision), bundle: parseExperienceBundle(input.bundle) };
    case 'refresh': record(input, ['op', 'requestId', 'expectedRevision']);
      return { op: input.op, requestId: identifier(input.requestId, 128), expectedRevision: count(input.expectedRevision) };
    case 'restore': record(input, ['op', 'requestId', 'expectedRevision', 'expectedRecoveryGeneration']);
      return { op: input.op, requestId: identifier(input.requestId, 128), expectedRevision: count(input.expectedRevision), expectedRecoveryGeneration: count(input.expectedRecoveryGeneration) };
    case 'status': record(input, ['op', 'requestId']); return { op: input.op, requestId: identifier(input.requestId, 128) };
    case 'prune': record(input, ['op', 'requestId', 'keep']);
      if (count(input.keep) > 16) throw new Error('Invalid keep count');
      return { op: input.op, requestId: identifier(input.requestId, 128), keep: count(input.keep) };
    case 'compact': record(input, ['op', 'expectedEpoch']); return { op: input.op, expectedEpoch: count(input.expectedEpoch) };
    case 'relay': {
      record(input, ['op', 'main', 'children', 'departed']);
      const main = parseWindowContext(input.main);
      if (main.role !== 'main' || !Array.isArray(input.children) || input.children.length > 32 || !Array.isArray(input.departed) || input.departed.length > 64) throw new Error('Invalid native UI relay');
      const children = input.children.map(value => {
        const child = record(value); record(child, Object.hasOwn(child, 'placement') ? ['context', 'visible', 'presenceSequence', 'placement'] : ['context', 'visible', 'presenceSequence']); const context = parseWindowContext(child.context);
        if (context.role !== 'chat' || context.hostId !== main.hostId || context.profileId !== main.profileId || context.brokerInstance !== main.brokerInstance || typeof child.visible !== 'boolean') throw new Error('Foreign relay child');
        const placement = child.placement == null ? null : record(child.placement, ['nativeTransitionId', 'bindingRevision']);
        const bindingRevision = placement === null ? null : count(placement.bindingRevision);
        if (bindingRevision === 0) throw new Error('Invalid relay binding revision');
        return { context, visible: child.visible, presenceSequence: count(child.presenceSequence), placement: placement === null || bindingRevision === null ? null : { nativeTransitionId: identifier(placement.nativeTransitionId, 200), bindingRevision } };
      });
      if (new Set(children.map(child => child.context.label)).size !== children.length || new Set(children.map(child => child.context.documentIncarnation)).size !== children.length) throw new Error('Duplicate relay child');
      return { op: input.op, main, children, departed: input.departed.map(value => identifier(value, 200)) };
    }
    case 'state': {
      record(input, Object.hasOwn(input, 'nativePlacement') ? ['op', 'after', 'waitMs', 'context', 'visible', 'presenceSequence', 'nativePlacement'] : ['op', 'after', 'waitMs', 'context', 'visible', 'presenceSequence']);
      if (input.nativePlacement !== undefined && typeof input.nativePlacement !== 'boolean') throw new Error('Invalid native placement capability');
      const waitMs = count(input.waitMs);
      if (waitMs > 2000 || typeof input.visible !== 'boolean') throw new Error('Invalid UI state request');
      return { op: input.op, after: input.after === null ? null : count(input.after), waitMs, context: parseWindowContext(input.context), visible: input.visible, presenceSequence: count(input.presenceSequence), nativePlacement: input.nativePlacement === true };
    }
    case 'placement-reserve': case 'placement-idle': case 'placement-failed': {
      const keys = ['op', 'session', 'envelope', 'transitionId'];
      record(input, input.op === 'placement-reserve' ? [...keys, 'target'] : input.op === 'placement-failed' ? [...keys, 'reason'] : keys);
      const common = { session: identifier(input.session, 200), envelope: parseDelivery(input.envelope), transitionId: identifier(input.transitionId, 200) };
      return input.op === 'placement-reserve' ? { ...common, op: input.op, target: parseNativePlacementTarget(input.target) } : input.op === 'placement-failed' ? { ...common, op: input.op, reason: identifier(input.reason, 500) } : { ...common, op: input.op };
    }
    case 'paint': {
      record(input, ['op', 'session', 'deliveryGeneration', 'selectionRevision', 'digest']);
      const envelope = parseDelivery({ requestId: 'paint', deliveryGeneration: input.deliveryGeneration, selectionRevision: input.selectionRevision, digest: input.digest });
      return { op: input.op, session: identifier(input.session, 200), deliveryGeneration: envelope.deliveryGeneration, selectionRevision: envelope.selectionRevision, digest: envelope.digest };
    }
    case 'ack': {
      record(input, ['op', 'session', 'envelope', 'result']);
      const result = record(input.result);
      if (result.kind === 'rendered') record(result, ['kind']);
      else if (result.kind === 'failed') record(result, ['kind', 'reason']);
      else throw new Error('Invalid rendering result');
      return { op: input.op, session: identifier(input.session, 200), envelope: parseDeliveryEnvelope(input.envelope),
        result: result.kind === 'rendered' ? { kind: 'rendered' } : { kind: 'failed', reason: identifier(result.reason, 500) } };
    }
    default: throw new Error('Unsupported UI operation');
  }
}
