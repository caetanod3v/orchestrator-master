import React from 'react';
import { useStore } from '../store.jsx';
import { DemoTag } from './ui.jsx';
import { DASH, fmtTokens, fmtCost, hasTotals, stateOf, totalRows, missionRows, limitView } from '../usage-view.js';

const COLS = [['input', 'Entrada'], ['output', 'Saída'], ['cacheCreation', 'Cache criação'], ['cacheRead', 'Cache leitura']];

function State({ t }) {
  const s = stateOf(t);
  return <span className={`tok-state ${s.kind}`} title={s.kind === 'provisional' ? 'Parcial: ainda sem o resultado final da CLI' : s.kind === 'mixed' ? 'Parte dos dados ainda é provisória' : undefined}>{s.label}</span>;
}

function UsageTable({ rows }) {
  return (
    <table className="tok">
      <thead>
        <tr>
          <th scope="col" />
          {COLS.map(([k, label]) => <th scope="col" key={k}>{label}</th>)}
          <th scope="col" title="Estimativa calculada pela CLI; não representa necessariamente a cobrança real">Custo est.</th>
          <th scope="col">Dados</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <th scope="row">{r.label}</th>
            {COLS.map(([k]) => <td key={k}>{fmtTokens(r.t?.[k])}</td>)}
            <td>{fmtCost(r.t?.costUsd)}</td>
            <td><State t={r.t} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Painel do Cockpit: consumo REPORTADO pela CLI do Claude Code. Agregados vêm de /api/state.usage (o servidor deriva tudo; nada é somado aqui). */
export default function TokenMonitor() {
  const { state, missions } = useStore();
  const usage = state?.usage;
  const limit = limitView(usage?.rateLimit);

  return (
    <div className="tokmon">
      <p className="dim small">Consumo reportado pela CLI do Claude Code. Não é saldo nem limite da assinatura, e o custo é uma estimativa.</p>

      {!hasTotals(usage) ? (
        <div className="empty small">
          {usage && typeof usage.costUsd === 'number'
            ? `Custo acumulado reportado: ${fmtCost(usage.costUsd)} em ${usage.runs} execução(ões). Tokens ainda não disponíveis neste servidor.`
            : 'Nenhum consumo de tokens reportado ainda.'}
        </div>
      ) : <>
        <UsageTable rows={totalRows(usage)} />
        <p className="dim small">“{DASH}” = a CLI não reportou o valor. As somas incluem só o que foi reportado. Entradas provisórias são parciais e são substituídas pelo total final da execução.</p>

        <div className="k sec">por missão</div>
        {missionRows(usage, missions).length === 0 ? <div className="dim small">Sem dados por missão.</div> : missionRows(usage, missions).map((m) => (
          <details className="tok-mission" key={m.id}>
            <summary>
              <span className="grow t">{m.title}{m.demo && <DemoTag />}</span>
              <span className="dim">ent {fmtTokens(m.total.input)} · saí {fmtTokens(m.total.output)}</span>
              <State t={m.total} />
            </summary>
            <UsageTable rows={[
              { id: 'total', label: 'Total', t: m.total },
              { id: 'planner', label: 'Planner', t: m.byAgent?.planner },
              { id: 'executor', label: 'Executor', t: m.byAgent?.executor },
            ]} />
          </details>
        ))}
      </>}

      <div className="k sec">limite da assinatura</div>
      <div className="row small"><span className="dim">limite oficial</span><span className="val">{DASH}</span></div>
      <div className="row small"><span className="dim">tokens restantes</span><span className="val">{DASH}</span></div>
      <p className="dim small">A CLI não informa limite nem saldo; nenhum valor é estimado aqui.</p>
      {limit && <>
        <div className="k sec">indicador de limite da CLI</div>
        <div className="row small"><span className="dim">status</span><span className={`val tok-limit ${limit.kind}`}>{limit.status}</span></div>
        <div className="row small"><span className="dim">utilização (valor informado)</span><span className="val">{limit.utilization}</span></div>
        <div className="row small"><span className="dim">renova em</span><span className="val">{limit.resetsAt}</span></div>
        <div className="row small"><span className="dim">visto em</span><span className="val">{limit.agent}</span></div>
        <p className="dim small">Aviso emitido pela CLI; separado do consumo e sem relação direta com os totais acima.</p>
      </>}
    </div>
  );
}
