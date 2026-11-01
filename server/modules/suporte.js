import { route, HttpError } from '../lib/http.js';
import { run, get, all, tx } from '../db.js';
import { exigir } from '../lib/validators.js';
import { iso, agora } from '../lib/clock.js';
import { registrar } from '../lib/audit.js';
import { notificar, notificarVarios } from '../lib/notify.js';
import { salvarDataUrl } from '../lib/files.js';
import { conectar } from '../lib/events.js';
import { randomBytes } from 'node:crypto';

const G = { perfis: ['GESTOR'] };

// ---------- tempo real (SSE) ----------
route('GET', '/api/stream', ({ user, res }) => { conectar(user.id, res); });

// ---------- notificações ----------
route('GET', '/api/notificacoes', ({ user }) => ({
  notificacoes: all('SELECT id, tipo, mensagem, referencia, data_envio AS dataEnvio, lida FROM notificacoes WHERE usuario_id=? ORDER BY id DESC LIMIT 50', user.id),
  naoLidas: get('SELECT COUNT(*) AS n FROM notificacoes WHERE usuario_id=? AND lida=0', user.id).n,
}));
route('POST', '/api/notificacoes/lidas', ({ user }) => { run('UPDATE notificacoes SET lida=1 WHERE usuario_id=?', user.id); });
route('POST', '/api/notificacoes/:id/lida', ({ user, params }) => { run('UPDATE notificacoes SET lida=1 WHERE id=? AND usuario_id=?', Number(params.id), user.id); });

// ---------- chamados de suporte (UC42, UC43 / RF34) ----------
const CATEGORIAS = ['ACESSO', 'OFERTA', 'ENTREGA', 'CADASTRO', 'OUTRO'];
const STATUS = ['ABERTO', 'EM_ATENDIMENTO', 'RESOLVIDO', 'FECHADO'];

route('POST', '/api/chamados', ({ user, body }) => {
  const categoria = exigir.enum(body, 'categoria', 'Categoria', CATEGORIAS);
  const assunto = exigir.texto(body, 'assunto', 'o assunto', { max: 150 });
  const descricao = exigir.texto(body, 'descricao', 'a descrição do problema', { max: 3000 });
  const anexo = body.anexo ? salvarDataUrl(body.anexo, 'imagem') : null;
  const protocolo = `CH-${agora().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(2).toString('hex').toUpperCase()}`;
  const r = run('INSERT INTO chamados (protocolo, usuario_id, categoria, assunto, descricao, anexo, aberto_em, atualizado_em) VALUES (?,?,?,?,?,?,?,?)', protocolo, user.id, categoria, assunto, descricao, anexo, iso(), iso());
  registrar({ autorId: user.id, entidade: 'chamado', entidadeId: Number(r.lastInsertRowid), acao: 'ABRIR', para: 'ABERTO' });
  notificarVarios(all("SELECT id FROM usuarios WHERE tipo='GESTOR' AND status_cadastro='APROVADO'").map((g) => g.id), 'CHAMADO', `Novo chamado ${protocolo}: ${assunto}`, { referencia: `chamado:${r.lastInsertRowid}` });
  return { id: Number(r.lastInsertRowid), protocolo, status: 'ABERTO' };
});

const chamadoApi = (c) => ({ id: c.id, protocolo: c.protocolo, categoria: c.categoria, assunto: c.assunto, status: c.status, abertoEm: c.aberto_em, atualizadoEm: c.atualizado_em, solicitante: c.solicitante });

route('GET', '/api/chamados', ({ user, query }) => {
  const ehGestor = user.tipo === 'GESTOR';
  const linhas = all(
    `SELECT c.*, u.nome AS solicitante FROM chamados c JOIN usuarios u ON u.id=c.usuario_id
     WHERE (?=1 OR c.usuario_id=?) AND (?='' OR c.status=?) ORDER BY c.id DESC LIMIT 200`, ehGestor ? 1 : 0, user.id, query.status || '', query.status || '');
  return { chamados: linhas.map(chamadoApi) };
});

function chamadoAcessivel(id, user) {
  const c = get('SELECT c.*, u.nome AS solicitante FROM chamados c JOIN usuarios u ON u.id=c.usuario_id WHERE c.id=?', id);
  if (!c || (user.tipo !== 'GESTOR' && c.usuario_id !== user.id)) throw new HttpError(404, 'Chamado não encontrado.', 'NAO_ENCONTRADO');
  return c;
}
route('GET', '/api/chamados/:id', ({ user, params }) => {
  const c = chamadoAcessivel(Number(params.id), user);
  const mensagens = all('SELECT m.id, m.texto, m.data, m.autor_id, u.nome AS autor, u.tipo AS autorTipo FROM chamado_mensagens m JOIN usuarios u ON u.id=m.autor_id WHERE chamado_id=? ORDER BY m.id', c.id);
  return { chamado: { ...chamadoApi(c), descricao: c.descricao, anexo: c.anexo }, mensagens };
});
route('POST', '/api/chamados/:id/mensagens', ({ user, params, body }) => {
  const c = chamadoAcessivel(Number(params.id), user);
  if (c.status === 'FECHADO') throw new HttpError(409, 'Chamado fechado.', 'CHAMADO_FECHADO');
  const texto = exigir.texto(body, 'texto', 'a mensagem', { max: 3000 });
  tx(() => {
    run('INSERT INTO chamado_mensagens (chamado_id, autor_id, texto, data) VALUES (?,?,?,?)', c.id, user.id, texto, iso());
    // UC43: ao responder, o gestor coloca o chamado em atendimento
    const novo = user.tipo === 'GESTOR' && c.status === 'ABERTO' ? 'EM_ATENDIMENTO' : c.status;
    run('UPDATE chamados SET status=?, atualizado_em=? WHERE id=?', novo, iso(), c.id);
  });
  if (user.tipo === 'GESTOR') notificar(c.usuario_id, 'CHAMADO', `Seu chamado ${c.protocolo} recebeu uma resposta.`, { referencia: `chamado:${c.id}` });
});
route('POST', '/api/chamados/:id/status', G, ({ user, params, body }) => {
  const c = chamadoAcessivel(Number(params.id), user);
  const status = exigir.enum(body, 'status', 'Status', STATUS);
  run('UPDATE chamados SET status=?, atualizado_em=? WHERE id=?', status, iso(), c.id);
  registrar({ autorId: user.id, entidade: 'chamado', entidadeId: c.id, acao: 'STATUS', de: c.status, para: status });
  notificar(c.usuario_id, 'CHAMADO', `Seu chamado ${c.protocolo} agora está: ${status.replace('_', ' ').toLowerCase()}.`, { referencia: `chamado:${c.id}` });
});

// ---------- pesquisas de satisfação (UC44 / RF40) ----------
route('POST', '/api/gestor/pesquisas', G, ({ user, body }) => {
  const titulo = exigir.texto(body, 'titulo', 'o título', { max: 150 });
  const ini = exigir.data(body, 'periodoInicio', 'Início');
  const fim = exigir.data(body, 'periodoFim', 'Fim');
  if (fim <= ini) throw new HttpError(400, 'O fim deve ser posterior ao início.', 'PERIODO_INVALIDO');
  const perguntas = (Array.isArray(body.perguntas) ? body.perguntas : []).map((p) => String(p).trim()).filter(Boolean).slice(0, 10);
  if (!perguntas.length) throw new HttpError(400, 'Informe ao menos uma pergunta.', 'PERGUNTAS_OBRIGATORIAS');
  const r = run('INSERT INTO pesquisas (titulo, periodo_inicio, periodo_fim, perguntas, ativa) VALUES (?,?,?,?,1)', titulo, ini.toISOString(), fim.toISOString(), JSON.stringify(perguntas));
  registrar({ autorId: user.id, entidade: 'pesquisa', entidadeId: Number(r.lastInsertRowid), acao: 'PUBLICAR' });
  notificarVarios(all("SELECT id FROM usuarios WHERE tipo<>'GESTOR' AND status_cadastro='APROVADO'").map((u) => u.id), 'GERAL', `Nova pesquisa de satisfação: ${titulo}`, { referencia: `pesquisa:${r.lastInsertRowid}` });
  return { id: Number(r.lastInsertRowid) };
});

route('GET', '/api/pesquisas', ({ user }) => {
  const agoraI = iso();
  const ativas = all('SELECT * FROM pesquisas WHERE ativa=1 AND periodo_inicio<=? AND periodo_fim>=? ORDER BY id DESC', agoraI, agoraI);
  return {
    pesquisas: ativas.map((p) => ({
      id: p.id, titulo: p.titulo, periodoFim: p.periodo_fim, perguntas: JSON.parse(p.perguntas),
      respondida: !!get('SELECT 1 FROM respostas_pesquisa WHERE pesquisa_id=? AND usuario_id=?', p.id, user.id),
    })),
  };
});
route('POST', '/api/pesquisas/:id/responder', ({ user, params, body }) => {
  const p = get('SELECT * FROM pesquisas WHERE id=? AND ativa=1 AND periodo_inicio<=? AND periodo_fim>=?', Number(params.id), iso(), iso());
  if (!p) throw new HttpError(404, 'Pesquisa indisponível.', 'NAO_ENCONTRADO');
  if (get('SELECT 1 FROM respostas_pesquisa WHERE pesquisa_id=? AND usuario_id=?', p.id, user.id)) {
    throw new HttpError(409, 'Você já respondeu esta pesquisa.', 'JA_RESPONDIDA'); // UC44 3a
  }
  const nota = exigir.numero(body, 'notaGeral', 'Nota geral', { min: 1, max: 5 });
  const respostas = (Array.isArray(body.respostas) ? body.respostas : []).slice(0, 10).map((x) => Math.min(5, Math.max(1, Number(x) || 0)));
  run('INSERT INTO respostas_pesquisa (pesquisa_id, usuario_id, nota_geral, respostas, comentario, data_resposta) VALUES (?,?,?,?,?,?)', p.id, user.id, nota, JSON.stringify(respostas), exigir.opcional(body, 'comentario', 1000), iso());
});
route('GET', '/api/gestor/pesquisas', G, () => ({
  pesquisas: all('SELECT * FROM pesquisas ORDER BY id DESC LIMIT 50').map((p) => {
    const rs = all('SELECT nota_geral, respostas, comentario FROM respostas_pesquisa WHERE pesquisa_id=?', p.id);
    const perguntas = JSON.parse(p.perguntas);
    const mediaDe = (a) => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 100) / 100 : null);
    return {
      id: p.id, titulo: p.titulo, periodoInicio: p.periodo_inicio, periodoFim: p.periodo_fim, respostas: rs.length, mediaGeral: mediaDe(rs.map((r) => r.nota_geral)),
      porPergunta: perguntas.map((q, i) => ({ pergunta: q, media: mediaDe(rs.map((r) => JSON.parse(r.respostas || '[]')[i]).filter(Boolean)) })),
      comentarios: rs.map((r) => r.comentario).filter(Boolean), // sem identificação do autor
    };
  }),
}));

// ---------- feedback anônimo (UC45, UC46 / RF40 / RN31) ----------
// Nada que identifique o autor é gravado: sem usuario_id, sem IP, sem log, só a data (não o horário).
// O limitador abaixo vive apenas em memória (não persiste) e usa a chave do usuário só para conter abuso.
const enviosRecentes = new Map();
route('POST', '/api/feedback', ({ user, body }) => {
  const agoraMs = agora().getTime();
  const lista = (enviosRecentes.get(user.id) || []).filter((t) => agoraMs - t < 3600e3);
  if (lista.length >= 5) throw new HttpError(429, 'Limite de envios por hora atingido. Tente mais tarde.', 'MUITOS_ENVIOS');
  lista.push(agoraMs);
  enviosRecentes.set(user.id, lista);
  const tipo = exigir.enum(body, 'tipo', 'Tipo', ['SUGESTAO', 'DENUNCIA']);
  const texto = exigir.texto(body, 'texto', 'a mensagem', { max: 3000 }); // UC45 2a
  const anexo = body.anexo ? salvarDataUrl(body.anexo, 'imagem') : null;
  run('INSERT INTO feedbacks_anonimos (tipo, texto, anexo, data_envio) VALUES (?,?,?,?)', tipo, texto, anexo, iso().slice(0, 10));
  return { mensagem: 'Enviado de forma anônima à equipe gestora.' };
});

route('GET', '/api/gestor/feedbacks', G, ({ query }) => ({
  feedbacks: all(
    `SELECT id, tipo, texto, anexo, data_envio AS dataEnvio, status, providencia FROM feedbacks_anonimos
     WHERE (?='' OR tipo=?) AND (?='' OR status=?) ORDER BY id DESC LIMIT 200`, query.tipo || '', query.tipo || '', query.status || '', query.status || ''),
}));
route('POST', '/api/gestor/feedbacks/:id/status', G, ({ params, body }) => {
  const status = exigir.enum(body, 'status', 'Status', ['EM_ANALISE', 'RESOLVIDO']);
  const r = run('UPDATE feedbacks_anonimos SET status=?, providencia=? WHERE id=?', status, exigir.opcional(body, 'providencia', 1000), Number(params.id));
  if (!r.changes) throw new HttpError(404, 'Item não encontrado.', 'NAO_ENCONTRADO');
});
