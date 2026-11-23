import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const manifestUrl = new URL('./experience.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
const css = await readFile(new URL('./style.css', import.meta.url));
manifest.assets = [{ name: 'style.css', mimeType: 'text/css', bytes: css.length, sha256: createHash('sha256').update(css).digest('hex') }];
await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');
