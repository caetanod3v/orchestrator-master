import React, { useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { Panel, Btn, Empty } from '../components/ui.jsx';

function GitInfo({ id }) {
  const [info, setInfo] = useState(null);
  const load = async () => setInfo(await api.get(`/api/workspaces/${id}/git`).catch((e) => ({ error: e.message })));
  if (!info) return <Btn onClick={load}>Ver Git</Btn>;
  if (info.error) return <span className="s-failed">{info.error}</span>;
  if (!info.isRepo) return <span className="dim">não é repositório Git</span>;
  return <span className="mono small">{info.branch} · {info.dirty ? `${info.changeCount} alterações` : 'limpo'}</span>;
}

export default function Workspaces() {
  const { workspaces, state, act } = useStore();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [check, setCheck] = useState(null);

  const validate = async () => setCheck(await api.post('/api/workspaces/validate', { path }));
  const add = async (e) => {
    e.preventDefault();
    const ok = await act(() => api.post('/api/workspaces', { path, name }));
    if (ok) { setPath(''); setName(''); setCheck(null); }
  };
  const activeId = state?.activeWorkspace?.id;

  return (
    <div className="two">
      <Panel title="Cadastrar repositório autorizado">
        <form onSubmit={add} className="form">
          <label>Caminho absoluto<input value={path} onChange={(e) => { setPath(e.target.value); setCheck(null); }} placeholder="C:\projetos\meu-repo" required /></label>
          <label>Nome (opcional)<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
          {check && (check.ok
            ? <div className="s-completed small">✓ Diretório válido · {check.hasGit ? 'Git' : 'sem Git'} · {check.hasPackageJson ? 'package.json' : 'sem package.json'}</div>
            : <div className="s-failed small">✕ {check.error}</div>)}
          <div className="actions"><Btn type="button" onClick={validate}>Validar</Btn><Btn kind="primary" type="submit">Cadastrar</Btn></div>
        </form>
        <p className="dim small">Cadastrar apenas autoriza o caminho. O orquestrador não altera arquivos nem executa comandos nele nesta fase.</p>
      </Panel>
      <Panel title={`Workspaces (${workspaces.length})`}>
        {workspaces.length === 0 && <Empty>Nenhum workspace cadastrado.</Empty>}
        <table className="tbl">
          <tbody>
            {workspaces.map((w) => (
              <tr key={w.id} className={w.id === activeId ? 'sel' : ''}>
                <td><div>{w.name} {w.id === activeId && <b className="s-completed small">● ativo</b>}</div><div className="mono dim small">{w.path}</div><GitInfo id={w.id} /></td>
                <td><div className="actions nomargin">
                  <Btn disabled={w.id === activeId} onClick={() => act(() => api.post(`/api/workspaces/${w.id}/activate`))}>Ativar</Btn>
                  <Btn onClick={() => confirm('Remover do cadastro? Os arquivos não são alterados.') && act(() => api.del(`/api/workspaces/${w.id}`))}>Remover</Btn>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
