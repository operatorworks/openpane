import { verifyImageUpload } from '@openpane/host/images';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import postcss from 'postcss';
import type { Container, Document } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { canonicalJson, EXPERIENCE_LIMITS, parseExperience } from '@openpane/contracts';
import type { ExperienceBundle, ExperienceV1 } from '@openpane/contracts';
import { hex, identifier, record } from '@openpane/contracts/decode';

export const EXPERIENCE_PARTS = ['main', 'page-rail', 'page', 'chat-directory', 'chat-window', 'header', 'transcript', 'transcript-row', 'message-text',
  'toolbar', 'composer', 'button', 'card', 'card-title', 'card-toolbar', 'card-summary', 'plot-frame', 'plot', 'plot-axis', 'plot-grid', 'plot-trace', 'plot-legend', 'card-empty', 'query-details', 'data-table'] as const;
export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const visualProperties = new Set(['color', 'background-color', 'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'fill', 'stroke']);
const spacingProperties = new Set(['gap', 'row-gap', 'column-gap', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left']);
const borderProperties = new Set(['border', 'border-top', 'border-right', 'border-bottom', 'border-left']);
const lengths = (text: string, maximum: number, count = 1) => {
  const values = text.split(/\s+/);
  return values.length >= 1 && values.length <= count && values.every(value => value === '0' || (/^\d+(?:\.\d+)?px$/.test(value) && parseFloat(value) <= maximum));
};
function visualColor(text: string): boolean {
  return /^#[\da-f]{3}(?:[\da-f]{3})?(?:[\da-f]{2})?$/i.test(text) || /^(transparent|currentColor|inherit)$/.test(text)
    || /^var\(--aui-(?:color-(?:canvas|surface|raised|text|muted|border|control-border|accent|on-accent|danger|on-danger|focus)|chart-(?:background|grid|axis|trace[1-8]))\)$/.test(text);
}
function declaration(property: string, value: string, assets: ReadonlySet<string>): void {
  if (visualProperties.has(property) && visualColor(value)) return;
  if (spacingProperties.has(property) && lengths(value, 64, property === 'padding' ? 4 : property === 'gap' ? 2 : 1)) return;
  if (property === 'font-size' && lengths(value, 48) && parseFloat(value) >= 10) return;
  if (property === 'line-height' && /^(1(?:\.\d+)?|2(?:\.0+)?)$/.test(value)) return;
  if (property === 'font-weight' && /^[1-9]00$/.test(value)) return;
  if (property === 'font-family' && /^[a-zA-Z0-9 ,"'-]{1,256}$/.test(value) && /[a-zA-Z]/.test(value)) return;
  if (property === 'border-radius' && lengths(value, 32, 4)) return;
  if ((property === 'border-width' || property === 'stroke-width') && lengths(value, 4, property === 'border-width' ? 4 : 1)) return;
  if (property === 'border-style' && /^(solid|dashed|dotted|double|inset|outset|none)$/.test(value)) return;
  if (borderProperties.has(property)) {
    const match = /^(0|\d+(?:\.\d+)?px) (solid|dashed|dotted|double|inset|outset|none) (.+)$/.exec(value);
    if (match && lengths(match[1]!, 4) && visualColor(match[3]!)) return;
  }
  if (property === 'text-decoration' && /^(none|underline|line-through)$/.test(value)) return;
  if (property === 'box-shadow' && (value === 'none' || value.split(',').every(shadow => {
    const match = /^(?:inset )?(-?\d+(?:\.\d+)?px|0) (-?\d+(?:\.\d+)?px|0) (\d+(?:\.\d+)?px|0) (#[\da-f]{6})$/i.exec(shadow.trim());
    return match && Math.abs(parseFloat(match[1]!)) <= 16 && Math.abs(parseFloat(match[2]!)) <= 16 && parseFloat(match[3]!) <= 16;
  }))) return;
  if (property === 'background-image') {
    const match = /^url\("([a-zA-Z0-9][a-zA-Z0-9._-]*)"\)$/.exec(value);
    if (match && assets.has(match[1]!)) return;
    if (value === 'none') return;
  }
  throw new Error(`Unsupported experience declaration: ${property}`);
}
export function scopeExperienceCss(css: string, digest: string, images: ReadonlySet<string>): string {
  hex(digest, 64);
  if (Buffer.byteLength(css) > EXPERIENCE_LIMITS.stylesheetBytes) throw new Error('Stylesheet exceeds byte limit');
  const root = postcss.parse(css);
  let rules = 0;
  root.walkAtRules(rule => {
    if (!['media', 'supports'].includes(rule.name) || !rule.nodes || rule.params.length > 512) throw new Error('Unsupported experience at-rule');
    let depth = 0;
    for (let parent: Container | Document | undefined = rule.parent; parent; parent = parent.parent) if (++depth > 4) throw new Error('Experience CSS nesting exceeds limit');
  });
  root.walkRules(rule => {
    if (++rules > 256 || rule.parent?.type === 'rule') throw new Error('Experience CSS rule limit or nesting');
    const selectors = selectorParser().astSync(rule.selector);
    if (selectors.nodes.length > 16) throw new Error('Too many experience selectors');
    for (const selector of selectors.nodes) {
      let semantic = false, nodes = 0;
      selector.walk(node => {
        if (++nodes > 64) throw new Error('Experience selector exceeds limit');
        if (node.type === 'attribute' && node.attribute === 'data-openpane-part' && node.operator === '=' && EXPERIENCE_PARTS.some(part => part === node.value)) { semantic = true; return; }
        if (node.type === 'combinator' && [' ', '>'].includes(node.value)) return;
        if (node.type === 'pseudo' && [':hover', ':focus', ':focus-visible', ':disabled', ':enabled', ':first-child', ':last-child'].includes(node.value) && !node.nodes?.length) return;
        throw new Error('Experience selectors must use documented semantic parts');
      });
      if (!semantic) throw new Error('Experience selector has no semantic part');
      selector.prepend(selectorParser.combinator({ value: ' ' }));
      const scope = selectorParser.attribute({ attribute: 'data-openpane-experience', operator: '=', value: digest, quoteMark: '"', raws: {} });
      scope.setValue(digest, { quoteMark: '"' });
      selector.prepend(scope);
    }
    rule.selector = selectors.toString();
  });
  root.walkDecls(decl => {
    if (decl.important || decl.parent?.type !== 'rule') throw new Error('Unsupported experience declaration context');
    const property = decl.prop.toLowerCase(), value = decl.value.trim();
    declaration(property, value, images);
    if (property === 'background-image' && value !== 'none') {
      const name = /^url\("([a-zA-Z0-9][a-zA-Z0-9._-]*)"\)$/.exec(value)?.[1];
      if (!name) throw new Error('Invalid experience image');
      decl.value = `url("/ui-assets/${digest}/${name}")`;
    }
  });
  return root.toString();
}
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
export function createExperienceBundle(manifest: ExperienceV1, stylesheet: string | null, assets: ExperienceBundle['assets']): ExperienceBundle {
  const content = { manifest, stylesheet, assets: [...assets].sort((a, b) => a.name.localeCompare(b.name)) };
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
  }).sort((a, b) => a.name.localeCompare(b.name));
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
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > limit) throw new Error('Experience file exceeds limit');
      const bytes = Buffer.alloc(limit + 1);
      const { bytesRead } = await file.read(bytes, 0, limit + 1, 0);
      if (bytesRead > limit) throw new Error('Experience file exceeds limit');
      return bytes.subarray(0, bytesRead);
    } finally { await file.close(); }
  };
  const manifest = parseExperience(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read('experience.json', EXPERIENCE_LIMITS.manifestBytes))));
  const stylesheet = manifest.stylesheet === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(await read(manifest.stylesheet, EXPERIENCE_LIMITS.stylesheetBytes));
  const assets = await Promise.all(manifest.assets.filter(asset => asset.mimeType === 'image/png').map(async asset => ({ name: asset.name, base64: (await read(asset.name, asset.bytes)).toString('base64') })));
  return createExperienceBundle(manifest, stylesheet, assets);
}
