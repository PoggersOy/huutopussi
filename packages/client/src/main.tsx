import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './i18n';
import App from './App';
import { initInstallPrompt } from './install';
import { initPwa } from './pwa';

initPwa();
initInstallPrompt();

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
