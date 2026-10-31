import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { Btn, Empty, Icon } from '../components/ui.jsx';

const EXAMPLE = 'Quero criar uma landing page para uma barbearia, com agendamento pelo WhatsApp e visual moderno.';
const MAX_COMPOSER_PX = 200; // o campo cresce com o texto até esta altura; depois rola por dentro

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// Onde a conversa está (chat.phase, calculado no servidor). A cor reaproveita as classes de estado existentes.
const PHASE = {
  discussing: ['queued', 'Conversando sobre o objetivo'], clarifying: ['awaiting_approval', 'Preciso de uma informação sua'], proposal: ['awaiting_approval', 'Plano aguardando sua aprovação'],
  new_goal: ['blocked', 'Novo objetivo em discussão'], approving: ['running', 'Aprovação em andamento'],
};

/** O que o sistema entendeu até agora: o que você confirmou fica separado do que ele está só supondo e do que ainda falta saber. Aberto enquanto falta informação. */
function Brief({ b }) {
  if (!b) return null;
  const List = ({ title, items, cls }) => (items.length > 0 ? <div className="small"><div className={`k ${cls || ''}`}>{title}</div><ul className="plain">{items.map((x) => <li key={x}>{x}</li>)}</ul></div> : null);
  return (
    <details className="brief" open={b.open.length > 0}>
      <summary><span className="k">O que entendi</span> · <b>{b.goal}</b> <span className="dim small">objetivo {b.goalNo}</span></summary>
      <List title="falta saber" items={b.open} cls="s-awaiting_approval" />
      <List title="você confirmou" items={b.confirmed} />
      <List title="estou assumindo (diga se estiver errado)" items={b.assumptions} />
    </details>
  );
}

/** Plano preparado: cartão com a linha do tempo de etapas. O que cada etapa exige (aprovação ou bloqueio) vem da prévia calculada pelo servidor; aprovar o plano NÃO aprova as etapas sensíveis. */
function Proposal({ p, chat, stale, rounds, setRounds, busy, onApprove, onDiscard }) {
  const steps = p.steps || [];
  const title = (id) => steps.find((s) => s.id === id)?.title || id;
  const pol = (id) => p.policy?.find((x) => x.stepId === id);
  const need = Math.max(chat.maxIterations, steps.length);
  const value = rounds ?? Math.min(chat.hardMax, need);
  return (
    <section className="plan" aria-label="Plano preparado">
      <div className="plan-head">
        <span className="plan-kicker"><Icon name="gate" size={14} /> Plano preparado</span>
        <span className="chip warn">Aguardando a sua aprovação</span>
        <span className="dim small">ainda não executado</span>
      </div>
      {stale && <p className="s-blocked small">⚠ Este plano é do objetivo anterior{p.context?.goal ? ` ("${p.context.goal}")` : ''}; agora a conversa é sobre "{chat.brief.goal}". Aprovar executa ESTE plano; para preparar o novo, continue a conversa.</p>}
      <h4 className="plan-title">{p.title}</h4>
      <p>{p.objective}</p>
      {p.revision > 1 && <p className="small"><b>Revisão {p.revision}</b>{p.changes ? `: ${p.changes}` : ''}. Esta versão precisa ser aprovada de novo.</p>}
      {p.context?.assumptions?.length > 0 && <div className="small"><div className="k">suposições deste plano (você não confirmou)</div><ul className="plain">{p.context.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></div>}
      {steps.length > 0 ? (
        <ol className="plan-steps">
          {steps.map((s, i) => {
            const pl = pol(s.id);
            return (
              <li key={s.id} className={pl?.decision === 'approval_required' ? 'step-warn' : pl?.decision === 'deny' ? 'step-bad' : ''}>
                <span className="step-n">{i + 1}</span>
                <div className="step-main">
                  <b>{s.title}</b>{s.dependsOn.length > 0 && <span className="dim small"> · depois de: {s.dependsOn.map(title).join(', ')}</span>}
                  {pl?.decision === 'approval_required' && <div><span className="chip warn"><Icon name="gate" size={12} /> exigirá a sua aprovação antes de executar</span><p className="step-why">{pl.why.join(' ')}</p></div>}
                  {pl?.decision === 'deny' && <div><span className="chip bad"><Icon name="alert" size={12} /> será bloqueada pela política</span><p className="step-why">{pl.why.join(' ')}</p></div>}
                  <details className="small"><summary className="dim">detalhes</summary>
                    <p>{s.instructions}</p>
                    <ul className="plain">{s.acceptance.map((a) => <li key={a}>{a}</li>)}</ul>
                  </details>
                </div>
              </li>
            );
          })}
        </ol>
      ) : <p className="dim small">O ciclo decidirá as tarefas uma rodada por vez, com o Planner, depois da aprovação (o modo de plano em etapas, ORCH_CYCLE_PLAN, está desligado no servidor).</p>}
      <div className="form plan-actions">
        <label>Limite de rodadas (1 a {chat.hardMax}){steps.length > 0 && ` · o plano tem ${steps.length} etapas, uma por rodada`}
          <input type="number" min={1} max={chat.hardMax} value={value} onChange={(e) => setRounds(Number(e.target.value))} />
        </label>
        <p className="dim small">Aprovar cria uma missão nova e inicia o ciclo. O Executor só lê e edita arquivos no espaço de trabalho, e cada etapa passa pelas verificações reais configuradas. Etapas marcadas como sensíveis ainda pedem a sua aprovação separada na hora de executar. Para mudar algo, descreva o ajuste na conversa: um novo plano substitui este.</p>
        <div className="actions">
          <Btn kind="primary" disabled={busy} onClick={() => onApprove(value)}><Icon name="check" size={15} /> Aprovar e executar</Btn>
          <Btn disabled={busy} onClick={onDiscard}>Descartar plano</Btn>
        </div>
      </div>
    </section>
  );
}

/** Toda a conversa (estado, envio, esclarecimentos, planos, aprovação). Usada pela página Conversa e embutida no Cockpit (`embedded`); a lógica e as chamadas ao backend existem só aqui.
 *  `visible`: falso enquanto o painel do Cockpit está recolhido (o estado continua montado e carregado). `onPhase`: informa o estado da conversa ao painel. */
export function ChatView({ embedded = false, visible = true, onPhase = null }) {
  const { notify, selectMission, refresh, state } = useStore();
  const [chat, setChat] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [text, setText] = useState('');
  const [working, setWorking] = useState(null); // 'send' | 'approve' | 'other' enquanto uma chamada está em curso
  const [rounds, setRounds] = useState(null);
  const scroller = useRef(null), box = useRef(null), picker = useRef(null);
  const [files, setFiles] = useState([]); // só seleção LOCAL (nome e tamanho): nada é lido nem enviado ao Planner

  const status0 = PHASE[chat?.phase];
  useEffect(() => { onPhase?.(status0 ? { label: status0[1], tone: status0[0] } : null); }, [chat?.phase]);
  const load = async () => { try { setChat(await api.get('/api/chat')); setLoadError(null); } catch (e) { setLoadError(e.message); } };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const el = scroller.current; if (!el) return;
    const plan = el.querySelector('.plan');
    // com um plano na tela, alinha o início dele (o botão de aprovar vem depois de ler); sem plano, vai para a última mensagem
    if (plan && !working) el.scrollTop += plan.getBoundingClientRect().top - el.getBoundingClientRect().top - 12; else el.scrollTop = el.scrollHeight;
  }, [chat?.messages.length, chat?.proposal?.id, working, visible]);
  // o campo cresce moderadamente com o texto (até MAX_COMPOSER_PX) e volta a uma linha ao esvaziar
  useLayoutEffect(() => { const el = box.current; if (!el || !visible) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_PX)}px`; }, [text, chat === null, visible]);

  const run = async (kind, fn) => {
    setWorking(kind);
    try { return await fn(); } catch (e) { notify(e.message, 'error'); await load(); return null; } finally { setWorking(null); }
  };
  const send = async (e) => {
    e?.preventDefault();
    if (!text.trim() || working) return;
    const r = await run('send', () => api.post('/api/chat/message', { text }));
    if (r) { // em caso de erro o texto (e a seleção de arquivos) continua na caixa para tentar de novo
      setChat(r); setText(''); setRounds(null);
      if (files.length) { notify('Mensagem enviada sem os arquivos selecionados: anexos ainda não são enviados ao Planner.'); setFiles([]); }
    }
  };
  const approve = async (maxIterations) => {
    const r = await run('approve', () => api.post('/api/chat/approve', { proposalId: chat.proposal.id, maxIterations }));
    if (!r) return;
    selectMission(r.missionId); await refresh(); notify('Missão criada e ciclo iniciado.');
    location.hash = '#/missions';
  };
  const pick = (e) => {
    const added = [...(e.target.files || [])].map((f) => ({ key: `${f.name}:${f.size}:${f.lastModified}`, name: f.name, size: f.size }));
    e.target.value = ''; // permite escolher o mesmo arquivo de novo depois de removê-lo
    setFiles((old) => [...old, ...added.filter((a) => !old.some((o) => o.key === a.key))].slice(0, 10));
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

  const empty = chat.messages.length === 0 && !p;
  const status = PHASE[chat.phase];
  return (
    <div className={`chat-page${embedded ? ' embedded' : ''}`}>
      {!embedded && <h1 className="sr">Conversa</h1>}
      <div className="chat-top">
        {status && !embedded ? <span className={`status s-${status[0]}`}><i />{status[1]}</span> : <span />}
        <Btn onClick={reset} disabled={!!working || chat.messages.length === 0}>Nova conversa</Btn>
      </div>
      <div className="chat-scroll" ref={scroller} role="log" aria-live="polite" aria-label="Mensagens da conversa">
        <div className={`chat-col${empty ? ' is-empty' : ''}`}>
          {empty && (
            <div className="chat-hello">
              <h2>O que vamos construir?</h2>
              <p className="dim">Descreva em linguagem livre. Eu pergunto o que faltar e preparo um plano para você aprovar; nada é executado sem a sua aprovação.</p>
              <Btn onClick={() => { setText(EXAMPLE); box.current?.focus(); }} disabled={blocked}>Usar um exemplo</Btn>
            </div>
          )}
          {chat.messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.role === 'assistant' && <span className="avatar" aria-hidden="true"><Icon name="cockpit" size={15} /></span>}
              <div className="msg-body">
                <span className={m.kind === 'clarify' ? 'who' : 'sr'}>{m.role === 'user' ? 'Você' : 'Assistente'}{m.kind === 'clarify' ? ' · preciso de mais informações' : ''}</span>
                {m.text}
                {m.questions?.length > 0 && <ul>{m.questions.map((q) => <li key={q}>{q}</li>)}</ul>}
              </div>
            </div>
          ))}
          {working === 'send' && <div className="msg assistant" role="status"><span className="avatar" aria-hidden="true"><Icon name="cockpit" size={15} /></span><div className="msg-body dim">{p ? 'Atualizando o plano com o que você disse…' : chat.brief ? 'Considerando o que já combinamos…' : 'Interpretando o pedido…'}<span className="typing" aria-hidden="true"><i /><i /><i /></span></div></div>}
          <Brief b={chat.brief} />
          {p && <Proposal p={p} chat={chat} stale={chat.phase === 'new_goal'} rounds={rounds} setRounds={setRounds} busy={!!working || blocked} onApprove={approve} onDiscard={discard} />}
        </div>
      </div>
      <form className="composer-wrap" onSubmit={send}>
        <div className="composer-col">
          {unavailable && <p className="s-blocked small">⚠ {unavailable} {chat.workspaceProblem && <a href="#/workspaces">Espaços de trabalho →</a>}</p>}
          {files.length > 0 && (
            <div className="chips" aria-label="Arquivos selecionados">
              {files.map((f) => (
                <span className="chip" key={f.key} title={`${f.name} (${fmtSize(f.size)})`}>
                  <span className="chip-name">{f.name}</span><span className="dim">{fmtSize(f.size)}</span>
                  <button type="button" className="chip-x" aria-label={`Remover ${f.name}`} onClick={() => setFiles((old) => old.filter((o) => o.key !== f.key))}><Icon name="close" size={12} /></button>
                </span>
              ))}
              <span className="dim small">Seleção local: os arquivos ainda não são enviados ao Planner.</span>
            </div>
          )}
          <div className="composer">
            <input ref={picker} type="file" multiple hidden onChange={pick} tabIndex={-1} />
            <button type="button" className="icon-btn" aria-label="Selecionar arquivos (ainda não são enviados ao Planner)" title="Selecionar arquivos (ainda não são enviados ao Planner)" disabled={blocked || !!working} onClick={() => picker.current?.click()}><Icon name="plus" /></button>
            <textarea ref={box} rows={1} value={text} maxLength={2000} disabled={blocked || !!working} aria-label="Sua mensagem" placeholder="Escreva o que você quer construir…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
            <button type="submit" className="icon-btn send" aria-label={working === 'send' ? 'Enviando' : 'Enviar mensagem'} title="Enviar (Enter)" disabled={blocked || !!working || !text.trim()}><Icon name="send" /></button>
          </div>
          <p className="dim small composer-hint">{chat.workspace ? `Espaço de trabalho: ${chat.workspace.name} · ` : ''}Enter envia · Shift+Enter quebra a linha · conversar não executa nada</p>
        </div>
      </form>
    </div>
  );
}

export default function Chat() {
  return <ChatView />;
}
