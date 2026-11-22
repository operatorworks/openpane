import type { DeliveryEnvelope, ExperienceBundle, WindowContext } from '@openpane/contracts';
import { parseWindowContext, parseDelivery } from '@openpane/contracts';
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
  | { readonly op: 'state'; readonly after: number | null; readonly waitMs: number; readonly context: WindowContext; readonly visible: boolean; readonly presenceSequence: number }
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
    case 'state': {
      record(input, ['op', 'after', 'waitMs', 'context', 'visible', 'presenceSequence']);
      const waitMs = count(input.waitMs);
      if (waitMs > 2000 || typeof input.visible !== 'boolean') throw new Error('Invalid UI state request');
      return { op: input.op, after: input.after === null ? null : count(input.after), waitMs, context: parseWindowContext(input.context), visible: input.visible, presenceSequence: count(input.presenceSequence) };
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
