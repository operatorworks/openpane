import { test } from 'node:test';
import { assertCompileCases } from '../../../tests/support/compile.mjs';
const targets = [
  { workspace: 'packages/contracts', type: 'RunIdentity', module: '@openpane/contracts', forbidden: ['document', 'process'] },
  { workspace: 'packages/protocol', type: 'Event', module: '@openpane/protocol', forbidden: ['document', 'process'] },
  { workspace: 'packages/sdk', type: 'ExtensionManifest', module: '@openpane/sdk', forbidden: ['document', 'process'] },
  { workspace: 'packages/sdk', type: 'ConversationModule', module: '@openpane/sdk/react', forbidden: ['document', 'process'], config: 'tsconfig.react.json' },
  { workspace: 'packages/theme', type: 'Theme', module: '@openpane/theme', forbidden: ['document', 'process'] },
  { workspace: 'packages/theme', type: 'ThemeProviderProps', module: '@openpane/theme/react', forbidden: ['document', 'process'], config: 'tsconfig.react.json' },
  { workspace: 'packages/ui-primitives', type: 'ButtonProps', module: '@openpane/ui-primitives/desktop', forbidden: ['process'] },
  { workspace: 'packages/ui-primitives', type: 'ButtonProps', module: '@openpane/ui-primitives/native', forbidden: ['document', 'process'], config: 'tsconfig.native.json' },
  { workspace: 'packages/host', type: 'EventObserver', probe: 'EventObserver<string>', module: '@openpane/host', forbidden: ['document'] },
  { workspace: 'packages/host', type: 'describeProjection', probe: 'typeof describeProjection', module: '@openpane/host/agui', forbidden: ['document'] },
  { workspace: 'packages/host', type: 'frontendToolsFor', probe: 'typeof frontendToolsFor', module: '@openpane/host/frontend-tools', forbidden: ['document'] },
  { workspace: 'apps/desktop', type: 'DesktopMount', module: '@openpane/desktop', forbidden: ['process'] },
  { workspace: 'apps/ios', type: 'IosConversationView', module: '@openpane/ios', forbidden: ['document', 'process'] },
];

for (const { workspace, type, module, forbidden, probe = type, config = 'tsconfig.json' } of targets) {
  test(`${module} rejects foreign ambient globals`, () => assertCompileCases({
    config: `${workspace}/${config}`,
    prefix: `import type { ${type} } from '${module}';\nexport type Probe = ${probe};\n`,
    cases: [['', null], ...forbidden.map((global) => [`void ${global};\n`, new RegExp(`Cannot find name '${global}'`)])],
  }));
}

test('run authority has exactly one binding and requires its owner', async () => {
  await assertCompileCases({
    prefix: "import type { RunAuthority, RunIdentity } from '@openpane/contracts';\nconst binding = { namespace: 'example.crew', installationId: 'agent', opaqueSessionId: 'session' };\nexport type Identity = RunIdentity;\n",
    cases: [
      ["export const valid: RunAuthority = { kind: 'remote-provider', binding };", null],
      ["void binding; export const invalid: RunAuthority = { kind: 'remote-provider' };", /Property 'binding' is missing/],
      ["export const invalid: RunAuthority = { kind: 'openpane-host', binding };", /Property 'hostId' is missing/],
      ["export const invalid: RunIdentity = { conversation: { hostId: 'host', conversationId: 'conversation' }, runId: 'run', authority: { kind: 'remote-provider', binding }, provider: binding };", /'provider' does not exist/],
    ],
  });
});
