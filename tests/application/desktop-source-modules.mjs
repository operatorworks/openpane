import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../../apps/desktop/src/application/', import.meta.url));
export const desktopSourceModules = {
  name: 'one-desktop-source-graph',
  setup(builder) {
    builder.onResolve({ filter: /\/desktop\/dist\/application\/[^/]+\.js$/ }, args => {
      const name = args.path.slice(args.path.lastIndexOf('/') + 1, -3);
      const path = [`${directory}${name}.ts`, `${directory}${name}.tsx`].find(path => existsSync(path));
      if (!path) throw new Error(`Desktop fixture source is missing: ${name}`);
      return { path };
    });
  },
};
