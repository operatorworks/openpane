import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from './preparation-support.mjs';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export function repository() {
  const directory = mkdtempSync(join(tmpdir(), 'openpane-custom-build-'));
  const repo = join(directory, 'source');
  cpSync(join(root, 'templates/customization'), repo, { recursive: true });
  const git = (...args) => execute('git', args, repo);
  git('init', '--template=', '--quiet');
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'Fixture');
    return git('rev-parse', 'HEAD');
  };
  return { directory, repo, commit, write: (path, text) => writeFileSync(join(repo, path), text) };
}
export function buildCustom(fixture, commit = fixture.commit(), out = join(fixture.directory, 'browser')) {
  return execFileSync(process.execPath, [join(root, 'scripts/build-local-customization.mjs'), '--repository', fixture.repo, '--commit', commit, '--out', out], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
}
