import React from 'react';
import { supervisionView } from '../supervision-view.js';
import { Status } from './ui.jsx';

/** Histórico de supervisão do ciclo (cycle.supervision): cada decisão do supervisor, o motivo e o orçamento usado. Só leitura; quem executa é sempre o ciclo. */
export default function SupervisionLog({ entries }) {
  const rows = supervisionView(entries);
  if (!rows.length) return null;
  return (
    <div className="small" data-testid="supervision">
      <div className="k">supervisão · {rows.length} {rows.length === 1 ? 'decisão' : 'decisões'}</div>
      <ul className="plain">
        {rows.map((e) => (
          <li key={e.key} data-testid="supervision-entry">
            <span className="n">{e.round !== null ? String(e.round).padStart(2, '0') : '—'}</span> <Status value={e.status} label={e.actionLabel} />
            {e.observationLabel && <span className="dim"> · {e.observationLabel}{e.uncertain && ' (estado real desconhecido)'}</span>}
            {e.step && <span className="dim"> · etapa {e.step}</span>}
            <div className="dim">↳ {e.reason}</div>
            {e.trendLabel && <div className="dim" data-testid="supervision-trend">tendência: {e.trendLabel}</div>}
            {e.appliedLabel && <div className="dim" data-testid="supervision-applied">o que aconteceu com a recomendação: {e.appliedLabel}</div>}
            {(e.signature || e.budget) && <div className="dim">{e.signature && `assinatura da falha ${e.signature}`}{e.signature && e.budget && ' · '}{e.budget}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
