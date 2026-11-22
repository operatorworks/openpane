import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UiStore } from './ui-store.js';
import { parseUiRequest, UI_FRAME_BYTES, UiRefusal } from './ui-protocol.js';
import { uiFailure } from './ui-control.js';
import { json, readJson } from './framing.js';
import { scopeExperienceCss } from './experience-bundle.js';
import { CSP } from './static-assets.js';
import type { HostObservability } from './observability.js';

export function uiEndpoint(store: UiStore | null, fault: string | null, observability: HostObservability, isClosing: () => boolean) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const startTime = performance.timeOrigin + performance.now();
    let outcome: 'ok' | 'unavailable' = 'ok';
    try {
      if (isClosing()) throw new UiRefusal('unavailable', 'UI service is shutting down');
      const origin = `http://127.0.0.1:${request.socket.localPort}`;
      if (request.headersDistinct.host?.length !== 1 || request.headers.host !== new URL(origin).host) throw new Error('Host mismatch');
      if (request.url?.startsWith('/ui-assets/')) {
        if (!store || (request.method !== 'GET' && request.method !== 'HEAD')) throw new UiRefusal('unavailable', 'UI assets unavailable');
        const match = /^\/ui-assets\/([a-f0-9]{64})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/.exec(request.url);
        if (!match?.[1] || !match[2]) throw new Error('Invalid UI asset path');
        const bundle = store.bundle(match[1]), name = match[2];
        const asset = bundle.manifest.assets.find(asset => asset.name === name);
        if (!asset) throw new UiRefusal('not-found', 'Undeclared UI asset');
        const artwork = bundle.assets.find(asset => asset.name === name);
        const bytes = asset.mimeType === 'text/css' ? Buffer.from(scopeExperienceCss(bundle.stylesheet ?? '', bundle.digest, new Set(bundle.assets.map(asset => asset.name))))
          : artwork ? Buffer.from(artwork.base64, 'base64') : null;
        if (!bytes) throw new UiRefusal('not-found', 'Missing UI asset');
        response.writeHead(200, { 'content-type': asset.mimeType, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP });
        response.end(request.method === 'HEAD' ? undefined : bytes); return;
      }
      if (request.url !== '/api/ui/v1' || request.method !== 'POST' || request.headersDistinct.origin?.length !== 1 || request.headers.origin !== origin || request.headersDistinct['content-type']?.length !== 1 || request.headers['content-type'] !== 'application/json') throw new Error('Origin or content type mismatch');
      const operation = parseUiRequest(await readJson(request, UI_FRAME_BYTES, 5000));
      if (!['context', 'state', 'ack', 'paint', 'restore'].includes(operation.op)) throw new Error('UI operation requires the local CLI');
      if (!store) throw new UiRefusal('unavailable', fault ?? 'UI database unavailable; builtin appearance remains active');
      json(response, 200, { ok: true, value: await store.execute(operation) }, {}, 1024 * 1024);
    } catch (error) { outcome = 'unavailable'; if (!response.headersSent) json(response, error instanceof UiRefusal && error.code === 'not-found' ? 404 : 400, uiFailure(error)); }
    finally { observability.record({ operation: 'ui', client: 'browser-development', outcome, startTime, statusCode: response.headersSent ? response.statusCode : null }); }
  };
}
