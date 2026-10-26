import React, { useState } from 'react';
import { useStore } from '../store.jsx';
import { Panel, Empty, fmtTime, typeLabel } from '../components/ui.jsx';

const TYPES = ['all', 'mission', 'cycle', 'task', 'execution', 'approval', 'rejection', 'workspace', 'settings', 'system'];

export default function Activity() {
  const { activity } = useStore();
  const [f, setF] = useState('all');
  const rows = activity.filter((a) => f === 'all' || a.type === f);
  return (
    <Panel title={`Atividade (${rows.length})`} right={
      <select value={f} onChange={(e) => setF(e.target.value)} aria-label="Filtrar atividade por tipo">{TYPES.map((t) => <option key={t} value={t}>{t === 'all' ? 'todos' : typeLabel(t)}</option>)}</select>
    }>
      {rows.length === 0 && <Empty>Nenhum evento registrado ainda. Eventos reais aparecem aqui conforme você usa o sistema.</Empty>}
      <table className="tbl mono small">
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}><td className="dim">{fmtTime(a.at)}</td><td><span className={`type t-${a.type}`}>{typeLabel(a.type)}</span></td><td>{a.message}</td></tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
