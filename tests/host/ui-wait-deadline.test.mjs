import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { UiFrames } from '../../apps/host/build/tsc/ui-frames.js';
import * as protocol from '../../apps/host/build/tsc/ui-protocol.js';

const cli = new URL('../../apps/host/build/tsc/ui-cli.js', import.meta.url).href;
const protocolModule = new URL('../../apps/host/build/tsc/ui-protocol.js', import.meta.url).href;
function scenario(mode) {
  const source = `
    import { createServer } from 'node:net';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { mkdtempSync, chmodSync, renameSync, lstatSync, existsSync, rmSync } from 'node:fs';
    import { join } from 'node:path';
    import { runUiCli } from ${JSON.stringify(cli)};
    import * as protocol from ${JSON.stringify(protocolModule)};
    const mode = ${JSON.stringify(mode)}, directory = mkdtempSync('/tmp/op-ui-budget-'), path = join(directory, 'ui.sock'), sockets = new Set(), requests = [], timers = [];
    const pending = { outcome: 'pending', receipt: { requestId: '1:fraction', identity: 'original-pending-receipt' } };
    let ghostSocket = false, closedBeforeFinal = false;
    const server = createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let input = '';
      socket.on('data', chunk => {
        input += chunk; if (!input.includes('\\n')) return;
        requests.push(JSON.parse(input.slice(0, input.indexOf('\\n')))); input = '';
        if (mode === 'no-first-timeout') return;
        if (requests.length === 1) {
          if (mode === 'connect-error') { renameSync(path, path + '.parked'); server.close(() => { renameSync(path + '.parked', path); ghostSocket = lstatSync(path).isSocket(); }); }
          if (mode === 'expired-after-sleep' || mode === 'cross-samples') server.close(() => { closedBeforeFinal = !existsSync(path); });
          socket.end(JSON.stringify({ ok: true, value: pending }) + '\\n'); return;
        }
        if (mode === 'disconnect') socket.end();
        if (mode === 'protocol') socket.end('invalid-json\\n');
        if (mode === 'refusal') socket.end(JSON.stringify({ ok: false, code: 'conflict', error: 'Recorded conflict' }) + '\\n');
        if (mode === 'remote-timeout-text') socket.end(JSON.stringify({ ok: false, code: 'unavailable', error: 'UI frame timed out' }) + '\\n');
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); }); chmodSync(path, 0o600);
    const fractional = mode === 'fractional-timeout', limit = mode === 'zero-wait' ? 0 : fractional || mode === 'no-first-timeout' || (mode === 'expired-after-sleep' || mode === 'cross-samples') ? 311 : 1000;
    const values = mode === 'cross-samples' ? [0, 0, 0.25, 0.25, 310.25, 311.25] : fractional ? [0, 0, 0.25, 0.25, 300.25, 300.25, 310.25] : mode === 'expired-after-sleep' ? [0, 0, 0.25, 0.25, 311.25] : mode === 'no-first-timeout' || mode === 'zero-wait' ? [0, 0] : [0, 0, 0.25, 0.25, 800.25, 800.25, 1000.25];
    let reads = 0, sampledClock = 0; const pollBudgets = [];
    Object.defineProperty(performance, 'now', { configurable: true, value() { sampledClock = values[Math.min(reads++, values.length - 1)]; return sampledClock; } });
    const originalStat = fs.lstatSync; fs.lstatSync = (...args) => { if (args[0] === path) pollBudgets.push({ sampledClock, limit }); return originalStat(...args); }; syncBuiltinESMExports();
    const realTimer = globalThis.setTimeout, write = process.stdout.write; let output = '', error = null;
    globalThis.setTimeout = (callback, milliseconds, ...args) => { timers.push(milliseconds); return realTimer(callback, milliseconds, ...args); };
    process.stdout.write = value => { output += String(value); return true; };
    try { await runUiCli(['--data-dir', directory, 'wait', '--request-id', '1:fraction', '--wait-ms', String(limit)]); }
    catch (cause) { error = { code: cause.code ?? null, message: cause.message, timeout: typeof protocol.UiTimeout === 'function' && cause instanceof protocol.UiTimeout }; }
    finally {
      process.stdout.write = write; globalThis.setTimeout = realTimer; fs.lstatSync = originalStat; syncBuiltinESMExports();
      for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true });
    }
    write.call(process.stdout, JSON.stringify({ output: output ? JSON.parse(output) : null, error, reads, timers, requests, ghostSocket, closedBeforeFinal, pollBudgets }) + '\\n');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 3500 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('fractional final poll timeout returns the original pending receipt before the controlled clock deadline', { timeout: 5000 }, () => {
  const result = scenario('fractional-timeout');
  assert.equal(result.error, null, JSON.stringify(result));
  assert.deepEqual(result.output, { outcome: 'pending', receipt: { requestId: '1:fraction', identity: 'original-pending-receipt' }, waitEnded: true });
  assert.ok(result.timers.some(milliseconds => Math.abs(milliseconds - 10.75) < 0.0001), JSON.stringify(result.timers));
  assert.ok(result.requests.length >= 1 && result.requests.length <= 2);
});

test('a budget exhausted during sleep returns the pending receipt without touching the removed socket', { timeout: 5000 }, () => {
  const result = scenario('expired-after-sleep');
  assert.equal(result.closedBeforeFinal, true, 'the real listener has closed and removed its socket before wait completes');
  assert.equal(result.error, null, JSON.stringify(result));
  assert.deepEqual(result.output, { outcome: 'pending', receipt: { requestId: '1:fraction', identity: 'original-pending-receipt' }, waitEnded: true });
  assert.equal(result.requests.length, 1);
});

test('a zero-duration wait still reads the current receipt once', { timeout: 5000 }, () => {
  const result = scenario('zero-wait');
  assert.equal(result.error, null, JSON.stringify(result));
  assert.deepEqual(result.output, { outcome: 'pending', receipt: { requestId: '1:fraction', identity: 'original-pending-receipt' }, waitEnded: true });
  assert.equal(result.requests.length, 1);
});

for (const mode of ['disconnect', 'protocol', 'refusal', 'remote-timeout-text', 'connect-error']) test(`wait preserves a ${mode} error while the poll budget is live`, { timeout: 5000 }, () => {
  const result = scenario(mode);
  assert.equal(result.output, null, JSON.stringify(result)); assert.equal(result.error?.timeout, false, JSON.stringify(result));
  assert.equal(result.error.code, mode === 'refusal' ? 'conflict' : 'unavailable');
  if (mode === 'connect-error') {
    assert.equal(result.ghostSocket, true, 'socket ownership check passes before the real refused connection');
    assert.equal(result.error.message, 'UI host could not be reached. Check that this profile is running, then retry the original request.');
  }
});

test('a first poll timeout without a receipt remains an unavailable refusal', { timeout: 5000 }, () => {
  const result = scenario('no-first-timeout');
  assert.equal(result.output, null); assert.equal(result.error?.code, 'unavailable'); assert.equal(result.error?.timeout, true, JSON.stringify(result));
  assert.equal(result.requests.length, 1);
});

test('the frame reader marks its own real socket timer exhaustion with the same typed refusal', { timeout: 3000 }, async () => {
  const directory = await mkdtemp('/tmp/op-ui-frame-'), sockets = new Set(), path = join(directory, 'ui.sock');
  const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(path, resolve)); await chmod(path, 0o600);
  const socket = createConnection(path); await once(socket, 'connect'); const reader = new UiFrames(socket);
  try {
    let failure; try { await reader.next(10.75); } catch (error) { failure = error; }
    assert.equal(typeof protocol.UiTimeout, 'function'); assert.ok(failure instanceof protocol.UiTimeout); assert.equal(failure.code, 'unavailable'); assert.equal(await reader.ended, failure);
  } finally { reader.close(); for (const client of sockets) client.destroy(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});

test('a pending wait never admits a socket check with an observed expired poll budget', { timeout: 5000 }, () => {
  const result = scenario('cross-samples');
  assert.equal(result.closedBeforeFinal, true);
  assert.equal(result.requests.length, 1);
  assert.ok(result.pollBudgets.length > 0, 'the real socket check is observed');
  assert.ok(result.pollBudgets.slice(1).every(poll => poll.sampledClock < poll.limit), JSON.stringify(result));
  if (result.pollBudgets.length > 1) {
    assert.equal(result.output, null);
    assert.equal(result.error?.code, 'unavailable', 'a poll admitted with a live sampled budget preserves its genuine connection failure');
  } else {
    assert.equal(result.error, null);
    assert.equal(result.output.waitEnded, true);
    assert.equal(result.output.receipt.identity, 'original-pending-receipt');
  }
});
