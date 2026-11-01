import { run, get, all } from '../db.js';
import { agora, iso, somarHoras } from '../lib/clock.js';
import { registrar } from '../lib/audit.js';
import { notificar, notificarGestores } from '../lib/notify.js';
import { mudarEstadoOferta } from './estados.js';
import { R } from './regras.js';

// UC18 / RF10 / RN03 / RN20 - cancela a reserva e devolve a oferta à fila (ou expira, se o prazo acabou)
export function devolverAFila(ofertaId, { motivo, statusReserva = 'EXPIRADA', contarFalta = false, autorId = null }) {
  const o = get('SELECT * FROM ofertas WHERE id=?', ofertaId);
  const reserva = get("SELECT * FROM reservas WHERE oferta_id=? AND status='ATIVA'", ofertaId);
  if (!reserva) return null;
  const coleta = get('SELECT * FROM coletas WHERE reserva_id=?', reserva.id);

  run('UPDATE reservas SET status=? WHERE id=?', statusReserva, reserva.id);
  run("UPDATE coletas SET status='CANCELADA' WHERE id=?", coleta.id);
  run('DELETE FROM localizacoes WHERE coleta_id=?', coleta.id);

  const agoraD = agora();
  let novoEstado = 'DISPONIVEL';
  if (new Date(o.validade) <= agoraD) novoEstado = 'EXPIRADA';
  else {
    // Janela renovada: mesma duração, a partir de agora, limitada pela validade
    const duracao = new Date(o.janela_fim) - new Date(o.janela_inicio);
    const novoFim = new Date(Math.min(new Date(o.validade).getTime(), agoraD.getTime() + duracao));
    if (novoFim - agoraD < 30 * 60e3) novoEstado = 'EXPIRADA';
    else run('UPDATE ofertas SET janela_inicio=?, janela_fim=? WHERE id=?', iso(agoraD), iso(novoFim), ofertaId);
  }
  mudarEstadoOferta(ofertaId, novoEstado, { autorId, justificativa: motivo });

  if (contarFalta && coleta.transportador_id) registrarFalta(coleta.transportador_id); // UC18 2b / RN20

  if (coleta.transportador_id && !contarFalta) notificar(coleta.transportador_id, 'STATUS_ENTREGA', `A coleta de ${o.tipo_alimento} foi cancelada: ${motivo}.`, { referencia: `oferta:${ofertaId}` });
  notificar(reserva.osc_id, 'STATUS_ENTREGA', `A reserva de ${o.tipo_alimento} foi cancelada: ${motivo}.`, { referencia: `oferta:${ofertaId}` });
  notificar(o.estabelecimento_id, 'STATUS_ENTREGA',
    novoEstado === 'DISPONIVEL' ? `Sua oferta de ${o.tipo_alimento} voltou para a fila (${motivo}). A janela de retirada foi renovada.` : `Sua oferta de ${o.tipo_alimento} expirou (${motivo}).`,
    { referencia: `oferta:${ofertaId}` });
  return novoEstado;
}

// RN20 - 3 faltas consecutivas suspendem o transportador por 30 dias
export function registrarFalta(transportadorId) {
  run('UPDATE transportadores SET faltas_consecutivas = faltas_consecutivas + 1 WHERE usuario_id=?', transportadorId);
  const t = get('SELECT faltas_consecutivas AS f FROM transportadores WHERE usuario_id=?', transportadorId);
  registrar({ autorId: null, entidade: 'transportador', entidadeId: transportadorId, acao: 'FALTA_COLETA', para: String(t.f) });
  notificar(transportadorId, 'GERAL', `Falta registrada: você não realizou uma coleta assumida (${t.f}/${R.faltasParaSuspensao}).`);
  if (t.f >= R.faltasParaSuspensao) {
    const ate = iso(somarHoras(agora(), R.diasSuspensaoTransportador * 24));
    run('UPDATE transportadores SET suspenso_ate=?, faltas_consecutivas=0 WHERE usuario_id=?', ate, transportadorId);
    registrar({ entidade: 'transportador', entidadeId: transportadorId, acao: 'SUSPENSAO_AUTOMATICA', justificativa: `${R.faltasParaSuspensao} faltas consecutivas (RN20)` });
    notificar(transportadorId, 'CADASTRO', `Você foi suspenso por ${R.diasSuspensaoTransportador} dias por faltas consecutivas (RN20).`);
    notificarGestores('GERAL', 'Transportador suspenso automaticamente por faltas consecutivas.', { referencia: `usuario:${transportadorId}` });
    // libera coletas já aceitas e ainda não realizadas
    for (const c of all("SELECT c.id, r.oferta_id FROM coletas c JOIN reservas r ON r.id=c.reserva_id WHERE c.transportador_id=? AND c.status='ACEITA'", transportadorId)) {
      liberarColeta(c.id, c.oferta_id, 'Transportador suspenso');
    }
  }
}

// RN29 - coleta volta a ser oferecida a outros transportadores (reserva continua válida)
export function liberarColeta(coletaId, ofertaId, motivo, autorId = null) {
  run("UPDATE coletas SET transportador_id=NULL, status='PENDENTE', aceita_em=NULL WHERE id=?", coletaId);
  mudarEstadoOferta(ofertaId, 'RESERVADA', { autorId, justificativa: motivo });
}
