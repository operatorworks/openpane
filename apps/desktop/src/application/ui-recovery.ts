import { count, identifier, record } from '@openpane/contracts/decode';
import type { UiContextV1 } from '@openpane/contracts';

export const UI_RECOVERY_KEY = 'openpane.ui-recovery.v1';
export interface RecoveryRequest {
  readonly op: 'restore'; readonly requestId: string; readonly expectedRecoveryGeneration: number; readonly expectedRevision: number;
}
export type RecoveryOriginator = { readonly kind: 'browser' } | { readonly kind: 'native'; readonly brokerInstance: string; readonly sequence: number };
export function sameRecoveryOriginator(a: RecoveryOriginator, b: RecoveryOriginator): boolean {
  return a.kind === 'browser' ? b.kind === 'browser' : b.kind === 'native' && a.brokerInstance === b.brokerInstance && a.sequence === b.sequence;
}
function parseOriginator(value: unknown): RecoveryOriginator {
  if (value === undefined) return { kind: 'browser' };
  const input = record(value);
  if (input.kind === 'browser') { record(input, ['kind']); return { kind: 'browser' }; }
  record(input, ['kind', 'brokerInstance', 'sequence']);
  if (input.kind !== 'native' || count(input.sequence) === 0) throw new Error('Invalid native recovery originator');
  return { kind: 'native', brokerInstance: identifier(input.brokerInstance, 200), sequence: count(input.sequence) };
}
export type UiRecovery =
  | { readonly version: 1; readonly kind: 'needs-context' }
  | ({ readonly version: 1; readonly hostId: string; readonly profileId: string; readonly request: RecoveryRequest; readonly originator: RecoveryOriginator } & (
    | { readonly kind: 'reserved' }
    | { readonly kind: 'conflicted'; readonly reason: string }
  ));
export function reserveRecovery(context: UiContextV1, originator: RecoveryOriginator = { kind: 'browser' }): Extract<UiRecovery, { readonly kind: 'reserved' }> {
  return { version: 1, kind: 'reserved', hostId: context.hostId, profileId: context.profileId, originator,
    request: { op: 'restore', requestId: `recovery:${context.recoveryGeneration}:${crypto.randomUUID()}`,
      expectedRecoveryGeneration: context.recoveryGeneration, expectedRevision: context.revision } };
}
export function parseUiRecovery(value: unknown): UiRecovery {
  const input = record(value);
  if (input.version !== 1) throw new Error('Unsupported local appearance recovery');
  if (input.kind === 'needs-context') { record(input, ['version', 'kind']); return { version: 1, kind: 'needs-context' }; }
  const common = ['version', 'kind', 'hostId', 'profileId', 'request', ...(Object.hasOwn(input, 'originator') ? ['originator'] : [])];
  record(input, input.kind === 'conflicted' ? [...common, 'reason'] : common);
  const request = record(input.request, ['op', 'requestId', 'expectedRecoveryGeneration', 'expectedRevision']);
  const expectedRecoveryGeneration = count(request.expectedRecoveryGeneration), requestId = identifier(request.requestId, 128);
  if (request.op !== 'restore' || !new RegExp(`^recovery:${expectedRecoveryGeneration}:[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}$`, 'i').test(requestId)) throw new Error('Invalid local appearance recovery request');
  const parsed = { version: 1, originator: parseOriginator(input.originator), hostId: identifier(input.hostId), profileId: identifier(input.profileId, 200),
    request: { op: 'restore', requestId, expectedRecoveryGeneration, expectedRevision: count(request.expectedRevision) } } satisfies Omit<Extract<UiRecovery, { readonly kind: 'reserved' }>, 'kind'>;
  if (input.kind === 'reserved') return { ...parsed, kind: 'reserved' };
  if (input.kind === 'conflicted') return { ...parsed, kind: 'conflicted', reason: identifier(input.reason, 1000) };
  throw new Error('Invalid local appearance recovery state');
}
