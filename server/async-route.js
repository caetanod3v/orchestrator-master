// Express 4 NÃO captura rejeição de handler assíncrono: sem isto, um erro (ex.: falha de disco no store.save()) vira rejeição não tratada, que encerra o
// processo e deixa a requisição pendurada. O adaptador devolve 500 com JSON estruturado e nunca responde duas vezes.
export const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve().then(() => handler(req, res, next)).catch((err) => {
    console.error(`[rota] erro inesperado em ${req.method} ${String(req.originalUrl || req.url).split('?')[0]}:`, err?.code || err?.message || err);
    if (res.headersSent) { if (!res.writableEnded) res.end(); return; }   // já começou a responder: só fecha
    res.status(500).json({ error: 'Erro interno.' });                      // sem detalhes do erro (podem conter caminhos internos)
  });
};
