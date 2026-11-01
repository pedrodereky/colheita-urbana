import { copyFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { run, get, all, db } from '../db.js';
import { config } from '../config.js';
import { agora, iso } from '../lib/clock.js';
import { registrar } from '../lib/audit.js';
import { notificarGestores, notificarVarios, enviarEmailPara } from '../lib/notify.js';
import { mudarEstadoOferta } from '../domain/estados.js';
import { devolverAFila } from '../domain/fila.js';
import { R } from '../domain/regras.js';
import { calcularIndicadores } from './gestao.js';
import { reemitirRecibosPendentes } from './historico.js';

// UC18 / RF10 / RN03 / RN20 - reservas cuja janela de retirada terminou sem coleta
export function devolverOfertasNaoRetiradas() {
  let n = 0;
  const vencidas = all(
    `SELECT o.id, c.transportador_id, r.modalidade, c.status AS coleta_status FROM ofertas o JOIN reservas r ON r.oferta_id=o.id AND r.status='ATIVA' JOIN coletas c ON c.reserva_id=r.id
     WHERE o.estado IN ('RESERVADA','EM_COLETA') AND o.janela_fim<=?`, iso());
  for (const v of vencidas) {
    // falta só quando um voluntário assumiu a coleta e não compareceu (RN25: a OSC não passa por RN20)
    const falta = v.coleta_status === 'ACEITA' && !!v.transportador_id && v.modalidade === 'VOLUNTARIO';
    devolverAFila(v.id, { motivo: falta ? 'Transportador não compareceu dentro da janela' : 'Janela de retirada encerrada sem coleta', statusReserva: 'EXPIRADA', contarFalta: falta });
    n++;
  }
  return n;
}

// Ofertas sem reserva cuja validade ou janela de retirada já acabou
export function expirarOfertasDisponiveis() {
  const lista = all("SELECT id FROM ofertas WHERE estado='DISPONIVEL' AND (validade<=? OR janela_fim<=?)", iso(), iso());
  for (const o of lista) mudarEstadoOferta(o.id, 'EXPIRADA', { justificativa: 'Prazo encerrado sem reserva' });
  return lista.length;
}

// UC41 / RF36 / RN26 - validade crítica sem OSC interessada
export function alertarValidadeCritica() {
  const limite = iso(new Date(agora().getTime() + R.validadeCriticaHoras * 3600e3));
  const lista = all(
    `SELECT o.id, o.tipo_alimento, o.quantidade_kg, o.validade, u.nome FROM ofertas o JOIN usuarios u ON u.id=o.estabelecimento_id
     WHERE o.estado='DISPONIVEL' AND o.validade<=? AND o.validade>? AND NOT EXISTS (SELECT 1 FROM alertas_validade a WHERE a.oferta_id=o.id)`, limite, iso());
  for (const o of lista) {
    run('INSERT INTO alertas_validade (oferta_id, enviado_em) VALUES (?,?)', o.id, iso());
    notificarGestores('VALIDADE_CRITICA', `Validade crítica: ${o.quantidade_kg} kg de ${o.tipo_alimento} (${o.nome}) vencem em menos de ${R.validadeCriticaHoras}h e nenhuma OSC reservou.`, { referencia: `oferta:${o.id}` });
    registrar({ entidade: 'oferta', entidadeId: o.id, acao: 'ALERTA_VALIDADE_CRITICA' });
  }
  return lista.length;
}

// RN28 - relatório mensal de métricas para os gestores
export function enviarRelatorioMensal() {
  const hoje = agora();
  const ini = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - 1, 1));
  const fim = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1) - 1);
  const chave = ini.toISOString().slice(0, 7);
  const ja = get('SELECT relatorio_enviado FROM indicadores WHERE periodo=?', chave);
  if (ja?.relatorio_enviado) return false;
  const ind = calcularIndicadores(iso(ini), iso(fim));
  run('INSERT INTO indicadores (periodo, dados, calculado_em, relatorio_enviado) VALUES (?,?,?,1) ON CONFLICT(periodo) DO UPDATE SET dados=excluded.dados, calculado_em=excluded.calculado_em, relatorio_enviado=1', chave, JSON.stringify(ind), iso());
  const resumo = `Relatório de ${chave}: ${ind.quilosResgatados} kg resgatados, ${ind.refeicoesEquivalentes} refeições, ${ind.taxaOfertasExpiradas}% de ofertas expiradas.`;
  const gestores = all("SELECT id FROM usuarios WHERE tipo='GESTOR' AND status_cadastro='APROVADO'").map((g) => g.id);
  notificarVarios(gestores, 'GERAL', resumo);
  for (const id of gestores) enviarEmailPara(id, `Colheita Urbana - relatório mensal ${chave}`, resumo);
  return true;
}

// RNF14 - backup diário consistente (VACUUM INTO) e rotação de 14 dias
export function backupDiario() {
  const nome = `colheita-${agora().toISOString().slice(0, 10)}.db`;
  const destino = resolve(config.backupsDir, nome);
  if (existsSync(destino)) return false;
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  const antigos = readdirSync(config.backupsDir).filter((f) => f.endsWith('.db')).sort().slice(0, -14);
  for (const f of antigos) unlinkSync(resolve(config.backupsDir, f));
  return true;
}

// Limpeza: sessões/tokens vencidos e chats antigos (retenção limitada - LGPD / RN34)
export function limpeza() {
  run('DELETE FROM sessoes WHERE expira_em<?', iso());
  run('DELETE FROM tokens_recuperacao WHERE expira_em<?', iso());
  const corte = iso(new Date(agora().getTime() - R.chatRetencaoDias * 86400e3));
  run(
    `DELETE FROM mensagens_chat WHERE coleta_id IN (
       SELECT c.id FROM coletas c JOIN reservas r ON r.id=c.reserva_id JOIN ofertas o ON o.id=r.oferta_id
       WHERE o.estado NOT IN ('EM_COLETA','EM_TRANSPORTE') AND COALESCE(c.hora_entrega, c.aceita_em, '') < ?)`, corte);
  // RN32 - posição só existe durante a entrega
  run("DELETE FROM localizacoes WHERE coleta_id IN (SELECT c.id FROM coletas c JOIN reservas r ON r.id=c.reserva_id JOIN ofertas o ON o.id=r.oferta_id WHERE o.estado NOT IN ('EM_COLETA','EM_TRANSPORTE'))");
}

export function rodarJobs() {
  const passos = { devolverOfertasNaoRetiradas, expirarOfertasDisponiveis, alertarValidadeCritica, reemitirRecibosPendentes, enviarRelatorioMensal, backupDiario, limpeza };
  const resultado = {};
  for (const [nome, fn] of Object.entries(passos)) {
    try { resultado[nome] = fn(); } catch (e) { console.error(`[job:${nome}]`, e); resultado[nome] = 'erro'; }
  }
  return resultado;
}

let timer = null;
export function iniciarAgendador(intervaloMs = 60000) {
  rodarJobs();
  timer = setInterval(rodarJobs, intervaloMs);
  timer.unref();
}
export const pararAgendador = () => clearInterval(timer);
