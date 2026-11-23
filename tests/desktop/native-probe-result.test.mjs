import assert from 'node:assert/strict';
import test from 'node:test';
import { assessNativeProbe } from './experience-probe/result.mjs';
const report = (kind, detail, at = 300001) => ({ kind, detail, at });
function complete() {
  return [report('minimized', true, 0), report('wrong-document-denied', true), report('main-complete', true),
    ...Array.from({ length: 8 }, (_, slot) => [report('child-ready', { label: `child-${slot}`, recovered: true }), report('child-complete', { label: `child-${slot}` }),
      report('paint', { label: `child-${slot}`, generation: 150 }), ...['send','stop','approve'].map(action => report('interaction', { slot, action, elapsedMs: 1 }))]).flat()];
}
test('native probe requires late paint and interaction evidence from all eight children', () => {
  const reports = complete(); assert.equal(assessNativeProbe(reports, false).passed, true);
  for (const missing of [r => r.kind === 'paint' && r.detail.label === 'child-7', r => r.kind === 'interaction' && r.detail.slot === 3 && r.detail.action === 'approve', r => r.kind === 'minimized']) {
    assert.equal(assessNativeProbe(reports.filter(r => !missing(r)), false).passed, false);
  }
  assert.equal(assessNativeProbe(reports.map(r => r.kind === 'paint' ? { ...r, at: 1 } : r), false).passed, false);
  assert.equal(assessNativeProbe([...reports, report('failure', 'interaction failed')], false).passed, false);
  assert.equal(assessNativeProbe(reports, true).passed, false);
});
