import { LOCAL_FONT_STACK_PATTERN, HOME_PANE_KINDS, EXPERIENCE_COLOR_ROLES, EXPERIENCE_SPACE_ROLES, EXPERIENCE_RADIUS_ROLES, EXPERIENCE_TEXT_ROLES, EXPERIENCE_CHART_ROLES } from './experience.js';
const number = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum });
const integer = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum });
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const object = (properties: object, required: readonly string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const roles = (keys: readonly string[], schema: object) => object(Object.fromEntries(keys.map(key => [key, schema])));
const color = { type: 'string', pattern: '^#[a-fA-F0-9]{6}$' };
const tokens = object({
  colors: roles(EXPERIENCE_COLOR_ROLES, color), spacing: roles(EXPERIENCE_SPACE_ROLES, number(0, 64)), radius: roles(EXPERIENCE_RADIUS_ROLES, number(0, 32)),
  typography: roles(EXPERIENCE_TEXT_ROLES, object({ size: number(10, 48), lineHeight: number(1, 2), weight: { enum: [100, 200, 300, 400, 500, 600, 700, 800, 900] } })),
  fonts: roles(['body', 'code'], { ...text(256), pattern: LOCAL_FONT_STACK_PATTERN }),
  treatments: object({ borderWidth: number(0, 4), shadow: { enum: ['none', 'soft', 'bevel'] } }), chart: roles(EXPERIENCE_CHART_ROLES, color),
});
const panes = { type: 'array', minItems: 1, maxItems: HOME_PANE_KINDS.length, uniqueItems: true, items: { enum: HOME_PANE_KINDS } };
export const homeCompositionSchema = { oneOf: [
  object({ kind: { const: 'stack' }, panes }, ['kind', 'panes']),
  { ...object({ kind: { const: 'columns' }, primary: panes, secondary: panes, balance: { enum: ['even', 'primary-wide', 'secondary-wide'] } }, ['kind', 'primary', 'secondary', 'balance']),
    allOf: HOME_PANE_KINDS.map(kind => ({ not: { properties: { primary: { type: 'array', contains: { const: kind } }, secondary: { type: 'array', contains: { const: kind } } }, required: ['primary', 'secondary'] } })) },
] };
export const experienceSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  ...object({
    schemaVersion: { const: 2 }, id: { ...text(64), pattern: '^[a-z][a-z0-9-]*$' }, label: text(200),
    theme: object({ mode: { enum: ['system', 'light', 'dark'] }, density: { enum: ['comfortable', 'compact'] }, light: tokens, dark: tokens }, ['mode', 'density', 'light', 'dark']),
    presentation: object({ home: homeCompositionSchema, transcript: { enum: ['bubbles', 'lines'] }, navigation: { enum: ['rail', 'pages'] }, chats: { enum: ['inline', 'separate'] },
      chatWindow: object({ width: integer(360, 1600), height: integer(480, 1200), titlebar: { enum: ['native', 'integrated'] }, title: { enum: ['agent', 'conversation', 'agent-and-conversation'] } }, ['width', 'height', 'titlebar', 'title']),
    }, ['home', 'transcript', 'navigation', 'chats', 'chatWindow']),
    stylesheet: { anyOf: [{ type: 'null' }, text(128)] },
    assets: { type: 'array', maxItems: 17, items: object({ name: { ...text(128), pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' }, mimeType: { enum: ['text/css', 'image/png'] }, bytes: integer(0, 2_097_152), sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['name', 'mimeType', 'bytes', 'sha256']) },
  }, ['schemaVersion', 'id', 'label', 'theme', 'presentation', 'stylesheet', 'assets']),
  $comment: 'Also enforce unique asset names, sole matching CSS inventory <=128 KiB, <=16 PNGs totaling <=2 MiB, and manifest <=64 KiB. Decode PNG dimensions and verify exact byte counts/digests in the host bundle parser.',
};
