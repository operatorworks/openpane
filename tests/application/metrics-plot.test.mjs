import assert from 'node:assert/strict';
import test from 'node:test';
import { metricsPanels } from '../../apps/desktop/dist/application/metrics-plot.js';
const card = series => ({ fromMs: 0, toMs: 1000, series });
test('metrics plots separate units, preserve null gaps and scale opposite finite extremes without invalid SVG', () => {
  const panels = metricsPanels(card([{ label: 'A', unit: '%', points: [[0, -Number.MAX_VALUE], [100, null], [200, Number.MAX_VALUE]] }, { label: 'B', unit: 'byte', points: [[0, 0], [1000, 0]] }, { label: 'C', unit: '%', points: [[0, 1], [1000, 2]] }]));
  assert.equal(panels.length, 2); assert.equal(panels[0].series.length, 2); assert.equal(panels[0].series[0].paths.length, 2);
  assert.doesNotMatch(JSON.stringify(panels.flatMap(panel => panel.series.map(series => series.paths))), /NaN|Infinity/);
  assert.equal(panels[1].minimum, 0); assert.equal(panels[1].maximum, 0);
});
