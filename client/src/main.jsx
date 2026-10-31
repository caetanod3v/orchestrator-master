import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { StoreProvider } from './store.jsx';
import './tokens.css';
import './styles.css';
import './shell.css';
import './cockpit.css';
import './chat.css';
import './pages.css';

createRoot(document.getElementById('root')).render(
  <StoreProvider>
    <App />
  </StoreProvider>,
);
