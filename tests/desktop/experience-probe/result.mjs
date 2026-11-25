const validPaint = report => report.kind === 'paint' && typeof report.detail?.label === 'string' && Number.isSafeInteger(report.detail?.generation) && report.detail.generation > 0;
export function finalNativePaints(reports) {
  const frozen = reports.findLast(report => report.kind === 'relay-frozen');
  const generation = frozen?.detail?.generation ?? null;
  return { generation, paints: generation > 0 ? reports.filter(report => validPaint(report) && report.at >= frozen.at && report.detail?.generation === generation) : [] };
}

export function assessNativeProbe(reports, timedOut) {
  const paints = reports.filter(validPaint), interactions = reports.filter(report => report.kind === 'interaction');
  const minimized = reports.find(report => report.kind === 'minimized');
  const minimizedAt = minimized?.at ?? Infinity, nativeMinimizedAt = minimized?.detail?.sampleAtMs ?? Infinity;
  const samples = reports.filter(report => report.kind === 'minimized-state' && report.at >= minimizedAt).sort((a, b) => a.detail.sampleAtMs - b.detail.sampleAtMs);
  const nativeClockValid = Number.isFinite(nativeMinimizedAt) && samples.every(sample => Number.isFinite(sample.detail.sampleAtMs) && sample.detail.sampleAtMs >= nativeMinimizedAt);
  const firstSample = samples[0]?.detail.sampleAtMs ?? Infinity, lastSample = samples.at(-1)?.detail.sampleAtMs ?? -Infinity;
  const maxSampleGapMs = Math.max(firstSample - nativeMinimizedAt, 0, ...samples.slice(1).map((sample, index) => sample.detail.sampleAtMs - samples[index].detail.sampleAtMs));
  const minimizeSampling = { clock: 'native-monotonic', nativeClockValid, count: samples.length, spanMs: Number.isFinite(lastSample - firstSample) ? lastSample - firstSample : 0, maxGapMs: Number.isFinite(maxSampleGapMs) ? maxSampleGapMs : null,
    allMinimized: samples.length > 0 && samples.every(report => report.detail.minimized === true) };
  const late = report => report.at >= minimizedAt + 300000;
  const finalPaints = finalNativePaints(reports);
  const lateLabels = new Set(finalPaints.paints.filter(late).map(report => report.detail.label));
  const lateActions = new Set(interactions.filter(late).map(report => `${report.detail.slot}:${report.detail.action}`));
  const result = { timedOut, minimizeSampling, failures: reports.filter(report => report.kind === 'failure'), minimized: Number.isFinite(minimizedAt),
    wrongDocumentDenied: reports.some(report => report.kind === 'wrong-document-denied'), recoveredDraft: reports.some(report => report.kind === 'child-ready' && report.detail.recovered),
    mainComplete: reports.some(report => report.kind === 'main-complete' && late(report)),
    childrenComplete: new Set(reports.filter(report => report.kind === 'child-complete').map(report => report.detail.label)).size,
    latePaintedChildren: lateLabels.size,
    lateInteractionsComplete: Array.from({ length: 8 }, (_, slot) => ['send', 'stop', 'approve'].every(action => lateActions.has(`${slot}:${action}`))).every(Boolean),
    lastGenerationByLabel: Object.fromEntries(paints.map(report => [report.detail.label, report.detail.generation])),
    interactions: interactions.length, maxInteractionMs: Math.max(0, ...interactions.map(report => report.detail.elapsedMs)) };
  return { ...result, passed: !timedOut && !result.failures.length && result.minimized && minimizeSampling.nativeClockValid && minimizeSampling.allMinimized && minimizeSampling.spanMs >= 300000 && minimizeSampling.maxGapMs <= 5000 && result.wrongDocumentDenied && result.recoveredDraft && result.mainComplete && result.childrenComplete === 8 && result.latePaintedChildren === 8 && result.lateInteractionsComplete };
}
