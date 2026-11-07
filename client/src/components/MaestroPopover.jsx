import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { Btn } from './ui.jsx';
import { maestroSummary, timelineRows, collapsedLine, TASK_LABEL } from '../maestro-view.js';

/**
 * Painel contextual do Maestro, na barra de terminais: um botão compacto (LED + contadores) que abre um painel recolhível com as decisões pendentes, a linha do tempo e o modo autônomo.
 * Aprovações NUNCA ficam escondidas: o botão ganha o contador âmbar e o painel abre sozinho quando chega uma tarefa nova que espera você (uma vez por tarefa). O modo autônomo ligado
 * fica sempre sinalizado no próprio botão. As configurações (ligar/desligar o autônomo) ficam em Configurações > Orquestração.
 */
export default function MaestroPopover({ onOpenSettings }) {
  const { maestro, setMaestro, notify } = useStore();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [tl, setTl] = useState(false);
  const box = useRef(null), seen = useRef(null);
  const tasks = maestro?.tasks ?? [];
  const pending = tasks.filter((t) => t.status === 'pending'), sum = maestroSummary(tasks), rows = useMemo(() => timelineRows(tasks, 20), [tasks]);

  // abre sozinho quando surge uma tarefa pendente que ainda não foi mostrada (a 1ª leitura só registra as já existentes)
  useEffect(() => {
    const ids = new Set(pending.map((t) => t.id));
    if (seen.current === null) { seen.current = ids; return; }
    if ([...ids].some((id) => !seen.current.has(id))) setOpen(true);
    seen.current = new Set([...seen.current, ...ids]);
  }, [pending.map((t) => t.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  if (!maestro) return null;
  const run = async (fn) => { setBusy(true); try { setMaestro(await fn()); } catch (e) { notify(e.message, 'error'); } finally { setBusy(false); } };
  const tone = sum.failed ? 'err' : pending.length ? 'warn' : maestro.autonomous ? 'auto' : 'idle';
  return (
    <div className="mpo" ref={box}>
      <button type="button" className={`mpo-btn tone-${tone}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true" aria-controls="mpo-panel"
        title={`Maestro: ${collapsedLine(tasks, maestro.autonomous)}${maestro.autonomous ? ' · autônomo ligado' : ''}`}>
        <i className="mpo-led" aria-hidden="true" /><span>Maestro</span>
        {pending.length > 0 && <b className="mpo-n warn" aria-label={`${pending.length} aguardando você`}>{pending.length}</b>}
        {sum.failed > 0 && <b className="mpo-n err" aria-label={`${sum.failed} com falha`}>{sum.failed}</b>}
        {maestro.autonomous && <span className="mpo-auto" title="Maestro autônomo ligado: tarefas são entregues sem aprovação"><span className="tbx-l">autônomo</span><span className="tbx-s" aria-hidden="true">auto</span></span>}
      </button>
      {open && (
        <section id="mpo-panel" className="mpo-panel" aria-label="Maestro">
          <header className="mpo-h"><b>Maestro</b><span className="dim small">{collapsedLine(tasks, maestro.autonomous)}</span>
            <Btn kind="quiet" onClick={() => { setOpen(false); onOpenSettings?.('orquestracao'); }} title="Ligar ou desligar o modo autônomo">Configurar</Btn>
          </header>
          <p className={`small mpo-mode${maestro.autonomous ? ' on' : ' dim'}`} role="status">{maestro.autonomous ? 'Modo autônomo ligado: as tarefas são entregues sem aprovação.' : 'Modo autônomo desligado: cada tarefa espera a sua aprovação.'}</p>
          {pending.length > 0 && <ul className="mp-list" aria-label="Tarefas aguardando aprovação">{pending.map((t) => (
            <li key={t.id} className="mp-item" title="Confira o terminal de destino antes de aprovar: o Enter enviado com a tarefa também confirma qualquer pergunta que ele esteja mostrando.">
              <div className="mp-txt"><b>Para {t.toTitle}</b>{t.note && <span className="dim small"> · {t.note}</span>}<div className="mp-task">{t.text}</div></div>
              <div className="mp-act"><Btn kind="primary" disabled={busy} onClick={() => run(() => api.post(`/api/maestro/tasks/${t.id}/approve`))}>Aprovar e enviar</Btn><Btn disabled={busy} onClick={() => run(() => api.post(`/api/maestro/tasks/${t.id}/reject`))}>Recusar</Btn></div>
            </li>))}</ul>}
          <button type="button" className="mpo-fold" onClick={() => setTl(!tl)} aria-expanded={tl} aria-controls="mpo-tl">{tl ? '▾' : '▸'} Linha do tempo <span className="dim">{rows.length}</span></button>
          {tl && <ol id="mpo-tl" className="mp-tl" aria-label="Linha do tempo do Maestro">
            {rows.length === 0 ? <li className="dim small">Nenhum evento ainda.</li> : rows.map((r) => (
              <li key={r.id} className={r.status === 'failed' ? 'bad' : ''} title={r.text}><time className="mono dim">{r.at ? new Date(r.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--:--'}</time><span className={`mp-st mp-st-${r.status}`}>{TASK_LABEL[r.status] || r.status}</span><b>{r.toTitle}</b><span className="mp-clip">{r.text}</span></li>))}
          </ol>}
        </section>
      )}
    </div>
  );
}
