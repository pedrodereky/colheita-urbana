import { get, all } from '../db.js';
import { decifrar } from './crypto.js';

export function carregarUsuario(id) {
  const u = get('SELECT * FROM usuarios WHERE id=?', id);
  if (!u) return null;
  return montar(u);
}

function montar(u) {
  const base = {
    id: u.id, tipo: u.tipo, nome: u.nome, statusCadastro: u.status_cadastro, motivoStatus: u.motivo_status,
    latitude: u.latitude, longitude: u.longitude, criadoEm: u.criado_em,
  };
  return { ...base, _u: u };
}

// Versão para o próprio usuário / gestor: dados sensíveis decifrados
export function perfilCompleto(id) {
  const u = get('SELECT * FROM usuarios WHERE id=?', id);
  if (!u) return null;
  const p = {
    id: u.id, tipo: u.tipo, nome: u.nome, email: decifrar(u.email_enc), telefone: decifrar(u.telefone_enc),
    endereco: decifrar(u.endereco_enc), latitude: u.latitude, longitude: u.longitude,
    statusCadastro: u.status_cadastro, motivoStatus: u.motivo_status, criadoEm: u.criado_em,
  };
  if (u.tipo === 'ESTABELECIMENTO') {
    const e = get('SELECT * FROM estabelecimentos WHERE usuario_id=?', id);
    Object.assign(p, { cnpj: decifrar(e.cnpj_enc), ramo: e.ramo, avaliacoesPositivasSeguidas: e.avaliacoes_positivas_seguidas });
  } else if (u.tipo === 'OSC') {
    const o = get('SELECT * FROM oscs WHERE usuario_id=?', id);
    Object.assign(p, {
      cnpj: decifrar(o.cnpj_enc), capacidadeRefrigeradaKg: o.capacidade_refrigerada_kg, capacidadeSecaKg: o.capacidade_seca_kg,
      validadeDocumentacao: o.validade_documentacao, comprovante: o.comprovante,
    });
  } else if (u.tipo === 'TRANSPORTADOR') {
    const t = get('SELECT * FROM transportadores WHERE usuario_id=?', id);
    Object.assign(p, {
      cpf: decifrar(t.cpf_enc), tipoVeiculo: t.tipo_veiculo, disponibilidade: t.disponibilidade,
      faltasConsecutivas: t.faltas_consecutivas, entregasConcluidas: t.entregas_concluidas, suspensoAte: t.suspenso_ate,
    });
  } else {
    Object.assign(p, { matricula: get('SELECT matricula FROM gestores WHERE usuario_id=?', id)?.matricula });
  }
  p.reconhecimentos = all('SELECT tipo, descricao, criterio, data_emissao AS dataEmissao FROM reconhecimentos WHERE usuario_id=? ORDER BY id', id);
  return p;
}

// Versão pública mínima (nome + localização aproximada) para outros perfis
export function resumoPublico(id) {
  const u = get('SELECT id, tipo, nome, latitude, longitude FROM usuarios WHERE id=?', id);
  return u ? { id: u.id, tipo: u.tipo, nome: u.nome, latitude: u.latitude, longitude: u.longitude } : null;
}

export const ehAprovado = (u) => u.statusCadastro === 'APROVADO';
