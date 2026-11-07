import React, { useState } from 'react';
import { useStore } from '../store.jsx';
import { Icon, fmtTime, typeLabel } from './ui.jsx';

const TYPES = ['all', 'mission', 'cycle', 'task', 'execution', 'approval', 'rejection', 'workspace', 'settings', 'system'];
const KEY = 'forge.activityOpen';
const read = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

/**
 * Histórico de atividades (eventos reais de /api/activity), fechado por padrão: só uma faixa de uma linha com o último evento.
 * Expande sob demanda para investigar uma execução e não ocupa espaço dos terminais enquanto fechado.
 */
export default function ActivityDrawer() {
  const { activity } = useStore();
  const [open, setOpen] = useState(read);
  const [f, setF] = useState('all');
  const flip = () => { const n = !open; setOpen(n); try { localStorage.setItem(KEY, n ? '1' : '0'); } catch { /* sem armazenamento: vale só nesta sessão */ } };
  const rows = (activity ?? []).filter((a) => f === 'all' || a.type === f);
  const last = activity?.[0];
  return (
    <section className={`ad${open ? ' open' : ''}`} aria-label="Atividade">
      <div className="ad-bar">
        <button type="button" className="ad-fold" onClick={flip} aria-expanded={open} aria-controls="ad-body"><Icon name={open ? 'chevronDown' : 'chevronUp'} size={14} /><b>Atividade</b><span className="dim small">{activity?.length ?? 0}</span></button>
        {!open && last && <span className="ad-last dim small" title={last.message}><time className="mono">{new Date(last.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</time> {last.message}</span>}
        {open && <select className="oc-sel ad-sel" value={f} onChange={(e) => setF(e.target.value)} aria-label="Filtrar atividade por tipo">{TYPES.map((t) => <option key={t} value={t}>{t === 'all' ? 'todos' : typeLabel(t)}</option>)}</select>}
      </div>
      {open && <div id="ad-body" className="ad-body">
        {rows.length === 0 ? <p className="dim small">Nenhum evento registrado ainda.</p> : <table className="mono small"><tbody>
          {rows.map((a) => <tr key={a.id}><td className="dim">{fmtTime(a.at)}</td><td><span className={`type t-${a.type}`}>{typeLabel(a.type)}</span></td><td>{a.message}</td></tr>)}
        </tbody></table>}
      </div>}
    </section>
  );
}
