import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { Btn, Icon, fmtTime } from './ui.jsx';

const PAGE = 100;

/** Conversa aberta: só leitura, paginada. O texto vem da cópia própria do servidor (não depende do Claude Code estar rodando). */
function Reader({ wsId, row, onBack, onDeleted }) {
  const { notify } = useStore();
  const [d, setD] = useState(null), [msgs, setMsgs] = useState([]), [err, setErr] = useState(null), [busy, setBusy] = useState(false);
  const paging = useRef(false); // um pedido por vez: dois cliques em "Carregar mais" nunca duplicam as mensagens
  const more = useCallback(async (offset) => {
    if (paging.current) return; paging.current = true;
    try { const r = await api.get(`/api/workspaces/${wsId}/conversations/${row.id}?offset=${offset}&limit=${PAGE}`); setD(r); setMsgs((m) => (offset === 0 ? r.messages : [...m, ...r.messages])); setErr(null); } catch (e) { setErr(e.message || 'Não foi possível ler a conversa.'); } finally { paging.current = false; }
  }, [wsId, row.id]);
  useEffect(() => { more(0); }, [more]);
  const del = async () => {
    if (!window.confirm('Apagar esta conversa do histórico? A cópia é removida; o transcript do Claude Code (se ainda existir) não é tocado.')) return;
    setBusy(true);
    try { await api.del(`/api/workspaces/${wsId}/conversations/${row.id}`); notify('Conversa apagada do histórico.'); onDeleted(); } catch (e) { notify(e.message || 'Não foi possível apagar.', 'error'); setBusy(false); }
  };
  return (
    <div className="conv-reader">
      <div className="sh-bar"><Btn kind="quiet" onClick={onBack}>← Conversas</Btn><span className="grow" /><Btn kind="quiet" disabled={busy} onClick={del}>Apagar</Btn></div>
      <h3 className="oc-h conv-title">{row.aiTitle || row.title || 'Sem título'}</h3>
      {err && <div className="banner err" role="alert">{err}</div>}
      {d === null && !err && <p className="dim" role="status">Carregando…</p>}
      {d?.truncated && <p className="dim small" role="note">Conversa longa: a cópia parou no limite de tamanho; o final não foi guardado.</p>}
      <ol className="conv-msgs" aria-label="Mensagens">{msgs.map((m, i) => <li key={i} className={`conv-msg ${m.r === 'u' ? 'me' : 'ai'}`}><div className="conv-who small dim">{m.r === 'u' ? 'Você' : 'Claude'}{m.at && <> · {fmtTime(m.at)}</>}</div><div className="conv-t">{m.t}</div></li>)}</ol>
      {d && msgs.length < d.total && <Btn kind="quiet" onClick={() => more(msgs.length)}>Carregar mais ({d.total - msgs.length})</Btn>}
    </div>
  );
}

/** Conversas copiadas do workspace (GET /api/workspaces/:id/conversations): independe de tópicos e de haver terminal aberto. */
export default function ConversationHistory({ ws }) {
  const [list, setList] = useState(null), [err, setErr] = useState(null), [q, setQ] = useState(''), [open, setOpen] = useState(null);
  const seq = useRef(0);
  const load = useCallback(async (text) => {
    const n = ++seq.current;
    try { const d = await api.get(`/api/workspaces/${ws.id}/conversations${text ? `?q=${encodeURIComponent(text)}` : ''}`); if (n === seq.current) { setList(Array.isArray(d?.conversations) ? d.conversations : []); setErr(null); } } catch (e) { if (n === seq.current) setErr(e.message || 'Não foi possível ler as conversas.'); }
  }, [ws.id]);
  useEffect(() => { const t = setTimeout(() => load(q), q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  if (open) return <Reader wsId={ws.id} row={open} onBack={() => setOpen(null)} onDeleted={() => { setOpen(null); load(q); }} />;
  return (
    <>
      <div className="sh-bar"><input className="conv-q" type="search" placeholder="Buscar nas conversas…" aria-label="Buscar nas conversas" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} /><span className="grow" /><Btn kind="quiet" onClick={() => load(q)} title="Reler"><Icon name="restore" size={14} /> Atualizar</Btn></div>
      {err && <div className="banner err" role="alert">{err}</div>}
      {list === null && !err && <p className="dim" role="status">Carregando…</p>}
      {list !== null && !list.length && <p className="dim">{q ? 'Nenhuma conversa encontrada.' : 'Nenhuma conversa copiada neste workspace ainda. Elas aparecem depois que uma sessão troca mensagens.'}</p>}
      {list !== null && list.length > 0 && <ul className="sh-list" aria-label="Conversas">{list.map((c) => (
        <li key={c.id}><button type="button" className="conv-row" onClick={() => setOpen(c)}>
          <span className="sh-t"><b>{c.aiTitle || c.title || 'Sem título'}</b>{c.truncated && <span className="oc-pill" title="A cópia parou no limite de tamanho">longa</span>}</span>
          {c.first && <span className="conv-snip dim small">{c.first}</span>}
          <span className="sh-sub dim small"><span>{c.user + c.assistant} mensagens</span>{(c.lastAt || c.updatedAt) && <span>{fmtTime(c.lastAt || c.updatedAt)}</span>}</span>
        </button></li>
      ))}</ul>}
    </>
  );
}
