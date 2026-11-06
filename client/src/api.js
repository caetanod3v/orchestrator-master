async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Erro ${res.status}`), { status: res.status, ...(data.code ? { code: data.code } : {}) });
  return data;
}
export const api = {
  get: (u) => req('GET', u),
  post: (u, b) => req('POST', u, b ?? {}),
  put: (u, b) => req('PUT', u, b),
  del: (u) => req('DELETE', u),
};

/** Rotas de abas de workspace e tópicos (contrato S1.3/S1.4). Fechar um workspace NUNCA encerra terminais; só tira a aba. */
export const nav = {
  openWorkspace: (id) => api.post(`/api/workspaces/${id}/open`),
  closeWorkspace: (id) => api.post(`/api/workspaces/${id}/close`),
  activateWorkspace: (id) => api.post(`/api/workspaces/${id}/activate`),
  createTopic: (workspaceId, title) => api.post('/api/topics', { workspaceId, title }),
  renameTopic: (id, title) => api.post(`/api/topics/${id}/rename`, { title }),
  archiveTopic: (id) => api.post(`/api/topics/${id}/archive`),
  activateGeneral: (workspaceId) => api.post(`/api/workspaces/${workspaceId}/topic/general`),
  activateTopic: (id) => api.post(`/api/topics/${id}/activate`),
};
