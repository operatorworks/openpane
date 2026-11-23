import { parseDisplayCursor, parseDisplayPage, parseScope, parseUiContext } from '@openpane/contracts';
import { boundedText, count, identifier } from '@openpane/contracts/decode';
import { requestUi } from './ui-control.js';
import { displayDigest } from './ui-display-db.js';
import { displayStatus, publishDatadog } from './ui-display-client.js';
import { validateDisplayEvent } from './ui-display-protocol.js';

export async function runDisplayCli(action: string | undefined, socket: string, values: Readonly<Record<string, string | boolean | undefined>>, stdin: () => Promise<unknown>): Promise<unknown> {
  const required = (name: string): string => { const value = values[name]; if (typeof value !== 'string' || !value) throw new Error(`Provide --${name}`); return value; };
  const optional = (name: string): string | undefined => { const value = values[name]; return typeof value === 'string' ? value : undefined; };
  const integer = (name: string): number => { const value = required(name); if (!/^\d+$/.test(value)) throw new Error(`Invalid --${name}`); return count(Number(value)); };
  const json = (text: string, name: string): unknown => { try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON in --${name}`); } };
  if (action === 'schema') return requestUi(socket, { op: 'display-schema' });
  const scope = parseScope(json(required('scope-json'), 'scope-json'));
  if (action === 'list') {
    if (values.after !== undefined && values['cursor-json'] !== undefined) throw new Error('Use either --after or --cursor-json');
    const cursor = values['cursor-json'] !== undefined ? parseDisplayCursor(json(required('cursor-json'), 'cursor-json'))
      : values.after !== undefined ? { kind: 'live', epoch: parseUiContext(await requestUi(socket, { op: 'context' })).requestEpoch, sequence: integer('after') } : null;
    return parseDisplayPage(await requestUi(socket, { op: 'display-list', subscription: { scope, subscriptionId: optional('subscription-id') ?? `cli:${displayDigest(scope)}`, cursor } }));
  }
  const publicationId = identifier(required('publication-id'), 128);
  switch (action) {
    case 'status': return displayStatus(socket, scope, publicationId);
    case 'publish': {
      if (values.stdin !== true) throw new Error('Display publication requires --stdin with one named CUSTOM event');
      return requestUi(socket, { op: 'display-publish', scope, publicationId, event: validateDisplayEvent(await stdin()) });
    }
    case 'remove': return requestUi(socket, { op: 'display-remove', scope, publicationId, requestId: required('request-id') });
    case 'retry': return publishDatadog({ socket, scope, publicationId, action: { kind: 'retry', expectedAttempt: integer('expected-attempt') } });
    case 'datadog': {
      const from = optional('from') ?? '1h', to = optional('to') ?? 'now';
      if (![from, to].every(value => value.length <= 32 && /^(?:now|\d+[mhd]?)$/.test(value))) throw new Error('Use now, whole epoch seconds or a relative range such as 1h');
      return publishDatadog({ socket, scope, publicationId, action: { kind: 'query', query: boundedText(required('query'), 4096), title: boundedText(optional('title') ?? 'Datadog metrics', 200), from, to, pup: optional('pup') ?? null } });
    }
    default: throw new Error('Use display schema, publish, datadog, list, status, remove or retry');
  }
}
