import { isAbsolute } from 'node:path';
import { EventSchema } from '@openpane/protocol';
import { parseDisplaySubscription, parseMetricsEvent, parseScope } from '@openpane/contracts';
import type { ConversationScope, DisplayPublication, DisplaySubscription } from '@openpane/contracts';
import { boundedText, count, identifier, record } from '@openpane/contracts/decode';

export interface DisplayQueryInput {
  readonly query: string;
  readonly title: string;
  readonly from: string;
  readonly to: string;
  readonly executable: string;
  readonly executableHint: string;
  readonly version: string;
  readonly site: string;
  readonly siteHint: string;
}
export const DISPLAY_QUERY_FAILURES = ['pup-unavailable', 'pup-failed', 'pup-timeout', 'pup-output-limit', 'invalid-response', 'cancelled'] as const;
export type DisplayQueryFailure = typeof DISPLAY_QUERY_FAILURES[number];
type PublicationKey = { readonly scope: ConversationScope; readonly publicationId: string };
export type DisplayRequest =
  | { readonly op: 'display-schema' }
  | (PublicationKey & { readonly op: 'display-publish'; readonly event: DisplayPublication['event'] })
  | (PublicationKey & { readonly op: 'display-status' })
  | (PublicationKey & { readonly op: 'display-remove'; readonly requestId: string })
  | { readonly op: 'display-list'; readonly subscription: DisplaySubscription }
  | (PublicationKey & { readonly op: 'display-query-reserve'; readonly input: DisplayQueryInput })
  | (PublicationKey & { readonly op: 'display-query-retry'; readonly expectedAttempt: number })
  | (PublicationKey & { readonly op: 'display-query-finalize'; readonly attempt: number; readonly event: DisplayPublication['event'] })
  | (PublicationKey & { readonly op: 'display-query-fail'; readonly attempt: number; readonly reason: DisplayQueryFailure });

export function parseDisplayQueryInput(value: unknown): DisplayQueryInput {
  const input = record(value, ['query', 'title', 'from', 'to', 'executable', 'executableHint', 'version', 'site', 'siteHint']);
  const executable = identifier(input.executable, 4096), version = identifier(input.version, 128), site = identifier(input.site, 253);
  if (!isAbsolute(executable) || executable.includes('\0')) throw new Error('Pup executable must be an absolute path');
  if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid qualified pup version');
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(site)) throw new Error('Invalid Datadog site');
  return { query: boundedText(input.query, 4096), title: boundedText(input.title, 200), from: identifier(input.from, 32), to: identifier(input.to, 32), executable,
    executableHint: identifier(input.executableHint, 4096), version, site, siteHint: identifier(input.siteHint, 512) };
}
export function validateDisplayEvent(value: unknown): DisplayPublication['event'] {
  EventSchema.parse(value);
  return parseMetricsEvent(value);
}
export function parseDisplayRequest(value: unknown): DisplayRequest {
  const input = record(value);
  if (input.op === 'display-schema') { record(input, ['op']); return { op: input.op }; }
  if (input.op === 'display-list') { record(input, ['op', 'subscription']); return { op: input.op, subscription: parseDisplaySubscription(input.subscription) }; }
  const key = () => ({ scope: parseScope(input.scope), publicationId: identifier(input.publicationId, 128) });
  const attempt = (value: unknown): number => { const result = count(value); if (!result) throw new Error('Query attempt must be positive'); return result; };
  switch (input.op) {
    case 'display-publish': record(input, ['op', 'scope', 'publicationId', 'event']); return { op: input.op, ...key(), event: validateDisplayEvent(input.event) };
    case 'display-status': record(input, ['op', 'scope', 'publicationId']); return { op: input.op, ...key() };
    case 'display-remove': record(input, ['op', 'scope', 'publicationId', 'requestId']); return { op: input.op, ...key(), requestId: identifier(input.requestId, 128) };
    case 'display-query-reserve': record(input, ['op', 'scope', 'publicationId', 'input']); return { op: input.op, ...key(), input: parseDisplayQueryInput(input.input) };
    case 'display-query-retry': record(input, ['op', 'scope', 'publicationId', 'expectedAttempt']); return { op: input.op, ...key(), expectedAttempt: attempt(input.expectedAttempt) };
    case 'display-query-finalize': record(input, ['op', 'scope', 'publicationId', 'attempt', 'event']); return { op: input.op, ...key(), attempt: attempt(input.attempt), event: validateDisplayEvent(input.event) };
    case 'display-query-fail': {
      record(input, ['op', 'scope', 'publicationId', 'attempt', 'reason']);
      const reason = DISPLAY_QUERY_FAILURES.find(reason => reason === input.reason);
      if (!reason) throw new Error('Invalid query failure code');
      return { op: input.op, ...key(), attempt: attempt(input.attempt), reason };
    }
    default: throw new Error('Unsupported UI operation');
  }
}
