import { get, run } from '../db.js';
import { HttpError } from '../lib/http.js';
import { registrar } from '../lib/audit.js';

// Ciclo de vida da oferta (diagrama de estados / EstadoOferta)
export const TRANSICOES = {
  DISPONIVEL: ['RESERVADA', 'CANCELADA', 'EXPIRADA'],
  RESERVADA: ['EM_COLETA', 'DISPONIVEL', 'EXPIRADA', 'CANCELADA'],
  EM_COLETA: ['EM_TRANSPORTE', 'RESERVADA', 'DISPONIVEL', 'EXPIRADA', 'CANCELADA'],
  EM_TRANSPORTE: ['ENTREGUE', 'RECUSADA'],
  ENTREGUE: ['AVALIADA'],
  RECUSADA: [],
  EXPIRADA: [],
  CANCELADA: [],
  AVALIADA: [],
};

export const ESTADOS_ATIVOS = ['RESERVADA', 'EM_COLETA', 'EM_TRANSPORTE'];
export const ESTADOS_ENTREGA_EM_ANDAMENTO = ['EM_COLETA', 'EM_TRANSPORTE']; // chat, localização (RN32, RN34)
export const ESTADOS_RECEBIDOS = ['ENTREGUE', 'AVALIADA'];                   // RN07, RN33

// RF15 / RNF07 - toda mudança de estado é validada e registrada com autor, data/hora e justificativa
export function mudarEstadoOferta(ofertaId, novo, { autorId = null, justificativa = null } = {}) {
  const o = get('SELECT estado FROM ofertas WHERE id=?', ofertaId);
  if (!o) throw new HttpError(404, 'Oferta não encontrada.', 'OFERTA_NAO_ENCONTRADA');
  if (!TRANSICOES[o.estado]?.includes(novo)) {
    throw new HttpError(409, `Transição inválida: ${o.estado} → ${novo}.`, 'TRANSICAO_INVALIDA');
  }
  run('UPDATE ofertas SET estado=? WHERE id=?', novo, ofertaId);
  registrar({ autorId, entidade: 'oferta', entidadeId: ofertaId, acao: 'MUDAR_ESTADO', de: o.estado, para: novo, justificativa });
  return o.estado;
}

export function urgenciaDe(validadeIso, agora) {
  const h = (new Date(validadeIso) - agora) / 3600e3;
  return h <= 12 ? 'CRITICA' : h <= 72 ? 'CURTA' : 'NORMAL'; // RN26
}
