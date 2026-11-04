import React, { useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { friendlyNames } from '../env-view.js';
import Dialog from './Dialog.jsx';
import { Btn, Icon } from './ui.jsx';

/** Abrir um workspace já cadastrado ou cadastrar um novo (caminho de uma pasta). Usa as mesmas rotas de sempre; nada é executado ao cadastrar. */
export default function WorkspaceDialog({ onClose }) {
  const { workspaces, state, act, notify } = useStore();
  const [path, setPath] = useState(''), [name, setName] = useState(''), [check, setCheck] = useState(null), [busy, setBusy] = useState(false);
  const names = friendlyNames(workspaces), activeId = state?.activeWorkspace?.id;

  const open = async (w) => { await act(() => api.post(`/api/workspaces/${w.id}/activate`)); onClose(); };
  const validate = async () => { try { setCheck(await api.post('/api/workspaces/validate', { path })); } catch (e) { setCheck({ ok: false, error: e.message }); } };
  const add = async (e) => {
    e.preventDefault(); setBusy(true);
    try {
      const ws = await api.post('/api/workspaces', { path, name });
      await api.post(`/api/workspaces/${ws.id}/activate`); // um workspace recém-cadastrado já abre o ambiente dele
      notify(`Ambiente "${ws.name}" aberto.`); onClose();
    } catch (err) { notify(err.message, 'error'); setCheck({ ok: false, error: err.message }); } finally { setBusy(false); }
    await act(async () => null);
  };

  return (
    <Dialog title="Abrir ou adicionar workspace" onClose={onClose} id="ws-dlg">
      {workspaces.length > 0 && (
        <section aria-label="Workspaces cadastrados">
          <h3 className="oc-h">Cadastrados</h3>
          <ul className="oc-wslist">
            {workspaces.map((w) => (
              <li key={w.id}>
                <button type="button" className={`oc-wsrow${w.id === activeId ? ' on' : ''}`} onClick={() => open(w)} title={w.path}>
                  <Icon name="workspace" size={16} />
                  <span className="oc-wsrow-t"><b>{names.get(w.id)}</b><span className="mono dim small">{w.path}</span></span>
                  {w.id === activeId ? <span className="oc-pill ok">aberto</span> : <span className="oc-pill">abrir</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Adicionar workspace">
        <h3 className="oc-h">Adicionar</h3>
        <form onSubmit={add} className="oc-form">
          <label>Caminho da pasta do projeto
            <input className="mono" data-autofocus={workspaces.length === 0 ? '' : undefined} value={path} onChange={(e) => { setPath(e.target.value); setCheck(null); }} placeholder="C:\projetos\meu-repo" required />
          </label>
          <label>Nome (opcional)
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="como aparece na barra lateral" />
          </label>
          {check && (check.ok
            ? <p className="oc-note ok" role="status">Pasta válida · {check.hasGit ? 'repositório Git' : 'sem Git (o isolamento por worktree não estará disponível)'}</p>
            : <p className="oc-note err" role="alert">{check.error}</p>)}
          <div className="oc-actions"><Btn type="button" onClick={validate} disabled={!path.trim()}>Validar</Btn><Btn kind="primary" type="submit" disabled={busy || !path.trim()}>Adicionar e abrir</Btn></div>
        </form>
        <p className="dim small">Os terminais deste ambiente abrem nessa pasta. Cadastrar não executa nada.</p>
      </section>
    </Dialog>
  );
}
