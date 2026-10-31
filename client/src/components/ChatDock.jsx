import React, { useState } from 'react';
import { ChatView } from '../pages/Chat.jsx';
import { Icon } from './ui.jsx';

const KEY = 'cockpit-chat';
const read = () => { try { return localStorage.getItem(KEY) === 'open'; } catch { return false; } };

/** Painel inferior do Cockpit: a mesma conversa da página Conversa (um único ChatView), recolhível. Recolhido, ocupa só uma barra e não cobre o Neural Core. */
export default function ChatDock() {
  const [open, setOpen] = useState(read);
  const [phase, setPhase] = useState(null);
  const toggle = () => setOpen((o) => { try { localStorage.setItem(KEY, o ? 'closed' : 'open'); } catch { /* sem armazenamento */ } return !o; });
  return (
    <section className={`chat-dock${open ? ' open' : ''}`} aria-label="Conversa com o orquestrador">
      <button type="button" className="dock-bar" aria-expanded={open} aria-controls="chat-dock-body" onClick={toggle}>
        <span className="dock-ico" aria-hidden="true"><Icon name="cockpit" size={16} /></span>
        <span className="ttl">Conversa com o orquestrador</span>
        {phase && <span className={`status s-${phase.tone}`}><i />{phase.label}</span>}
        <span className="grow" />
        <span className="tog"><span className="txt">{open ? 'Recolher' : 'Expandir'}</span><Icon name={open ? 'chevronDown' : 'chevronUp'} size={16} /></span>
      </button>
      <div id="chat-dock-body" className="dock-body" hidden={!open}><ChatView embedded visible={open} onPhase={setPhase} /></div>
    </section>
  );
}
