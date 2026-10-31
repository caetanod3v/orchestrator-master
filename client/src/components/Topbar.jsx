import React from 'react';
import { useStore } from '../store.jsx';
import { api } from '../api.js';
import { Btn, Icon } from './ui.jsx';

/** Barra superior da folha: título da página à esquerda e a única ação global (interromper) à direita. Em telas estreitas leva o botão da navegação. */
export default function Topbar({ title, narrow, onMenu, menuRef, navOpen }) {
  const { state, act, notify } = useStore();
  const live = state?.system === 'running'; // só destaca o botão enquanto algo está em execução (o botão continua sempre habilitado)
  const stop = () => act(async () => { const r = await api.post('/api/execution/stop'); notify(r.detail); });
  return (
    <header className="topbar">
      {narrow && <button type="button" ref={menuRef} className="icon-btn nav-toggle" onClick={onMenu} aria-label="Abrir navegação" aria-haspopup="dialog" aria-expanded={!!navOpen} aria-controls="nav-drawer"><Icon name="menu" /></button>}
      <h1 className="topbar-title">{title}</h1>
      <span className="grow" />
      <Btn kind={live ? 'danger live' : 'danger'} onClick={stop} aria-label="Interromper execução" title="Solicita interrupção segura da execução atual"><Icon name="stop" size={13} /><span className="txt">Interromper</span></Btn>
    </header>
  );
}
