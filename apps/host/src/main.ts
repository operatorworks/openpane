import { fileURLToPath } from 'node:url';
import { uiFailure } from './ui-control.js';
async function main(): Promise<void> {
  if (process.argv[2] === 'ui') {
    const { runUiCli } = await import('./ui-cli.js');
    await runUiCli(process.argv.slice(3));
  } else {
    const { runHostMain } = await import('./host-main.js');
    await runHostMain(fileURLToPath(import.meta.url));
  }
}
void main().catch(error => {
  const message = error instanceof Error ? error.message : 'Host operation failed';
  process.stderr.write((process.argv[2] === 'ui' ? JSON.stringify(uiFailure(error)) : message) + '\n');
  process.exitCode = 1;
});
