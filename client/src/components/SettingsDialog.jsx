import React, { useState } from 'react';
import { useStore } from '../store.jsx';
import { usePrefs } from '../hooks.js';
import { FONT_RANGE } from '../prefs.js';
import Dialog from './Dialog.jsx';
import { Btn, Icon } from './ui.jsx';

const SECTIONS = [
  ['perfil', 'Perfil e conta', 'user'],
  ['geral', 'Preferências gerais', 'sliders'],
  ['aparencia', 'Aparência', 'sun'],
  ['cli', 'Claude Code CLI', 'terminal'],
  ['providers', 'Providers', 'layers'],
];

const Row = ({ title, hint, children }) => <div className="oc-row"><div className="oc-row-t"><b>{title}</b>{hint && <span className="dim small">{hint}</span>}</div><div className="oc-row-c">{children}</div></div>;
const Switch = ({ checked, onChange, label }) => (
  <label className="oc-switch"><input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span className="oc-switch-track" aria-hidden="true"><i /></span><span className="sr">{label}</span></label>
);

/** Configurações básicas (engrenagem da sidebar). Só opções que existem de verdade: preferências locais da interface e o estado real do Claude Code. */
export default function SettingsDialog({ onClose, initial = 'perfil' }) {
  const { state, terminals, refresh } = useStore();
  const [prefs, setPref] = usePrefs();
  const [tab, setTab] = useState(initial);
  const [checking, setChecking] = useState(false);
  const roles = terminals?.roles ?? [];
  const ex = state?.executor;
  const recheck = async () => { setChecking(true); try { await refresh(); } finally { setChecking(false); } };
  const onKey = (e) => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const i = SECTIONS.findIndex(([id]) => id === tab), n = SECTIONS[(i + (e.key === 'ArrowDown' ? 1 : -1) + SECTIONS.length) % SECTIONS.length][0];
    e.preventDefault(); setTab(n); document.getElementById(`set-tab-${n}`)?.focus();
  };

  return (
    <Dialog title="Configurações" onClose={onClose} size="lg" id="set-dlg">
      <div className="oc-set">
        <div className="oc-set-nav" role="tablist" aria-orientation="vertical" aria-label="Seções" onKeyDown={onKey}>
          {SECTIONS.map(([id, label, icon]) => (
            <button key={id} id={`set-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls="set-panel" tabIndex={tab === id ? 0 : -1} className="oc-set-tab" onClick={() => setTab(id)}>
              <Icon name={icon} size={16} /><span>{label}</span>
            </button>
          ))}
        </div>
        <div className="oc-set-panel" id="set-panel" role="tabpanel" aria-labelledby={`set-tab-${tab}`} key={tab}>
          {tab === 'perfil' && <>
            <Row title="Nome exibido" hint="Aparece no rodapé da barra lateral.">
              <input value={prefs.name} onChange={(e) => setPref('name', e.target.value)} maxLength={40} placeholder="Seu nome" data-autofocus="" aria-label="Nome exibido" />
            </Row>
            <Row title="Conta" hint="Ainda não existe login nem conta: o Orchestrator roda só neste computador (127.0.0.1) e o nome fica salvo apenas aqui. O login do Claude Code é independente e fica no próprio CLI." />
          </>}

          {tab === 'geral' && <>
            <Row title="Isolar novos terminais em worktree" hint="Cada terminal trabalha numa branch Git própria, sem pisar nos arquivos dos outros. Exige repositório Git.">
              <Switch checked={prefs.isolate} onChange={(v) => setPref('isolate', v)} label="Isolar novos terminais em worktree" />
            </Row>
            <Row title="Papel do novo terminal" hint="Usado pelo botão “Novo terminal”.">
              <select value={prefs.role} onChange={(e) => setPref('role', e.target.value)} aria-label="Papel do novo terminal" disabled={!roles.length}>
                {roles.length ? roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>) : <option value={prefs.role}>{prefs.role}</option>}
              </select>
            </Row>
          </>}

          {tab === 'aparencia' && <>
            <Row title="Tema" hint="Escuro (grafite e preto). Ainda não há outro tema." />
            <Row title="Animações" hint="Automático segue a preferência do sistema por menos movimento; Reduzidas desliga as animações da interface.">
              <div className="oc-seg" role="radiogroup" aria-label="Animações">
                {[['auto', 'Automático'], ['reduced', 'Reduzidas']].map(([v, l]) => (
                  <button key={v} type="button" role="radio" aria-checked={prefs.motion === v} className={prefs.motion === v ? 'on' : ''} onClick={() => setPref('motion', v)}>{l}</button>
                ))}
              </div>
            </Row>
            <Row title="Fonte dos terminais" hint={`${prefs.fontSize}px (de ${FONT_RANGE.min} a ${FONT_RANGE.max}). Vale na hora para todos os terminais.`}>
              <input type="range" min={FONT_RANGE.min} max={FONT_RANGE.max} step="1" value={prefs.fontSize} onChange={(e) => setPref('fontSize', Number(e.target.value))} aria-label="Tamanho da fonte dos terminais" className="oc-range" />
            </Row>
          </>}

          {tab === 'cli' && <>
            <Row title="Estado" hint="Os terminais executam o comando claude encontrado no PATH, com o seu login e as suas permissões.">
              {!state ? <span className="dim">verificando…</span> : ex?.available
                ? <span className="oc-state ok"><i aria-hidden="true" />Detectado{ex.version ? ` · ${ex.version}` : ''}</span>
                : <span className="oc-state bad"><i aria-hidden="true" />Não encontrado no PATH</span>}
            </Row>
            {state && !ex?.available && <p className="oc-note err" role="status">Instale o Claude Code, entre com o seu login rodando <span className="mono">claude</span> uma vez num terminal e verifique de novo.</p>}
            <Row title="Verificar de novo" hint="A detecção é guardada por alguns segundos.">
              <Btn onClick={recheck} disabled={checking}>{checking ? 'Verificando…' : 'Verificar'}</Btn>
            </Row>
            <Row title="Permissões" hint="O terminal interativo pede permissões no próprio terminal. Quando o projeto tem configuração do Claude Code que executa comandos e não está revisada no Git, o Orchestrator pede a sua confirmação antes de abrir." />
          </>}

          {tab === 'providers' && <>
            <p className="dim small oc-lead">O provider é o CLI de agente que roda dentro de cada terminal.</p>
            <ul className="oc-prov">
              <li className="on"><span className="oc-prov-i"><Icon name="terminal" size={18} /></span><span className="oc-prov-t"><b>Claude Code</b><span className="dim small">Provider atual dos terminais.</span></span><span className="oc-pill ok">ativo</span></li>
              <li className="off" aria-disabled="true"><span className="oc-prov-i"><Icon name="terminal" size={18} /></span><span className="oc-prov-t"><b>Codex CLI</b><span className="dim small">Ainda não integrado. Nenhuma configuração é necessária por enquanto.</span></span><span className="oc-pill">em breve</span></li>
            </ul>
          </>}
        </div>
      </div>
    </Dialog>
  );
}
