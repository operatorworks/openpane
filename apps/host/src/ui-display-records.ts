import { parseDisplayReceipt, sameScope } from '@openpane/contracts';
import type { ConversationScope, DisplayReceipt, QueryReservation } from '@openpane/contracts';
import { count, hex, identifier, record } from '@openpane/contracts/decode';
import { parseDisplayQueryInput } from './ui-display-protocol.js';
import type { DisplayQueryInput } from './ui-display-protocol.js';
import type { PupRange } from './ui-pup.js';

export type QueryOutcome =
  | { readonly kind: 'running' | 'abandoned' }
  | { readonly kind: 'failed' | 'interrupted'; readonly reason: string }
  | { readonly kind: 'published' | 'removed'; readonly receipt: DisplayReceipt };
export type DisplayKey = { readonly version: 1; readonly inputDigest: string } & (
  | { readonly mode: 'raw'; readonly removed: boolean; readonly receipt: DisplayReceipt }
  | { readonly mode: 'query'; readonly input: DisplayQueryInput; readonly range: PupRange; readonly executeUntilMs: number; readonly attempt: number; readonly outcome: QueryOutcome }
);
export function keyState(key: DisplayKey): 'published' | 'removed' | 'running' | 'failed' | 'interrupted' | 'abandoned' {
  return key.mode === 'raw' ? key.removed ? 'removed' : 'published' : key.outcome.kind;
}
export function parseDisplayKey(value: unknown, scope: ConversationScope, publicationId: string): DisplayKey {
  const input = record(value);
  if (input.version !== 1) throw new Error('Unsupported display record version');
  const common = { version: 1, inputDigest: hex(input.inputDigest, 64) } as const;
  const receipt = (value: unknown): DisplayReceipt => {
    const parsed = parseDisplayReceipt(value);
    if (!sameScope(parsed.scope, scope) || parsed.publicationId !== publicationId) throw new Error('Display record identity mismatch');
    return parsed;
  };
  if (input.mode === 'raw') {
    record(input, ['version', 'inputDigest', 'mode', 'removed', 'receipt']);
    if (typeof input.removed !== 'boolean') throw new Error('Invalid display record');
    return { ...common, mode: 'raw', removed: input.removed, receipt: receipt(input.receipt) };
  }
  record(input, ['version', 'inputDigest', 'mode', 'input', 'range', 'executeUntilMs', 'attempt', 'outcome']);
  if (input.mode !== 'query') throw new Error('Invalid display mode');
  const range = record(input.range, ['fromSeconds', 'toSeconds']);
  const fromSeconds = count(range.fromSeconds), toSeconds = count(range.toSeconds), attempt = count(input.attempt);
  if (!attempt || fromSeconds >= toSeconds || toSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) throw new Error('Invalid display query generation or range');
  const outcome = record(input.outcome);
  let parsed: QueryOutcome;
  if (outcome.kind === 'running' || outcome.kind === 'abandoned') { record(outcome, ['kind']); parsed = { kind: outcome.kind }; }
  else if (outcome.kind === 'failed' || outcome.kind === 'interrupted') { record(outcome, ['kind', 'reason']); parsed = { kind: outcome.kind, reason: identifier(outcome.reason, 128) }; }
  else {
    record(outcome, ['kind', 'receipt']);
    if (outcome.kind !== 'published' && outcome.kind !== 'removed') throw new Error('Invalid query outcome');
    parsed = { kind: outcome.kind, receipt: receipt(outcome.receipt) };
  }
  return { ...common, mode: 'query', input: parseDisplayQueryInput(input.input), range: { fromSeconds, toSeconds }, executeUntilMs: count(input.executeUntilMs ?? 0), attempt, outcome: parsed };
}
export function queryReservation(scope: ConversationScope, publicationId: string, key: Extract<DisplayKey, { readonly mode: 'query' }>): QueryReservation {
  const common = { scope, publicationId, attempt: key.attempt, query: key.input.query, ...key.range, executable: key.input.executable, version: key.input.version, site: key.input.site };
  switch (key.outcome.kind) {
    case 'running': case 'abandoned': return { ...common, kind: key.outcome.kind };
    case 'failed': case 'interrupted': return { ...common, kind: key.outcome.kind, reason: key.outcome.reason };
    case 'published': case 'removed': return { ...common, kind: key.outcome.kind, sequence: key.outcome.receipt.sequence, digest: key.outcome.receipt.digest };
  }
}
