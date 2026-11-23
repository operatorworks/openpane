import { count, identifier, record } from '@openpane/contracts/decode';
import type { UiContextV1 } from '@openpane/contracts';

export const UI_RECOVERY_KEY = 'openpane.ui-recovery.v1';
export interface RecoveryRequest {
  readonly op: 'restore'; readonly requestId: string; readonly expectedRecoveryGeneration: number; readonly expectedRevision: number;
}
export type UiRecovery =
  | { readonly version: 1; readonly kind: 'needs-context' }
  | ({ readonly version: 1; readonly hostId: string; readonly profileId: string; readonly request: RecoveryRequest } & (
    | { readonly kind: 'reserved' }
    | { readonly kind: 'conflicted'; readonly reason: string }
  ));
export function reserveRecovery(context: UiContextV1): Extract<UiRecovery, { readonly kind: 'reserved' }> {
  return { version: 1, kind: 'reserved', hostId: context.hostId, profileId: context.profileId,
    request: { op: 'restore', requestId: `recovery:${context.recoveryGeneration}:${crypto.randomUUID()}`,
      expectedRecoveryGeneration: context.recoveryGeneration, expectedRevision: context.revision } };
}
export function parseUiRecovery(value: unknown): UiRecovery {
  const input = record(value);
  if (input.version !== 1) throw new Error('Unsupported local appearance recovery');
  if (input.kind === 'needs-context') { record(input, ['version', 'kind']); return { version: 1, kind: 'needs-context' }; }
  const common = ['version', 'kind', 'hostId', 'profileId', 'request'];
  record(input, input.kind === 'conflicted' ? [...common, 'reason'] : common);
  const request = record(input.request, ['op', 'requestId', 'expectedRecoveryGeneration', 'expectedRevision']);
  const expectedRecoveryGeneration = count(request.expectedRecoveryGeneration), requestId = identifier(request.requestId, 128);
  if (request.op !== 'restore' || !new RegExp(`^recovery:${expectedRecoveryGeneration}:[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}$`, 'i').test(requestId)) throw new Error('Invalid local appearance recovery request');
  const parsed = { version: 1, hostId: identifier(input.hostId), profileId: identifier(input.profileId, 200),
    request: { op: 'restore', requestId, expectedRecoveryGeneration, expectedRevision: count(request.expectedRevision) } } satisfies Omit<Extract<UiRecovery, { readonly kind: 'reserved' }>, 'kind'>;
  if (input.kind === 'reserved') return { ...parsed, kind: 'reserved' };
  if (input.kind === 'conflicted') return { ...parsed, kind: 'conflicted', reason: identifier(input.reason, 1000) };
  throw new Error('Invalid local appearance recovery state');
}
