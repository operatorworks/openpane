import { copyFile } from 'node:fs/promises';
await Promise.all(['event-schema.mjs', 'event-schema.d.mts'].map(name =>
  copyFile(new URL(`../src/${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url))));
