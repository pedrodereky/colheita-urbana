import { get, all } from '../db.js';
import { config, veiculos } from '../config.js';
import { agora } from '../lib/clock.js';
import { HttpError } from '../lib/http.js';

export const tipoArmazenamento = (conservacao) => (conservacao === 'AMBIENTE' ? 'seca' : 'refrigerada');

// RN13 / RN14 - capacidade declarada x volume já comprometido em reservas ativas
export function capacidadeOsc(oscId, conservacao) {
  const o = get('SELECT capacidade_refrigerada_kg AS r, capacidade_seca_kg AS s FROM oscs WHERE usuario_id=?', oscId);
  const tipo = tipoArmazenamento(conservacao);
  const total = tipo === 'seca' ? o.s : o.r;
  const usado = get(
    `SELECT COALESCE(SUM(r.quantidade_kg),0) AS kg FROM reservas r JOIN ofertas of ON of.id=r.oferta_id
     WHERE r.osc_id=? AND r.status='ATIVA' AND (CASE WHEN of.conservacao='AMBIENTE' THEN 'seca' ELSE 'refrigerada' END)=?`,
    oscId, tipo,
  ).kg;
  return { tipo, total, usado, livre: Math.max(0, total - usado) };
}

// RN01 / RN15 - cadastro aprovado e documentação anual em dia
export function oscApta(oscId) {
  const u = get("SELECT status_cadastro AS s FROM usuarios WHERE id=? AND tipo='OSC'", oscId);
  const o = get('SELECT validade_documentacao AS v FROM oscs WHERE usuario_id=?', oscId);
  if (!u || u.s !== 'APROVADO') return { apta: false, motivo: 'Cadastro da OSC não está aprovado (RN01).' };
  if (!o || new Date(o.v + 'T23:59:59Z') < agora()) return { apta: false, motivo: 'Documentação anual vencida (RN01/RN15).' };
  return { apta: true };
}

export function exigirAprovado(user) {
  if (user.statusCadastro !== 'APROVADO') {
    const msg = { PENDENTE: 'Seu cadastro ainda está em análise.', REJEITADO: 'Seu cadastro foi rejeitado. Corrija os dados no perfil.', SUSPENSO: 'Seu cadastro está suspenso.' }[user.statusCadastro];
    throw new HttpError(403, msg || 'Cadastro não aprovado.', 'CADASTRO_NAO_APROVADO');
  }
}

// RN18 - veículo compatível com a carga
export const veiculoSuporta = (tipoVeiculo, kg) => kg <= (veiculos[tipoVeiculo]?.capacidadeKg ?? 0);

// RN10 - coletas ativas do transportador
export const coletasAtivas = (transportadorId) =>
  get("SELECT COUNT(*) AS n FROM coletas WHERE transportador_id=? AND status IN ('ACEITA','EM_TRANSPORTE')", transportadorId).n;

// RN02 / RN20 - transportador apto
export function transportadorApto(transportadorId) {
  const u = get("SELECT status_cadastro AS s FROM usuarios WHERE id=? AND tipo='TRANSPORTADOR'", transportadorId);
  const t = get('SELECT suspenso_ate FROM transportadores WHERE usuario_id=?', transportadorId);
  if (!u || u.s !== 'APROVADO') return { apto: false, motivo: 'Cadastro de transportador não validado (RN02).' };
  if (t.suspenso_ate && new Date(t.suspenso_ate) > agora()) {
    return { apto: false, motivo: `Você está suspenso até ${new Date(t.suspenso_ate).toLocaleDateString('pt-BR')} por faltas consecutivas (RN20).` };
  }
  return { apto: true };
}

export const idsPorTipo = (tipo) => all("SELECT id FROM usuarios WHERE tipo=? AND status_cadastro='APROVADO'", tipo).map((r) => r.id);
export const R = config.regras;
