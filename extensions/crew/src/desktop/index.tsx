import { EXTENSION_SDK_VERSION } from '@openpane/sdk';
import type { UiExtensionEntry } from '@openpane/sdk/react';
import { CrewTranscript } from './CrewTranscript.js';
import { CrewWorkspace } from './CrewWorkspace.js';
import './styles.css';

const entry: UiExtensionEntry<'desktop'> = {
  kind: 'desktop',
  sdkVersion: EXTENSION_SDK_VERSION,
  activate() {
    return { modules: [], workspace: { label: 'Crew', component: CrewWorkspace, transcript: CrewTranscript }, dispose() {} };
  },
};
export default entry;
