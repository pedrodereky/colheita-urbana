// Hub de eventos em tempo real (SSE). Substitui o WebSocket do diagrama de componentes
// por um canal unidirecional servidor->cliente, suficiente para posição, estado e chat.
const clientes = new Map(); // usuarioId -> Set<res>

export function conectar(usuarioId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  if (!clientes.has(usuarioId)) clientes.set(usuarioId, new Set());
  clientes.get(usuarioId).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => {
    clearInterval(ping);
    clientes.get(usuarioId)?.delete(res);
    if (!clientes.get(usuarioId)?.size) clientes.delete(usuarioId);
  });
}

export function publicar(usuarioIds, evento, dados) {
  const msg = `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
  for (const id of new Set([].concat(usuarioIds).filter(Boolean))) {
    for (const res of clientes.get(id) || []) res.write(msg);
  }
}

export const totalConectados = () => clientes.size;
