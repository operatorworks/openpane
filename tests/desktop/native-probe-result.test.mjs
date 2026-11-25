import assert from 'node:assert/strict';
import test from 'node:test';
import { assessNativeProbe } from './experience-probe/result.mjs';
const report = (kind, detail, at = 300001) => ({ kind, detail, at });
function complete() {
  return [report('minimized', { minimized: true, sampleAtMs: 0 }, 0), ...Array.from({ length: 151 }, (_, index) => report('minimized-state', { minimized: true, sampleAtMs: index * 2000 }, index * 2000)), report('wrong-document-denied', true), report('main-complete', true), report('relay', { generation: 150 }), report('relay-frozen', { generation:150 }, 300000),
    ...Array.from({ length: 8 }, (_, slot) => [report('child-ready', { label: `child-${slot}`, recovered: true }), report('child-complete', { label: `child-${slot}` }),
      report('paint', { label: `child-${slot}`, generation: 150 }), ...['send','stop','approve'].map(action => report('interaction', { slot, action, elapsedMs: 1 }))]).flat()];
}
test('native probe requires late paint and interaction evidence from all eight children', () => {
  const reports = complete(); assert.equal(assessNativeProbe(reports, false).passed, true);
  for (const missing of [r => r.kind === 'paint' && r.detail.label === 'child-7', r => r.kind === 'interaction' && r.detail.slot === 3 && r.detail.action === 'approve', r => r.kind === 'minimized']) {
    assert.equal(assessNativeProbe(reports.filter(r => !missing(r)), false).passed, false);
  }
  assert.equal(assessNativeProbe(reports.map(r => r.kind === 'paint' ? { ...r, at: 1 } : r), false).passed, false);
  assert.equal(assessNativeProbe(reports.map(r => r.kind === 'paint' && r.detail.label === 'child-7' ? { ...r, detail: { ...r.detail, generation: 1 } } : r), false).passed, false);
  assert.equal(assessNativeProbe([...reports, report('failure', 'interaction failed')], false).passed, false);
  assert.equal(assessNativeProbe(reports, true).passed, false);
});

test('a restored main or missing minimize samples cannot qualify a minimized relay interval', () => {
  const reports = complete();
  assert.equal(assessNativeProbe([...reports, report('minimized-state', { minimized: false, sampleAtMs: 1000 }, 1000)], false).passed, false);
  assert.equal(assessNativeProbe(reports.filter(item => item.kind !== 'minimized-state'), false).passed, false);
});


test('native sample times reject a five-second gap hidden by delayed report arrival', () => {
  let index = 0;
  const reports = complete().map(report => {
    if (report.kind !== 'minimized-state') return report.at > 0 ? { ...report, at: 310001 } : report;
    const current = index++;
    const sampleAtMs = current >= 2 ? current * 2000 + 3200 : current * 2000;
    const at = current === 1 ? 4800 : sampleAtMs;
    return { ...report, at, detail: { minimized: true, sampleAtMs } };
  });
  const result = assessNativeProbe(reports, false);
  assert.equal(result.passed, false);
  assert.equal(result.minimizeSampling.clock, 'native-monotonic');
  assert.equal(result.minimizeSampling.maxGapMs, 5200);
});

test('arrival-only minimize samples cannot qualify the native interval', () => {
  const reports = complete().map(report => report.kind === 'minimized-state' ? { ...report, detail: { minimized: true } } : report);
  assert.equal(assessNativeProbe(reports, false).passed, false);
});

test('completion waits until the final required child paint arrives', () => {
  const reports = complete(), pending = reports.filter(report => !(report.kind === 'paint' && report.detail.label === 'child-7'));
  assert.equal(pending.some(report => report.kind === 'main-complete'), true);
  assert.equal(pending.filter(report => report.kind === 'child-complete').length, 8);
  assert.equal(assessNativeProbe(pending, false).passed, false);
  assert.equal(assessNativeProbe([...pending, report('paint', { label: 'child-7', generation: 150 }, 300500)], false).passed, true);
});


test('qualification requires paint after the frozen relay boundary', () => {
  const reports = complete();
  assert.equal(assessNativeProbe(reports.filter(report => report.kind !== 'relay-frozen'), false).passed, false);
  assert.equal(assessNativeProbe(reports.map(report => report.kind === 'relay-frozen' ? {...report,at:300002} : report), false).passed, false);
});

test('a freeze report without a generation cannot qualify or crash assessment', () => {
  for (const detail of [undefined, null, {}, { generation: 0 }]) {
    const reports = complete().map(item => item.kind === 'relay-frozen' ? { ...item, detail } : item);
    assert.equal(assessNativeProbe(reports, false).passed, false);
  }
});

test('a child paint without detail cannot crash assessment or qualify', () => {
  const reports = complete().map(item => item.kind === 'paint' && item.detail.label === 'child-7' ? { ...item, detail: null } : item);
  const result = assessNativeProbe(reports, false); assert.equal(result.passed, false); assert.equal(result.latePaintedChildren, 7);
});
