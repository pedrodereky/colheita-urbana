import { route, HttpError } from '../lib/http.js';
import { run, get, all, tx } from '../db.js';
import { exigir } from '../lib/validators.js';
import { agora, iso } from '../lib/clock.js';
import { registrar } from '../lib/audit.js';
import { distancia } from '../lib/maps.js';
import { notificar, notificarVarios } from '../lib/notify.js';
import { mudarEstadoOferta } from '../domain/estados.js';
import { exigirAprovado, oscApta, capacidadeOsc, idsPorTipo, veiculoSuporta, coletasAtivas, transportadorApto, R } from '../domain/regras.js';
import { ofertaParaApi } from './ofertas.js';
import { devolverAFila } from '../domain/fila.js';

const O = { perfis: ['OSC'] };

// UC14 / RF08 / RF12 / RN09 - ofertas ordenadas por proximidade, urgência e histórico de distribuição
route('GET', '/api/ofertas', O, async ({ user, query }) => {
  exigirAprovado(user);
  const apta = oscApta(user.id);
  if (!apta.apta) throw new HttpError(403, apta.motivo, 'OSC_INAPTA');
  const agoraD = agora();
  const candidatas = all(
    `SELECT o.*, u.nome AS estabelecimento_nome, u.latitude AS lat, u.longitude AS lon FROM ofertas o JOIN usuarios u ON u.id=o.estabelecimento_id
     WHERE o.estado='DISPONIVEL' AND o.validade>? AND o.janela_fim>?`, iso(agoraD), iso(agoraD),
  ).filter((o) => (!query.categoria || o.categoria === query.categoria) && (!query.conservacao || o.conservacao === query.conservacao));

  let mapaIndisponivel = false;
  const medidas = await Promise.all(candidatas.map(async (o) => {
    try { return await distancia({ latitude: user.latitude, longitude: user.longitude }, { latitude: o.lat, longitude: o.lon }); }
    catch { mapaIndisponivel = true; return null; }
  }));

  // RF12 - só mostra o que dá para entregar antes do vencimento
  let itens = candidatas.map((o, i) => ({ o, m: medidas[i] })).filter(({ o, m }) => {
    if (!m) return true;
    const retirada = Math.max(agoraD.getTime(), new Date(o.janela_inicio).getTime());
    return retirada + m.minutos * 60e3 <= new Date(o.validade).getTime();
  });

  // Histórico: quanto esta OSC recebeu nos últimos 30 dias frente à média das OSCs
  const desde = iso(new Date(agoraD.getTime() - 30 * 86400e3));
  const kgDe = (id) => get("SELECT COALESCE(SUM(quantidade_kg),0) AS kg FROM historico_doacoes WHERE osc_id=? AND situacao='ENTREGUE' AND data_conclusao>=?", id, desde).kg;
  const ids = idsPorTipo('OSC');
  const media = ids.length ? ids.reduce((s, id) => s + kgDe(id), 0) / ids.length : 0;
  const fator = Math.min(1.5, kgDe(user.id) / (media + 1));

  const horas = (o) => Math.max(0, (new Date(o.validade) - agoraD) / 3600e3);
  const maxDist = Math.max(1, ...itens.map(({ m }) => m?.distanciaKm ?? 0));
  const maxHoras = Math.max(1, ...itens.map(({ o }) => horas(o)));

  itens = itens.map(({ o, m }) => {
    const perecivelUrgente = o.conservacao !== 'AMBIENTE' && horas(o) <= R.validadeCurtaHoras ? 0.2 : 0;
    const score = mapaIndisponivel
      ? horas(o) / maxHoras
      : 0.4 * (m.distanciaKm / maxDist) + 0.35 * (horas(o) / maxHoras) + 0.25 * fator - perecivelUrgente;
    const cap = capacidadeOsc(user.id, o.conservacao);
    return {
      ...ofertaParaApi(o), distanciaKm: m ? Math.round(m.distanciaKm * 10) / 10 : null, tempoEstimadoMin: m?.minutos ?? null,
      horasParaVencer: Math.round(horas(o) * 10) / 10, cabeNaCapacidade: cap.livre >= o.quantidade_kg, capacidadeLivreKg: cap.livre, score: Math.round(score * 1000) / 1000,
    };
  }).sort((a, b) => a.score - b.score);

  return { ofertas: itens, mapaIndisponivel, aviso: mapaIndisponivel ? 'Serviço de mapas indisponível: ordenando apenas pela validade.' : null };
});

// UC15 + UC16 - reservar oferta escolhendo a modalidade de entrega
route('POST', '/api/ofertas/:id/reservar', O, async ({ user, params, body }) => {
  exigirAprovado(user);
  const modalidade = exigir.enum(body, 'modalidade', 'Modalidade de entrega', ['VOLUNTARIO', 'PROPRIO']); // UC16 2a
  const responsavel = modalidade === 'PROPRIO' ? exigir.texto(body, 'responsavelRetirada', 'o nome do responsável pela retirada', { max: 120 }) : null;
  const ofertaId = Number(params.id);

  // distância para checar RF12 na hora de reservar (fora da transação por ser assíncrono)
  const pre = get('SELECT o.*, u.latitude AS lat, u.longitude AS lon FROM ofertas o JOIN usuarios u ON u.id=o.estabelecimento_id WHERE o.id=?', ofertaId);
  if (!pre) throw new HttpError(404, 'Oferta não encontrada.', 'NAO_ENCONTRADO');
  let minutos = 0;
  try { minutos = (await distancia({ latitude: user.latitude, longitude: user.longitude }, { latitude: pre.lat, longitude: pre.lon })).minutos; } catch { /* sem mapa: segue sem checar trajeto */ }

  const resultado = tx(() => {
    const o = get('SELECT * FROM ofertas WHERE id=?', ofertaId);
    if (o.estado !== 'DISPONIVEL') throw new HttpError(409, 'Esta oferta não está mais disponível.', 'OFERTA_INDISPONIVEL');
    const apta = oscApta(user.id);
    if (!apta.apta) throw new HttpError(403, apta.motivo, 'OSC_INAPTA');                                   // RN01 / UC15 3a
    if (get('SELECT 1 FROM reservas WHERE oferta_id=? AND osc_id=?', ofertaId, user.id)) {
      throw new HttpError(409, 'Sua OSC já reservou esta oferta anteriormente (RN19).', 'RESERVA_DUPLICADA'); // RN19
    }
    const cap = capacidadeOsc(user.id, o.conservacao);
    if (o.quantidade_kg > cap.livre) {
      throw new HttpError(422, `Capacidade de armazenamento ${cap.tipo === 'seca' ? 'seca' : 'refrigerada'} excedida: livre ${cap.livre.toFixed(1)} kg, oferta ${o.quantidade_kg} kg (RN14).`, 'CAPACIDADE_EXCEDIDA');
    }
    const agoraD = agora();
    if (new Date(o.janela_fim) <= agoraD) throw new HttpError(409, 'A janela de retirada desta oferta já terminou.', 'JANELA_ENCERRADA');
    if (Math.max(agoraD.getTime(), new Date(o.janela_inicio).getTime()) + minutos * 60e3 > new Date(o.validade).getTime()) {
      throw new HttpError(422, 'Não é possível entregar esta oferta antes do vencimento (RF12).', 'FORA_DO_PRAZO');
    }

    const r = run('INSERT INTO reservas (oferta_id, osc_id, modalidade, responsavel_retirada, status, quantidade_kg, data_reserva) VALUES (?,?,?,?,?,?,?)',
      ofertaId, user.id, modalidade, responsavel, 'ATIVA', o.quantidade_kg, iso());
    const reservaId = Number(r.lastInsertRowid);
    const c = run('INSERT INTO coletas (reserva_id, status) VALUES (?, ?)', reservaId, 'PENDENTE');
    const coletaId = Number(c.lastInsertRowid);
    mudarEstadoOferta(ofertaId, 'RESERVADA', { autorId: user.id });
    registrar({ autorId: user.id, entidade: 'reserva', entidadeId: reservaId, acao: 'RESERVAR', para: modalidade });

    if (modalidade === 'PROPRIO') {
      // RN25 - a OSC assume o papel do transportador (sem RN02/RN10/RN20)
      run("UPDATE coletas SET status='ACEITA', aceita_em=? WHERE id=?", iso(), coletaId);
      mudarEstadoOferta(ofertaId, 'EM_COLETA', { autorId: user.id, justificativa: 'Transporte próprio da OSC' });
    }
    return { reservaId, coletaId, oferta: o };
  });

  notificar(resultado.oferta.estabelecimento_id, 'STATUS_ENTREGA', `Sua oferta de ${resultado.oferta.tipo_alimento} foi reservada por ${user.nome}.`, { referencia: `coleta:${resultado.coletaId}` });
  if (modalidade === 'VOLUNTARIO') {
    const aptos = idsPorTipo('TRANSPORTADOR').filter((id) => {
      const t = get('SELECT tipo_veiculo FROM transportadores WHERE usuario_id=?', id);
      return transportadorApto(id).apto && coletasAtivas(id) < R.maxColetasAtivas && veiculoSuporta(t.tipo_veiculo, resultado.oferta.quantidade_kg);
    });
    notificarVarios(aptos, 'GERAL', `Nova coleta disponível: ${resultado.oferta.quantidade_kg} kg de ${resultado.oferta.tipo_alimento}.`, { referencia: `coleta:${resultado.coletaId}` });
  }
  return { reservaId: resultado.reservaId, coletaId: resultado.coletaId, modalidade };
});

route('GET', '/api/reservas', O, ({ user }) => {
  const linhas = all(
    `SELECT r.*, o.tipo_alimento, o.estado, o.categoria, o.validade, o.janela_inicio, o.janela_fim, u.nome AS estabelecimento, c.id AS coleta_id, c.status AS coleta_status
     FROM reservas r JOIN ofertas o ON o.id=r.oferta_id JOIN usuarios u ON u.id=o.estabelecimento_id JOIN coletas c ON c.reserva_id=r.id
     WHERE r.osc_id=? ORDER BY r.id DESC LIMIT 200`, user.id);
  return {
    reservas: linhas.map((r) => ({
      id: r.id, ofertaId: r.oferta_id, coletaId: r.coleta_id, tipoAlimento: r.tipo_alimento, categoria: r.categoria, estabelecimento: r.estabelecimento,
      quantidadeKg: r.quantidade_kg, modalidade: r.modalidade, responsavelRetirada: r.responsavel_retirada, status: r.status, estadoOferta: r.estado,
      validade: r.validade, janelaInicio: r.janela_inicio, janelaFim: r.janela_fim, dataReserva: r.data_reserva,
      avaliadaDoacao: !!get("SELECT 1 FROM avaliacoes WHERE reserva_id=? AND tipo='DOACAO'", r.id),
      avaliadaEntrega: !!get("SELECT 1 FROM avaliacoes WHERE reserva_id=? AND tipo='ENTREGA'", r.id),
    })),
  };
});

// A OSC pode desistir da reserva enquanto os alimentos ainda não foram coletados.
// A oferta volta à fila (RN19: esta OSC não pode reservá-la de novo) e não há falta para ninguém.
route('POST', '/api/reservas/:id/cancelar', O, ({ user, params, body }) => {
  const motivo = exigir.opcional(body, 'justificativa', 300) || 'sem justificativa';
  tx(() => {
    const r = get('SELECT r.*, o.estado FROM reservas r JOIN ofertas o ON o.id=r.oferta_id WHERE r.id=? AND r.osc_id=?', Number(params.id), user.id);
    if (!r) throw new HttpError(404, 'Reserva não encontrada.', 'NAO_ENCONTRADO');
    if (r.status !== 'ATIVA' || !['RESERVADA', 'EM_COLETA'].includes(r.estado)) {
      throw new HttpError(409, 'Só é possível cancelar antes de os alimentos serem coletados.', 'ESTADO_INVALIDO');
    }
    registrar({ autorId: user.id, entidade: 'reserva', entidadeId: r.id, acao: 'CANCELAR', de: 'ATIVA', para: 'CANCELADA', justificativa: motivo });
    devolverAFila(r.oferta_id, { motivo: `cancelada pela OSC (${motivo})`, statusReserva: 'CANCELADA', autorId: user.id });
  });
});
