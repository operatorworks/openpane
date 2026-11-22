import { request } from 'node:http';
import { pipeline } from 'node:stream';
import { extname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build, createServer } from 'vite';
import { assertSupportedNode } from '@openpane/host/customization';
import { desktopConfig } from '../apps/desktop/vite.config.mjs';
import { bundledPlan } from './bundled-extensions.mjs';
import { mergePlans } from './lib/customization-plugin.mjs';
import { developmentPlan, previewHost, previewPort } from './lib/customization-development-plan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const assetTypes = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const html = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OpenPane local preview</title></head><body><div id="root"></div><script type="module" src="/src/shell/customization-preview-main.tsx"></script></body></html>';

function previewRoutes(host, origin, plan) {
  // A document's full import graph is compiled together, including modules it has not requested yet.
  // Retaining hashed outputs lets older documents finish lazy imports after another tab reloads.
  const assets = new Map();
  async function snapshot() {
    const config = desktopConfig('browser', plan, { development: true });
    const result = await build({ ...config, configFile: false, root: join(root, 'apps/desktop'), mode: 'browser', logLevel: 'error',
      build: { ...config.build, write: false, copyPublicDir: false, assetsInlineLimit: 0,
        rollupOptions: { input: join(root, 'apps/desktop/src/shell/customization-preview-main.tsx'),
          output: { entryFileNames: 'assets/preview-[hash].js' } } } });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
    const entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
    for (const output of outputs) assets.set('/' + output.fileName, output.type === 'chunk' ? output.code : output.source);
    const css = [...(entry.viteMetadata?.importedCss ?? [])].map(file => `<link rel="stylesheet" href="/${file}">`).join('');
    return html.replace('</head>', css + '</head>').replace('/src/shell/customization-preview-main.tsx', '/' + entry.fileName);
  }
  return { name: 'openpane-local-preview', closeBundle() { assets.clear(); }, configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = new URL(req.url ?? '/', origin).pathname;
      const refuse = (status, message) => { res.statusCode = status; res.end(message); };
      if (path.startsWith('/api/')) {
        if (!['/api/v1', '/api/v1/images'].includes(req.url)) return refuse(404, 'Unknown preview API path.');
        if (req.headers.host !== new URL(origin).host || req.headers.origin !== origin) return refuse(403, 'Preview API requires its own origin.');
        if (req.method !== 'POST') return refuse(405, 'Preview API requires POST.');
        if (req.headers['content-type'] !== 'application/json') return refuse(415, 'Preview API requires JSON.');
        const target = new URL(req.url, host);
        const upstream = request(target, { method: 'POST', headers: { ...req.headers, host: target.host, origin: host,
          connection: 'close' } }, response => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          pipeline(response, res, () => {});
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
        res.setHeader('Cache-Control', 'no-store');
        void snapshot().then(body => server.transformIndexHtml('/preview.html', body)).then(body => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(req.method === 'HEAD' ? '' : body);
        }).catch(error => {
          server.config.logger.error(error.message);
          refuse(500, 'Could not load preview. Check the source diagnostic in the terminal, correct the entry, then reload.');
        });
        return;
      }
      if (path === '/' || path.endsWith('.html') || req.headers.accept?.includes('text/html')) return refuse(404, 'Use /preview.html for the labeled local preview.');
      if (assets.has(path)) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(405, 'Preview assets require GET.');
        res.setHeader('Content-Type', assetTypes[extname(path)] ?? 'application/octet-stream');
        res.end(req.method === 'HEAD' ? '' : assets.get(path));
        return;
      }
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
  if (origin === host) throw new Error('Preview must use a different --port from the selected host.');
  const plan = mergePlans(bundledPlan(root), external);
  const config = desktopConfig('browser', plan, { development: true });
  const server = await createServer({ ...config, configFile: false, root: join(root, 'apps/desktop'), mode: 'browser', appType: 'custom',
    plugins: [previewRoutes(host, origin, plan), ...config.plugins],
    // Only installed browser-host dependencies are prebundled. Working-source dependencies must stay visible to the source policy.
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-markdown', 'fast-sha256', '@ag-ui/core', '@cfworker/json-schema', '@tauri-apps/api/core'] },
    server: { ...config.server, port: chosenPort, strictPort: true, preTransformRequests: false, hmr: false, ws: false, open: false,
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
