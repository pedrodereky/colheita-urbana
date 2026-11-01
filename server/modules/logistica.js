import { route, HttpError } from '../lib/http.js';
import { run, get, all, tx } from '../db.js';
import { exigir } from '../lib/validators.js';
import { agora, iso } from '../lib/clock.js';
import { registrar } from '../lib/audit.js';
import { rota, haversineKm, estimarMinutos } from '../lib/maps.js';
import { salvarDataUrl } from '../lib/files.js';
import { publicar } from '../lib/events.js';
import { notificar, notificarGestores } from '../lib/notify.js';
import { decifrar } from '../lib/crypto.js';
import { mudarEstadoOferta, ESTADOS_ENTREGA_EM_ANDAMENTO } from '../domain/estados.js';
import { liberarColeta } from '../domain/fila.js';
import { registrarInconsistencia } from '../domain/suspensao.js';
import { transportadorApto, coletasAtivas, veiculoSuporta, idsPorTipo, R } from '../domain/regras.js';
import { gravarHistorico, emitirRecibo } from './historico.js';
import { concederReconhecimentos } from './avaliacao.js';
import { imagensDe } from './ofertas.js';
import { veiculos } from '../config.js';

const T = { perfis: ['TRANSPORTADOR'] };

// ---- contexto de uma coleta/entrega e quem pode vê-la ----
function carregar(coletaId) {
  const c = get(
    `SELECT c.*, r.osc_id, r.oferta_id, r.modalidade, r.responsavel_retirada, r.status AS reserva_status, r.quantidade_kg,
            o.estabelecimento_id, o.estado, o.tipo_alimento, o.categoria, o.conservacao, o.validade, o.janela_inicio, o.janela_fim
     FROM coletas c JOIN reservas r ON r.id=c.reserva_id JOIN ofertas o ON o.id=r.oferta_id WHERE c.id=?`, coletaId);
  if (!c) throw new HttpError(404, 'Entrega não encontrada.', 'NAO_ENCONTRADO');
  return c;
}
function papel(c, user) {
  if (user.id === c.estabelecimento_id) return 'ESTABELECIMENTO';
  if (user.id === c.osc_id) return 'OSC';
  if (user.id === c.transportador_id) return 'TRANSPORTADOR';
  if (user.tipo === 'GESTOR') return 'GESTOR';
  return null;
}
function exigirParte(c, user) {
  const p = papel(c, user);
  if (!p) throw new HttpError(403, 'Você não participa desta entrega.', 'SEM_PERMISSAO');
  return p;
}
// Quem executa as ações de campo: o transportador, ou a OSC quando usa transporte próprio (RN25)
function exigirExecutor(c, user) {
  const p = papel(c, user);
  if (p === 'TRANSPORTADOR' || (p === 'OSC' && c.modalidade === 'PROPRIO')) return p;
  throw new HttpError(403, 'Apenas o responsável pela coleta pode fazer isso.', 'SEM_PERMISSAO');
}
const loc = (id) => get('SELECT nome, latitude, longitude, endereco_enc FROM usuarios WHERE id=?', id);
const emAndamento = (c) => ESTADOS_ENTREGA_EM_ANDAMENTO.includes(c.estado);

// ---- UC19: coletas disponíveis e aceite ----
route('GET', '/api/coletas/disponiveis', T, ({ user }) => {
  const t = get('SELECT tipo_veiculo FROM transportadores WHERE usuario_id=?', user.id);
  const linhas = all(
    `SELECT c.id, r.quantidade_kg, o.tipo_alimento, o.categoria, o.conservacao, o.validade, o.janela_inicio, o.janela_fim,
            e.nome AS estabelecimento, e.latitude AS elat, e.longitude AS elon, oc.nome AS osc, oc.latitude AS olat, oc.longitude AS olon
     FROM coletas c JOIN reservas r ON r.id=c.reserva_id JOIN ofertas o ON o.id=r.oferta_id
     JOIN usuarios e ON e.id=o.estabelecimento_id JOIN usuarios oc ON oc.id=r.osc_id
     WHERE c.status='PENDENTE' AND r.modalidade='VOLUNTARIO' AND r.status='ATIVA' AND o.estado='RESERVADA' AND o.janela_fim>?`, iso());
  const base = { latitude: user.latitude, longitude: user.longitude };
  return {
    coletas: linhas.filter((l) => veiculoSuporta(t.tipo_veiculo, l.quantidade_kg)).map((l) => {
      const ate = haversineKm(base, { latitude: l.elat, longitude: l.elon }) * R.fatorRota;
      const trajeto = haversineKm({ latitude: l.elat, longitude: l.elon }, { latitude: l.olat, longitude: l.olon }) * R.fatorRota;
      return {
        id: l.id, tipoAlimento: l.tipo_alimento, categoria: l.categoria, conservacao: l.conservacao, quantidadeKg: l.quantidade_kg, validade: l.validade,
        janelaInicio: l.janela_inicio, janelaFim: l.janela_fim, estabelecimento: l.estabelecimento, osc: l.osc,
        distanciaAteRetiradaKm: Math.round(ate * 10) / 10, distanciaTrajetoKm: Math.round(trajeto * 10) / 10,
      };
    }).sort((a, b) => a.distanciaAteRetiradaKm - b.distanciaAteRetiradaKm),
    ativas: coletasAtivas(user.id), limite: R.maxColetasAtivas,
  };
});

route('POST', '/api/coletas/:id/aceitar', T, ({ user, params }) => {
  const id = Number(params.id);
  const c = tx(() => {
    const c = carregar(id);
    const apto = transportadorApto(user.id);
    if (!apto.apto) throw new HttpError(403, apto.motivo, 'TRANSPORTADOR_INAPTO');                                    // RN02 / RN20
    if (c.modalidade !== 'VOLUNTARIO') throw new HttpError(409, 'Esta entrega usa transporte próprio da OSC (RN25).', 'MODALIDADE_PROPRIA');
    if (c.status !== 'PENDENTE' || c.estado !== 'RESERVADA') throw new HttpError(409, 'Esta coleta não está mais disponível.', 'COLETA_INDISPONIVEL');
    if (new Date(c.janela_fim) <= agora()) throw new HttpError(409, 'A janela de retirada já terminou.', 'JANELA_ENCERRADA');
    if (coletasAtivas(user.id) >= R.maxColetasAtivas) throw new HttpError(409, `Limite de ${R.maxColetasAtivas} coletas simultâneas atingido (RN10).`, 'LIMITE_COLETAS');
    const t = get('SELECT tipo_veiculo FROM transportadores WHERE usuario_id=?', user.id);
    if (!veiculoSuporta(t.tipo_veiculo, c.quantidade_kg)) throw new HttpError(422, `Seu veículo (${veiculos[t.tipo_veiculo].rotulo}) não comporta ${c.quantidade_kg} kg (RN18).`, 'VEICULO_INCOMPATIVEL');
    run("UPDATE coletas SET transportador_id=?, status='ACEITA', aceita_em=? WHERE id=?", user.id, iso(), id);
    mudarEstadoOferta(c.oferta_id, 'EM_COLETA', { autorId: user.id });
    registrar({ autorId: user.id, entidade: 'coleta', entidadeId: id, acao: 'ACEITAR' });
    return c;
  });
  notificar(c.osc_id, 'STATUS_ENTREGA', `${user.nome} aceitou a coleta de ${c.tipo_alimento}.`, { referencia: `coleta:${id}` });
  notificar(c.estabelecimento_id, 'STATUS_ENTREGA', `${user.nome} irá retirar ${c.tipo_alimento}.`, { referencia: `coleta:${id}` });
  publicar([c.osc_id, c.estabelecimento_id, user.id], 'entrega', { coletaId: id });
  return { coletaId: id };
});

// RN29 - o transportador pode desistir antes de coletar; a coleta volta para outros voluntários
route('POST', '/api/coletas/:id/desistir', T, ({ user, params }) => {
  const id = Number(params.id);
  const c = carregar(id);
  if (c.transportador_id !== user.id || c.status !== 'ACEITA') throw new HttpError(409, 'Só é possível desistir de uma coleta aceita e ainda não realizada.', 'ESTADO_INVALIDO');
  tx(() => liberarColeta(id, c.oferta_id, 'Transportador desistiu', user.id));
  notificar(c.osc_id, 'STATUS_ENTREGA', 'O transportador desistiu; procuramos outro voluntário.', { referencia: `coleta:${id}` });
  const aptos = idsPorTipo('TRANSPORTADOR').filter((t) => t !== user.id && transportadorApto(t).apto && coletasAtivas(t) < R.maxColetasAtivas);
  for (const t of aptos) notificar(t, 'GERAL', `Coleta disponível novamente: ${c.tipo_alimento} (${c.quantidade_kg} kg).`, { referencia: `coleta:${id}` });
});

// ---- UC20: melhor rota ----
route('GET', '/api/coletas/:id/rota', async ({ user, params, query }) => {
  const c = carregar(Number(params.id));
  exigirExecutor(c, user);
  if (!['ACEITA', 'EM_TRANSPORTE'].includes(c.status)) throw new HttpError(409, 'A coleta precisa estar aceita.', 'ESTADO_INVALIDO');
  const e = loc(c.estabelecimento_id), o = loc(c.osc_id);
  const origem = query.latitude && query.longitude
    ? { latitude: Number(query.latitude), longitude: Number(query.longitude) }
    : { latitude: user.latitude, longitude: user.longitude };
  const pontos = [
    ...(c.status === 'ACEITA' ? [{ rotulo: 'Você', ...origem }, { rotulo: e.nome, latitude: e.latitude, longitude: e.longitude }] : [{ rotulo: 'Você', ...origem }]),
    { rotulo: o.nome, latitude: o.latitude, longitude: o.longitude },
  ];
  const enderecos = { retirada: decifrar(e.endereco_enc), entrega: decifrar(o.endereco_enc) };
  try {
    const trechos = [];
    for (let i = 0; i < pontos.length - 1; i++) trechos.push(await rota(pontos[i], pontos[i + 1]));
    const distanciaKm = trechos.reduce((s, t) => s + t.distanciaKm, 0);
    const minutos = trechos.reduce((s, t) => s + t.minutos, 0);
    run('UPDATE coletas SET rota_sugerida=?, distancia_km=? WHERE id=?', JSON.stringify(trechos.map((t) => t.caminho)), distanciaKm, c.id);
    return { pontos, trechos, distanciaKm, minutos, enderecos, provedor: trechos[0].provedor };
  } catch {
    return { rotaIndisponivel: true, aviso: 'Rota indisponível no momento. Siga pelos endereços informados.', pontos, enderecos }; // UC20 2a
  }
});

// ---- UC21: registrar horário da coleta ----
route('POST', '/api/coletas/:id/registrar-coleta', async ({ user, params }) => {
  const id = Number(params.id);
  const c = carregar(id);
  exigirExecutor(c, user);
  if (c.status !== 'ACEITA' || c.estado !== 'EM_COLETA') throw new HttpError(409, 'Esta coleta não pode ser registrada agora.', 'ESTADO_INVALIDO');
  if (new Date(c.janela_fim) <= agora()) throw new HttpError(409, 'A janela de retirada terminou (RN03).', 'JANELA_ENCERRADA');
  const e = loc(c.estabelecimento_id), o = loc(c.osc_id);
  let minutos;
  try { minutos = (await rota(e, o)).minutos; } catch { minutos = estimarMinutos(haversineKm(e, o) * R.fatorRota); }
  const agoraD = agora();
  const previsao = iso(new Date(agoraD.getTime() + minutos * 60e3));
  tx(() => {
    run("UPDATE coletas SET status='EM_TRANSPORTE', hora_coleta=?, previsao_chegada=? WHERE id=?", iso(agoraD), previsao, id);
    mudarEstadoOferta(c.oferta_id, 'EM_TRANSPORTE', { autorId: user.id });
    if (c.transportador_id) run('UPDATE transportadores SET faltas_consecutivas=0 WHERE usuario_id=?', c.transportador_id); // RN20: consecutivas
    registrar({ autorId: user.id, entidade: 'coleta', entidadeId: id, acao: 'REGISTRAR_COLETA' });
  });
  notificar(c.osc_id, 'STATUS_ENTREGA', `Alimentos coletados. Chegada prevista em cerca de ${minutos} min.`, { referencia: `coleta:${id}` });
  notificar(c.estabelecimento_id, 'STATUS_ENTREGA', `A coleta de ${c.tipo_alimento} foi realizada.`, { referencia: `coleta:${id}` });
  publicar([c.osc_id, c.estabelecimento_id, c.transportador_id], 'entrega', { coletaId: id });
  return { horaColeta: iso(agoraD), previsaoChegada: previsao, minutos };
});

// ---- UC22: reportar problema na coleta (RN05: evidência + comentário) ----
route('POST', '/api/coletas/:id/ocorrencias', ({ user, params, body }) => {
  const id = Number(params.id);
  const c = carregar(id);
  exigirExecutor(c, user);
  if (!['ACEITA', 'EM_TRANSPORTE'].includes(c.status)) throw new HttpError(409, 'Só é possível reportar problemas em uma coleta ativa.', 'ESTADO_INVALIDO');
  const tipo = exigir.enum(body, 'tipo', 'Tipo de problema', ['EMBALAGEM_VIOLADA', 'ENDERECO_INCORRETO', 'AUSENCIA_DOADOR']);
  const descricao = exigir.texto(body, 'descricao', 'um comentário descrevendo o problema', { max: 1000 });
  if (!body.evidencia) throw new HttpError(400, 'Anexe uma foto ou vídeo como evidência (RN05).', 'EVIDENCIA_OBRIGATORIA');
  const arquivo = salvarDataUrl(body.evidencia, 'evidencia');
  const r = run('INSERT INTO ocorrencias (coleta_id, autor_id, tipo, descricao, evidencia, data_hora) VALUES (?,?,?,?,?,?)', id, user.id, tipo, descricao, arquivo, iso());
  registrar({ autorId: user.id, entidade: 'coleta', entidadeId: id, acao: 'OCORRENCIA', para: tipo, justificativa: descricao });
  const rotulo = { EMBALAGEM_VIOLADA: 'embalagem violada', ENDERECO_INCORRETO: 'endereço incorreto', AUSENCIA_DOADOR: 'ausência do doador' }[tipo];
  notificarGestores('STATUS_ENTREGA', `Problema na coleta #${id}: ${rotulo}.`, { referencia: `coleta:${id}` });
  notificar(c.estabelecimento_id, 'STATUS_ENTREGA', `Problema na coleta de ${c.tipo_alimento}: ${rotulo}.`, { referencia: `coleta:${id}` });
  notificar(c.osc_id, 'STATUS_ENTREGA', `Problema na coleta de ${c.tipo_alimento}: ${rotulo}.`, { referencia: `coleta:${id}` });
  return { id: Number(r.lastInsertRowid) };
});

// ---- UC23 / RF38 / RN32: localização em tempo real ----
route('POST', '/api/coletas/:id/localizacao', T, ({ user, params, body }) => {
  const id = Number(params.id);
  const c = carregar(id);
  if (c.transportador_id !== user.id || !['ACEITA', 'EM_TRANSPORTE'].includes(c.status) || !emAndamento(c)) {
    throw new HttpError(409, 'O compartilhamento só é permitido durante uma entrega em andamento (RN32).', 'FORA_DE_ENTREGA');
  }
  const { latitude, longitude } = exigir.coordenadas(body);
  const precisao = body.precisao == null ? null : Number(body.precisao);
  run(`INSERT INTO localizacoes (coleta_id, latitude, longitude, precisao_metros, atualizado_em) VALUES (?,?,?,?,?)
       ON CONFLICT(coleta_id) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, precisao_metros=excluded.precisao_metros, atualizado_em=excluded.atualizado_em`,
    id, latitude, longitude, precisao, iso());
  const destino = c.status === 'ACEITA' ? loc(c.estabelecimento_id) : loc(c.osc_id);
  const minutos = estimarMinutos(haversineKm({ latitude, longitude }, destino) * R.fatorRota);
  // visível só para o estabelecimento e a OSC (RN32)
  publicar([c.osc_id, c.estabelecimento_id], 'localizacao', { coletaId: id, latitude, longitude, atualizadoEm: iso(), tempoRestanteMin: minutos });
  return { ok: true };
});

// ---- UC24 / RF32: acompanhar entrega ----
function descreverEntrega(c, user) {
  const p = papel(c, user);
  const e = loc(c.estabelecimento_id), o = loc(c.osc_id);
  const t = c.transportador_id ? get('SELECT u.nome, t.tipo_veiculo FROM usuarios u JOIN transportadores t ON t.usuario_id=u.id WHERE u.id=?', c.transportador_id) : null;
  const vendoLocalizacao = ['OSC', 'ESTABELECIMENTO', 'TRANSPORTADOR'].includes(p) && emAndamento(c); // RN32 (gestor não vê)
  const l = vendoLocalizacao ? get('SELECT latitude, longitude, atualizado_em FROM localizacoes WHERE coleta_id=?', c.id) : null;
  let tempoRestanteMin = null;
  if (c.estado === 'EM_TRANSPORTE') {
    tempoRestanteMin = l
      ? estimarMinutos(haversineKm(l, o) * R.fatorRota)
      : c.previsao_chegada ? Math.max(0, Math.round((new Date(c.previsao_chegada) - agora()) / 60e3)) : null;
  }
  const linhaTempo = all("SELECT timestamp, estado_novo AS estado FROM logs_auditoria WHERE entidade='oferta' AND entidade_id=? AND acao='MUDAR_ESTADO' ORDER BY id", String(c.oferta_id));
  const acoes = [];
  const executor = p === 'TRANSPORTADOR' || (p === 'OSC' && c.modalidade === 'PROPRIO');
  if (executor && c.status === 'ACEITA' && c.estado === 'EM_COLETA') acoes.push('REGISTRAR_COLETA', 'REPORTAR_PROBLEMA');
  if (executor && c.status === 'EM_TRANSPORTE') acoes.push('REPORTAR_PROBLEMA');
  if (p === 'TRANSPORTADOR' && c.status === 'ACEITA' && c.estado === 'EM_COLETA') acoes.push('DESISTIR');
  if (p === 'TRANSPORTADOR' && emAndamento(c)) acoes.push('COMPARTILHAR_LOCALIZACAO');
  if (executor && ['ACEITA', 'EM_TRANSPORTE'].includes(c.status)) acoes.push('VER_ROTA');
  if (p === 'OSC' && c.estado === 'EM_TRANSPORTE') acoes.push('CONFIRMAR_RECEBIMENTO', 'RECUSAR_ENTREGA');
  if (p === 'OSC' && ['RESERVADA', 'EM_COLETA'].includes(c.estado)) acoes.push('CANCELAR_RESERVA');
  if (p === 'OSC' && ['ENTREGUE', 'AVALIADA'].includes(c.estado)) acoes.push('AVALIAR');
  return {
    id: c.id, reservaId: c.reserva_id, ofertaId: c.oferta_id, papel: p, estado: c.estado, statusColeta: c.status, modalidade: c.modalidade,
    responsavelRetirada: c.responsavel_retirada, tipoAlimento: c.tipo_alimento, categoria: c.categoria, conservacao: c.conservacao, quantidadeKg: c.quantidade_kg,
    validade: c.validade, janelaInicio: c.janela_inicio, janelaFim: c.janela_fim, horaColeta: c.hora_coleta, horaEntrega: c.hora_entrega, previsaoChegada: c.previsao_chegada,
    tempoRestanteMin, imagens: imagensDe(c.oferta_id),
    estabelecimento: { nome: e.nome, latitude: e.latitude, longitude: e.longitude, endereco: p === 'GESTOR' || c.transportador_id || p === 'ESTABELECIMENTO' || p === 'OSC' ? decifrar(e.endereco_enc) : null },
    osc: { nome: o.nome, latitude: o.latitude, longitude: o.longitude, endereco: c.transportador_id || p === 'OSC' || p === 'ESTABELECIMENTO' || p === 'GESTOR' ? decifrar(o.endereco_enc) : null },
    transportador: t ? { nome: t.nome, veiculo: veiculos[t.tipo_veiculo]?.rotulo } : null,
    localizacao: l ? { latitude: l.latitude, longitude: l.longitude, atualizadoEm: l.atualizado_em } : null,
    chatAtivo: emAndamento(c), linhaTempo, acoes,
    ocorrencias: all('SELECT id, tipo, descricao, evidencia, data_hora AS dataHora FROM ocorrencias WHERE coleta_id=? ORDER BY id', c.id),
    recibo: get('SELECT id, numero FROM recibos WHERE reserva_id=?', c.reserva_id) || null,
    avaliacoes: {
      doacao: !!get("SELECT 1 FROM avaliacoes WHERE reserva_id=? AND tipo='DOACAO'", c.reserva_id),
      entrega: !!get("SELECT 1 FROM avaliacoes WHERE reserva_id=? AND tipo='ENTREGA'", c.reserva_id),
    },
  };
}

route('GET', '/api/coletas/:id', ({ user, params }) => {
  const c = carregar(Number(params.id));
  exigirParte(c, user);
  return { entrega: descreverEntrega(c, user) };
});

route('GET', '/api/entregas', ({ user }) => {
  const filtro = { ESTABELECIMENTO: 'o.estabelecimento_id=?', OSC: 'r.osc_id=?', TRANSPORTADOR: 'c.transportador_id=?' }[user.tipo];
  if (!filtro) throw new HttpError(403, 'Sem acesso.', 'SEM_PERMISSAO');
  const linhas = all(
    `SELECT c.id, o.tipo_alimento, o.estado, r.quantidade_kg, r.modalidade, e.nome AS estabelecimento, oc.nome AS osc, c.previsao_chegada
     FROM coletas c JOIN reservas r ON r.id=c.reserva_id JOIN ofertas o ON o.id=r.oferta_id
     JOIN usuarios e ON e.id=o.estabelecimento_id JOIN usuarios oc ON oc.id=r.osc_id
     WHERE ${filtro} AND c.status<>'CANCELADA' ORDER BY c.id DESC LIMIT 100`, user.id);
  return { entregas: linhas.map((l) => ({ id: l.id, tipoAlimento: l.tipo_alimento, estado: l.estado, quantidadeKg: l.quantidade_kg, modalidade: l.modalidade, estabelecimento: l.estabelecimento, osc: l.osc, previsaoChegada: l.previsao_chegada })) };
});

// ---- UC25 / RF37 / RN34: chat da entrega ----
route('GET', '/api/coletas/:id/chat', ({ user, params }) => {
  const c = carregar(Number(params.id));
  const p = exigirParte(c, user);
  if (p === 'GESTOR') throw new HttpError(403, 'O chat é restrito aos participantes da entrega.', 'SEM_PERMISSAO');
  const mensagens = all('SELECT m.id, m.autor_id, u.nome AS autor, m.texto, m.data_envio AS dataEnvio FROM mensagens_chat m JOIN usuarios u ON u.id=m.autor_id WHERE m.coleta_id=? ORDER BY m.id', c.id);
  return { ativo: emAndamento(c), mensagens: mensagens.map((m) => ({ ...m, minha: m.autor_id === user.id })) };
});

route('POST', '/api/coletas/:id/chat', ({ user, params, body }) => {
  const c = carregar(Number(params.id));
  const p = exigirParte(c, user);
  if (p === 'GESTOR') throw new HttpError(403, 'O chat é restrito aos participantes da entrega.', 'SEM_PERMISSAO');
  if (!emAndamento(c)) throw new HttpError(409, 'O chat foi encerrado junto com a entrega (RN34).', 'CHAT_ENCERRADO');
  const texto = exigir.texto(body, 'texto', 'a mensagem', { max: 1000 });
  const r = run('INSERT INTO mensagens_chat (coleta_id, autor_id, texto, data_envio) VALUES (?,?,?,?)', c.id, user.id, texto, iso());
  const msg = { id: Number(r.lastInsertRowid), coletaId: c.id, autorId: user.id, autor: user.nome, texto, dataEnvio: iso() };
  publicar([c.osc_id, c.estabelecimento_id, c.transportador_id].filter((x) => x && x !== user.id), 'chat', msg);
  return { mensagem: { ...msg, minha: true } };
});

// ---- UC26 / UC27 ----
route('POST', '/api/coletas/:id/confirmar-recebimento', async ({ user, params }) => {
  const id = Number(params.id);
  const c = carregar(id);
  if (user.id !== c.osc_id) throw new HttpError(403, 'Apenas a OSC receptora confirma o recebimento.', 'SEM_PERMISSAO');
  if (c.estado !== 'EM_TRANSPORTE') throw new HttpError(409, 'A doação ainda não está em transporte.', 'ESTADO_INVALIDO');
  tx(() => {
    mudarEstadoOferta(c.oferta_id, 'ENTREGUE', { autorId: user.id });
    run("UPDATE coletas SET status='CONCLUIDA', hora_entrega=? WHERE id=?", iso(), id);
    run("UPDATE reservas SET status='CONCLUIDA' WHERE id=?", c.reserva_id);
    run('DELETE FROM localizacoes WHERE coleta_id=?', id); // RN32: deixa de coletar
    if (c.transportador_id) run('UPDATE transportadores SET entregas_concluidas = entregas_concluidas + 1 WHERE usuario_id=?', c.transportador_id);
    gravarHistorico(c.reserva_id, 'ENTREGUE');                                                  // UC33
    registrar({ autorId: user.id, entidade: 'coleta', entidadeId: id, acao: 'CONFIRMAR_RECEBIMENTO' });
  });
  const recibo = emitirRecibo(c.reserva_id);                                                    // UC28 (RN33)
  if (c.transportador_id) concederReconhecimentos({ transportadorId: c.transportador_id });     // UC32 (RN27)
  notificar(c.estabelecimento_id, 'STATUS_ENTREGA', `A OSC confirmou o recebimento de ${c.tipo_alimento}. Recibo ${recibo?.numero ?? 'em emissão'} disponível.`, { referencia: `coleta:${id}` });
  if (c.transportador_id) notificar(c.transportador_id, 'STATUS_ENTREGA', 'Entrega concluída. Obrigado pela colaboração!', { referencia: `coleta:${id}` });
  publicar([c.estabelecimento_id, c.transportador_id, c.osc_id], 'entrega', { coletaId: id });
  return { recibo };
});

route('POST', '/api/coletas/:id/recusar', ({ user, params, body }) => {
  const id = Number(params.id);
  const c = carregar(id);
  if (user.id !== c.osc_id) throw new HttpError(403, 'Apenas a OSC receptora pode recusar a entrega.', 'SEM_PERMISSAO');
  const justificativa = exigir.texto(body, 'justificativa', 'a justificativa da recusa', { max: 500 }); // UC27 3a / RN24
  if (c.estado !== 'EM_TRANSPORTE') throw new HttpError(409, 'A doação ainda não está em transporte.', 'ESTADO_INVALIDO');
  tx(() => {
    mudarEstadoOferta(c.oferta_id, 'RECUSADA', { autorId: user.id, justificativa });
    run("UPDATE coletas SET status='RECUSADA', hora_entrega=? WHERE id=?", iso(), id);
    run("UPDATE reservas SET status='RECUSADA' WHERE id=?", c.reserva_id);
    run('DELETE FROM localizacoes WHERE coleta_id=?', id);
    gravarHistorico(c.reserva_id, 'RECUSADA');
    registrarInconsistencia(c.estabelecimento_id, c.reserva_id, justificativa);                  // RN12
    registrar({ autorId: user.id, entidade: 'coleta', entidadeId: id, acao: 'RECUSAR_ENTREGA', justificativa });
  });
  notificar(c.estabelecimento_id, 'STATUS_ENTREGA', `A OSC recusou a entrega de ${c.tipo_alimento}: ${justificativa}`, { referencia: `coleta:${id}` }); // RN24
  if (c.transportador_id) notificar(c.transportador_id, 'STATUS_ENTREGA', 'A entrega foi recusada pela OSC por qualidade dos alimentos.', { referencia: `coleta:${id}` });
  publicar([c.estabelecimento_id, c.transportador_id, c.osc_id], 'entrega', { coletaId: id });
});
