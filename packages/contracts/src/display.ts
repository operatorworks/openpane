import { boundedText, count, hex, identifier, record, utf8Bytes } from './decode.js';
import { parseScope, sameScope } from './durable.js';
import { METRICS_EVENT_NAME, metricsCardSchema, parseMetricsCard } from './metrics-card.js';
import type { ConversationScope } from './index.js';
import type { DisplayChange, DisplayPublication, QueryReservation } from './ui-state.js';

export const DISPLAY_PAGE_LIMITS = { items: 8, bytes: 512 * 1024 } as const;
export type DisplayReceipt = Omit<DisplayPublication, 'event'>;
export const metricsEventSchema = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
  required: ['type', 'name', 'value'], properties: { type: { const: 'CUSTOM' }, name: { const: METRICS_EVENT_NAME }, value: metricsCardSchema } } as const;
export type DisplayCursor =
  | { readonly kind: 'live'; readonly epoch: number; readonly sequence: number }
  | { readonly kind: 'snapshot'; readonly snapshotId: string; readonly highWater: number; readonly after: number };
export interface DisplaySubscription {
  readonly scope: ConversationScope;
  readonly subscriptionId: string;
  readonly cursor: DisplayCursor | null;
}
type PageIdentity = { readonly scope: ConversationScope; readonly subscriptionId: string; readonly from: DisplayCursor | null };
export type DisplayPage = PageIdentity & (
  | { readonly kind: 'reset' }
  | { readonly kind: 'snapshot'; readonly snapshotId: string; readonly highWater: number; readonly publications: readonly DisplayPublication[]; readonly next: DisplayCursor }
  | { readonly kind: 'changes'; readonly highWater: number; readonly changes: readonly DisplayChange[]; readonly next: Extract<DisplayCursor, { readonly kind: 'live' }> }
);
export type DisplayDelivery = { readonly kind: 'page'; readonly page: DisplayPage }
  | { readonly kind: 'unavailable'; readonly scope: ConversationScope; readonly subscriptionId: string; readonly from: DisplayCursor | null; readonly reason: string };
export function parseDisplayDelivery(value: unknown): DisplayDelivery {
  const input = record(value);
  if (input.kind === 'page') { record(input, ['kind', 'page']); return { kind: 'page', page: parseDisplayPage(input.page) }; }
  record(input, ['kind', 'scope', 'subscriptionId', 'from', 'reason']);
  if (input.kind !== 'unavailable') throw new Error('Invalid display delivery');
  return { kind: 'unavailable', scope: parseScope(input.scope), subscriptionId: identifier(input.subscriptionId, 128), from: input.from === null ? null : parseDisplayCursor(input.from), reason: boundedText(input.reason, 500) };
}
export function parseMetricsEvent(value: unknown): DisplayPublication['event'] {
  const event = record(value, ['type', 'name', 'value']);
  if (event.type !== 'CUSTOM' || event.name !== METRICS_EVENT_NAME) throw new Error('Expected the named OpenPane metrics CUSTOM event');
  return { type: 'CUSTOM', name: METRICS_EVENT_NAME, value: parseMetricsCard(event.value) };
}
export function parseDisplayPublication(value: unknown): DisplayPublication {
  const input = record(value, ['scope', 'publicationId', 'sequence', 'publishedAtMs', 'digest', 'event']);
  return { ...parseDisplayReceipt({ scope: input.scope, publicationId: input.publicationId, sequence: input.sequence, publishedAtMs: input.publishedAtMs, digest: input.digest }), event: parseMetricsEvent(input.event) };
}
export function parseDisplayReceipt(value: unknown): DisplayReceipt {
  const input = record(value, ['scope', 'publicationId', 'sequence', 'publishedAtMs', 'digest']);
  const sequence = count(input.sequence);
  if (!sequence) throw new Error('Display sequence must be positive');
  return { scope: parseScope(input.scope), publicationId: identifier(input.publicationId, 128), sequence,
    publishedAtMs: count(input.publishedAtMs), digest: hex(input.digest, 64) };
}
export function parseDisplayCursor(value: unknown): DisplayCursor {
  const input = record(value);
  if (input.kind === 'live') {
    record(input, ['kind', 'epoch', 'sequence']);
    const epoch = count(input.epoch);
    if (!epoch) throw new Error('Invalid display epoch');
    return { kind: 'live', epoch, sequence: count(input.sequence) };
  }
  record(input, ['kind', 'snapshotId', 'highWater', 'after']);
  const highWater = count(input.highWater), after = count(input.after);
  if (input.kind !== 'snapshot' || after > highWater) throw new Error('Invalid display snapshot cursor');
  return { kind: 'snapshot', snapshotId: identifier(input.snapshotId, 128), highWater, after };
}
export function parseDisplaySubscription(value: unknown): DisplaySubscription {
  const input = record(value, ['scope', 'subscriptionId', 'cursor']);
  return { scope: parseScope(input.scope), subscriptionId: identifier(input.subscriptionId, 128), cursor: input.cursor === null ? null : parseDisplayCursor(input.cursor) };
}
export function parseQueryReservation(value: unknown): QueryReservation {
  const input = record(value), kind = input.kind;
  const keys = ['scope', 'publicationId', 'attempt', 'query', 'fromSeconds', 'toSeconds', 'executable', 'version', 'site', 'kind'];
  record(input, kind === 'failed' || kind === 'interrupted' ? [...keys, 'reason'] : kind === 'published' || kind === 'removed' ? [...keys, 'sequence', 'digest'] : keys);
  const attempt = count(input.attempt), fromSeconds = count(input.fromSeconds), toSeconds = count(input.toSeconds);
  if (!attempt || fromSeconds >= toSeconds || toSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) throw new Error('Invalid query reservation');
  const common = { scope: parseScope(input.scope), publicationId: identifier(input.publicationId, 128), attempt, query: boundedText(input.query, 4096),
    fromSeconds, toSeconds, executable: identifier(input.executable, 4096), version: identifier(input.version, 128), site: identifier(input.site, 253) };
  switch (kind) {
    case 'reserved': case 'running': case 'abandoned': return { ...common, kind };
    case 'failed': case 'interrupted': return { ...common, kind, reason: identifier(input.reason, 128) };
    case 'published': case 'removed': {
      const sequence = count(input.sequence); if (!sequence) throw new Error('Invalid published query sequence');
      return { ...common, kind, sequence, digest: hex(input.digest, 64) };
    }
    default: throw new Error('Invalid query reservation outcome');
  }
}
export function parseDisplayPage(value: unknown): DisplayPage {
  const input = record(value);
  const identity = { scope: parseScope(input.scope), subscriptionId: identifier(input.subscriptionId, 128), from: input.from === null ? null : parseDisplayCursor(input.from) };
  const next = input.kind === 'reset' ? null : parseDisplayCursor(input.next);
  let page: DisplayPage;
  if (input.kind === 'reset') { record(input, ['kind', 'scope', 'subscriptionId', 'from']); page = { ...identity, kind: 'reset' }; }
  else if (input.kind === 'snapshot' && next) {
    record(input, ['kind', 'scope', 'subscriptionId', 'from', 'snapshotId', 'highWater', 'publications', 'next']);
    if (!Array.isArray(input.publications) || input.publications.length > DISPLAY_PAGE_LIMITS.items) throw new Error('Display snapshot exceeds its item limit');
    const snapshotId = identifier(input.snapshotId, 128), highWater = count(input.highWater);
    const publications = input.publications.map(parseDisplayPublication);
    if (identity.from?.kind === 'live' || new Set(publications.map(publication => publication.publicationId)).size !== publications.length) throw new Error('Invalid display snapshot publications');
    let previous = identity.from?.kind === 'snapshot' ? identity.from.after : 0;
    for (const publication of publications) {
      if (!sameScope(publication.scope, identity.scope) || publication.sequence <= previous || publication.sequence > highWater) throw new Error('Invalid scoped display snapshot order');
      previous = publication.sequence;
    }
    if (identity.from?.kind === 'snapshot' && (identity.from.snapshotId !== snapshotId || identity.from.highWater !== highWater)) throw new Error('Display snapshot identity changed');
    if (next.kind === 'snapshot' ? !publications.length || next.snapshotId !== snapshotId || next.highWater !== highWater || next.after !== previous : next.sequence !== highWater) throw new Error('Invalid display snapshot continuation');
    page = { ...identity, kind: 'snapshot', snapshotId, highWater, publications, next };
  } else if (input.kind === 'changes' && next?.kind === 'live') {
    record(input, ['kind', 'scope', 'subscriptionId', 'from', 'highWater', 'changes', 'next']);
    if (identity.from?.kind !== 'live' || next.epoch !== identity.from.epoch || !Array.isArray(input.changes) || input.changes.length > DISPLAY_PAGE_LIMITS.items) throw new Error('Invalid display change page');
    const highWater = count(input.highWater);
    if (next.sequence > highWater) throw new Error('Display cursor exceeds its high-water mark');
    let previous = identity.from.sequence;
    const changes = input.changes.map((value: unknown): DisplayChange => {
      const change = record(value);
      let parsed: DisplayChange;
      if (change.kind === 'published') {
        record(change, ['kind', 'publication']);
        const publication = parseDisplayPublication(change.publication);
        if (!sameScope(publication.scope, identity.scope)) throw new Error('Foreign display publication');
        parsed = { kind: 'published', publication };
      } else {
        record(change, ['kind', 'publicationId', 'sequence']);
        if (change.kind !== 'removed') throw new Error('Invalid display change');
        parsed = { kind: 'removed', publicationId: identifier(change.publicationId, 128), sequence: count(change.sequence) };
      }
      const sequence = parsed.kind === 'published' ? parsed.publication.sequence : parsed.sequence;
      if (sequence <= previous || sequence > next.sequence) throw new Error('Invalid display change order');
      previous = sequence; return parsed;
    });
    if (next.sequence < previous) throw new Error('Display cursor moved backwards');
    page = { ...identity, kind: 'changes', highWater, changes, next };
  } else throw new Error('Invalid display page');
  if (utf8Bytes(JSON.stringify({ ok: true, value: page })) > DISPLAY_PAGE_LIMITS.bytes) throw new Error('Display page exceeds its byte limit');
  return page;
}
