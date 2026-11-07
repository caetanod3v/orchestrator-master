import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { orderSessions } from '../layout-state.js';
import { historyRows, resumeBody, needsConfigAck, restoreSummary, restorePlan, batchSummary } from '../session-history.js';
import Dialog from './Dialog.jsx';
import ConversationHistory from './ConversationHistory.jsx';
import { Btn, Icon, fmtTime } from './ui.jsx';

function Row({ r, busy, locked, onResume }) {
  const why = r.resumable ? null : (r.blockedMessage || 'Esta sessão não pode ser retomada agora.');
  return (
    <li className={`sh-row${r.restore ? ' restore' : ''}`} style={{ '--role': r.color || 'var(--brand)' }}>
      <div className="sh-main">
        <div className="sh-t"><i className="sh-dot" aria-hidden="true" /><b>{r.title || 'Sem título'}</b><span className="sh-role">{r.roleLabel}</span>{r.forked && <span className="oc-pill" title="Esta sessão nasceu de um fork">fork</span>}</div>
        <div className="sh-sub dim small">
          <span className={`oc-pill${r.state === 'running' ? ' ok' : ''}`}>{r.stateLabel}</span>
          {r.reasonLabel && <span>{r.reasonLabel}</span>}
          {r.usesWorktree && <span>worktree próprio</span>}
          {r.resumes > 0 && <span>{r.resumes === 1 ? 'retomada 1 vez' : `retomada ${r.resumes} vezes`}</span>}
          {(r.endedAt || r.startedAt) && <span title={r.endedAt ? 'Encerrada em' : 'Aberta em'}>{fmtTime(r.endedAt || r.startedAt)}</span>}
        </div>
        {why && <div className="sh-why small" role="note">{why}</div>}
      </div>
      <div className="sh-act">
        <Btn kind="primary" disabled={!r.resumable || locked} onClick={() => onResume(r, false)} title={r.resumable ? 'Reabre a MESMA sessão do Claude Code (o histórico da conversa é restaurado)' : why}>{busy === r.id ? 'Abrindo…' : 'Retomar'}</Btn>
        <Btn kind="quiet" disabled={!r.resumable || locked} onClick={() => onResume(r, true)} title={r.resumable ? 'Abre uma CÓPIA da sessão em outro terminal; a original fica intacta' : why}>Fork</Btn>
      </div>
    </li>
  );
}

/** Histórico de sessões do workspace ativo: lista o que o servidor registrou e reabre sessões interrompidas ou encerradas (retomada normal ou fork). Nada é decidido aqui: o servidor refaz todas as checagens. */
export default function SessionHistory({ ws, topicId, where, order = [], autoRestore = true, onAutoRestore, onClose }) {
  const { topics, notify, loadTerminals, terminals } = useStore();
  const [tab, setTab] = useState('sessoes'); // sessoes | conversas
  const [progress, setProgress] = useState(null); // { i, n } durante a restauração em lote
  const [list, setList] = useState(null), [err, setErr] = useState(null), [busy, setBusy] = useState(null), [onlyTopic, setOnlyTopic] = useState(false);
  const lock = useRef(false); // trava síncrona: dois cliques seguidos nunca abrem duas sessões
  const load = useCallback(async () => {
    try { const d = await api.get('/api/terminals/history'); setList(Array.isArray(d?.sessions) ? d.sessions : []); setErr(null); } catch (e) { setErr(e.message || 'Não foi possível ler o histórico.'); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const rows = useMemo(() => historyRows({ history: list, workspaceId: ws.id, topics, topicId, onlyTopic }), [list, ws.id, topics, topicId, onlyTopic]);
  const summary = restoreSummary(rows);

  const resume = async (r, fork) => {
    if (lock.current) return;
    lock.current = true; setBusy(r.id);
    try {
      let ack = false, res;
      for (;;) {
        try { res = await api.post('/api/terminals/resume', resumeBody({ recordId: r.id, fork, ack })); break; } catch (e) {
          // configuração executável do projeto não revisada: o servidor só abre com a confirmação explícita (uma pergunta; nunca automática)
          if (!ack && needsConfigAck(e) && window.confirm(`${e.message}\n\n${fork ? 'Abrir o fork' : 'Retomar a sessão'} mesmo assim?`)) { ack = true; continue; }
          throw e;
        }
      }
      notify(`${fork ? 'Fork aberto' : 'Sessão retomada'}: ${res?.session?.title ?? r.title} (${where}). O Claude Code leva alguns segundos para iniciar.`);
    } catch (e) { notify(e.message || 'Não foi possível retomar a sessão.', 'error'); } finally { lock.current = false; setBusy(null); await load(); loadTerminals(); }
  };

  /** Retoma, uma a uma e em ordem, as sessões que estavam abertas (as visíveis neste filtro; nunca fork). Uma só confirmação para configuração não revisada, limite de terminais respeitado e falhas reunidas no relatório final. */
  const restoreAll = async () => {
    if (lock.current) return;
    const live = (terminals?.sessions ?? []).filter((s) => s.status === 'running').length;
    const plan = restorePlan(orderSessions(rows.restore, order, (r) => r.id), (terminals?.maxSessions ?? 10) - live) // na ordem em que estavam na grade;
    if (!plan.open.length) { notify(plan.skipped.length ? 'Não há vaga para restaurar: feche algum terminal antes (limite de terminais).' : 'Nenhuma sessão para restaurar.', 'error'); return; }
    const extra = plan.skipped.length ? `\n\n${plan.skipped.length} não cabe(m) no limite de terminais e ficará(ão) de fora.` : '';
    if (!window.confirm(`Restaurar ${plan.open.length} ${plan.open.length === 1 ? 'sessão' : 'sessões'} em ${ws.displayName || ws.name}? Cada uma reabre a mesma sessão do Claude Code (o histórico da conversa é restaurado).${extra}`)) return;
    lock.current = true;
    const results = []; let ack = false, declined = false, stopped = false;
    try {
      for (const [i, r] of plan.open.entries()) {
        if (stopped) break;
        setProgress({ i: i + 1, n: plan.open.length }); setBusy(r.id);
        for (;;) {
          try { await api.post('/api/terminals/resume', resumeBody({ recordId: r.id, ack })); results.push({ row: r, ok: true }); break; } catch (e) {
            if (!ack && !declined && needsConfigAck(e)) { if (window.confirm(`${e.message}\n\nRestaurar as sessões mesmo assim?`)) { ack = true; continue; } declined = true; }
            const limit = e?.status === 409 && /Limite de/.test(e.message || '');
            results.push({ row: r, ok: false, error: limit ? 'limite de terminais' : needsConfigAck(e) ? 'configuração do projeto não confirmada' : (e?.message || 'erro') });
            if (limit) stopped = true; // sem vaga: não adianta insistir nas demais
            break;
          }
        }
      }
    } finally {
      lock.current = false; setBusy(null); setProgress(null);
      const sum = batchSummary(results, plan.skipped.length + (plan.open.length - results.length)); notify(sum.text, sum.kind);
      await load(); loadTerminals();
    }
  };

  return (
    <Dialog title={`Histórico · ${ws.displayName || ws.name}`} onClose={onClose} id="sh-dlg" size="lg">
      <div className="sh-body">
      <div className="sh-tabs" role="group" aria-label="Tipo de histórico"><Btn kind={tab === 'sessoes' ? 'primary' : 'quiet'} aria-pressed={tab === 'sessoes'} onClick={() => setTab('sessoes')}>Sessões</Btn><Btn kind={tab === 'conversas' ? 'primary' : 'quiet'} aria-pressed={tab === 'conversas'} onClick={() => setTab('conversas')}>Conversas</Btn></div>
      {onAutoRestore && <label className="sh-auto" title="Ao abrir um workspace sem terminais, reabre sozinho as sessões que estavam abertas quando o app ou o servidor foi encerrado (só as do último encerramento). Vale só neste navegador."><input type="checkbox" role="switch" checked={autoRestore} onChange={(e) => onAutoRestore(e.target.checked)} /> Restaurar sessões automaticamente ao abrir o workspace</label>}
      {tab === 'conversas' ? <ConversationHistory ws={ws} /> : <>
      <div className="sh-bar">
        {topicId && <label className="sh-only"><input type="checkbox" checked={onlyTopic} onChange={(e) => setOnlyTopic(e.target.checked)} /> Só o tópico ativo ({where})</label>}
        <span className="grow" />
        <Btn kind="quiet" onClick={load} title="Reler o histórico"><Icon name="restore" size={14} /> Atualizar</Btn>
      </div>
      {err && <div className="banner err" role="alert">{err}</div>}
      {list === null && !err && <p className="dim" role="status">Carregando…</p>}
      {list !== null && summary && <p className="sh-sum" role="status"><Icon name="alertCircle" size={14} /> {summary}.</p>}
      {list !== null && !rows.restore.length && !rows.others.length && <p className="dim">Nenhuma sessão registrada {onlyTopic ? 'neste tópico' : 'neste workspace'} ainda.</p>}
      {rows.restore.length > 0 && <section aria-label="Sessões que estavam abertas"><div className="sh-h"><h3 className="oc-h">Estavam abertas</h3><Btn kind="primary" disabled={busy !== null} onClick={restoreAll} title="Retoma todas as sessões desta lista, uma a uma (nunca faz fork)">{progress ? `Restaurando ${progress.i} de ${progress.n}…` : `Restaurar todas (${rows.restore.length})`}</Btn></div><ul className="sh-list">{rows.restore.map((r) => <Row key={r.id} r={r} busy={busy} locked={busy !== null} onResume={resume} />)}</ul></section>}
      {rows.others.length > 0 && <section aria-label="Outras sessões"><h3 className="oc-h">{rows.restore.length ? 'Outras sessões' : 'Sessões'}</h3><ul className="sh-list">{rows.others.map((r) => <Row key={r.id} r={r} busy={busy} locked={busy !== null} onResume={resume} />)}</ul></section>}
      </>}
      </div>
    </Dialog>
  );
}
