import postcss from 'postcss';
import type { Container, Document } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import valueParser from 'postcss-value-parser';
import { EXPERIENCE_COLOR_ROLES, EXPERIENCE_CHART_ROLES, EXPERIENCE_LIMITS, EXPERIENCE_PROPERTIES, EXPERIENCE_PSEUDO_CLASSES,
  LOCAL_FONT_STACK_PATTERN, experienceRoleApplies, experienceStateApplies, isExperiencePart } from '@openpane/contracts';
import { hex } from '@openpane/contracts/decode';

type ValueNode = valueParser.Node;
const meaningful = (nodes: readonly ValueNode[]) => nodes.filter(node => node.type !== 'space');
const localFontStack = new RegExp(LOCAL_FONT_STACK_PATTERN);
const colorVariables = new Set([
  ...EXPERIENCE_COLOR_ROLES.map(role => `--aui-color-${role.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`),
  ...EXPERIENCE_CHART_ROLES.map(role => `--aui-chart-${role}`),
]);
const visualProperties = new Set(['color', 'background-color', 'accent-color', 'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'fill', 'stroke']);
const spacingProperties = new Set(['gap', 'row-gap', 'column-gap', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left']);
const borderProperties = new Set(['border', 'border-top', 'border-right', 'border-bottom', 'border-left']);
const borderStyle = /^(solid|dashed|dotted|double|inset|outset|none)$/;
function color(node: ValueNode | undefined): boolean {
  if (!node) return false;
  if (node.type === 'word') return /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(node.value) || /^(transparent|currentColor|inherit)$/.test(node.value);
  if (node.type !== 'function' || node.value !== 'var' || node.unclosed) return false;
  const args = meaningful(node.nodes);
  return args.length === 1 && args[0]?.type === 'word' && colorVariables.has(args[0].value);
}
function length(node: ValueNode | undefined, maximum: number, signed = false): boolean {
  return node?.type === 'word' && (node.value === '0' || new RegExp(`^${signed ? '-?' : ''}\\d+(?:\\.\\d+)?px$`).test(node.value)) && Math.abs(parseFloat(node.value)) <= maximum;
}
function lengths(nodes: readonly ValueNode[], maximum: number, count = 1): boolean {
  return nodes.length >= 1 && nodes.length <= count && nodes.every(node => length(node, maximum));
}
function groups(nodes: readonly ValueNode[]): ValueNode[][] {
  const result: ValueNode[][] = [[]];
  for (const node of nodes) {
    if (node.type === 'space') continue;
    if (node.type === 'div' && node.value === ',') result.push([]);
    else result[result.length - 1]?.push(node);
  }
  return result;
}
function gradient(node: ValueNode | undefined): boolean {
  if (node?.type !== 'function' || node.value !== 'linear-gradient' || node.unclosed) return false;
  const [direction, ...stops] = groups(node.nodes);
  if (!direction || !direction.every(item => item.type === 'word') || !['to right', 'to bottom', 'to left', 'to top', '0deg', '90deg', '180deg', '270deg'].includes(direction.map(item => item.value).join(' ')) || stops.length < 2 || stops.length > 4) return false;
  let previous = -1;
  return stops.every(stop => {
    if (stop.length < 1 || stop.length > 2 || !color(stop[0])) return false;
    if (stop.length === 1) return true;
    const position = stop[1];
    if (position?.type !== 'word' || !/^\d+(?:\.\d+)?%$/.test(position.value)) return false;
    const percent = parseFloat(position.value);
    if (percent > 100 || percent < previous) return false;
    previous = percent; return true;
  });
}
function shadows(nodes: readonly ValueNode[]): boolean {
  const layers = groups(nodes);
  return layers.length <= 4 && layers.every(layer => {
    const values = layer[0]?.type === 'word' && layer[0].value === 'inset' ? layer.slice(1) : layer;
    const offsets = values.slice(0, -1);
    return offsets.length >= 2 && offsets.length <= 4 && offsets.every((node, index) => length(node, 16, index !== 2)) && color(values.at(-1));
  });
}
function declaration(property: string, value: string, assets: ReadonlySet<string>): void {
  if (!EXPERIENCE_PROPERTIES.some(name => name === property)) throw new Error(`Unsupported experience declaration: ${property}`);
  const nodes = meaningful(valueParser(value).nodes);
  const first = nodes[0];
  if (visualProperties.has(property) && nodes.length === 1 && color(first)) return;
  if (spacingProperties.has(property) && lengths(nodes, 64, property === 'padding' ? 4 : property === 'gap' ? 2 : 1)) return;
  if (property === 'font-size' && lengths(nodes, 48) && parseFloat(value) >= 10) return;
  if (property === 'line-height' && /^(1(?:\.\d+)?|2(?:\.0+)?)$/.test(value)) return;
  if (property === 'font-weight' && /^[1-9]00$/.test(value)) return;
  if (property === 'font-family' && value.length <= 256 && localFontStack.test(value)) return;
  if (property === 'font-style' && /^(normal|italic)$/.test(value)) return;
  if (property === 'letter-spacing' && lengths(nodes, 2)) return;
  if (property === 'border-radius' && lengths(nodes, 32, 4)) return;
  if ((/^border(?:-(top|right|bottom|left))?-width$/.test(property) || property === 'stroke-width') && lengths(nodes, 4, property === 'border-width' ? 4 : 1)) return;
  if (/^border(?:-(top|right|bottom|left))?-style$/.test(property) && borderStyle.test(value)) return;
  if (borderProperties.has(property) && nodes.length === 3 && length(first, 4) && nodes[1]?.type === 'word' && borderStyle.test(nodes[1].value) && color(nodes[2])) return;
  if (property === 'text-decoration' && /^(none|underline|line-through)$/.test(value)) return;
  if (property === 'box-shadow' && (value === 'none' || shadows(nodes))) return;
  if (property === 'background-image') {
    const image = /^url\("([a-zA-Z0-9][a-zA-Z0-9._-]*)"\)$/.exec(value);
    if (image && assets.has(image[1]!)) return;
    if (value === 'none' || nodes.length === 1 && gradient(first)) return;
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
      if (selector.nodes.length > 64) throw new Error('Experience selector exceeds limit');
      let compound: typeof selector.nodes = [];
      const validate = () => {
        const parts = compound.filter(node => node.type === 'attribute' && node.attribute === 'data-openpane-part');
        const part = parts[0];
        if (parts.length !== 1 || part?.type !== 'attribute' || !isExperiencePart(part.value)) throw new Error('Experience selectors must use documented semantic parts');
        for (const node of compound) {
          if (node.type === 'attribute' && node.operator === '=' && !node.insensitive && !node.namespace) {
            if (node.attribute === 'data-openpane-part' && node === part) continue;
            if (node.attribute === 'data-openpane-role' && experienceRoleApplies(part.value, node.value ?? '')) continue;
            if (node.attribute === 'data-openpane-state' && experienceStateApplies(part.value, node.value ?? '')) continue;
          }
          if (node.type === 'pseudo' && EXPERIENCE_PSEUDO_CLASSES.some(name => name === node.value) && !node.nodes?.length) continue;
          throw new Error('Experience selector role or state does not apply to its semantic part');
        }
      };
      for (const node of selector.nodes) {
        if (node.type === 'combinator') {
          if (![' ', '>'].includes(node.value)) throw new Error('Unsupported experience combinator');
          validate(); compound = [];
        } else compound.push(node);
      }
      validate();
      selector.prepend(selectorParser.combinator({ value: ' ' }));
      const scope = selectorParser.attribute({ attribute: 'data-openpane-experience', operator: '=', value: digest, quoteMark: '"', raws: {} });
      scope.setValue(digest, { quoteMark: '"' }); selector.prepend(scope);
    }
    rule.selector = selectors.toString();
  });
  root.walkDecls(decl => {
    if (decl.important || decl.parent?.type !== 'rule') throw new Error('Unsupported experience declaration context');
    const property = decl.prop.toLowerCase(), value = decl.value.trim();
    declaration(property, value, images);
    if (property === 'background-image' && value.startsWith('url(')) {
      const name = /^url\("([a-zA-Z0-9][a-zA-Z0-9._-]*)"\)$/.exec(value)?.[1];
      if (!name) throw new Error('Invalid experience image');
      decl.value = `url("/ui-assets/${digest}/${name}")`;
    }
  });
  return `@layer openpane-authored {\n${root.toString()}\n}`;
}
