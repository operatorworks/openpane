export function firstJsonLine(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let length = 0;
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off('error', failed); child.off('exit', exited); child.stdout.off('data', data);
      if (error) reject(error); else resolve(value);
    };
    const failed = error => finish(error);
    const exited = () => finish(new Error('Packaged host exited before reporting startup'));
    const data = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const newline = bytes.indexOf(10), part = newline < 0 ? bytes : bytes.subarray(0, newline);
      length += part.length;
      if (length > 65536) { finish(new Error('Packaged host startup output exceeded its limit')); return; }
      chunks.push(part);
      if (newline < 0) return;
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new Error('Packaged host reported invalid startup JSON')); }
    };
    const timer = setTimeout(() => finish(new Error('Packaged host did not start')), timeoutMs);
    child.once('error', failed); child.once('exit', exited); child.stdout.on('data', data);
  });
}

export async function stopChild(child, { graceMs = 10000, killMs = 3000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return { stopped: true, forced: false };
  let exited = false;
  const exit = new Promise(resolve => { child.once('exit', () => { exited = true; resolve(); }); });
  const wait = async milliseconds => {
    let timer;
    try { await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); return exited; }
    finally { clearTimeout(timer); }
  };
  child.kill('SIGTERM');
  if (await wait(graceMs)) return { stopped: true, forced: false };
  child.kill('SIGKILL');
  const stopped = await wait(killMs);
  if (!stopped) { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
  return { stopped, forced: true };
}
