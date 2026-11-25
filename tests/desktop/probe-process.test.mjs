import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { firstJsonLine, stopChild } from './experience-probe/process.mjs';

function running(t, source) {
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stopChild(child, { graceMs: 50, killMs: 1000 }));
  return child;
}

test('malformed startup rejects through cleanup instead of escaping a process callback', async t => {
  const child = running(t, "console.log('warning instead of JSON'); setInterval(() => {}, 1000)");
  await assert.rejects(firstJsonLine(child, 1000), /invalid startup JSON/);
  assert.deepEqual(await stopChild(child, { graceMs: 1000, killMs: 1000 }), { stopped: true, forced: false });
  assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
});

test('a native probe that ignores SIGTERM is killed within the shutdown bound', async t => {
  const child = running(t, "process.on('SIGTERM', () => {}); console.log(JSON.stringify({ready:true})); setInterval(() => {}, 1000)");
  assert.deepEqual(await firstJsonLine(child, 1000), { ready: true });
  const start = performance.now();
  assert.deepEqual(await stopChild(child, { graceMs: 50, killMs: 1000 }), { stopped: true, forced: true });
  assert.ok(performance.now() - start < 2000);
  assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
});

test('startup line limit excludes following output in the same chunk', async () => {
  const { EventEmitter } = await import('node:events');
  const child = new EventEmitter(); child.stdout = new EventEmitter();
  const ready = firstJsonLine(child, 1000);
  child.stdout.emit('data', Buffer.from('{"ready":'));
  child.stdout.emit('data', Buffer.from('true}\n' + 'x'.repeat(70000)));
  assert.deepEqual(await ready, { ready: true });
});
