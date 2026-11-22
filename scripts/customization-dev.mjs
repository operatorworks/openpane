import { request } from 'node:http';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { assertSupportedNode } from '@openpane/host/customization';
import { desktopConfig } from '../apps/desktop/vite.config.mjs';
import { bundledPlan } from './bundled-extensions.mjs';
import { mergePlans } from './lib/customization-plugin.mjs';
import { developmentPlan, previewHost, previewPort } from './lib/customization-development-plan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OpenPane local preview</title></head><body><div id="root"></div><script type="module" src="/src/shell/customization-preview-main.tsx"></script></body></html>';

function previewRoutes(host, origin) {
  return { name: 'openpane-local-preview', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = new URL(req.url ?? '/', origin).pathname;
      const refuse = (status, message) => { res.statusCode = status; res.end(message); };
      if (path.startsWith('/api/')) {
        if (!['/api/v1', '/api/v1/images'].includes(req.url)) return refuse(404, 'Unknown preview API path.');
        if (req.headers.host !== new URL(origin).host || req.headers.origin !== origin) return refuse(403, 'Preview API requires its own origin.');
        if (req.method !== 'POST') return refuse(405, 'Preview API requires POST.');
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(req.headers['content-type'] ?? '')) return refuse(415, 'Preview API requires JSON.');
        const target = new URL(req.url, host);
        const upstream = request(target, { method: 'POST', headers: { ...req.headers, host: target.host, origin: host,
          connection: 'close' } }, response => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        });
        upstream.on('error', () => { if (!res.headersSent) refuse(502, 'Preview host unavailable.'); else res.destroy(); });
        req.on('aborted', () => upstream.destroy());
        res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
        req.pipe(upstream);
        return;
      }
      if (path === '/preview.html') {
        if (req.headers.host !== new URL(origin).host) return refuse(403, 'Preview requires its printed loopback address.');
        if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(405, 'Preview document requires GET.');
        void server.transformIndexHtml('/preview.html', html).then(body => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(req.method === 'HEAD' ? '' : body);
        }).catch(() => refuse(500, 'Could not load preview. Check the source diagnostic in the terminal, correct the entry, then reload.'));
        return;
      }
      if (path === '/' || path.endsWith('.html') || req.headers.accept?.includes('text/html')) return refuse(404, 'Use /preview.html for the labeled local preview.');
      next();
    });
  } };
}

export async function startCustomizationPreview({ source, hostUrl, port }) {
  assertSupportedNode();
  const external = await developmentPlan(source), host = previewHost(hostUrl);
  const chosenPort = port === undefined ? previewPort(external.roots[0], host) : Number(port);
  if (!Number.isInteger(chosenPort) || chosenPort < 1024 || chosenPort > 65535) throw new Error('Preview --port must be an integer from 1024 to 65535.');
  const origin = `http://127.0.0.1:${chosenPort}`;
  const config = desktopConfig('browser', mergePlans(bundledPlan(root), external), { development: true });
  const server = await createServer({ ...config, configFile: false, root: join(root, 'apps/desktop'), mode: 'browser', appType: 'custom',
    plugins: [previewRoutes(host, origin), ...config.plugins],
    // Only installed host ABI dependencies are prebundled. Working-source dependencies must stay visible to the source policy.
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-markdown'] },
    server: { ...config.server, port: chosenPort, strictPort: true, hmr: false, ws: false, open: false,
      fs: { allow: [root, ...external.roots] } } });
  try { await server.listen(); }
  catch (error) { await server.close(); throw new Error(`Could not start preview on ${origin}. Choose another --port if occupied.`, { cause: error }); }
  return { server, origin, url: `${origin}/preview.html`, source: external.roots[0] };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['source', 'host-url', 'port'].map(name => [name, { type: 'string' }])) });
    if (!values.source || !values['host-url']) throw new Error('Usage: npm run customization:dev -- --source /absolute/package --host-url http://127.0.0.1:PORT [--port PORT]');
    const preview = await startCustomizationPreview({ source: values.source, hostUrl: values['host-url'], port: values.port });
    process.stdout.write(`Unqualified local preview: ${preview.url}\nFull-trust working source. Reload manually while idle; code and CSS never update automatically. Manifest/source-map edits require restarting this command. No dependencies or package scripts are installed or run.\n`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void preview.server.close().then(() => process.exit(0)); });
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
