import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { Panel, Btn, Empty } from '../components/ui.jsx';

const EXAMPLE = 'Quero criar uma landing page para uma barbearia, com agendamento pelo WhatsApp e visual moderno.';

// Onde a conversa está (chat.phase, calculado no servidor). A cor reaproveita as classes de estado existentes.
const PHASE = {
  discussing: ['queued', 'Conversando sobre o objetivo'], clarifying: ['awaiting_approval', 'Preciso de uma informação sua'], proposal: ['awaiting_approval', 'Plano aguardando sua aprovação'],
  new_goal: ['blocked', 'Novo objetivo em discussão'], approving: ['running', 'Aprovação em andamento'],
};

/** O que o sistema entendeu até agora: o que você confirmou fica separado do que ele está só supondo e do que ainda falta saber. */
function Brief({ b }) {
  if (!b) return null;
  const List = ({ title, items, cls }) => (items.length > 0 ? <div className="small"><div className={`k ${cls || ''}`}>{title}</div><ul className="plain">{items.map((x) => <li key={x}>{x}</li>)}</ul></div> : null);
  return (
    <Panel title="O que entendi" right={<span className="dim small">objetivo {b.goalNo}</span>}>
      <p><b>{b.goal}</b></p>
      <List title="falta saber" items={b.open} cls="s-awaiting_approval" />
      <List title="você confirmou" items={b.confirmed} />
      <List title="estou assumindo (diga se estiver errado)" items={b.assumptions} />
    </Panel>
  );
}

/** Plano preparado em linguagem corrente: etapas e dependências só para leitura (o usuário aprova ou pede ajustes por mensagem; não edita a estrutura). */
function Proposal({ p, chat, stale, rounds, setRounds, busy, onApprove, onDiscard }) {
  const steps = p.steps || [];
  const title = (id) => steps.find((s) => s.id === id)?.title || id;
  const need = Math.max(chat.maxIterations, steps.length);
  const value = rounds ?? Math.min(chat.hardMax, need);
  return (
    <Panel title="Plano preparado" right={<span className="dim small">ainda não executado</span>}>
      {stale && <p className="s-blocked small">⚠ Este plano é do objetivo anterior{p.context?.goal ? ` ("${p.context.goal}")` : ''}; agora a conversa é sobre "{chat.brief.goal}". Aprovar executa ESTE plano; para preparar o novo, continue a conversa.</p>}
      <p><b>{p.title}</b></p>
      <p>{p.objective}</p>
      {p.revision > 1 && <p className="small"><b>Revisão {p.revision}</b>{p.changes ? `: ${p.changes}` : ''}. Esta versão precisa ser aprovada de novo.</p>}
      {p.context?.assumptions?.length > 0 && <div className="small"><div className="k">suposições deste plano (você não confirmou)</div><ul className="plain">{p.context.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></div>}
      {steps.length > 0 ? (
        <ol className="plain">
          {steps.map((s) => (
            <li key={s.id}>
              <b>{s.title}</b>{s.dependsOn.length > 0 && <span className="dim small"> · depois de: {s.dependsOn.map(title).join(', ')}</span>}
              <details className="small"><summary className="dim">detalhes</summary>
                <p>{s.instructions}</p>
                <ul className="plain">{s.acceptance.map((a) => <li key={a}>{a}</li>)}</ul>
              </details>
            </li>
          ))}
        </ol>
      ) : <p className="dim small">O ciclo decidirá as tarefas uma rodada por vez, com o Planner, depois da aprovação (o modo de plano em etapas, ORCH_CYCLE_PLAN, está desligado no servidor).</p>}
      <div className="form">
        <label>Limite de rodadas (1 a {chat.hardMax}){steps.length > 0 && ` · o plano tem ${steps.length} etapas, uma por rodada`}
          <input type="number" min={1} max={chat.hardMax} value={value} onChange={(e) => setRounds(Number(e.target.value))} />
        </label>
        <p className="dim small">Aprovar cria uma missão nova e inicia o ciclo. O Executor só lê e edita arquivos no espaço de trabalho, e cada etapa passa pelas verificações reais configuradas. Para mudar algo, descreva o ajuste na conversa: um novo plano substitui este.</p>
        <div className="actions">
          <Btn kind="primary" disabled={busy} onClick={() => onApprove(value)}>▶ Aprovar e executar</Btn>
          <Btn disabled={busy} onClick={onDiscard}>Descartar plano</Btn>
        </div>
      </div>
    </Panel>
  );
}

export default function Chat() {
  const { notify, selectMission, refresh, state } = useStore();
  const [chat, setChat] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [text, setText] = useState('');
  const [working, setWorking] = useState(null); // 'send' | 'approve' | 'other' enquanto uma chamada está em curso
  const [rounds, setRounds] = useState(null);
  const end = useRef(null);

  const load = async () => { try { setChat(await api.get('/api/chat')); setLoadError(null); } catch (e) { setLoadError(e.message); } };
  useEffect(() => { load(); }, []);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [chat?.messages.length, working]);

  const run = async (kind, fn) => {
    setWorking(kind);
    try { return await fn(); } catch (e) { notify(e.message, 'error'); await load(); return null; } finally { setWorking(null); }
  };
  const send = async (e) => {
    e?.preventDefault();
    if (!text.trim() || working) return;
    const r = await run('send', () => api.post('/api/chat/message', { text }));
    if (r) { setChat(r); setText(''); setRounds(null); } // em caso de erro o texto continua na caixa para tentar de novo
  };
  const approve = async (maxIterations) => {
    const r = await run('approve', () => api.post('/api/chat/approve', { proposalId: chat.proposal.id, maxIterations }));
    if (!r) return;
    selectMission(r.missionId); await refresh(); notify('Missão criada e ciclo iniciado.');
    location.hash = '#/missions';
  };
  const discard = async () => { const r = await run('other', () => api.post('/api/chat/discard', { proposalId: chat.proposal.id })); if (r) setChat(r); };
  const reset = async () => {
    if (chat.messages.length > 2 && !confirm('Começar uma nova conversa? O histórico desta conversa será apagado (missões já criadas não são afetadas).')) return;
    const r = await run('other', () => api.post('/api/chat/reset')); if (r) { setChat(r); setRounds(null); }
  };

  if (loadError) return <Empty>Não foi possível carregar a conversa: {loadError}</Empty>;
  if (!chat) return <Empty>Carregando…</Empty>;
  const p = chat.proposal?.status === 'proposed' ? chat.proposal : null;
  const persistDown = state?.persistence?.ok === false;
  const blocked = !!chat.workspaceProblem || persistDown;
  const unavailable = chat.workspaceProblem || (persistDown ? 'O banco não está gravando em disco: a conversa fica indisponível até a gravação voltar.' : null);

  return (
    <div className="two split">
      <div className="col">
        <Panel title="Conversa" right={<Btn onClick={reset} disabled={!!working || chat.messages.length === 0}>Nova conversa</Btn>}>
          {PHASE[chat.phase] && <p><span className={`status s-${PHASE[chat.phase][0]}`}><i />{PHASE[chat.phase][1]}</span></p>}
          <div className="chat-log" role="log" aria-live="polite" aria-label="Mensagens da conversa">
            {chat.messages.length === 0 && (
              <Empty>
                Descreva o que você quer construir, em linguagem livre. Eu pergunto o que faltar e preparo um plano para você aprovar; nada é executado sem sua aprovação.
                <div className="gap" /><Btn onClick={() => setText(EXAMPLE)} disabled={blocked}>Usar um exemplo</Btn>
              </Empty>
            )}
            {chat.messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                <span className="who">{m.role === 'user' ? 'Você' : 'Assistente'}{m.kind === 'clarify' ? ' · precisa de mais informações' : ''}</span>
                {m.text}
                {m.questions?.length > 0 && <ul>{m.questions.map((q) => <li key={q}>{q}</li>)}</ul>}
              </div>
            ))}
            {working === 'send' && <div className="msg assistant dim" role="status">{p ? 'Atualizando o plano com o que você disse…' : chat.brief ? 'Considerando o que já combinamos…' : 'Interpretando o pedido…'}</div>}
            <div ref={end} />
          </div>
          {unavailable && <p className="s-blocked small">⚠ {unavailable} {chat.workspaceProblem && <a href="#/workspaces">Espaços de trabalho →</a>}</p>}
          <form onSubmit={send} className="form">
            <label>Sua mensagem
              <textarea rows={3} value={text} maxLength={2000} disabled={blocked || !!working} placeholder={EXAMPLE}
                onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e); }} />
            </label>
            <div className="row">
              <span className="dim small">{chat.workspace ? `Espaço de trabalho: ${chat.workspace.name} · ` : ''}Ctrl+Enter envia · conversar não executa nada</span>
              <Btn kind="primary" type="submit" disabled={blocked || !!working || !text.trim()}>{working === 'send' ? 'Enviando…' : 'Enviar'}</Btn>
            </div>
          </form>
        </Panel>
      </div>
      <div className="col">
        <Brief b={chat.brief} />
        {chat.brief && <div className="gap" />}
        {p
          ? <Proposal p={p} chat={chat} stale={chat.phase === 'new_goal'} rounds={rounds} setRounds={setRounds} busy={!!working || blocked} onApprove={approve} onDiscard={discard} />
          : <Panel title="Plano preparado"><Empty>Nenhum plano ainda. Quando você descrever um trabalho e eu tiver informação suficiente, o plano aparece aqui para você aprovar.</Empty></Panel>}
      </div>
    </div>
  );
}
