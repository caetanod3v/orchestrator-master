import React, { useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../store.jsx';
import { Btn, DemoTag, Glyph, Icon, Status, fmtTime } from './ui.jsx';
import { summarizeTask, classifyLogLine, logToText, logOmitted } from '../op-state.js';

const REPORT_LINES = 4;
const FILES_SHOWN = 8;

/** Texto longo resumido por linhas, com o conteúdo completo a um clique (nada é cortado nos dados). */
function Clamp({ text, lines = REPORT_LINES, label }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 240 || text.split('\n').length > lines;
  return (
    <div className="clamp">
      <p className={`clamp-text${open || !long ? '' : ' cut'}`} style={{ '--lines': lines }}>{text}</p>
      {long && <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Mostrar menos' : `Mostrar ${label} completo`}</button>}
    </div>
  );
}

/** Logs completos da tarefa: fonte monoespaçada, erros e avisos marcados pelo prefixo da própria linha, altura limitada com rolagem própria e cópia do conteúdo exato. */
function LogViewer({ task }) {
  const { notify } = useStore();
  const lines = task.log || [];
  const omitted = logOmitted(task);
  const [open, setOpen] = useState(() => ['running', 'failed', 'interrupted'].includes(task.status));
  const box = useRef(null), stick = useRef(true);
  const first = Math.max(0, (task.logTotal || lines.length) - lines.length);
  const width = String((task.logTotal || lines.length) || 1).length;
  useLayoutEffect(() => { const el = box.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [lines.length, open]);
  const onScroll = () => { const el = box.current; stick.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 24; };
  const copy = async () => {
    const text = logToText(lines);
    try { await navigator.clipboard.writeText(text); notify(`Log copiado (${lines.length} ${lines.length === 1 ? 'linha' : 'linhas'}).`); return; } catch { /* tenta o caminho antigo */ }
    try {
      const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove();
      notify(ok ? `Log copiado (${lines.length} linhas).` : 'Não foi possível copiar o log.', ok ? 'info' : 'error');
    } catch { notify('Não foi possível copiar o log.', 'error'); }
  };
  const err = lines.filter((l) => classifyLogLine(l) === 'error').length, warn = lines.filter((l) => classifyLogLine(l) === 'warn').length;
  return (
    <section className="logs" aria-label="Logs completos">
      <div className="logs-bar">
        <button type="button" className="logs-toggle" aria-expanded={open} aria-controls={`log-${task.id}`} onClick={() => setOpen((o) => !o)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} /><span>Logs completos</span>
          <span className="dim small">{lines.length} {lines.length === 1 ? 'linha' : 'linhas'}{err > 0 && ` · ${err} ${err === 1 ? 'erro' : 'erros'}`}{warn > 0 && ` · ${warn} ${warn === 1 ? 'aviso' : 'avisos'}`}</span>
        </button>
        <Btn kind="quiet sm" onClick={copy} disabled={!lines.length} aria-label="Copiar o log completo"><Icon name="copy" size={14} /> Copiar</Btn>
      </div>
      {open && (
        <>
          {omitted > 0 && <p className="dim small logs-note">Mostrando as últimas {lines.length} de {task.logTotal} linhas; as anteriores não estão disponíveis nesta tela.</p>}
          <div id={`log-${task.id}`} className="log" ref={box} onScroll={onScroll} role="log" tabIndex={0} aria-label="Saída registrada da tarefa">
            {lines.length === 0
              ? <span className="dim">{task.startedAt ? 'A execução não registrou saída.' : 'Sem saída: nenhum processo foi executado para esta tarefa.'}</span>
              : lines.map((l, i) => <div key={first + i} className={`ll ll-${classifyLogLine(l)}`}><span className="ln">{String(first + i + 1).padStart(width, '0')}</span><span className="lt">{l}</span></div>)}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Inspetor de uma tarefa. Ordem fixa: 1) resumo do estado, 2) resultado e alterações, 3) próxima ação ou decisão pendente, 4) detalhes técnicos, 5) logs completos.
 * Todo texto sai de summarizeTask (só dados do servidor); as ações chamam as mesmas rotas de sempre e o servidor revalida tudo.
 */
export default function TaskInspector({ mission, task, actions, busy, onClose, onLocate }) {
  const s = summarizeTask(task, { mission, busy });
  const st = task.status;
  const retry = ['failed', 'interrupted'].includes(st) && !task.rejected;
  const canRun = st === 'queued' && task.authorized && !task.blockedReason;
  const demo = !!mission.demo;
  const files = s.changes?.files ?? [];
  return (
    <div className="ti">
      <div className="blk-top">
        <h3 className="blk-h">{task.title}{demo && <DemoTag />}</h3>
        <div className="ti-tools">
          <Btn kind="quiet sm" onClick={onLocate} aria-label="Mostrar a tarefa no canvas"><Icon name="target" size={14} /> No canvas</Btn>
          <Btn kind="quiet sm" onClick={onClose} aria-label="Fechar tarefa (Esc)">Fechar <kbd>Esc</kbd></Btn>
        </div>
      </div>

      <section className="ti-sec" aria-label="Resumo do estado">
        <Status value={st} label={s.label} />
        <p className="ti-head">{s.headline}</p>
        {s.outcome?.kind === 'error' && (
          <div className="ti-note err" role="note">
            <b>{st === 'interrupted' ? 'Motivo registrado' : 'Erro registrado'}</b>
            <span>{s.outcome.text}{s.outcome.exitCode != null && !s.outcome.text.includes(String(s.outcome.exitCode)) && <span className="mono"> (código de saída {s.outcome.exitCode})</span>}</span>
            {s.outcome.note && <span>{s.outcome.note}</span>}
          </div>
        )}
        {s.verification && (
          <p className={`ti-ver ver-${s.verification.level}`}>
            <Glyph kind={s.verification.level === 'verified' ? 'done' : s.verification.level === 'failed' ? 'error' : 'idle'} />
            <span>{s.verification.text}{s.verification.basis && <span className="dim"> Base: {s.verification.basis}.</span>}</span>
          </p>
        )}
        {s.verification?.reasons?.length > 0 && <ul className="plain small dim">{s.verification.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      </section>

      <section className="ti-sec" aria-label="Resultado e alterações">
        <h4 className="ti-h">Resultado e alterações</h4>
        {s.report ? <Clamp text={s.report} label="relatório" /> : <p className="dim small">{s.reportMissing ? 'A execução não produziu um relatório.' : 'Sem relatório: a tarefa ainda não foi executada.'}</p>}
        <p className="small ti-ch">{s.changes.text}</p>
        {s.changes.note && <p className="small dim">{s.changes.note}</p>}
        {files.length > 0 && (
          <ul className="files">
            {files.slice(0, FILES_SHOWN).map((f) => (
              <li key={f.path}>
                <span className="mono grow">{f.path}{f.preexisting && <span className="dim"> (já alterado antes)</span>}</span>
                {f.added != null ? <><span className="add">+{f.added}</span> <span className="rem">−{f.removed}</span></> : <span className="dim small">{f.status === '??' ? 'novo' : f.status}</span>}
              </li>
            ))}
            {files.length > FILES_SHOWN && <li className="dim small">e mais {files.length - FILES_SHOWN} {files.length - FILES_SHOWN === 1 ? 'arquivo' : 'arquivos'} (veja os detalhes técnicos)</li>}
          </ul>
        )}
      </section>

      <section className={`ti-sec ti-next${st === 'awaiting_approval' ? ' pending' : ''}`} aria-label="Próxima ação">
        <h4 className="ti-h">{st === 'awaiting_approval' ? 'Decisão pendente' : 'Próxima ação'}</h4>
        <p className="small">{s.next.text}</p>
        <div className="actions">
          {(st === 'queued' || retry) && !task.authorized && !demo && <Btn kind="primary" onClick={actions.authorize}><Icon name="check" size={15} /> {retry ? 'Autorizar nova tentativa' : 'Autorizar execução'}</Btn>}
          {st === 'queued' && task.authorized && <Btn kind="primary" disabled={!canRun || busy} onClick={actions.run}><Icon name="play" size={14} /> Executar</Btn>}
          {st === 'queued' && task.authorized && <Btn onClick={actions.revoke}>Revogar autorização</Btn>}
          {st === 'running' && <Btn kind="danger" onClick={actions.stop}><Icon name="stop" size={13} /> Interromper execução</Btn>}
          {st === 'awaiting_approval' && <><Btn kind="primary" onClick={actions.approve}><Icon name="check" size={15} /> Aprovar resultado</Btn><Btn kind="danger" onClick={actions.reject}><Icon name="close" size={14} /> Rejeitar</Btn></>}
        </div>
        {demo && <p className="dim small">Missão demonstrativa: decisões alteram só o estado fictício local; não há execução real.</p>}
      </section>

      <details className="ti-tech">
        <summary>Detalhes técnicos</summary>
        <div className="ti-tech-body">
          {s.details.map((d) => <div className="kv" key={d.k}><span>{d.k}</span><span className={d.mono ? 'mono' : undefined}>{d.at ? fmtTime(d.at) : d.v}</span></div>)}
          {files.length > FILES_SHOWN && files.slice(FILES_SHOWN).map((f) => <div className="kv" key={f.path}><span>Arquivo</span><span className="mono">{f.path}</span></div>)}
        </div>
      </details>

      <LogViewer key={task.id} task={task} />
    </div>
  );
}
