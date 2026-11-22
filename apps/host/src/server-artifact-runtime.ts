import { EXTENSION_SDK_VERSION } from '@openpane/sdk';
import type { ServerArtifactExpectation } from '@openpane/host/customization';

declare const OPENPANE_SERVER_CUSTOMIZATION_ABI: string;

export function serverArtifactExpectation(artifactId: string): ServerArtifactExpectation {
  if (typeof OPENPANE_SERVER_CUSTOMIZATION_ABI !== 'string') throw new Error('Server artifacts require a packaged host');
  return { artifactId, sdkVersion: EXTENSION_SDK_VERSION, nodeVersion: process.versions.node,
    nodeModules: process.versions.modules, abiIdentity: OPENPANE_SERVER_CUSTOMIZATION_ABI };
}
