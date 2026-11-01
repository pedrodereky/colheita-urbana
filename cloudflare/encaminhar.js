// Proxy reverso usado pelas Pages Functions: o navegador fala só com o domínio do Pages
// (mesma origem, então o cookie de sessão SameSite=Strict continua valendo) e a Function
// repassa /api/* ao backend Node. Streams (SSE) passam sem buffer.
export async function encaminhar({ request, env }) {
  if (!env.BACKEND_URL) {
    return new Response(JSON.stringify({ erro: 'Servidor indisponível (BACKEND_URL não configurado).', codigo: 'SEM_BACKEND' }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
  const origem = new URL(request.url);
  const destino = new URL(origem.pathname + origem.search, env.BACKEND_URL);

  const cabecalhos = new Headers(request.headers);
  cabecalhos.delete('host');
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) cabecalhos.set('x-forwarded-for', ip);
  if (env.PROXY_SECRET) cabecalhos.set('x-proxy-secret', env.PROXY_SECRET); // só o proxy fala com a API

  const semCorpo = request.method === 'GET' || request.method === 'HEAD';
  let resposta;
  try {
    resposta = await fetch(destino, { method: request.method, headers: cabecalhos, body: semCorpo ? undefined : request.body, redirect: 'manual', duplex: 'half' });
  } catch {
    return new Response(JSON.stringify({ erro: 'Não foi possível falar com o servidor. Tente novamente.', codigo: 'BACKEND_INDISPONIVEL' }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
  const saida = new Headers(resposta.headers);
  saida.delete('content-length'); // evita divergência quando o runtime recodifica
  return new Response(resposta.body, { status: resposta.status, statusText: resposta.statusText, headers: saida });
}
