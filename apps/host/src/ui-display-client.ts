import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { METRICS_EVENT_NAME, parseDisplayReceipt, parseQueryReservation, parseUiContext, sameScope } from '@openpane/contracts';
import type { ConversationScope, QueryReservation } from '@openpane/contracts';
import { record } from '@openpane/contracts/decode';
import { openUiQuerySession, requestUi } from './ui-control.js';
import type { UiQuerySession } from './ui-control.js';
import { parseDisplayQueryInput, validateDisplayEvent } from './ui-display-protocol.js';
import type { DisplayQueryFailure, DisplayQueryInput, DisplayRequest } from './ui-display-protocol.js';
import { normalizePup } from './ui-pup.js';
import { pupSite, pupVersion, runPup } from './ui-pup-process.js';
import { UiRefusal } from './ui-protocol.js';

interface QueryData { readonly input: DisplayQueryInput; readonly reservation: QueryReservation }
export type DisplayStatus = { readonly mode: 'missing' }
  | { readonly mode: 'raw'; readonly kind: 'published' | 'removed'; readonly receipt: ReturnType<typeof parseDisplayReceipt> }
  | ({ readonly mode: 'query' } & QueryData);
function identity(scope: ConversationScope, publicationId: string, value: { readonly scope: ConversationScope; readonly publicationId: string }): void {
  if (!sameScope(scope, value.scope) || publicationId !== value.publicationId) throw new Error('Display response belongs to another scope or publication');
}
function queryData(value: unknown, scope: ConversationScope, publicationId: string): QueryData {
  const input = record(value), query = parseDisplayQueryInput(input.input), reservation = parseQueryReservation(input.reservation);
  identity(scope, publicationId, reservation);
  if (query.query !== reservation.query || query.executable !== reservation.executable || query.version !== reservation.version || query.site !== reservation.site) throw new Error('Display query metadata disagrees with its reservation');
  return { input: query, reservation };
}
export async function displayStatus(socket: string, scope: ConversationScope, publicationId: string): Promise<DisplayStatus> {
  const input = record(await requestUi(socket, { op: 'display-status', scope, publicationId }));
  if (input.mode === 'missing') { record(input, ['mode']); return { mode: 'missing' }; }
  if (input.mode === 'raw') {
    record(input, ['mode', 'kind', 'receipt']); if (input.kind !== 'published' && input.kind !== 'removed') throw new Error('Invalid display state');
    const receipt = parseDisplayReceipt(input.receipt); identity(scope, publicationId, receipt); return { mode: 'raw', kind: input.kind, receipt };
  }
  record(input, ['mode', 'input', 'reservation']); if (input.mode !== 'query') throw new Error('Invalid display state');
  return { mode: 'query', ...queryData(input, scope, publicationId) };
}
async function executable(hint: string): Promise<string> {
  const candidates = hint === 'PATH:pup' ? (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path, 'pup')) : [hint];
  for (const path of candidates) {
    if (!isAbsolute(path)) continue;
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return await realpath(path); } catch {}
  }
  throw new Error('Pup executable not found. Configure an absolute --pup path or PATH.');
}
export interface DatadogCommand {
  readonly socket: string; readonly scope: ConversationScope; readonly publicationId: string;
  readonly action: { readonly kind: 'query'; readonly query: string; readonly title: string; readonly from: string; readonly to: string; readonly pup: string | null }
    | { readonly kind: 'retry'; readonly expectedAttempt: number };
}
export async function publishDatadog(command: DatadogCommand): Promise<{ readonly reservation: QueryReservation; readonly replayed: boolean }> {
  const { socket, scope, publicationId, action } = command, controller = new AbortController();
  let session: UiQuerySession | null = null;
  const cancelled = () => { controller.abort(); };
  process.once('SIGINT', cancelled); process.once('SIGTERM', cancelled);
  try {
    const status = await displayStatus(socket, scope, publicationId);
    if (status.mode === 'raw') throw new UiRefusal('conflict', 'Publication ID belongs to a raw display event');
    let request: Extract<DisplayRequest, { readonly op: 'display-query-retry' | 'display-query-reserve' }>;
    if (action.kind === 'retry') {
      request = { op: 'display-query-retry', scope, publicationId, expectedAttempt: action.expectedAttempt };
    } else {
      const configured = action.pup ?? (process.env.OPENPANE_PUP || null), executableHint = configured ?? 'PATH:pup', siteHint = process.env.DD_SITE || 'configured';
      if (configured !== null && !isAbsolute(configured)) throw new Error('Configure an absolute --pup executable path');
      let input: DisplayQueryInput;
      if (status.mode === 'query') input = { ...status.input, query: action.query, title: action.title, from: action.from, to: action.to, executableHint, siteHint };
      else {
        const context = parseUiContext(await requestUi(socket, { op: 'context' }));
        if (!new RegExp(`^${context.requestEpoch}:[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}$`, 'i').test(publicationId)) throw new UiRefusal('expired', 'Use an EPOCH:UUID publication ID from the current ui context');
        const path = await executable(executableHint), version = await pupVersion(path, controller.signal), site = await pupSite(path, controller.signal);
        input = { query: action.query, title: action.title, from: action.from, to: action.to, executable: path, executableHint, version, site, siteHint };
      }
      request = { op: 'display-query-reserve', scope, publicationId, input: parseDisplayQueryInput(input) };
    }
    session = await openUiQuerySession(socket, request);
    const first = record(session.first, ['input', 'reservation', 'granted']);
    if (typeof first.granted !== 'boolean') throw new Error('Invalid query session grant');
    const granted = queryData(first, scope, publicationId);
    if (!first.granted) return { reservation: granted.reservation, replayed: true };
    if (granted.reservation.kind !== 'running') throw new Error('A granted query session is not running');
    void session.ended.then(cancelled);
    const fail = async (reason: DisplayQueryFailure): Promise<void> => {
      if (!session?.alive()) return;
      try { await session.request({ op: 'display-query-fail', scope, publicationId, attempt: granted.reservation.attempt, reason }); } catch {}
    };
    if (action.kind === 'retry') {
      try { if (await pupVersion(granted.input.executable, controller.signal) !== granted.input.version) throw new Error('Pup version changed'); }
      catch { await fail('pup-unavailable'); throw new Error('The reserved pup version is unavailable. Use a new publication ID after configuring the intended version.'); }
    }
    if (!session.alive() || controller.signal.aborted) throw new UiRefusal('unavailable', 'Query owner disconnected before execution');
    const result = await runPup(granted.input.executable, ['--no-agent', '--output=json', 'metrics', 'query', `--query=${granted.input.query}`,
      `--from=${granted.reservation.fromSeconds}`, `--to=${granted.reservation.toSeconds}`], { signal: controller.signal, env: { ...process.env, DD_SITE: granted.input.site } });
    if (result.kind === 'failed') {
      await fail(result.reason);
      throw new UiRefusal('unavailable', `Pup query failed (${result.reason}). Inspect display status before an explicit retry.`);
    }
    let event: ReturnType<typeof validateDisplayEvent>;
    try { event = validateDisplayEvent({ type: 'CUSTOM', name: METRICS_EVENT_NAME, value: normalizePup(JSON.parse(result.stdout), granted.input.query, granted.input.title, granted.reservation, Date.now()) }); }
    catch { await fail('invalid-response'); throw new Error('Pup returned an unsupported or invalid metrics response. Inspect display status before retrying.'); }
    try {
      const value = record(await session.request({ op: 'display-query-finalize', scope, publicationId, attempt: granted.reservation.attempt, event }), ['input', 'reservation']);
      return { reservation: queryData(value, scope, publicationId).reservation, replayed: false };
    } catch {
      const recovered = await displayStatus(socket, scope, publicationId);
      if (recovered.mode === 'query' && (recovered.reservation.kind === 'published' || recovered.reservation.kind === 'removed')) return { reservation: recovered.reservation, replayed: true };
      throw new UiRefusal('unavailable', 'Publication result is unconfirmed. Inspect display status; the query will not run again automatically.');
    }
  } finally { process.removeListener('SIGINT', cancelled); process.removeListener('SIGTERM', cancelled); session?.close(); }
}
