import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './i18n';
import App from './App';
import { initAuth } from './auth';
import { initInstallPrompt } from './install';
import { initPwa } from './pwa';

initPwa();
initInstallPrompt();
// Restore any signed-in session and enable Google Sign-In (guest-safe if the
// server has no client id configured).
void initAuth();

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
