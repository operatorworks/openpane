import type { ConversationScope } from './index.js';
import { parseScope } from './durable.js';
import { count, identifier, record } from './decode.js';

export type EditorBinding = {
  readonly schemaVersion: 1;
  readonly scope: ConversationScope;
  readonly viewId: string;
  readonly revision: number;
  readonly writerGeneration: number;
} & (
  | { readonly kind: 'editing' }
  | { readonly kind: 'handoff-reserved'; readonly transitionId: string; readonly targetLabel: string }
);

export function parseEditorBinding(value: unknown): EditorBinding {
  const input = record(value);
  const keys = ['schemaVersion', 'kind', 'scope', 'viewId', 'revision', 'writerGeneration'];
  record(input, input.kind === 'handoff-reserved' ? [...keys, 'transitionId', 'targetLabel'] : keys);
  if (input.schemaVersion !== 1) throw new Error('Unsupported editor binding version');
  const revision = count(input.revision), writerGeneration = count(input.writerGeneration);
  if (revision === 0 || writerGeneration === 0) throw new Error('Invalid editor binding generation');
  const common = { schemaVersion: 1, scope: parseScope(input.scope), viewId: identifier(input.viewId, 200), revision, writerGeneration } satisfies Omit<EditorBinding, 'kind'>;
  if (input.kind === 'editing') return { ...common, kind: 'editing' };
  if (input.kind === 'handoff-reserved') return { ...common, kind: 'handoff-reserved',
    transitionId: identifier(input.transitionId, 200), targetLabel: identifier(input.targetLabel, 200) };
  throw new Error('Invalid editor binding state');
}

const id = { type: 'string', minLength: 1, maxLength: 200 };
const scope = { type: 'object', additionalProperties: false, required: ['hostId', 'conversationId'], properties: {
  hostId: { type: 'string', minLength: 1, maxLength: 1024 }, conversationId: { type: 'string', minLength: 1, maxLength: 1024 },
} };
const properties = { schemaVersion: { const: 1 }, scope, viewId: id,
  revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  writerGeneration: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } };
export const EDITOR_BINDING_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'OpenPane editor binding v1',
  oneOf: [
    { type: 'object', additionalProperties: false, required: [...Object.keys(properties), 'kind'], properties: { ...properties, kind: { const: 'editing' } } },
    { type: 'object', additionalProperties: false, required: [...Object.keys(properties), 'kind', 'transitionId', 'targetLabel'],
      properties: { ...properties, kind: { const: 'handoff-reserved' }, transitionId: id, targetLabel: id } },
  ],
};
