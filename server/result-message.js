// Mensagem FINAL do orquestrador para a conversa quando uma missão termina (ou para, aguardando uma decisão humana).
// É DERIVADA, nunca gravada: sai do relatório de entrega (delivery.js), que só usa registros persistidos (rodadas, evidência, arquivos observados, limitações). Por isso:
//  - não inventa nada: cada linha vem de um campo do relatório; o que o Planner/Executor DISSERAM vem marcado como declaração, não como prova;
//  - não duplica: o id é estável (ciclo + instante de término/bloqueio); reler a missão ou atualizar a página devolve a MESMA mensagem;
//  - não depende do painel lateral: o relatório continua acessível em /api/missions/:id/delivery (detalhes técnicos), e esta mensagem é só o resumo para a pessoa.
// outcome: completed (concluída E comprovada pelo sistema, com todas as etapas) | partial (concluída sem comprovação, ou parou com progresso) | failed (parou sem nenhum resultado aproveitável).
const clip = (s, n) => String(s ?? '').slice(0, n);
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const HEAD = { completed: 'Missão concluída', partial: 'Missão parcialmente concluída', failed: 'A missão não foi concluída (falhou)' };
const STOP = { blocked: 'O ciclo parou e aguarda uma decisão sua', cancelled: 'O ciclo foi cancelado', limit_reached: 'O ciclo parou ao atingir o limite de rodadas' };
const FILE_CAP = 15, PENDING_CAP = 8;
const changeOf = (status) => { const s = String(status ?? ''); return /\?|A/.test(s) ? 'criado' : /D/.test(s) ? 'apagado' : s ? 'modificado' : 'alterado'; };

/** `report`: saída de buildDelivery/deliveryOf. Devolve null enquanto a missão não terminou (em andamento, sem ciclo, demonstrativa). */
export function resultMessageOf(report, mission) {
  if (!isObj(report) || !isObj(report.state) || !isObj(report.cycle)) return null;
  const code = report.state.code;
  if (!['completed', 'cancelled', 'limit_reached', 'blocked'].includes(code)) return null;
  const steps = arr(report.observed?.steps).filter(isObj), stepsDone = steps.filter((s) => s.status === 'completed');
  const fileItems = arr(report.observed?.files?.items).filter((f) => isObj(f) && typeof f.path === 'string');
  const touched = fileItems.filter((f) => !f.preexisting), rounds = Number.isInteger(report.cycle.rounds) ? report.cycle.rounds : 0;
  const level = report.assurance?.level ?? null, verified = code === 'completed' && level === 'verified';
  const progress = stepsDone.length > 0 || touched.length > 0;
  let outcome;
  if (code === 'completed') outcome = verified && stepsDone.length === steps.length ? 'completed' : 'partial';
  else outcome = progress ? 'partial' : 'failed';

  const lines = [];
  if (code === 'completed') {
    lines.push(verified ? 'O Planner declarou a missão concluída e a evidência do sistema da última rodada confirma.' : level === 'accepted_unverified' ? 'Uma pessoa aceitou a conclusão SEM comprovação independente do sistema.' : 'O Planner declarou a missão concluída, mas o sistema NÃO conseguiu comprová-la de forma independente.');
  } else lines.push(`${STOP[code]}${report.cycle.blockedCode ? ` (${clip(report.cycle.blockedCode, 40)})` : ''}.`);
  if (steps.length) lines.push(`Etapas concluídas: ${stepsDone.length} de ${steps.length}${stepsDone.length ? ` (${stepsDone.map((s) => clip(s.title || s.id, 80)).join('; ')})` : ''}.`);
  lines.push(`Rodadas executadas: ${rounds}.`);
  const vs = arr(report.verified?.verifications).filter(isObj);
  const lastRound = Math.max(0, ...vs.map((v) => Number(v.round) || 0)), lastVs = vs.filter((v) => (Number(v.round) || 0) === lastRound);
  if (lastVs.length) lines.push(`Verificações reais da última rodada: ${lastVs.map((v) => `${clip(v.script, 30)} ${v.status === 'pass' ? 'passou' : v.status === 'fail' ? 'falhou' : clip(v.status, 20)}`).join(', ')}.`);
  else if (code === 'completed') lines.push('Nenhuma verificação real (teste/build/lint) rodou na última rodada.');
  const declared = report.declared?.plannerSummary;
  if (isObj(declared) && declared.text) lines.push(`Resumo do Planner (declaração, não prova): ${clip(declared.text, 600)}`);
  else if (isObj(report.acceptance) && report.acceptance.recorded && typeof mission?.cycle?.finalSummary === 'string') lines.push(`Decisão registrada pela pessoa: ${clip(mission.cycle.finalSummary, 600)}`);

  const pending = [];
  for (const r of arr(report.state.reasons)) if (typeof r === 'string' && r) pending.push(clip(r, 300));
  for (const s of steps) if (s.status !== 'completed') pending.push(`Etapa "${clip(s.title || s.id, 80)}" não concluída (${clip(s.status, 20)}).`);
  for (const l of arr(report.limitations)) if (typeof l === 'string' && l) pending.push(clip(l, 400));
  const uniq = [...new Set(pending)];

  const cycle = mission?.cycle, stamp = cycle?.finishedAt ?? (code === 'blocked' ? `blocked:${rounds}:${cycle?.blockedCode ?? ''}` : code);
  const files = touched.slice(0, FILE_CAP).map((f) => ({ path: clip(f.path, 200), change: changeOf(f.status) }));
  const text = [`${HEAD[outcome]}.`, ...lines, files.length ? `Arquivos criados ou modificados: ${files.map((f) => f.path).join(', ')}${touched.length > FILE_CAP ? ` e mais ${touched.length - FILE_CAP}` : ''}.` : 'Nenhum arquivo alterado foi registrado.', uniq.length ? `Pendências e limitações: ${uniq.slice(0, PENDING_CAP).join(' ')}` : ''].filter(Boolean).join('\n');
  return {
    id: `result:${report.cycle.id ?? 'sem-ciclo'}:${stamp}`, role: 'assistant', kind: 'result', at: cycle?.finishedAt ?? null, missionId: report.mission?.id ?? null, cycleId: report.cycle.id ?? null,
    outcome, outcomeLabel: HEAD[outcome], stoppedBy: code === 'completed' ? null : code, summary: lines, files, filesTotal: touched.length, pending: uniq.slice(0, PENDING_CAP), pendingTotal: uniq.length, text,
  };
}

/** Conversa da missão (a do chat que a originou) + a mensagem final derivada. Só leitura. */
export function threadOf(mission, report) {
  const conv = arr(mission?.conversation).filter((m) => isObj(m) && typeof m.id === 'string').map((m) => ({ id: m.id, role: m.role === 'user' ? 'user' : 'assistant', kind: m.kind ?? null, text: clip(m.text, 4000), at: m.at ?? null, ...(arr(m.questions).length ? { questions: arr(m.questions).map((q) => clip(q, 400)) } : {}) }));
  return { missionId: mission?.id ?? null, title: clip(mission?.title, 200), origin: mission?.origin ?? null, messages: conv, result: resultMessageOf(report, mission) };
}
