import { verifyImageUpload } from '@openpane/host/images';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { scopeExperienceCss } from './experience-css.js';
import { canonicalJson, EXPERIENCE_LIMITS, parseExperience } from '@openpane/contracts';
import type { ExperienceBundle, ExperienceV2 } from '@openpane/contracts';
import { hex, identifier, record } from '@openpane/contracts/decode';

export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export { scopeExperienceCss } from './experience-css.js';
function decodedAsset(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid experience asset encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Noncanonical asset encoding');
  return bytes;
}
function png(bytes: Buffer): void {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG asset');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > EXPERIENCE_LIMITS.imageDimension || height > EXPERIENCE_LIMITS.imageDimension) throw new Error('PNG dimensions exceed limit');
  if (verifyImageUpload('experience.png', bytes).metadata.mediaType !== 'image/png') throw new Error('Invalid PNG asset');
}
const assetOrder = (a: ExperienceBundle['assets'][number], b: ExperienceBundle['assets'][number]): number => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
export function createExperienceBundle(manifest: ExperienceV2, stylesheet: string | null, assets: ExperienceBundle['assets']): ExperienceBundle {
  const content = { manifest, stylesheet, assets: [...assets].sort(assetOrder) };
  return parseExperienceBundle({ ...content, digest: sha256(canonicalJson(content)) });
}
export function parseExperienceBundle(value: unknown): ExperienceBundle {
  const input = record(value, ['manifest', 'stylesheet', 'assets', 'digest']);
  const manifest = parseExperience(input.manifest), digest = hex(input.digest, 64);
  if (input.stylesheet !== null && typeof input.stylesheet !== 'string') throw new Error('Invalid stylesheet bytes');
  const stylesheet = input.stylesheet;
  if (!Array.isArray(input.assets) || input.assets.length > 16) throw new Error('Invalid artwork bytes');
  const names = new Set<string>();
  const assets = input.assets.map((value: unknown) => {
    const asset = record(value, ['name', 'base64']);
    const name = identifier(asset.name, 128), base64 = typeof asset.base64 === 'string' ? asset.base64 : '';
    if (names.has(name)) throw new Error('Duplicate artwork bytes'); names.add(name);
    const declared = manifest.assets.find(asset => asset.name === name && asset.mimeType === 'image/png');
    if (!declared || base64.length > 2_796_204) throw new Error('Undeclared or oversized artwork');
    const bytes = decodedAsset(base64);
    if (bytes.length !== declared.bytes || sha256(bytes) !== declared.sha256) throw new Error('Artwork bytes mismatch');
    png(bytes);
    return { name, base64 };
  }).sort(assetOrder);
  if (assets.length !== manifest.assets.filter(asset => asset.mimeType === 'image/png').length) throw new Error('Missing artwork bytes');
  const declaredCss = manifest.assets.find(asset => asset.mimeType === 'text/css');
  if (stylesheet === null ? declaredCss !== undefined : !declaredCss || Buffer.byteLength(stylesheet) !== declaredCss.bytes || sha256(stylesheet) !== declaredCss.sha256) throw new Error('Stylesheet bytes mismatch');
  if (stylesheet !== null) scopeExperienceCss(stylesheet, digest, names);
  const content = { manifest, stylesheet, assets };
  if (sha256(canonicalJson(content)) !== digest) throw new Error('Experience digest mismatch');
  return { ...content, digest };
}
export async function readExperienceDirectory(directory: string): Promise<ExperienceBundle> {
  const root = await realpath(directory);
  const read = async (name: string, limit: number): Promise<Buffer> => {
    const path = await realpath(join(root, name));
    if (!path.startsWith(root + sep)) throw new Error('Experience asset escapes source directory');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('Experience asset must be a regular file');
      if (stat.size > limit) throw new Error('Experience file exceeds limit');
      const bytes = Buffer.alloc(limit + 1);
      const { bytesRead } = await file.read(bytes, 0, limit + 1, 0);
      if (bytesRead > limit) throw new Error('Experience file exceeds limit');
      return bytes.subarray(0, bytesRead);
    } finally { await file.close(); }
  };
  const manifest = parseExperience(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read('experience.json', EXPERIENCE_LIMITS.manifestBytes))));
  const stylesheet = manifest.stylesheet === null ? null : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await read(manifest.stylesheet, EXPERIENCE_LIMITS.stylesheetBytes));
  const assets = await Promise.all(manifest.assets.filter(asset => asset.mimeType === 'image/png').map(async asset => ({ name: asset.name, base64: (await read(asset.name, asset.bytes)).toString('base64') })));
  return createExperienceBundle(manifest, stylesheet, assets);
}
