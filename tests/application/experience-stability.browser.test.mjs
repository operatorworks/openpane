import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { root, fixture, connected, draft, wait } from './browser-support.mjs';

// Unit A uses the actual application/controller with a disposable visual-data source.
// Production delivery and CSS validation are qualified separately in unit B.
test('live token and scoped CSS edits preserve the editor, composition, pending approval and run controls', { timeout: 45000 }, async t => {
  const host = await fixture(t);
  const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ThemeScope} from '@openpane/ui-primitives/desktop';
    import {BrowserApplication} from './apps/desktop/src/shell/BrowserApplication.tsx';
    import {PersonalizationProvider} from './apps/desktop/src/application/use-personalization.tsx';
    import {DesktopCustomizationProvider} from './apps/desktop/src/application/DesktopCustomizations.tsx';
    import './apps/desktop/src/shell/styles.css';
    function Probe() {
      const [tokens, setTokens] = React.useState({});
      React.useEffect(() => { window.applyVisualProbe = setTokens; }, []);
      return <ThemeScope {...tokens} data-experience-probe="active"><PersonalizationProvider><DesktopCustomizationProvider><BrowserApplication /></DesktopCustomizationProvider></PersonalizationProvider></ThemeScope>;
    }
    createRoot(document.getElementById('root')).render(<Probe />);
  ` }, bundle: true, write: false, outfile: 'probe.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js'));
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css'));
  const page = await host.browser.newPage();
  await page.route('**/probe.js', route => route.fulfill({ contentType: 'text/javascript', body: Buffer.from(js.contents) }));
  await page.route('**/probe.css', route => route.fulfill({ contentType: 'text/css', body: Buffer.from(css.contents) }));
  await page.route('**/probe.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Live visual stability probe</title><link rel="stylesheet" href="/probe.css"><div id="root"></div><script src="/probe.js"></script>' }));
  await page.goto(`${host.origin}/probe.html`);
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(page);
  const editor = page.getByRole('textbox', { name: 'Message', exact: true });
  await editor.fill('Approval stability probe'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  const approval = page.getByRole('region', { name: 'Approval required', exact: true }); await approval.waitFor();
  await draft(page, 'Preserve composed draft');
  const original = await editor.elementHandle(), approvalNode = await approval.elementHandle();
  await editor.focus();
  await editor.evaluate(node => {
    node.setSelectionRange(2, 10);
    window.compositionEvents = [];
    node.addEventListener('compositionend', () => window.compositionEvents.push('end'));
    node.dispatchEvent(new CompositionEvent('compositionstart', { data: 'composing', bubbles: true }));
  });
  const before = await editor.evaluate(node => ({ start: node.selectionStart, end: node.selectionEnd }));
  const commandsBefore = (await host.entries()).length;
  await page.evaluate(() => {
    window.applyVisualProbe({ typography: { body: { size: 13, lineHeight: 1.4 } }, spacing: { sm: 6 }, radius: { panel: 0 }, fonts: { body: 'Tahoma, Verdana, sans-serif' } });
    const style = document.createElement('style');
    style.textContent = '[data-experience-probe="active"] .composer textarea { background-color: #fff8dd; border-color: #3355aa; }';
    document.head.append(style);
  });
  await wait(() => editor.evaluate(node => getComputedStyle(node).backgroundColor === 'rgb(255, 248, 221)'), 'new visual style');
  assert.equal(await editor.evaluate((node, old) => node === old, original), true);
  assert.equal(await editor.inputValue(), 'Preserve composed draft');
  assert.deepEqual(await editor.evaluate(node => ({ start: node.selectionStart, end: node.selectionEnd })), before);
  assert.equal(await editor.evaluate(node => document.activeElement === node), true);
  assert.deepEqual(await page.evaluate(() => window.compositionEvents), []);
  assert.equal(await approval.evaluate((node, old) => node === old, approvalNode), true);
  assert.equal(await approval.getByRole('button', { name: 'approve', exact: true }).isEnabled(), true);
  assert.equal(await page.locator('[data-experience-probe]').evaluate(node => getComputedStyle(node).getPropertyValue('--aui-space-sm').trim()), '0.375rem');
  await editor.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { data: 'composing', bubbles: true })));
  assert.equal((await host.entries()).length, commandsBefore, 'cosmetic update did not resend a command');
  await page.getByRole('button', { name: 'approve', exact: true }).click();
  await wait(async () => await approval.count() === 0, 'approval remains functional after styling');
  assert.equal(await editor.inputValue(), 'Preserve composed draft');
  await page.reload(); await connected(page);
  assert.equal(await editor.inputValue(), 'Preserve composed draft');
});

test('fixed native chats apply the complete selected theme and explicit mode while retaining their draft', { timeout: 45000 }, async t => {
  const host = await fixture(t);
  const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {BrowserApplication} from './apps/desktop/src/shell/BrowserApplication.tsx';
    import {VisualContext} from './apps/desktop/src/application/experience-state.ts';
    import {PersonalizationProvider} from './apps/desktop/src/application/use-personalization.tsx';
    import {DesktopCustomizationProvider} from './apps/desktop/src/application/DesktopCustomizations.tsx';
    import './apps/desktop/src/shell/styles.css';
    function Probe() {
      const [experience,setExperience]=React.useState(null); window.selectNativeTheme=setExperience;
      return <VisualContext value={experience}><PersonalizationProvider><DesktopCustomizationProvider><BrowserApplication fixedChat={experience!==null}/></DesktopCustomizationProvider></PersonalizationProvider></VisualContext>;
    }
    createRoot(document.getElementById('root')).render(<Probe/>);
  ` }, bundle:true,write:false,outfile:'native-theme.js',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'} });
  const page=await host.browser.newPage();
  await page.route('**/native-theme.js',r=>r.fulfill({contentType:'text/javascript',body:Buffer.from(bundle.outputFiles.find(f=>f.path.endsWith('.js')).contents)}));
  await page.route('**/native-theme.css',r=>r.fulfill({contentType:'text/css',body:Buffer.from(bundle.outputFiles.find(f=>f.path.endsWith('.css')).contents)}));
  await page.route('**/native-theme.html',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><link rel="stylesheet" href="/native-theme.css"><div id="root"></div><script src="/native-theme.js"></script>'}));
  await page.goto(`${host.origin}/native-theme.html`);
  await page.getByRole('button',{name:'New recorded conversation',exact:true}).click(); await connected(page); await draft(page,'Native theme draft');
  const editor=page.getByRole('textbox',{name:'Message',exact:true});
  const theme={mode:'dark',light:{chart:{trace1:'#224466'},fonts:{body:'Verdana, sans-serif'}},dark:{chart:{trace1:'#8ed6b3'},fonts:{body:'Tahoma, sans-serif'},spacing:{sm:6}}};
  const experience={digest:'a'.repeat(64),manifest:{theme,presentation:{navigation:'pages',chats:'separate',chatWindow:{width:640,height:720,titlebar:'native',title:'conversation'}}}};
  await page.evaluate(value=>window.selectNativeTheme(value),experience);
  const native=page.locator('.application-chat-window'); await native.waitFor();
  assert.equal(await native.getAttribute('data-appearance'),'dark');
  assert.equal(await native.evaluate(n=>getComputedStyle(n).getPropertyValue('--aui-chart-trace1').trim()),'#8ed6b3');
  assert.match(await editor.evaluate(n=>getComputedStyle(n).fontFamily),/Tahoma/);
  const original=await editor.elementHandle();
  await page.evaluate(value=>window.selectNativeTheme(value),{...experience,manifest:{...experience.manifest,theme:{...theme,mode:'light'}}});
  await wait(async()=>await native.getAttribute('data-appearance')==='light','explicit native light mode');
  assert.equal(await native.evaluate(n=>getComputedStyle(n).getPropertyValue('--aui-chart-trace1').trim()),'#224466');
  assert.equal(await editor.inputValue(),'Native theme draft'); assert.equal(await editor.evaluate((n,old)=>n===old,original),true);
});
