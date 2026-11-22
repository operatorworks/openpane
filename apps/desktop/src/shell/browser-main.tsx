import { ExperienceScope } from '../application/ExperienceScope.js';
import { PersonalizationProvider } from '../application/use-personalization.js';
import { DesktopCustomizationProvider } from '../application/DesktopCustomizations.js';
import { createRoot } from 'react-dom/client';
import { BrowserApplication } from './BrowserApplication.js';
import { ArtifactIdentity } from '../application/ArtifactIdentity.js';

const container = document.getElementById('root');
if (!container) throw new Error('Browser development root container is missing');
createRoot(container).render(<ExperienceScope><PersonalizationProvider><DesktopCustomizationProvider><BrowserApplication artifact={<ArtifactIdentity />} /></DesktopCustomizationProvider></PersonalizationProvider></ExperienceScope>);
