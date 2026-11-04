import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import App from './App.jsx';
import { StoreProvider } from './store.jsx';
import './tokens.css';
import './styles.css';
import './shell.css';
import './cockpit.css';
import './pages.css';
import './theme.css'; // por último: aparência (console de agentes); não muda estrutura nem comportamento
import './oc.css'; // interface centrada nos terminais (sidebar de ambientes, Cockpit, diálogos): carregado depois de tudo

createRoot(document.getElementById('root')).render(
  <StoreProvider>
    <App />
  </StoreProvider>,
);
