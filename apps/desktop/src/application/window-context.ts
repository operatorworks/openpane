import type { EditorRecoveryGrant } from './editor-bindings.js';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { parseScope, parseConversationOpenResult, sameScope } from '@openpane/contracts';
import type { ConversationScope, ConversationOpenResult } from '@openpane/contracts';
import { identifier, record } from '@openpane/contracts/decode';

export interface NativeReservation {
  readonly scope: ConversationScope;
  readonly viewId: string;
  readonly label: string;
  readonly transitionId: string;
  readonly creationAgentId: string | null;
  readonly phase: 'assigned' | 'requested' | 'source-saved' | 'transfer-committed' | 'source-released' | 'target-ready' | 'inline-ready' | 'failed';
  readonly bindingRevision: number | null;
  readonly writerGeneration: number | null;
}
export type NativeWindowLookup =
  | { readonly kind: 'absent' }
  | { readonly kind: 'closed' | 'opening' | 'ready'; readonly reservation: NativeReservation };
export function parseNativeWindowLookup(value: unknown, scope: ConversationScope): NativeWindowLookup {
  const input = record(value);
  if (input.kind === 'absent') { record(input, ['kind']); return { kind: 'absent' }; }
  record(input, ['kind', 'reservation']);
  if (input.kind !== 'closed' && input.kind !== 'opening' && input.kind !== 'ready') throw new Error('Invalid native window state');
  const reservation = parseNativeReservation(input.reservation);
  if (!sameScope(reservation.scope, scope)) throw new Error('Foreign native window lookup');
  return { kind: input.kind, reservation };
}
export type DesktopWindowContext =
  | { readonly role: 'browser'; readonly capability: 'inline' }
  | ({ readonly version: 1; readonly label: string; readonly brokerInstance: string; readonly documentIncarnation: string; readonly viewId: string; readonly liveRelay: boolean } & (
    | { readonly role: 'main'; readonly reservation: null }
    | { readonly role: 'chat'; readonly reservation: NativeReservation }
  ));
export function parseNativeReservation(value: unknown): NativeReservation {
  const input = record(value, ['scope', 'viewId', 'label', 'transitionId', 'creationAgentId', 'phase', 'bindingRevision', 'writerGeneration']);
  const phase = input.phase;
  if (phase !== 'assigned' && phase !== 'requested' && phase !== 'source-saved' && phase !== 'transfer-committed' && phase !== 'source-released' && phase !== 'target-ready' && phase !== 'inline-ready' && phase !== 'failed') throw new Error('Invalid native reservation phase');
  function generation(value: unknown): number | null {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid native binding generation');
    return value;
  }
  return { scope: parseScope(input.scope), viewId: identifier(input.viewId, 200), label: identifier(input.label, 200), transitionId: identifier(input.transitionId, 200),
    creationAgentId: input.creationAgentId === null ? null : identifier(input.creationAgentId), phase, bindingRevision: generation(input.bindingRevision), writerGeneration: generation(input.writerGeneration) };
}
export function parseDesktopWindowContext(value: unknown): Exclude<DesktopWindowContext, { readonly role: 'browser' }> {
  const input = record(value, ['version', 'role', 'label', 'brokerInstance', 'documentIncarnation', 'viewId', 'reservation', 'liveRelay']);
  if (input.version !== 1 || typeof input.liveRelay !== 'boolean') throw new Error('Unsupported desktop window context');
  const common = { version: 1, label: identifier(input.label, 200), brokerInstance: identifier(input.brokerInstance, 200), documentIncarnation: identifier(input.documentIncarnation, 200), viewId: identifier(input.viewId, 200), liveRelay: input.liveRelay } satisfies Omit<Exclude<DesktopWindowContext, { readonly role: 'browser' }>, 'role' | 'reservation'>;
  if (input.role === 'main' && input.reservation === null && common.label === 'main') return { ...common, role: 'main', reservation: null };
  if (input.role === 'chat') {
    const reservation = parseNativeReservation(input.reservation);
    if (reservation.label !== common.label || reservation.viewId !== common.viewId) throw new Error('Native child context does not match its reservation');
    return { ...common, role: 'chat', reservation };
  }
  throw new Error('Unknown desktop window role');
}
export async function loadWindowContext(): Promise<DesktopWindowContext> {
  if (!isTauri()) return { role: 'browser', capability: 'inline' };
  const value: unknown = await invoke('desktop_window', { command: { kind: 'context', nonce: crypto.randomUUID() } });
  return parseDesktopWindowContext(value);
}
export class DesktopWindowPort {
  constructor(readonly context: Exclude<DesktopWindowContext, { readonly role: 'browser' }>) {}
  request = (command: object): Promise<unknown> => invoke('desktop_window', { command: { ...command, incarnation: this.context.documentIncarnation } });
  listen = (event: 'openpane-ui-wakeup' | 'openpane-ui-cache' | 'openpane-placement-intent' | 'openpane-close-requested', handler: () => void): Promise<() => void> => listen(event, handler, { target: { kind: 'WebviewWindow', label: this.context.label } });
}

export interface NativePlacementIntent {
  readonly sourceScope: ConversationScope;
  readonly requestId: string;
  readonly action: { readonly kind: 'create'; readonly agentId: string; readonly carry: boolean } | { readonly kind: 'open'; readonly scope: ConversationScope; readonly carry: boolean; readonly passive?: true };
  readonly target: NativeReservation | null;
  readonly result: ConversationOpenResult | null;
}
export function parseNativePlacementIntent(value: unknown): NativePlacementIntent {
  const input = record(value, ['sourceScope', 'requestId', 'action', 'target', 'result']), action = record(input.action);
  let parsed: NativePlacementIntent['action'];
  if (typeof action.carry !== 'boolean') throw new Error('Invalid native draft carry action');
  if (action.kind === 'create') { record(action, ['kind', 'agentId', 'carry']); parsed = { kind: 'create', agentId: identifier(action.agentId), carry: action.carry }; }
  else if (action.kind === 'open') {
    record(action, ['kind', 'scope', 'carry', ...(Object.hasOwn(action, 'passive') ? ['passive'] : [])]);
    if (Object.hasOwn(action, 'passive') && action.passive !== true) throw new Error('Invalid passive native placement action');
    parsed = { kind: 'open', scope: parseScope(action.scope), carry: action.carry, ...(action.passive === true ? { passive: true } : {}) };
  }
  else throw new Error('Invalid native placement action');
  const sourceScope = parseScope(input.sourceScope), target = input.target === null ? null : parseNativeReservation(input.target);
  if (target && target.scope.hostId !== sourceScope.hostId) throw new Error('Foreign native placement intent');
  return { sourceScope, requestId: identifier(input.requestId, 200), action: parsed, target,
    result: input.result === null ? null : parseConversationOpenResult(input.result) };
}

export function parseEditorRecoveryGrant(value: unknown): EditorRecoveryGrant {
  const input = record(value, ['scope', 'viewId', 'nativeLabel', 'fromTransitionId', 'transitionId', 'targetLabel', 'creationAgentId']);
  if (input.targetLabel !== 'main') throw new Error('Only main may recover an abandoned native handoff');
  return { scope: parseScope(input.scope), viewId: identifier(input.viewId, 200), nativeLabel: identifier(input.nativeLabel, 200),
    fromTransitionId: identifier(input.fromTransitionId, 200), transitionId: identifier(input.transitionId, 200), targetLabel: input.targetLabel,
    creationAgentId: input.creationAgentId === null ? null : identifier(input.creationAgentId) };
}


export function childPlacementResult(result: Exclude<ConversationOpenResult, { readonly kind: 'pending' }>): Exclude<ConversationOpenResult, { readonly kind: 'pending' | 'inline' }>;
export function childPlacementResult(result: ConversationOpenResult): Exclude<ConversationOpenResult, { readonly kind: 'inline' }>;
export function childPlacementResult(result: ConversationOpenResult): Exclude<ConversationOpenResult, { readonly kind: 'inline' }> {
  return result.kind === 'inline' ? { kind: 'detached', scope: result.scope, label: 'main' } : result;
}
