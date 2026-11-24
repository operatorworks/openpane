import { spawn, execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { canonicalJson, parseUiContext } from '@openpane/contracts';
import { requestUi } from '../../../apps/host/build/tsc/ui-control.js';
import { firstJsonLine, stopChild } from './process.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const executable = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Pass the installed pinned Codex executable as argv[2]');
const directory = await mkdtemp('/tmp/op-ui-');
await chmod(directory, 0o700);
const workspace = join(directory, 'workspace'); await mkdir(workspace);
const profile = join(directory, 'profile'), entry = join(root, 'apps/host/dist/main.js');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AZURE_OPENAI_API_KEY'].includes(key)));
const child = spawn(process.execPath, [entry, 'codex', '--data-dir', profile, '--workspace', workspace, '--executable', executable, '--port', '0'], { cwd: root, env, stdio: 'pipe' });
let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
const startup = firstJsonLine(child); void startup.catch(() => {});
let browser;
let result;
try {
  browser = await chromium.launch({ headless: false });
  const info = await startup;
  const page = await browser.newPage(); page.setDefaultTimeout(20000);
  await page.goto(`${info.origin}/browser.html`);
  const newChat = page.getByRole('button', { name: 'New conversation', exact: true });
  await newChat.click();
  const editor = page.getByRole('textbox', { name: 'Message', exact: true }); await editor.waitFor();
  const conversationId = (await page.locator('.scope-label').textContent()).trim();
  const scope = { hostId: info.hostId, conversationId };
  const prefix = [process.execPath, entry, 'ui', '--data-dir', profile];
  const context = await requestUi(join(profile, 'ui.sock'), { op: 'context' });
  const expectedExperienceSchema = await requestUi(join(profile, 'ui.sock'), { op: 'schema' });
  const expectedDisplaySchema = await requestUi(join(profile, 'ui.sock'), { op: 'display-schema' });
  const publicationId = `${context.requestEpoch}:${randomUUID()}`;
  const now = Date.now();
  await requestUi(join(profile, 'ui.sock'), { op: 'display-publish', scope, publicationId, event: { type: 'CUSTOM', name: 'openpane.datadog.metrics.v1', value: { schemaVersion: 1, title: 'Synthetic CLI qualification', query: 'synthetic:cli-proof', fromMs: now - 1000, toMs: now, fetchedAtMs: now, series: [] } } });
  const expectedStatus = await requestUi(join(profile, 'ui.sock'), { op: 'display-status', scope, publicationId });
  const pup = process.argv[3] ? resolve(process.argv[3]) : null;
  const toSeconds = Math.floor(Date.now() / 1000), range = { fromSeconds: toSeconds - 3600, toSeconds };
  const prompt = `Qualify the production OpenPane UI CLI in this disposable workspace. Create probe.txt containing exactly "approved UI probe" with no terminating newline. Use the exact argvPrefix and ConversationScope supplied in this turn's <openpane-ui> item. Read context, experience schema and display schema. Save their production stdout to ui-context.json, ui-experience-schema.json and ui-display-schema.json respectively. Then run display status for that exact scope with --publication-id ${publicationId}, saving stdout to ui-status.json. Do not create another launcher or socket, change configuration, fabricate output or use another runtime. Request ordinary approval if necessary. ${pup ? `Also execute ${JSON.stringify(pup)} --no-agent --output=json metrics query --query 'avg:system.cpu.user{*}' --from=${range.fromSeconds} --to=${range.toSeconds}, with DD_SITE=us3.datadoghq.com and no --org; save stdout to pup-raw.json in this workspace. Do not print credentials. If it fails, stop and report that failure.` : ''} Report completion.`;
  await writeFile(join(directory, 'intent.json'), JSON.stringify({ scope, prefix, publicationId, prompt, codexVersion: execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), node: process.version }, null, 2));
  await editor.fill(prompt); await page.getByRole('button', { name: 'Send', exact: true }).click();
  const approvals = [], deadline = Date.now() + 180000;
  for (;;) {
    const cards = page.getByRole('region', { name: 'Approval required', exact: true });
    for (const card of await cards.all()) {
      const text = await card.textContent();
      if (!approvals.includes(text)) {
        approvals.push(text);
        console.log('Review and answer the ordinary approval in the visible OpenPane window. The probe does not approve requests.');
      }
    }
    let edited = false, queried = !pup, profileOutputMatched = false;
    try { edited = (await readFile(join(workspace, 'probe.txt'), 'utf8')) === 'approved UI probe'; } catch {}
    try {
      if (pup) {
        const { normalizePup } = await import('../../../apps/host/build/tsc/ui-pup.js');
        normalizePup(JSON.parse(await readFile(join(workspace, 'pup-raw.json'), 'utf8')), 'avg:system.cpu.user{*}', 'CPU query qualification', range, Date.now()); queried = true;
      }
    } catch {}
    try {
      const observed = parseUiContext(JSON.parse(await readFile(join(workspace, 'ui-context.json'), 'utf8')));
      const status = JSON.parse(await readFile(join(workspace, 'ui-status.json'), 'utf8'));
      const experienceSchema = JSON.parse(await readFile(join(workspace, 'ui-experience-schema.json'), 'utf8'));
      const displaySchema = JSON.parse(await readFile(join(workspace, 'ui-display-schema.json'), 'utf8'));
      profileOutputMatched = canonicalJson(experienceSchema) === canonicalJson(expectedExperienceSchema) && canonicalJson(displaySchema) === canonicalJson(expectedDisplaySchema) && observed.hostId === context.hostId && observed.profileId === context.profileId && observed.requestEpoch === context.requestEpoch && canonicalJson(status) === canonicalJson(expectedStatus);
    } catch {}
    if (edited && profileOutputMatched && queried) break;
    if (Date.now() > deadline) throw new Error('Approved CLI probe did not complete before deadline');
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  await page.screenshot({ path: join(directory, 'host-agent.png'), fullPage: true });
  await writeFile(join(directory, 'approvals.json'), JSON.stringify(approvals, null, 2));
  result = { status: 'passed', scope, publicationId, expectedPrefix: prefix, profileOutputMatched: true, executionProvenance: 'Agent command transcript not inspected; matching outputs do not establish executed argv.', approvals: approvals.length, pupQualified: pup !== null, evidence: directory };
} catch (error) { result = { status: 'failed', reason: error.message, evidence: directory }; }
finally {
  try { await browser?.close(); }
  catch { result = { status: 'failed', reason: 'Probe browser shutdown failed', evidence: directory }; }
  const stopped = await stopChild(child);
  if (stopped.forced || !stopped.stopped) result = { status: 'failed', reason: stopped.stopped ? 'Probe host required forced shutdown' : 'Probe host shutdown could not be confirmed', evidence: directory };
  await writeFile(join(directory, 'host-stderr.log'), stderr);
}
await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.status === 'passed' ? 0 : 1;
