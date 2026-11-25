import type { ConversationScope } from './index.js';
import { parseScope } from './durable.js';
import { identifier, record } from './decode.js';

/** The selected conversation is only the editor mounted inline in this document. */
export type ConversationOpenResult =
  | { readonly kind: 'inline'; readonly scope: ConversationScope }
  | { readonly kind: 'detached'; readonly scope: ConversationScope; readonly label: string }
  | { readonly kind: 'pending'; readonly scope: ConversationScope | null; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string };
export function parseConversationOpenResult(value: unknown): ConversationOpenResult {
  const input = record(value);
  switch (input.kind) {
    case 'inline': record(input, ['kind', 'scope']); return { kind: 'inline', scope: parseScope(input.scope) };
    case 'detached': record(input, ['kind', 'scope', 'label']); return { kind: 'detached', scope: parseScope(input.scope), label: identifier(input.label, 200) };
    case 'pending': record(input, ['kind', 'scope', 'reason']); return { kind: 'pending', scope: input.scope === null ? null : parseScope(input.scope), reason: identifier(input.reason, 1000) };
    case 'refused': record(input, ['kind', 'reason']); return { kind: 'refused', reason: identifier(input.reason, 1000) };
    default: throw new Error('Invalid conversation placement result');
  }
}
