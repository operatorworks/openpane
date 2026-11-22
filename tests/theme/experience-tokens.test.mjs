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
