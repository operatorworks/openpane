import './styles.css';
import { createRoot } from 'react-dom/client';
import { BrowserApplication } from './BrowserApplication.js';
import { DesktopCustomizationProvider } from '../application/DesktopCustomizations.js';
import { PersonalizationProvider } from '../application/use-personalization.js';

const container = document.getElementById('root');
if (!container) throw new Error('Local preview root container is missing');
createRoot(container).render(<PersonalizationProvider><DesktopCustomizationProvider>
  <aside role="note" style={{ position: 'fixed', bottom: 0, right: 0, zIndex: 10000, padding: '4px 12px',
    background: '#20242c', color: '#ffffff', fontSize: 12 }}>Unqualified local preview · Full-trust working source · Reload manually while idle</aside>
  <BrowserApplication />
</DesktopCustomizationProvider></PersonalizationProvider>);
