import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@moyu/theme/tokens.css';
import './styles/global.css';

import { App } from './App';
import { ensureNotificationServiceWorker } from './lib/notifications';

const container = document.getElementById('root');

if (!container) {
  throw new Error('root element is missing');
}

// Register early so the persistent-notification fallback is active before the
// first SSE event; the worker itself only handles clicks (no caching or push).
void ensureNotificationServiceWorker();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
