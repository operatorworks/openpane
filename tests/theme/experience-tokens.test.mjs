import assert from 'node:assert/strict';
import test from 'node:test';
import { createTheme, spacing, radius, typography, palettes } from '@openpane/theme';
import { toCssVariables } from '@openpane/ui-primitives/desktop';
import { EXPERIENCE_COLOR_ROLES } from '@openpane/contracts';
test('omitted experience tokens preserve builtin values and authoritative color roles', () => {
  const theme = createTheme();
  assert.deepEqual(theme.colors, palettes.light); assert.deepEqual(theme.spacing, spacing);
  assert.deepEqual(theme.radius, radius); assert.deepEqual(theme.typography, typography);
  assert.deepEqual(Object.keys(theme.colors).sort(), [...EXPERIENCE_COLOR_ROLES].sort());
  const vars = toCssVariables(theme);
  assert.equal(vars['--aui-font-body'], '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif');
  assert.equal(vars['--aui-space-sm'], '0.5rem'); assert.equal(vars['--aui-radius-panel'], '0.75rem');
});
test('partial visual tokens inherit through nested themes without mutating siblings', () => {
  const parent = createTheme({ typography: { body: { size: 13 } }, spacing: { sm: 6 }, radius: { panel: 0 },
    fonts: { body: 'Tahoma, Verdana, sans-serif' }, chart: { trace1: '#123456' }, treatments: { shadow: 'bevel' } });
  const child = createTheme({ typography: { body: { lineHeight: 1.4 } }, spacing: { lg: 12 } }, parent);
  assert.deepEqual(child.typography.body, { size: 13, weight: 400, lineHeight: 1.4 });
  assert.equal(child.spacing.sm, 6); assert.equal(child.spacing.lg, 12); assert.equal(parent.spacing.lg, 16);
  assert.equal(parent.typography.body.lineHeight, 1.6); assert.equal(child.fonts.body, parent.fonts.body);
  assert.equal(child.chart.trace1, '#123456'); assert.equal(child.radius.panel, 0);
  assert.equal(toCssVariables(child)['--aui-chart-trace1'], '#123456');
});

test('palette surface, border and muted colors supply chart defaults while explicit chart roles win', () => {
  const colors = { surface: '#1d2027', border: '#8793a8', muted: '#eef0f5' };
  const theme = createTheme({ colors });
  assert.equal(theme.chart.background, colors.surface);
  assert.equal(theme.chart.grid, colors.border);
  assert.equal(theme.chart.axis, colors.muted);
  assert.equal(createTheme({ colors, chart: { background: '#123456' } }).chart.background, '#123456');
  const inherited = createTheme({ colors }, createTheme());
  assert.equal(inherited.chart.background, colors.surface);
});


test('reapplying the same palette preserves explicitly authored chart roles', () => {
  const chart = { background: '#000080', grid: '#00aaff', axis: '#ffeeaa' };
  const parent = createTheme({ colors: palettes.light, chart });
  const child = createTheme({ colors: { ...parent.colors } }, parent);
  for (const [role, color] of Object.entries(chart)) assert.equal(child.chart[role], color);
});


test('equivalent hex spellings preserve explicit inherited chart colors', () => {
  const parent = createTheme({ colors: { surface: '#1D2027', border: '#2A2B2C', muted: '#AABBCC' }, chart: { background: '#000080', grid: '#008000', axis: '#800000' } });
  const child = createTheme({ colors: { surface: '#1d2027', border: '#2a2b2c', muted: '#aabbcc' } }, parent);
  assert.equal(child.chart.background, '#000080'); assert.equal(child.chart.grid, '#008000'); assert.equal(child.chart.axis, '#800000');
});
