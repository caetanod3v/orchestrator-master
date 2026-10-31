import React, { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Topbar from './components/Topbar.jsx';
import Cockpit from './pages/Cockpit.jsx';
import Chat from './pages/Chat.jsx';
import Missions from './pages/Missions.jsx';
import Agents from './pages/Agents.jsx';
import Workspaces from './pages/Workspaces.jsx';
import Activity from './pages/Activity.jsx';
import Settings from './pages/Settings.jsx';
import { useStore } from './store.jsx';
import { Icon, PersistenceNote } from './components/ui.jsx';

const PAGES = { chat: Chat, cockpit: Cockpit, missions: Missions, agents: Agents, workspaces: Workspaces, activity: Activity, settings: Settings };
// Título (igual ao rótulo da navegação) e frase de apoio de cada página. O Cockpit e a Conversa ocupam a folha inteira e não têm frase de apoio.
const HEAD = {
  cockpit: ['Cockpit', null],
  chat: ['Conversa', null],
  missions: ['Missões', 'Crie missões, acompanhe o ciclo autônomo e gerencie as tarefas.'],
  agents: ['Agentes', 'Os papéis do Planner e do Executor e como trabalham em conjunto.'],
  workspaces: ['Espaços de trabalho', 'Repositórios autorizados e verificações reais aprovadas por você.'],
  activity: ['Atividade', 'Registro de eventos do sistema, do mais recente ao mais antigo.'],
  settings: ['Configurações', 'Preferências locais e limites de segurança do orquestrador.'],
};
const current = () => { const p = location.hash.replace('#/', '').split('?')[0]; return p in PAGES ? p : 'cockpit'; };
const NARROW = '(max-width: 900px)';

/** `matchMedia` reativo: a navegação é um trilho em telas largas e uma gaveta modal nas estreitas. */
function useNarrow() {
  const [v, setV] = useState(() => !!window.matchMedia?.(NARROW).matches);
  useEffect(() => {
    const m = window.matchMedia?.(NARROW); if (!m) return undefined;
    const on = () => setV(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return v;
}

export default function App() {
  const [page, setPage] = useState(current());
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('side') === 'collapsed'; } catch { return false; } });
  const narrow = useNarrow();
  const menuRef = useRef(null);
  const { error, toast, state } = useStore();
  useEffect(() => {
    const on = () => { setPage(current()); setNavOpen(false); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => { if (!narrow) setNavOpen(false); }, [narrow]);
  const closeNav = useCallback(() => { setNavOpen(false); setTimeout(() => menuRef.current?.focus(), 0); }, []);
  const toggleSide = () => setCollapsed((c) => { try { localStorage.setItem('side', c ? 'open' : 'collapsed'); } catch { /* sem armazenamento */ } return !c; });
  const Page = PAGES[page];
  const [title, lead] = HEAD[page];
  const full = page === 'cockpit' || page === 'chat';
  return (
    <div className="app">
      <button type="button" className="skip" onClick={() => document.getElementById('main')?.focus()}>Pular para o conteúdo</button>
      {!narrow && <Sidebar page={page} collapsed={collapsed} onToggle={toggleSide} />}
      {narrow && navOpen && <><div className="nav-scrim" onClick={closeNav} aria-hidden="true" /><Sidebar page={page} modal onClose={closeNav} /></>}
      <div className="sheet">
        <Topbar title={title} narrow={narrow} onMenu={() => setNavOpen(true)} menuRef={menuRef} navOpen={navOpen} />
        {error && <div className="banner err" role="alert">{error}</div>}
        {state?.persistence && !state.persistence.ok && (
          <div className="banner err" role="alert">
            O banco não está sendo gravado em disco (erro {state.persistence.error}): o estado só existe em memória. Novos ciclos, retomadas e execuções são recusados ou bloqueados até a gravação voltar. <PersistenceNote incident={state.persistenceIncident} />
          </div>
        )}
        {full
          ? <main id="main" tabIndex={-1} key={page} className={`content full scene ${page === 'chat' ? 'chatpage' : 'cockpitpage'}`}><Page /></main>
          : (
            <main id="main" tabIndex={-1} key={page} className="content scene">
              <div className={`page${page === 'activity' ? ' wide' : ''}`}>
                <p className="page-lead">{lead}</p>
                <Page />
              </div>
            </main>
          )}
      </div>
      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          <span className="toast-ico"><Icon name={toast.kind === 'error' ? 'xCircle' : 'checkCircle'} size={20} /></span>
          <span className="toast-text">{toast.text}</span>
        </div>
      )}
    </div>
  );
}
