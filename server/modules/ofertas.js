import { route, HttpError } from '../lib/http.js';
import { run, get, all, tx } from '../db.js';
import { exigir, paraKg } from '../lib/validators.js';
import { agora, iso, horasEntre } from '../lib/clock.js';
import { registrar } from '../lib/audit.js';
import { salvarDataUrl } from '../lib/files.js';
import { notificar } from '../lib/notify.js';
import { haversineKm } from '../lib/maps.js';
import { mudarEstadoOferta, urgenciaDe } from '../domain/estados.js';
import { exigirAprovado, oscApta, capacidadeOsc, idsPorTipo, R } from '../domain/regras.js';

const E = { perfis: ['ESTABELECIMENTO'] };
const CONSERVACOES = ['AMBIENTE', 'REFRIGERADO', 'CONGELADO'];

export function imagensDe(ofertaId) {
  return all('SELECT arquivo FROM imagens_oferta WHERE oferta_id=? ORDER BY id', ofertaId).map((i) => i.arquivo);
}

export function ofertaParaApi(o) {
  return {
    id: o.id, estabelecimentoId: o.estabelecimento_id, estabelecimento: o.estabelecimento_nome, tipoAlimento: o.tipo_alimento, categoria: o.categoria,
    quantidadeKg: o.quantidade_kg, validade: o.validade, conservacao: o.conservacao, janelaInicio: o.janela_inicio, janelaFim: o.janela_fim,
    estado: o.estado, criadoEm: o.criado_em, urgencia: urgenciaDe(o.validade, agora()), imagens: imagensDe(o.id),
  };
}

const SELECT_OFERTA = 'SELECT o.*, u.nome AS estabelecimento_nome FROM ofertas o JOIN usuarios u ON u.id=o.estabelecimento_id';

// UC17 / RF11 - notifica OSCs elegíveis (aprovadas, documentação em dia, próximas e com capacidade)
export function notificarOscsElegiveis(oferta) {
  const origem = get('SELECT latitude, longitude, nome FROM usuarios WHERE id=?', oferta.estabelecimento_id);
  const elegiveis = [];
  for (const oscId of idsPorTipo('OSC')) {
    if (!oscApta(oscId).apta) continue;
    const loc = get('SELECT latitude, longitude FROM usuarios WHERE id=?', oscId);
    if (haversineKm(origem, loc) > R.raioNotificacaoKm) continue;
    if (capacidadeOsc(oscId, oferta.conservacao).livre < oferta.quantidade_kg) continue;
    elegiveis.push(oscId);
  }
  for (const id of elegiveis) {
    notificar(id, 'VALIDADE_CURTA', `Oferta de validade curta: ${oferta.quantidade_kg} kg de ${oferta.tipo_alimento} (${origem.nome}).`, { referencia: `oferta:${oferta.id}` });
  }
  registrar({ entidade: 'oferta', entidadeId: oferta.id, acao: 'NOTIFICAR_VALIDADE_CURTA', justificativa: `${elegiveis.length} OSC(s) notificada(s)` });
  return elegiveis.length;
}

// UC08 (+ UC09, UC10, UC11, UC12) - publicar oferta
route('POST', '/api/ofertas', E, ({ user, body }) => {
  exigirAprovado(user);
  const tipoAlimento = exigir.texto(body, 'tipoAlimento', 'o tipo de alimento', { max: 120 });
  const categoria = exigir.texto(body, 'categoria', 'a categoria', { max: 60 });
  const conservacao = exigir.enum(body, 'conservacao', 'Condição de conservação', CONSERVACOES);
  const validade = exigir.data(body, 'validade', 'Data de validade');
  const quantidadeKg = paraKg(body.quantidade, body.unidade || 'kg');

  // UC11 / RF30 / RN06
  if (quantidadeKg < R.quantidadeMinimaKg) {
    throw new HttpError(422, `Quantidade abaixo do mínimo permitido de ${R.quantidadeMinimaKg} kg (RN06).`, 'QUANTIDADE_MINIMA');
  }
  // UC09 / RF06 - janela de retirada
  const inicio = exigir.data(body, 'janelaInicio', 'Início da retirada');
  const fim = exigir.data(body, 'janelaFim', 'Fim da retirada');
  if (!(fim > inicio)) throw new HttpError(422, 'O fim da janela deve ser posterior ao início.', 'JANELA_INVALIDA');
  if (!(fim < validade)) throw new HttpError(422, 'A janela de retirada deve terminar antes do vencimento do alimento.', 'JANELA_INVALIDA');
  if (fim <= agora()) throw new HttpError(422, 'A janela de retirada já terminou.', 'JANELA_INVALIDA');
  // RN16 - validade mínima de 36h no momento da publicação
  if (horasEntre(agora(), validade) < R.validadeMinimaHoras) {
    throw new HttpError(422, `O alimento deve ter no mínimo ${R.validadeMinimaHoras} horas de validade restante (RN16).`, 'VALIDADE_MINIMA');
  }

  // UC10 - imagens (opcional) e UC12 - reaproveitar fotos de oferta anterior
  const arquivos = [];
  if (body.reutilizarImagensDe) {
    const origem = get('SELECT id FROM ofertas WHERE id=? AND estabelecimento_id=?', Number(body.reutilizarImagensDe), user.id);
    if (origem) arquivos.push(...imagensDe(origem.id));
  }
  for (const img of Array.isArray(body.imagens) ? body.imagens.slice(0, 5) : []) arquivos.push(salvarDataUrl(img, 'imagem'));

  const oferta = tx(() => {
    const r = run(
      `INSERT INTO ofertas (estabelecimento_id, tipo_alimento, categoria, quantidade_kg, validade, conservacao, janela_inicio, janela_fim, estado, origem_oferta_id, criado_em)
       VALUES (?,?,?,?,?,?,?,?, 'DISPONIVEL', ?, ?)`,
      user.id, tipoAlimento, categoria, quantidadeKg, validade.toISOString(), conservacao, inicio.toISOString(), fim.toISOString(),
      body.origemOfertaId ? Number(body.origemOfertaId) : null, iso(),
    );
    const id = Number(r.lastInsertRowid);
    for (const a of arquivos) run('INSERT INTO imagens_oferta (oferta_id, arquivo, enviado_em) VALUES (?,?,?)', id, a, iso());
    registrar({ autorId: user.id, entidade: 'oferta', entidadeId: id, acao: 'PUBLICAR', de: null, para: 'DISPONIVEL' });
    return get('SELECT * FROM ofertas WHERE id=?', id);
  });

  let notificadas = 0;
  if (horasEntre(agora(), validade) <= R.validadeCurtaHoras) notificadas = notificarOscsElegiveis(oferta); // RN26
  return { oferta: ofertaParaApi({ ...oferta, estabelecimento_nome: user.nome }), oscsNotificadas: notificadas };
});

// UC12 - modelo para repetir oferta anterior
route('GET', '/api/ofertas/:id/modelo', E, ({ user, params }) => {
  const o = get('SELECT * FROM ofertas WHERE id=? AND estabelecimento_id=?', Number(params.id), user.id);
  if (!o) throw new HttpError(404, 'Oferta não encontrada.', 'NAO_ENCONTRADO');
  return {
    modelo: { tipoAlimento: o.tipo_alimento, categoria: o.categoria, quantidade: o.quantidade_kg, unidade: 'kg', conservacao: o.conservacao, imagens: imagensDe(o.id), origemOfertaId: o.id },
  };
});

route('GET', '/api/ofertas/minhas', E, ({ user }) => {
  const ofertas = all(`${SELECT_OFERTA} WHERE o.estabelecimento_id=? ORDER BY o.id DESC LIMIT 200`, user.id).map((o) => {
    const reserva = get(
      `SELECT r.id, r.modalidade, u.nome AS osc FROM reservas r JOIN usuarios u ON u.id=r.osc_id WHERE r.oferta_id=? AND r.status IN ('ATIVA','CONCLUIDA','RECUSADA') ORDER BY r.id DESC LIMIT 1`, o.id);
    const coleta = reserva && get('SELECT id FROM coletas WHERE reserva_id=?', reserva.id);
    return { ...ofertaParaApi(o), reserva: reserva ? { id: reserva.id, modalidade: reserva.modalidade, osc: reserva.osc, coletaId: coleta?.id } : null };
  });
  return { ofertas };
});

// UC13 / RF28 / RN30
route('POST', '/api/ofertas/:id/cancelar', E, ({ user, params }) => {
  const id = Number(params.id);
  tx(() => {
    const o = get('SELECT * FROM ofertas WHERE id=? AND estabelecimento_id=?', id, user.id);
    if (!o) throw new HttpError(404, 'Oferta não encontrada.', 'NAO_ENCONTRADO');
    const reservada = get("SELECT 1 FROM reservas WHERE oferta_id=? AND status='ATIVA'", id);
    if (o.estado !== 'DISPONIVEL' || reservada) {
      throw new HttpError(409, 'Esta oferta já foi reservada e não pode ser cancelada (RN30).', 'OFERTA_JA_RESERVADA');
    }
    mudarEstadoOferta(id, 'CANCELADA', { autorId: user.id, justificativa: 'Cancelada pelo estabelecimento' });
  });
});

route('GET', '/api/ofertas/:id', ({ user, params }) => {
  const o = get(`${SELECT_OFERTA} WHERE o.id=?`, Number(params.id));
  if (!o) throw new HttpError(404, 'Oferta não encontrada.', 'NAO_ENCONTRADO');
  const envolvido =
    user.tipo === 'GESTOR' || o.estabelecimento_id === user.id ||
    get('SELECT 1 FROM reservas r LEFT JOIN coletas c ON c.reserva_id=r.id WHERE r.oferta_id=? AND (r.osc_id=? OR c.transportador_id=?)', o.id, user.id, user.id);
  if (!envolvido && !(o.estado === 'DISPONIVEL' && user.tipo !== 'ESTABELECIMENTO')) {
    throw new HttpError(403, 'Sem acesso a esta oferta.', 'SEM_PERMISSAO');
  }
  return { oferta: ofertaParaApi(o) };
});
