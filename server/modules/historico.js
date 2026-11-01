import { route, HttpError, enviarBuffer } from '../lib/http.js';
import { run, get, all } from '../db.js';
import { iso, agora } from '../lib/clock.js';
import { registrar } from '../lib/audit.js';
import { decifrar } from '../lib/crypto.js';
import { gerarPdf } from '../lib/pdf.js';
import { randomBytes } from 'node:crypto';

// UC33 / RF22 - grava o histórico ao concluir a doação (Entregue ou Recusada)
export function gravarHistorico(reservaId, situacao) {
  const d = get(
    `SELECT r.id, r.osc_id, r.quantidade_kg, o.estabelecimento_id, o.categoria, o.tipo_alimento FROM reservas r JOIN ofertas o ON o.id=r.oferta_id WHERE r.id=?`, reservaId);
  run(
    `INSERT OR IGNORE INTO historico_doacoes (reserva_id, osc_id, estabelecimento_id, data_conclusao, categoria, tipo_alimento, quantidade_kg, situacao) VALUES (?,?,?,?,?,?,?,?)`,
    reservaId, d.osc_id, d.estabelecimento_id, iso(), d.categoria, d.tipo_alimento, d.quantidade_kg, situacao);
}

// UC28 / RF39 / RN33 - recibo só depois da confirmação de recebimento
export function emitirRecibo(reservaId) {
  try {
    const existente = get('SELECT id, numero FROM recibos WHERE reserva_id=?', reservaId);
    if (existente) return existente;
    const d = get(
      `SELECT r.id, r.osc_id, r.quantidade_kg, o.estabelecimento_id, o.tipo_alimento, o.categoria, o.estado, c.hora_coleta, c.hora_entrega
       FROM reservas r JOIN ofertas o ON o.id=r.oferta_id JOIN coletas c ON c.reserva_id=r.id WHERE r.id=?`, reservaId);
    if (!['ENTREGUE', 'AVALIADA'].includes(d.estado)) throw new Error('recebimento não confirmado');
    const e = get('SELECT u.nome, es.cnpj_enc FROM usuarios u JOIN estabelecimentos es ON es.usuario_id=u.id WHERE u.id=?', d.estabelecimento_id);
    const o = get('SELECT u.nome, oc.cnpj_enc FROM usuarios u JOIN oscs oc ON oc.usuario_id=u.id WHERE u.id=?', d.osc_id);
    const numero = `CU-${agora().getFullYear()}-${String(reservaId).padStart(6, '0')}`;
    const codigo = randomBytes(5).toString('hex').toUpperCase();
    const dados = {
      estabelecimento: { nome: e.nome, cnpj: decifrar(e.cnpj_enc) }, osc: { nome: o.nome, cnpj: decifrar(o.cnpj_enc) },
      alimento: d.tipo_alimento, categoria: d.categoria, quantidadeKg: d.quantidade_kg, horaColeta: d.hora_coleta, horaEntrega: d.hora_entrega,
    };
    const r = run('INSERT INTO recibos (reserva_id, numero, codigo_verificacao, data_emissao, quantidade_kg, tipo_alimento, estabelecimento_id, osc_id, dados) VALUES (?,?,?,?,?,?,?,?,?)',
      reservaId, numero, codigo, iso(), d.quantidade_kg, d.tipo_alimento, d.estabelecimento_id, d.osc_id, JSON.stringify(dados));
    registrar({ entidade: 'recibo', entidadeId: Number(r.lastInsertRowid), acao: 'EMITIR', para: numero });
    return { id: Number(r.lastInsertRowid), numero };
  } catch (e) {
    // UC28 2a: registra o erro; a doação continua Entregue e o job tenta de novo
    registrar({ entidade: 'recibo', entidadeId: reservaId, acao: 'FALHA_EMISSAO', justificativa: String(e.message) });
    return null;
  }
}

export function reemitirRecibosPendentes() {
  let n = 0;
  for (const r of all("SELECT r.id FROM reservas r JOIN ofertas o ON o.id=r.oferta_id WHERE o.estado IN ('ENTREGUE','AVALIADA') AND NOT EXISTS (SELECT 1 FROM recibos x WHERE x.reserva_id=r.id)")) {
    if (emitirRecibo(r.id)) n++;
  }
  return n;
}

const paraApi = (r) => ({ id: r.id, numero: r.numero, codigoVerificacao: r.codigo_verificacao, dataEmissao: r.data_emissao, quantidadeKg: r.quantidade_kg, tipoAlimento: r.tipo_alimento, ...JSON.parse(r.dados) });

function reciboAcessivel(id, user) {
  const r = get('SELECT * FROM recibos WHERE id=?', id);
  if (!r) throw new HttpError(404, 'Recibo não encontrado.', 'NAO_ENCONTRADO');
  if (![r.estabelecimento_id, r.osc_id].includes(user.id) && user.tipo !== 'GESTOR') throw new HttpError(403, 'Sem acesso a este recibo.', 'SEM_PERMISSAO');
  return r;
}

route('GET', '/api/recibos', ({ user }) => {
  const col = user.tipo === 'ESTABELECIMENTO' ? 'estabelecimento_id' : user.tipo === 'OSC' ? 'osc_id' : null;
  if (!col) throw new HttpError(403, 'Sem acesso.', 'SEM_PERMISSAO');
  return { recibos: all(`SELECT * FROM recibos WHERE ${col}=? ORDER BY id DESC LIMIT 200`, user.id).map(paraApi) };
});
route('GET', '/api/recibos/:id', ({ user, params }) => ({ recibo: paraApi(reciboAcessivel(Number(params.id), user)) }));

// RelatórioPDF do recibo (ReciboDoacao.gerarPdf)
route('GET', '/api/recibos/:id/pdf', ({ user, params, res }) => {
  const r = paraApi(reciboAcessivel(Number(params.id), user));
  const f = (d) => (d ? new Date(d).toLocaleString('pt-BR') : '-');
  const pdf = gerarPdf({
    titulo: `Recibo de Doacao ${r.numero}`,
    linhas: [
      'Colheita Urbana - Termo de doacao de alimentos', '',
      `Doador: ${r.estabelecimento.nome} (CNPJ ${r.estabelecimento.cnpj})`,
      `Receptora: ${r.osc.nome} (CNPJ ${r.osc.cnpj})`, '',
      `Alimento: ${r.alimento} (${r.categoria})`, `Quantidade: ${r.quantidadeKg} kg`,
      `Coleta: ${f(r.horaColeta)}`, `Entrega: ${f(r.horaEntrega)}`, `Emissao: ${f(r.dataEmissao)}`, '',
      `Codigo de verificacao: ${r.codigoVerificacao}`,
      'Verifique a autenticidade em /#/verificar/' + r.codigoVerificacao,
    ].map((l) => l.normalize('NFC')),
  });
  enviarBuffer(res, pdf, 'application/pdf', `recibo-${r.numero}.pdf`);
});

// Verificação pública do recibo (sem CNPJ)
route('GET', '/api/verificar-recibo/:codigo', { publica: true }, ({ params }) => {
  const r = get('SELECT * FROM recibos WHERE codigo_verificacao=?', String(params.codigo).toUpperCase());
  if (!r) throw new HttpError(404, 'Recibo não encontrado.', 'NAO_ENCONTRADO');
  const d = paraApi(r);
  return { valido: true, numero: d.numero, dataEmissao: d.dataEmissao, doador: d.estabelecimento.nome, receptora: d.osc.nome, alimento: d.alimento, quantidadeKg: d.quantidadeKg };
});

// UC34 / UC35 / UC36 - consulta, ordenação e filtros
const ORDENS = { data: 'h.data_conclusao', quantidade: 'h.quantidade_kg', estabelecimento: 'e.nome' };
route('GET', '/api/historico', ({ user, query }) => {
  const col = user.tipo === 'OSC' ? 'h.osc_id' : user.tipo === 'ESTABELECIMENTO' ? 'h.estabelecimento_id' : null;
  if (!col) throw new HttpError(403, 'Sem acesso.', 'SEM_PERMISSAO');
  const cond = [`${col}=?`], p = [user.id];
  if (query.categoria) { cond.push('h.categoria=?'); p.push(query.categoria); }
  if (query.nota) { cond.push('h.nota=?'); p.push(Number(query.nota)); }
  if (query.situacao) { cond.push('h.situacao=?'); p.push(query.situacao); }
  if (query.de) { cond.push('h.data_conclusao>=?'); p.push(new Date(query.de).toISOString()); }
  if (query.ate) { cond.push('h.data_conclusao<=?'); p.push(new Date(new Date(query.ate).getTime() + 86400e3 - 1).toISOString()); }
  const ordem = `${ORDENS[query.ordenar] || ORDENS.data} ${query.ordem === 'asc' ? 'ASC' : 'DESC'}`;
  const itens = all(
    `SELECT h.*, e.nome AS estabelecimento, o.nome AS osc FROM historico_doacoes h JOIN usuarios e ON e.id=h.estabelecimento_id JOIN usuarios o ON o.id=h.osc_id
     WHERE ${cond.join(' AND ')} ORDER BY ${ordem} LIMIT 500`, ...p);
  return {
    historico: itens.map((h) => ({ id: h.id, reservaId: h.reserva_id, dataConclusao: h.data_conclusao, estabelecimento: h.estabelecimento, osc: h.osc, categoria: h.categoria, tipoAlimento: h.tipo_alimento, quantidadeKg: h.quantidade_kg, situacao: h.situacao, nota: h.nota })),
    categorias: all(`SELECT DISTINCT h.categoria FROM historico_doacoes h WHERE ${col}=?`, user.id).map((c) => c.categoria),
  };
});
