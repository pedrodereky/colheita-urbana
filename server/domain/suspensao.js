import { run, get, all } from '../db.js';
import { registrar } from '../lib/audit.js';
import { notificar, notificarGestores } from '../lib/notify.js';
import { mudarEstadoOferta } from './estados.js';
import { devolverAFila, liberarColeta } from './fila.js';
import { definirAoSuspender } from '../modules/auth.js';
import { agora, iso } from '../lib/clock.js';
import { R } from './regras.js';

// UC05 - ao suspender, cancela reservas e ofertas em aberto do cadastro
export function cancelarPendencias(id, tipo, autorId) {
  if (tipo === 'ESTABELECIMENTO') {
    for (const o of all("SELECT id FROM ofertas WHERE estabelecimento_id=? AND estado IN ('DISPONIVEL','RESERVADA','EM_COLETA')", id)) {
      const r = get("SELECT osc_id FROM reservas WHERE oferta_id=? AND status='ATIVA'", o.id);
      if (r) {
        run("UPDATE reservas SET status='CANCELADA' WHERE oferta_id=? AND status='ATIVA'", o.id);
        run("UPDATE coletas SET status='CANCELADA' WHERE reserva_id IN (SELECT id FROM reservas WHERE oferta_id=?) AND status IN ('PENDENTE','ACEITA')", o.id);
        notificar(r.osc_id, 'STATUS_ENTREGA', 'Uma oferta que você reservou foi cancelada porque o estabelecimento foi suspenso.', { referencia: `oferta:${o.id}` });
      }
      mudarEstadoOferta(o.id, 'CANCELADA', { autorId, justificativa: 'Estabelecimento suspenso' });
    }
  } else if (tipo === 'OSC') {
    for (const r of all("SELECT r.oferta_id FROM reservas r JOIN ofertas o ON o.id=r.oferta_id WHERE r.osc_id=? AND r.status='ATIVA' AND o.estado IN ('RESERVADA','EM_COLETA')", id)) {
      devolverAFila(r.oferta_id, { motivo: 'OSC suspensa', statusReserva: 'CANCELADA', autorId });
    }
  } else if (tipo === 'TRANSPORTADOR') {
    for (const c of all("SELECT c.id, r.oferta_id FROM coletas c JOIN reservas r ON r.id=c.reserva_id WHERE c.transportador_id=? AND c.status='ACEITA'", id)) {
      liberarColeta(c.id, c.oferta_id, 'Transportador suspenso', autorId);
    }
  }
}
definirAoSuspender(cancelarPendencias);

// RN12 - 3 inconsistências na conservação em 30 dias alertam o gestor
export function registrarInconsistencia(estabelecimentoId, reservaId, motivo) {
  run('INSERT INTO inconsistencias (estabelecimento_id, reserva_id, motivo, criado_em) VALUES (?,?,?,?)', estabelecimentoId, reservaId, motivo, iso());
  const desde = iso(new Date(agora().getTime() - R.janelaPenalidadeDias * 86400e3));
  const n = get('SELECT COUNT(*) AS n FROM inconsistencias WHERE estabelecimento_id=? AND criado_em>=?', estabelecimentoId, desde).n;
  if (n >= R.inconsistenciasParaBloqueio) {
    // RN12 "podem bloquear": a decisão é do gestor, que recebe o alerta e pode suspender o cadastro
    const just = `${n} inconsistências de conservação em ${R.janelaPenalidadeDias} dias (RN12)`;
    registrar({ entidade: 'usuario', entidadeId: estabelecimentoId, acao: 'ALERTA_INCONSISTENCIAS', justificativa: just });
    notificarGestores('GERAL', `Atenção: ${get('SELECT nome FROM usuarios WHERE id=?', estabelecimentoId).nome} acumulou ${just}. Avalie a suspensão.`, { referencia: `usuario:${estabelecimentoId}` });
  }
  return n;
}
