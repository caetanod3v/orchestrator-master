import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { createDeliveryLoader, deliveryKey, deliveryView, orchestrationNote } from '../delivery-view.js';
import { Btn, Icon, Status } from './ui.jsx';

const IDLE = { missionId: null, key: null, status: 'idle', report: null, error: null };

/**
 * Carrega o relatório da missão e o recarrega SÓ quando a chave de entrega muda (início, retomada, nova rodada, conclusão, aceitação…). O estado vem de
 * createDeliveryLoader (puro, testado): resposta atrasada de outra missão é descartada e a mesma chave não é pedida duas vezes.
 */
function useDelivery(mission) {
  const [st, setSt] = useState(IDLE);
  const loader = useRef(null);
  if (!loader.current) loader.current = createDeliveryLoader({ fetchReport: (id) => api.get(`/api/missions/${encodeURIComponent(id)}/delivery`), onChange: setSt });
  const id = mission?.id ?? null, key = deliveryKey(mission);
  useEffect(() => { loader.current.load(id, key); }, [id, key]);
  useEffect(() => () => loader.current.dispose(), []);
  const reload = () => loader.current.load(id, key, { force: true });
  // durante a troca de missão (um render antes de o carregador reagir) nunca mostra o relatório de outra missão
  return { st: st.missionId === id ? st : { ...IDLE, missionId: id, status: 'loading' }, reload };
}

/** Relatório de entrega da missão (somente leitura), montado pelo servidor só com registros gravados. O que não está nos registros não aparece como sucesso. */
export default function DeliveryReport({ mission }) {
  const { state } = useStore();
  const { st, reload } = useDelivery(mission);
  const v = st.report ? deliveryView(st.report) : null;
  const note = orchestrationNote(state?.orchestration);

  return (
    <div className="small" data-testid="delivery-report">
      <div className="row"><b className="sub">Relatório de entrega</b>{v && <Status value={v.headline.value} label={v.headline.label} />}
        {st.status === 'loading' && <span className="dim"> · atualizando…</span>}
        <Btn onClick={reload} disabled={st.status === 'loading'} title="Reler o relatório no servidor">Atualizar</Btn></div>
      {note && <div className="dim" data-testid="delivery-config">{note}</div>}
      {st.status === 'loading' && !v && <p className="dim" data-testid="delivery-loading">Carregando o relatório de entrega…</p>}
      {st.status === 'error' && <p className="stale err" data-testid="delivery-error"><Icon name="alert" size={14} /> Não foi possível carregar o relatório de entrega: {st.error}. Nada foi presumido; use Atualizar para tentar de novo.</p>}
      {(st.status === 'empty' || (st.status === 'ready' && !v)) && <p className="dim" data-testid="delivery-empty">Sem relatório de entrega disponível para esta missão.</p>}
      {v && <>
        {v.notice && <p className="stale" data-testid="delivery-notice">{v.notice}</p>}
        {v.reasons.map((r, i) => <div key={i} className="dim">↳ {r}</div>)}
        <div data-testid="delivery-assurance"><span className="k">garantia</span> <Status value={v.assurance.value} label={v.assurance.label} />
          {v.assurance.basis && <span className="dim"> · {v.assurance.basis}</span>}
          {v.assurance.reasons.map((r, i) => <div key={i} className="dim">↳ {r}</div>)}</div>
        {v.rounds !== null && <div className="dim">rodadas: {v.rounds}{v.maxIterations !== null && ` de no máximo ${v.maxIterations}`}</div>}
        <div data-testid="delivery-retries" className="dim">{v.retries.text}</div>
        {v.hasSteps && (
          <div data-testid="delivery-steps"><div className="k">etapas</div>
            <ul className="plain">{v.steps.map((s) => (
              <li key={s.id}><span className="n">{s.id}</span> <span className="grow">{s.title}</span> <Status value={s.status} label={s.label} />
                <span className="dim"> · {s.attemptsText}</span>{s.uncertain && <span className="s-interrupted"> · resultado incerto</span>}</li>))}</ul></div>
        )}
        {v.hasLimitations && (
          <div className="stale" data-testid="delivery-limitations"><b>Limitações da garantia</b>
            <ul className="plain">{v.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul></div>
        )}
        {v.evidence.length > 0 && (
          <details data-testid="delivery-evidence"><summary className="dim">evidência do sistema por rodada ({v.evidence.length})</summary>
            {v.evidence.map((e) => (
              <div key={e.round}><span className="n">{String(e.round).padStart(2, '0')}</span> <Status value={e.value} label={e.label} /> <span className="dim">· {e.basis}</span>
                {e.reasons.map((r, i) => <div key={i} className="dim">↳ {r}</div>)}
                {e.expectedFiles.length > 0 && <div className="dim">arquivos esperados: {e.expectedFiles.map((f) => `${f.path}: ${f.ok ? 'ok' : `falhou${f.reason ? ` (${f.reason})` : ''}`}`).join('; ')}</div>}</div>))}
          </details>
        )}
        {(v.verifications.length > 0 || v.missing.length > 0) && (
          <details data-testid="delivery-verifications"><summary className="dim">verificações reais ({v.verifications.length})</summary>
            {v.verifications.map((x, i) => <div key={i} className={x.pass ? 's-completed' : 's-failed'}>rodada {x.round} · {x.script}: <b>{x.label}</b>{x.required && ' · obrigatória'}{x.reason && ` · ${x.reason}`}</div>)}
            {v.missing.map((m, i) => <div key={`m${i}`} className="s-blocked">{m.script}{m.required && ' (obrigatória)'}: {m.reason}</div>)}
          </details>
        )}
      </>}
    </div>
  );
}
