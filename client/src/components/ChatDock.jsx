import React, { useState } from 'react';
import { ChatView } from '../pages/Chat.jsx';
import { Glyph, Icon } from './ui.jsx';

const KEY = 'cockpit-chat';
const read = () => { try { return localStorage.getItem(KEY) === 'open'; } catch { return false; } };
const TONE = { queued: 'idle', awaiting_approval: 'awaiting', blocked: 'awaiting', running: 'active' };

/** Painel inferior do Cockpit: a mesma conversa da página Conversa (um único ChatView), recolhível. Recolhido, é um campo de entrada que convida a escrever; aberto, ocupa uma faixa e o foco vai para o campo. */
export default function ChatDock() {
  const [open, setOpen] = useState(read);
  const [phase, setPhase] = useState(null);
  const toggle = () => setOpen((o) => { try { localStorage.setItem(KEY, o ? 'closed' : 'open'); } catch { /* sem armazenamento */ } return !o; });
  return (
    <section className={`chat-dock${open ? ' open' : ''}`} aria-label="Conversa com o orquestrador">
      <button type="button" className="dock-bar" aria-expanded={open} aria-controls="chat-dock-body" onClick={toggle}>
        <span className="dock-ico" aria-hidden="true"><Icon name="chat" size={18} /></span>
        <span className="ttl">{open ? 'Conversa' : 'Descreva o que quer construir'}</span>
        {phase
          ? <span className={`status s-${phase.tone}`}><Glyph kind={TONE[phase.tone] || 'idle'} />{phase.label}</span>
          : !open && <span className="hint">Nada é executado sem a sua aprovação.</span>}
        <span className="grow" />
        <span className="tog"><span className="txt">{open ? 'Recolher' : 'Abrir'}</span><Icon name={open ? 'chevronDown' : 'chevronUp'} size={16} /></span>
      </button>
      <div id="chat-dock-body" className="dock-body" hidden={!open}><ChatView embedded visible={open} onPhase={setPhase} /></div>
    </section>
  );
}
