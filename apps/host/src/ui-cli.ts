import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { count, record } from '@openpane/contracts/decode';
import { readExperienceDirectory } from './experience-bundle.js';
import { requestUi, uiInput } from './ui-control.js';
import { UI_FRAME_BYTES, UiRefusal } from './ui-protocol.js';
import { runDisplayCli } from './ui-display-cli.js';

async function stdin(): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > UI_FRAME_BYTES) throw new UiRefusal('invalid-input', 'UI stdin exceeds byte limit');
    chunks.push(buffer);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new UiRefusal('invalid-input', 'UI stdin must contain valid UTF-8 JSON'); }
}
export async function runUiCli(args: readonly string[]): Promise<void> {
  const { values, positionals } = uiInput(() => parseArgs({ args: [...args], allowPositionals: true, options: {
    'data-dir': { type: 'string' }, 'request-id': { type: 'string' }, 'expected-revision': { type: 'string' },
    'expected-recovery-generation': { type: 'string' }, 'expected-epoch': { type: 'string' }, directory: { type: 'string' }, stdin: { type: 'boolean' },
    builtin: { type: 'boolean' }, 'abandon-waits': { type: 'boolean' }, after: { type: 'string' }, keep: { type: 'string' }, 'wait-ms': { type: 'string' },
    'scope-json': { type: 'string' }, 'publication-id': { type: 'string' }, query: { type: 'string' }, title: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, pup: { type: 'string' },
    'expected-attempt': { type: 'string' }, 'cursor-json': { type: 'string' }, 'subscription-id': { type: 'string' },
  } }));
  if (!values['data-dir']) throw new UiRefusal('invalid-input', 'Provide --data-dir for the running host');
  const socket = join(resolve(values['data-dir']), 'ui.sock');
  const integer = (value: string | undefined): number => {
    if (value === undefined || !/^\d+$/.test(value)) throw new UiRefusal('invalid-input', 'Expected an explicit nonnegative integer');
    return uiInput(() => count(Number(value)));
  };
  const [category, action, ...extra] = positionals;
  if (extra.length) throw new UiRefusal('invalid-input', 'Unexpected UI command arguments');
  const commandFlags: Readonly<Record<string, readonly string[]>> = {
    context: [], targets: ['after'], 'experience schema': [], 'experience apply': ['request-id', 'expected-revision', 'directory', 'stdin'],
    'experience refresh': ['request-id', 'expected-revision'], 'experience restore': ['request-id', 'expected-revision', 'expected-recovery-generation', 'builtin'],
    'experience prune': ['request-id', 'keep'], 'maintenance compact': ['expected-epoch', 'abandon-waits'], status: ['request-id'], wait: ['request-id', 'wait-ms'],
    'display schema': [], 'display publish': ['scope-json', 'publication-id', 'stdin'], 'display status': ['scope-json', 'publication-id'],
    'display remove': ['scope-json', 'publication-id', 'request-id'], 'display retry': ['scope-json', 'publication-id', 'expected-attempt'],
    'display list': ['scope-json', 'after', 'cursor-json', 'subscription-id'], 'display datadog': ['scope-json', 'publication-id', 'query', 'title', 'from', 'to', 'pup'],
  };
  const commandName = `${category ?? ''} ${action ?? ''}`.trim();
  const allowed = Object.hasOwn(commandFlags, commandName) ? commandFlags[commandName] : undefined;
  if (!allowed || Object.keys(values).some(key => key !== 'data-dir' && !allowed.includes(key))) throw new UiRefusal('invalid-input', 'Unsupported UI command or flag');
  if (category === 'display') { process.stdout.write(JSON.stringify(await runDisplayCli(action, socket, values, stdin)) + '\n'); return; }
  const experienceDirectory = async (path: string) => {
    try { return await readExperienceDirectory(path); }
    catch (error) { throw new UiRefusal('invalid-input', error instanceof Error ? error.message.slice(0, 500) : 'Invalid experience directory'); }
  };
  const expectedRevision = () => integer(values['expected-revision']);
  const requestId = () => { if (!values['request-id']) throw new UiRefusal('invalid-input', 'Provide --request-id from ui context'); return values['request-id']; };
  let request: unknown;
  switch (`${category ?? ''} ${action ?? ''}`.trim()) {
    case 'targets': request = { op: 'targets', after: values.after ?? null }; break;
    case 'context': request = { op: 'context' }; break;
    case 'experience schema': request = { op: 'schema' }; break;
    case 'experience apply': {
      if (!!values.stdin === !!values.directory) throw new UiRefusal('invalid-input', 'Use exactly one of --directory or --stdin');
      request = { op: 'apply', requestId: requestId(), expectedRevision: expectedRevision(), bundle: values.directory ? await experienceDirectory(resolve(values.directory)) : await stdin() };
      break;
    }
    case 'experience refresh': request = { op: 'refresh', requestId: requestId(), expectedRevision: expectedRevision() }; break;
    case 'experience restore':
      if (!values.builtin) throw new UiRefusal('invalid-input', 'Restore requires --builtin');
      request = { op: 'restore', requestId: requestId(), expectedRevision: expectedRevision(), expectedRecoveryGeneration: integer(values['expected-recovery-generation']) }; break;
    case 'experience prune': request = { op: 'prune', requestId: requestId(), keep: integer(values.keep) }; break;
    case 'maintenance compact': request = { op: 'compact', expectedEpoch: integer(values['expected-epoch']), abandonWaits: values['abandon-waits'] === true }; break;
    case 'status': request = { op: 'status', requestId: requestId() }; break;
    case 'wait': {
      const limit = integer(values['wait-ms'] ?? '30000'); if (limit > 30000) throw new UiRefusal('invalid-input', 'Wait is limited to 30000 milliseconds');
      const deadline = performance.now() + limit;
      let last: Record<string, unknown> | null = null;
      for (;;) {
        const remaining = Math.max(1, deadline - performance.now());
        let result: Record<string, unknown>;
        try { result = record(await requestUi(socket, { op: 'status', requestId: requestId() }, remaining)); }
        catch (error) { if (!last || performance.now() < deadline) throw error; result = last; }
        last = result;
        if (result.outcome !== 'pending' || performance.now() >= deadline) { process.stdout.write(JSON.stringify({ ...result, waitEnded: result.outcome === 'pending' }) + '\n'); return; }
        await new Promise(resolve => setTimeout(resolve, Math.min(300, Math.max(0, deadline - performance.now()))));
      }
    }
    default: throw new UiRefusal('invalid-input', 'Use ui context, experience schema/apply/refresh/restore/prune, status, wait, or maintenance compact');
  }
  process.stdout.write(JSON.stringify(await requestUi(socket, request)) + '\n');
}
