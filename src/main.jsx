import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App.jsx';
import { initThemes } from './theme/index.js';
import './styles/base.css';
import './styles/shell.css';

// Apply the cached theme before the first render to avoid a flash of the default theme.
initThemes();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
