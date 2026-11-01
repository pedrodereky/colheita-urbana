// Cliente HTTP da API. Sessão por cookie HttpOnly; erros viram exceções com mensagem amigável.
export class ErroApi extends Error {
  constructor(status, corpo) { super(corpo?.erro || 'Falha de comunicação com o servidor.'); this.status = status; this.codigo = corpo?.codigo; }
}

let aoDeslogar = () => {};
export const definirAoDeslogar = (fn) => { aoDeslogar = fn; };

export async function api(metodo, caminho, corpo) {
  let r;
  try {
    r = await fetch(caminho, {
      method: metodo, credentials: 'same-origin',
      headers: corpo !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    });
  } catch { throw new ErroApi(0, { erro: 'Sem conexão com o servidor.', codigo: 'OFFLINE' }); }
  const tipo = r.headers.get('content-type') || '';
  const dados = tipo.includes('json') ? await r.json() : null;
  if (!r.ok) {
    if (r.status === 401 && caminho !== '/api/login' && caminho !== '/api/me') aoDeslogar();
    throw new ErroApi(r.status, dados);
  }
  return dados;
}
export const GET = (c) => api('GET', c);
export const POST = (c, b = {}) => api('POST', c, b);
export const PATCH = (c, b = {}) => api('PATCH', c, b);
export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== '' && v != null) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
