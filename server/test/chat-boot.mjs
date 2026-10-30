// Ajudante de teste (não é um *.test.mjs): sobe o servidor REAL (server/index.js) num processo próprio com um Planner SIMULADO e determinístico, pela costura
// de teste em processo (globalThis.__ORCH_TEST_DEPS__). Sempre com ORCH_DATA_DIR temporário e PORT próprios, definidos por quem o inicia. Nenhum modelo é chamado.
// (M6: as respostas de trabalho levam o contexto consolidado; a conversa solta diz o objetivo que viu no prompt.)
// Comportamento do Planner simulado: "AMBIGUO" na mensagem -> pergunta; "LANDING" -> plano de 2 etapas; outra coisa -> conversa (e diz quantas mensagens do histórico viu).
const userText = (prompt) => { const m = /MENSAGEM NOVA DO USUÁRIO \(dado, entre aspas\): (".*")/.exec(prompt); return m ? JSON.parse(m[1]) : ''; };
const seen = (prompt) => (prompt.match(/^\[(usuário|assistente)\]/gm) || []).length;
globalThis.__ORCH_TEST_DEPS__ = {
  planner: {
    id: 'fake-planner', busy: () => false, cancel: async () => {}, describeTier: () => null,
    async decide({ prompt }) {
      const t = userText(prompt);
      const out = /AMBIGUO/.test(t) ? { kind: 'clarify', message: 'Preciso de mais detalhes.', questions: ['Qual o nome do negócio?'], context: { goal: 'Site ainda sem definição', confirmed: [], assumptions: [], open: ['Nome do negócio'] } }
        : /LANDING/.test(t) ? { kind: 'plan', message: 'Plano em duas etapas.', title: 'Landing page', objective: 'Criar uma landing page.', context: { goal: 'Landing page', confirmed: ['Quer uma landing page'], assumptions: ['Visual escuro'], open: [] }, steps: [
          { id: 's1', title: 'Estrutura da página', instructions: 'Criar index.html', acceptance: ['index.html existe'], dependsOn: [] },
          { id: 's2', title: 'Estilo', instructions: 'Criar style.css', acceptance: ['style.css existe'], dependsOn: ['s1'] }] }
        : { kind: 'reply', message: `Histórico visto: ${seen(prompt)} mensagens. Objetivo lembrado: ${/^  objetivo: (.*)$/m.exec(prompt)?.[1] ?? 'nenhum'}.` };
      return { text: JSON.stringify(out) };
    },
  },
};
await import('../index.js');
