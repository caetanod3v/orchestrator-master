import React, { useEffect, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Topbar from './components/Topbar.jsx';
import Cockpit from './pages/Cockpit.jsx';
import Missions from './pages/Missions.jsx';
import Agents from './pages/Agents.jsx';
import Workspaces from './pages/Workspaces.jsx';
import Activity from './pages/Activity.jsx';
import Settings from './pages/Settings.jsx';
import { useStore } from './store.jsx';

const PAGES = { cockpit: Cockpit, missions: Missions, agents: Agents, workspaces: Workspaces, activity: Activity, settings: Settings };
// Título e frase de apoio de cada página interna (o Cockpit é tela cheia e não tem cabeçalho). Mantenha os títulos iguais aos rótulos da navegação.
const HEAD = {
  missions: ['Missões', 'Crie missões, acompanhe o ciclo autônomo e gerencie as tarefas.'],
  agents: ['Agentes', 'Conheça os papéis do Planner e do Executor e como trabalham em conjunto.'],
  workspaces: ['Espaços de trabalho', 'Repositórios autorizados e verificações reais aprovadas por você.'],
  activity: ['Atividade', 'Registro de eventos do sistema, do mais recente ao mais antigo.'],
  settings: ['Configurações', 'Preferências locais e limites de segurança do orquestrador.'],
};
const current = () => { const p = location.hash.replace('#/', '').split('?')[0]; return p in PAGES ? p : 'cockpit'; };

export default function App() {
  const [page, setPage] = useState(current());
  const { error, toast } = useStore();
  useEffect(() => {
    const on = () => setPage(current());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const Page = PAGES[page];
  return (
    <div className="app">
      <Sidebar page={page} />
      <div className="main">
        <Topbar />
        {error && <div className="banner err" role="alert">{error}</div>}
        {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}</div>}
        {page === 'cockpit'
          ? <div className="content full"><Page /></div>
          : (
            <div className="content">
              <div className={`page${page === 'activity' ? ' wide' : ''}`}>
                <header className="page-head"><h1>{HEAD[page][0]}</h1><p>{HEAD[page][1]}</p></header>
                <Page />
              </div>
            </div>
          )}
      </div>
    </div>
  );
}
