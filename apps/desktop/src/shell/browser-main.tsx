import { createRoot } from 'react-dom/client';
import { loadWindowContext } from '../application/window-context.js';
import { WindowRuntime } from '../application/window-runtime.js';
import { WindowApplication } from '../application/WindowApplication.js';

const container = document.getElementById('root');
if (!container) throw new Error('Browser development root container is missing');
const root = createRoot(container);
void loadWindowContext().then(context => {
  const runtime = new WindowRuntime(context);
  root.render(<WindowApplication runtime={runtime} />);
}).catch(error => {
  root.render(<main><h1>Editor unavailable</h1><p role="alert">{error instanceof Error ? error.message : String(error)}</p>
    <p>This window has not acquired a conversation. Saved work is preserved.</p><button type="button" onClick={() => window.location.reload()}>Retry window registration</button></main>);
});
