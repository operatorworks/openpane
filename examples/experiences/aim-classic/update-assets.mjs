import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const manifestUrl = new URL('./experience.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
if (typeof manifest.stylesheet !== 'string') throw new Error('Declare a stylesheet before updating its digest');
const css = await readFile(new URL(manifest.stylesheet, import.meta.url));
const asset = { name: manifest.stylesheet, mimeType: 'text/css', bytes: css.length, sha256: createHash('sha256').update(css).digest('hex') };
manifest.assets = [...manifest.assets.filter(entry => entry.mimeType !== 'text/css'), asset];
await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');
