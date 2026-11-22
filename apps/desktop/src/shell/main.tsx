import { PersonalizationProvider } from '../application/use-personalization.js';
import { DesktopCustomizationProvider } from '../application/DesktopCustomizations.js';
import { createRoot } from 'react-dom/client';
import { DesktopShell } from './Shell.js';
import { NativeApplication } from '../application/NativeApplication.js';

const container = document.getElementById('root');
if (!container) throw new Error('Desktop root container is missing');
createRoot(container).render(<PersonalizationProvider><DesktopCustomizationProvider>{location.protocol === 'tauri:' ? <NativeApplication /> : <DesktopShell />}</DesktopCustomizationProvider></PersonalizationProvider>);
