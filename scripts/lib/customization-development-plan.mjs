import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EXTENSION_SDK_VERSION } from '@openpane/sdk';
import { parseCustomizationPackage } from '../../packages/host/dist/customization/contract.js';
import { within } from './customization-asset-policy.mjs';

/** Working source is deliberately not a committed source identity or a releasable artifact. */
export async function developmentPlan(sourceRoot) {
  const root = await realpath(resolve(sourceRoot));
  const file = await realpath(resolve(root, 'package.json'));
  if (!within(root, file)) throw new Error('Preview package.json must stay inside the selected source root.');
  const metadata = JSON.parse(await readFile(file, 'utf8'));
  const mappings = metadata?.openpane?.sources;
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) throw new Error('Preview requires package.json.openpane.sources and a desktop extension entry.');
  const files = new Set();
  for (const value of [...Object.values(mappings), ...(metadata.openpane.shared === undefined ? [] : [metadata.openpane.shared])]) {
    if (typeof value !== 'string' || !value.startsWith('./')) throw new Error('Preview source mappings must be contained relative paths.');
    const path = await realpath(resolve(root, value));
    if (!within(root, path) || !(await stat(path)).isFile()) throw new Error('Preview source is missing or outside the selected package.');
    files.add(value.slice(2));
  }
  const parsed = parseCustomizationPackage(metadata, files);
  if (!parsed?.local || parsed.extensions.length) throw new Error('Preview accepts exactly one local executable package, without external extension references.');
  if (parsed.local.manifest.sdkVersion !== EXTENSION_SDK_VERSION) throw new Error(`Preview requires SDK ${EXTENSION_SDK_VERSION}.`);
  const desktop = parsed.local.manifest.entries.find(entry => entry.kind === 'desktop');
  if (!desktop) throw new Error('Preview requires an executable desktop entry.');
  return { kind: 'development', workingRoot: root, roots: [root], entries: [{ module: desktop.module, manifest: parsed.local.manifest,
    source: await realpath(resolve(root, parsed.local.sources.get(desktop.module))) }], identity: null };
}

export function previewHost(value) {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/?$/u.test(value))
    throw new Error('Preview host must be http://127.0.0.1:PORT/ without credentials, paths, queries or fragments.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Preview host must be http://127.0.0.1:PORT/ (use a loopback SSH tunnel for remote hosts).'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Preview host must be http://127.0.0.1:PORT/ without credentials, paths, queries or fragments.');
  return url.origin;
}
export function previewPort(sourceRoot, host) {
  return 20000 + createHash('sha256').update(`${sourceRoot}\0${host}`).digest().readUInt16BE(0) % 30000;
}
