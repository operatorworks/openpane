import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { parseExperience, experienceSchema, parseMetricsCard, metricsCardSchema, parseWindowContext, parseUiSelection, METRICS_EVENT_NAME } from '@openpane/contracts';
import { EventSchema } from '@openpane/protocol';

export const experience = () => ({ schemaVersion: 1, id: 'messenger-2002', label: 'Messenger',
  theme: { mode: 'system', light: {}, dark: {} },
  presentation: { navigation: 'rail', chats: 'separate', chatWindow: { width: 640, height: 720, titlebar: 'native', title: 'agent-and-conversation' } }, stylesheet: null, assets: [] });
const metrics = () => ({ schemaVersion: 1, title: 'CPU', query: 'avg:system.cpu.user{*}', fromMs: 1795374000000, toMs: 1795377600000, fetchedAtMs: 1795377600001,
  series: [{ label: 'Host A', unit: '%', points: [[1795374000000, 0], [1795374100000, null], [1795374200000, 42]] }] });
const ajv = new Ajv({ strict: true, strictNumbers: true });
const validateExperience = ajv.compile(experienceSchema), validateMetrics = ajv.compile(metricsCardSchema);

test('experience parsers and exported discovery schema describe bounded visual data', () => {
  const value = experience();
  value.theme.light = { colors: { accent: '#AABBCC' }, typography: { body: { size: 13, weight: 400 } }, fonts: { body: 'Tahoma, Verdana, sans-serif' }, spacing: { sm: 6 }, chart: { trace1: '#123456' } };
  assert.ok(validateExperience(value), ajv.errorsText(validateExperience.errors));
  assert.equal(parseExperience(value).theme.light.colors.accent, '#AABBCC');
  for (const mutate of [v => v.schemaVersion = 2, v => v.script = 'evil.js', v => v.theme.light = { layout: {} }, v => v.theme.mode = 'automatic',
    v => v.theme.light = { colors: { missing: '#ffffff' } }, v => v.theme.light = { typography: { body: { size: 9 } } },
    v => v.theme.light = { spacing: { sm: -1 } }, v => v.theme.light = { radius: { panel: Infinity } },
    v => v.theme.light = { fonts: { body: 'url(https://example.com)' } }, v => v.presentation.chatWindow.width = 359]) {
    const bad = experience(); mutate(bad); assert.throws(() => parseExperience(bad)); assert.equal(validateExperience(bad), false);
  }
});
test('asset inventory rejects duplicates, paths, mismatched CSS and capacity before loading bytes', () => {
  const asset = { name: 'frame.png', mimeType: 'image/png', bytes: 200, sha256: 'a'.repeat(64) };
  for (const assets of [[asset, asset], [{ ...asset, name: '../frame.png' }], [{ ...asset, mimeType: 'text/javascript' }], [{ ...asset, bytes: 2097153 }],
    [{ ...asset, mimeType: 'text/css', bytes: 131073 }], Array.from({ length: 17 }, (_, i) => ({ ...asset, name: `${i}.png` }))]) {
    assert.throws(() => parseExperience({ ...experience(), assets }));
  }
  assert.throws(() => parseExperience({ ...experience(), stylesheet: 'style.css' }));
  const css = { ...asset, name: 'style.css', mimeType: 'text/css' };
  assert.deepEqual(parseExperience({ ...experience(), stylesheet: css.name, assets: [css] }).assets, [css]);
});
test('metrics preserve millisecond timestamps, raw values and gaps through the pinned CUSTOM event schema', () => {
  const card = parseMetricsCard(metrics());
  assert.ok(validateMetrics(card));
  const event = EventSchema.parse({ type: 'CUSTOM', name: METRICS_EVENT_NAME, value: card });
  assert.deepEqual(parseMetricsCard(event.value), card);
  assert.equal(card.series[0].points[0][0], 1795374000000);
  assert.equal(card.series[0].points[0][1], 0);
  assert.equal(card.series[0].points[1][1], null);
  assert.equal(parseMetricsCard({ ...metrics(), series: [] }).series.length, 0);
  for (const mutate of [v => v.schemaVersion = 2, v => v.extra = true, v => v.fromMs = v.toMs + 1, v => v.toMs = 1.5,
    v => v.series[0].points.push(v.series[0].points[0]), v => v.series[0].points[0][1] = Infinity,
    v => v.series[0].points[0][0] = NaN, v => v.series[0].points[0].push(5), v => v.series[0].label = 'x'.repeat(201),
    v => v.series = Array(9).fill(v.series[0]), v => v.series[0].points = Array(401).fill([1, 1])]) {
    const value = metrics(); mutate(value); assert.throws(() => parseMetricsCard(value));
  }
});
test('metrics byte budget includes UTF-8 and JSON rather than just text length', () => {
  const value = metrics();
  value.query = '😀'.repeat(2000);
  value.series = Array.from({ length: 8 }, (_, index) => ({ label: `${index}`, unit: null, points: Array.from({ length: 400 }, (_, time) => [1795374000000 + time, 1234567890.123456]) }));
  assert.throws(() => parseMetricsCard(value), /byte limit/);
});
test('window context and UI selection enforce exact host, role and generation fields', () => {
  const main = { role: 'main', hostId: 'host', profileId: 'profile', brokerInstance: 'broker', label: 'main', documentIncarnation: 'doc', viewId: 'view' };
  assert.deepEqual(parseWindowContext(main), main);
  const chat = { ...main, role: 'chat', scope: { hostId: 'host', conversationId: 'chat' } };
  assert.deepEqual(parseWindowContext(chat), chat);
  assert.throws(() => parseWindowContext({ ...chat, scope: { ...chat.scope, hostId: 'other' } }));
  assert.throws(() => parseWindowContext({ ...main, scope: chat.scope }));
  const selection = { revision: 0, deliveryGeneration: 0, selected: { kind: 'builtin' }, previousHealthy: { kind: 'builtin' } };
  assert.deepEqual(parseUiSelection(selection), selection);
  assert.throws(() => parseUiSelection({ ...selection, revision: -1 }));
  assert.throws(() => parseUiSelection({ ...selection, selected: { kind: 'experience', digest: 'bad' } }));
});

test('human text limits agree with JSON Schema for astral Unicode characters', () => {
  const card = metrics(); card.title = '😀'.repeat(200); card.series[0].label = '😀'.repeat(200);
  assert.ok(validateMetrics(card)); assert.doesNotThrow(() => parseMetricsCard(card));
  card.title += '😀'; assert.equal(validateMetrics(card), false); assert.throws(() => parseMetricsCard(card));
  const visual = experience(); visual.label = '😀'.repeat(200);
  assert.ok(validateExperience(visual)); assert.doesNotThrow(() => parseExperience(visual));
});
