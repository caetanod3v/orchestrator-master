import React, { useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';

/**
 * Controle do Maestro Autônomo (Configurações > Orquestração). Desligado, toda tarefa que o maestro quer enviar espera a sua aprovação; ligado, é entregue na hora, com limite por minuto.
 * O servidor volta a desligar o modo quando reinicia. A confirmação ao ligar é a mesma de sempre (o Enter enviado junto também responde perguntas do terminal de destino).
 */
export default function MaestroControls() {
  const { maestro, setMaestro, notify } = useStore();
  const [busy, setBusy] = useState(false);
  if (!maestro) return <p className="dim small">Lendo o estado do Maestro…</p>;
  const toggle = async (e) => {
    const on = e.target.checked;
    const aviso = ['Ligar o maestro autônomo?', '', `As tarefas que o maestro enviar serão digitadas nos outros terminais SEM pedir a sua aprovação (até ${maestro.autoPerMinute} por minuto). O Enter enviado junto também confirma qualquer pergunta que o terminal de destino esteja mostrando (ex.: um pedido de permissão). Cada agente age com as suas permissões. O modo volta a desligado quando o servidor reinicia.`].join(String.fromCharCode(10));
    if (on && !window.confirm(aviso)) return;
    setBusy(true);
    try { setMaestro(await api.post('/api/maestro/autonomy', { enabled: on })); } catch (err) { notify(err.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="oc-row">
        <div className="oc-row-t"><b>Maestro autônomo</b><span className="dim small">Desligado: toda tarefa do maestro espera a sua aprovação. Ligado: é entregue na hora, com limite de {maestro.autoPerMinute} por minuto. Volta a desligado quando o servidor reinicia.</span></div>
        <div className="oc-row-c">
          <label className="oc-switch"><input type="checkbox" role="switch" checked={maestro.autonomous} disabled={busy} onChange={toggle} /><span className="oc-switch-track" aria-hidden="true"><i /></span><span className="sr">Maestro autônomo</span></label>
        </div>
      </div>
      {maestro.autonomous && <p className="oc-note err mp-warn" role="status">Ligado: tarefas são entregues sem aprovação. O Enter enviado junto também confirma qualquer pergunta do terminal de destino.</p>}
      <p className="dim small oc-lead">As tarefas, as aprovações pendentes e a linha do tempo do Maestro ficam no botão “Maestro” da barra de terminais.</p>
    </>
  );
}
