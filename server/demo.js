// Dados DEMONSTRATIVOS. Tudo aqui é fictício e marcado com demo: true.
const t = (m) => new Date(Date.now() - m * 60000).toISOString();

export function buildDemoMissions() {
  return [
    {
      id: 'demo_mission',
      demo: true,
      title: 'Exemplo: adicionar validação de formulário de login',
      objective: 'Missão fictícia para demonstrar a interface. Nenhum agente a executou.',
      workspaceId: null,
      status: 'awaiting_approval',
      createdAt: t(90),
      tasks: [
        { id: 'demo_t1', title: 'Mapear componentes do formulário de login', status: 'completed', dependsOn: [], report: 'DEMO — 3 arquivos identificados; nenhuma alteração feita.', files: [], log: [
          '[demo] $ claude -p "mapear componentes do login"', '[demo] 3 arquivos relevantes encontrados', '[demo] exit code 0'] },
        { id: 'demo_t2', title: 'Implementar validação de e-mail e senha', status: 'awaiting_approval', dependsOn: ['demo_t1'],
          report: 'DEMO — Validação adicionada ao formulário. Testes unitários sugeridos para a próxima tarefa.',
          files: [{ path: 'src/Login.jsx', added: 24, removed: 3 }, { path: 'src/validate.js', added: 31, removed: 0 }],
          log: ['[demo] $ claude -p "implementar validação"', '[demo] editando src/Login.jsx', '[demo] criando src/validate.js', '[demo] exit code 0'] },
        { id: 'demo_t3', title: 'Escrever testes da validação', status: 'queued', dependsOn: ['demo_t2'], report: '', files: [], log: [] },
        { id: 'demo_t4', title: 'Rodar suíte de testes e linter', status: 'queued', dependsOn: ['demo_t3'], report: '', files: [], log: [] },
      ],
    },
  ];
}
